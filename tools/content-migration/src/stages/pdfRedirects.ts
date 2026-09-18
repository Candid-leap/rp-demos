import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { ROOT, WORKSPACE, DIRS, env, ensureWorkspace } from "../config.js";
import { readCsv } from "../csvio.js";
import { loadUrlMap, saveUrlMap, type UrlMapEntry } from "../planstore.js";
import { audit } from "../log.js";
import { cachePathFor, assetFileName } from "../assets.js";
import { createAssetMeta, uploadAssetFile, WebflowError } from "../webflow.js";
import { ensureFolders } from "./migrate.js";

const STATE_FILE = path.join(WORKSPACE, "pdf-redirects.json");
const OUTPUT_CSV = path.join(DIRS.output, "fs-301-redirects.csv");
const DOC_LIMIT_KB = 10 * 1024;

export interface RedirectRow {
  fileName: string;
  sourceUrl: string;
  /** Site-relative path that Cloudflare currently redirects (Finsweet "path"). */
  oldPath: string;
  folder: string;
  sizeKb: number;
  status: "pending" | "uploaded" | "reused" | "too-large" | "failed";
  /** Finsweet "targetPath": Webflow asset URL, or the HubSpot CDN URL when the file cannot live on Webflow. */
  target: string | null;
  assetId?: string;
  error?: string;
}

export const redirectsProgress = {
  running: false, total: 0, done: 0, ok: 0, fail: 0, tooLarge: 0, reused: 0,
  startedAt: null as string | null, finishedAt: null as string | null, lastMessage: "",
};

function findListCsv(): string | null {
  const files = readdirSync(DIRS.inbox).filter((f) => /hubspot.*pdf/i.test(f) && f.endsWith(".csv"));
  return files[0] ? path.join(DIRS.inbox, files[0]) : null;
}

/** CDN pathname /hubfs/00000000/x/y.pdf -> site path /hubfs/x/y.pdf (encoding preserved). */
function oldPathFor(sourceUrl: string): string {
  const pathname = new URL(sourceUrl).pathname;
  const m = pathname.match(/^\/hubfs\/[0-9]+\/(.+)$/);
  return m ? `/hubfs/${m[1]}` : pathname;
}

export function loadRedirectState(): RedirectRow[] {
  if (!existsSync(STATE_FILE)) return [];
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as RedirectRow[];
}

function saveState(rows: RedirectRow[]): void {
  writeFileSync(STATE_FILE, JSON.stringify(rows, null, 2));
}

/** Parse the dropped HubSpot public-PDFs export into redirect rows (no network). */
export function buildRedirectRows(): RedirectRow[] {
  ensureWorkspace();
  const listFile = findListCsv();
  if (!listFile) return [];
  const csv = readCsv(listFile);
  const urlMap = loadUrlMap();
  const prev = new Map(loadRedirectState().map((r) => [r.sourceUrl, r]));
  const rows: RedirectRow[] = [];
  for (const r of csv.rows) {
    const sourceUrl = (r["URL"] ?? "").trim();
    if (!sourceUrl.startsWith("http")) continue;
    const sizeKb = Number(r["Size (KB)"] ?? 0);
    const existing = urlMap[sourceUrl];
    const carried = prev.get(sourceUrl);
    rows.push({
      fileName: r["File Name"] ?? "",
      sourceUrl,
      oldPath: oldPathFor(sourceUrl),
      folder: r["Folder"] ?? "",
      sizeKb,
      status: existing ? "reused" : sizeKb > DOC_LIMIT_KB ? "too-large" : carried?.status === "uploaded" ? "uploaded" : carried?.status === "failed" ? "failed" : "pending",
      target: existing ? existing.newUrl : sizeKb > DOC_LIMIT_KB ? sourceUrl : carried?.target ?? null,
      assetId: existing?.assetId ?? carried?.assetId,
      error: carried?.error,
    });
  }
  saveState(rows);
  return rows;
}

// Webflow 301 paths may only contain alphanumerics and . _ ? = % + & / ( ) * - @
const FINSWEET_ALLOWED = /^[A-Za-z0-9._?=%+&/()*\-@]*$/;

/**
 * Two Webflow path quirks are handled here:
 *  - "+" (literal or %2B): Webflow form-decodes incoming request paths, turning
 *    a real-world "+" into a space, so a stored "+" path never matches. The "+"
 *    is replaced with a (.*) wildcard in place, keeping the rest exact.
 *  - characters Webflow rejects outright (e.g. "!"): the path is truncated at
 *    the first bad character and finished with a (.*) wildcard.
 */
export function sanitizeFinsweetPath(p: string): string {
  let out = p
    .replaceAll("%2B", "(.*)").replaceAll("+", "(.*)")
    .replaceAll("%2C", "(.*)").replaceAll(",", "(.*)")
    .replaceAll("(.*)(.*)", "(.*)");
  const probe = out.replaceAll("(.*)", "");
  if (FINSWEET_ALLOWED.test(probe)) return out;
  let i = 0;
  while (i < out.length && (FINSWEET_ALLOWED.test(out[i]) || out.startsWith("(.*)", i))) i++;
  return out.slice(0, i) + "(.*)";
}

function writeFinsweetCsv(rows: RedirectRow[]): number {
  const lines = ["path,targetPath"];
  const fixups: string[] = [];
  let count = 0;
  const q = (s: string) => (s.includes(",") ? `"${s.replaceAll('"', '""')}"` : s);
  for (const r of rows) {
    if (!r.target) continue;
    const safePath = sanitizeFinsweetPath(r.oldPath);
    lines.push(`${q(safePath)},${q(r.target)}`);
    if (safePath !== r.oldPath) {
      fixups.push(`${q(safePath)},${q(r.target)}`);
      audit({ stage: "pdf-redirects", oldUrl: r.oldPath, note: `path contains characters Webflow rejects — wildcarded to ${safePath}` });
    }
    count++;
  }
  if (fixups.length) {
    writeFileSync(path.join(DIRS.output, "fs-301-redirects-fixups.csv"), ["path,targetPath", ...fixups].join("\n") + "\n");
    console.log(`${fixups.length} path(s) wildcarded for Webflow's charset — re-upload just these: output/fs-301-redirects-fixups.csv`);
  }
  // hand-maintained one-off redirects (e.g. moved pages) ride along with the PDF set
  const extra = path.join(ROOT, "extra-301s.csv");
  if (existsSync(extra)) {
    for (const line of readFileSync(extra, "utf8").trim().split("\n").slice(1)) {
      if (!line.trim()) continue;
      const comma = line.indexOf(",");
      const rawPath = line.slice(0, comma);
      const safePath = sanitizeFinsweetPath(rawPath);
      lines.push(`${q(safePath)},${line.slice(comma + 1).trim()}`);
      if (safePath !== rawPath) fixups.push(`${q(safePath)},${line.slice(comma + 1).trim()}`);
      count++;
    }
  }
  writeFileSync(OUTPUT_CSV, lines.join("\n") + "\n");
  return count;
}

async function download(sourceUrl: string): Promise<Buffer> {
  const cached = cachePathFor(sourceUrl);
  if (existsSync(cached)) return readFileSync(cached);
  const res = await fetch(sourceUrl, { redirect: "follow" });
  if (!res.ok) throw new WebflowError(res.status, "DOWNLOAD_FAILED", `HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("text/html")) {
    throw new WebflowError(res.status, "HTML_RESPONSE", `download returned an HTML page, not a file (${sourceUrl})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(cached, buf);
  return buf;
}

/**
 * Upload every pending public PDF to Webflow (PDFs folder), reusing anything
 * already in url-map.json, then write the Finsweet 301 CSV. Resumable; every
 * action goes to the audit log.
 */
export async function runPdfRedirects(): Promise<void> {
  const rows = buildRedirectRows();
  if (rows.length === 0) {
    console.log("No HubSpot public-PDFs CSV found in workspace/inbox/.");
    return;
  }
  if (!env.webflowToken || !env.webflowSiteId) {
    console.error("WEBFLOW_API_TOKEN / WEBFLOW_SITE_ID missing — run: pnpm precheck");
    process.exitCode = 1;
    return;
  }

  const pending = rows.filter((r) => r.status === "pending" || r.status === "failed");
  Object.assign(redirectsProgress, {
    running: true, total: pending.length, done: 0, ok: 0, fail: 0,
    tooLarge: rows.filter((r) => r.status === "too-large").length,
    reused: rows.filter((r) => r.status === "reused").length,
    startedAt: new Date().toISOString(), finishedAt: null, lastMessage: "starting",
  });
  console.log(`${rows.length} public PDFs: ${redirectsProgress.reused} already on Webflow, ${pending.length} to upload, ${redirectsProgress.tooLarge} over 10MB (stay on HubSpot CDN).`);

  const folderMap = await ensureFolders(new Set(["pdf"]));
  const folder = folderMap.get("pdf")!;

  for (const row of pending) {
    try {
      const data = await download(row.sourceUrl);
      if (data.length > DOC_LIMIT_KB * 1024) {
        row.status = "too-large";
        row.target = row.sourceUrl;
        audit({ stage: "pdf-redirects", oldUrl: row.sourceUrl, error: `over 10MB (${(data.length / 1048576).toFixed(1)}MB) — target stays on HubSpot CDN` });
        redirectsProgress.tooLarge++;
        continue;
      }
      const fileName = assetFileName(row.sourceUrl);
      const created = await createAssetMeta(env.webflowSiteId, fileName, createHash("md5").update(data).digest("hex"), folder.id);
      await uploadAssetFile(created, data, fileName);
      const hostedUrl = created.hostedUrl ?? created.assetUrl;
      if (!hostedUrl) throw new WebflowError(0, "NO_HOSTED_URL", "Webflow response had no hostedUrl");
      row.status = "uploaded";
      row.target = hostedUrl;
      row.assetId = created.id;
      row.error = undefined;
      const entry: UrlMapEntry & { oldUrls: string[]; type: string; folder: string; bytes: number } = {
        newUrl: hostedUrl, assetId: created.id, sourceUrl: row.sourceUrl,
        oldUrls: [row.oldPath], type: "pdf", folder: `Hubspot Migrated Asset/${folder.name}`,
        bytes: data.length, migratedAt: new Date().toISOString(),
      };
      // reload-merge-save so a concurrent writer's mappings are never clobbered
      const urlMap = loadUrlMap();
      urlMap[row.sourceUrl] = entry;
      saveUrlMap(urlMap);
      audit({ stage: "pdf-redirects", oldUrl: row.oldPath, newUrl: hostedUrl, assetId: created.id, note: `${data.length} bytes` });
      redirectsProgress.ok++;
    } catch (err) {
      const e = err as WebflowError;
      row.status = "failed";
      row.error = `${e.status ?? ""} ${e.code ?? ""} ${e.message}`.trim();
      audit({ stage: "pdf-redirects", oldUrl: row.sourceUrl, error: row.error });
      redirectsProgress.fail++;
    }
    redirectsProgress.done = redirectsProgress.ok + redirectsProgress.fail;
    redirectsProgress.lastMessage = `uploading ${redirectsProgress.done}/${pending.length}`;
    saveState(rows);
    if (redirectsProgress.done % 25 === 0) console.log(`  ${redirectsProgress.done}/${pending.length}`);
  }

  saveState(rows);
  const written = writeFinsweetCsv(rows);
  Object.assign(redirectsProgress, {
    running: false, finishedAt: new Date().toISOString(),
    lastMessage: `${redirectsProgress.ok} uploaded, ${redirectsProgress.fail} failed, ${written} redirects written`,
  });
  audit({ stage: "pdf-redirects", note: `Finsweet CSV written: ${written} redirects -> output/fs-301-redirects.csv` });
  console.log(`\nDone. ${written} redirect(s) -> workspace/output/fs-301-redirects.csv`);
  if (redirectsProgress.fail) console.log("Failures recorded in workspace/pdf-redirects.json — re-run to retry.");
}
