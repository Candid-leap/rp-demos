import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { WORKSPACE, env, ensureWorkspace } from "../config.js";
import { loadPlan, savePlan, loadUrlMap, saveUrlMap, type UrlMapEntry } from "../planstore.js";
import { audit } from "../log.js";
import { classify, folderNameFor, cachePathFor, assetFileName } from "../assets.js";
import { listAssetFolders, createAssetFolder, createAssetMeta, uploadAssetFile, WebflowError } from "../webflow.js";
import { PARENT_FOLDER_NAME } from "./precheck.js";

const ERRORS_FILE = path.join(WORKSPACE, "migrate-errors.json");

export interface MigrateError {
  phase: "download" | "upload" | "skipped";
  status?: number;
  code?: string;
  message: string;
  sourceUrl: string;
  at: string;
}

/** Live progress read by the portal's /api/migrate/status. */
export const migrateProgress = {
  running: false,
  phase: "idle" as "idle" | "download" | "upload" | "done",
  total: 0,
  done: 0,
  ok: 0,
  fail: 0,
  skipped: 0,
  startedAt: null as string | null,
  finishedAt: null as string | null,
  lastMessage: "",
};

// Webflow asset limits (verified against developers.webflow.com/data/docs/working-with-assets,
// Jul 2026): images max 4MB; documents/audio max 10MB; video files not supported at all.
const IMAGE_LIMIT = 4 * 1048576;
const DOC_LIMIT = 10 * 1048576;

function skipReason(type: string, bytes: number | null): { code: string; message: string } | null {
  if (type === "video") {
    return { code: "VIDEO_NOT_SUPPORTED", message: "Webflow assets do not accept video files — videos must stay externally hosted or be embedded" };
  }
  if (bytes != null && type === "image" && bytes > IMAGE_LIMIT) {
    return { code: "IMAGE_OVER_4MB", message: `image is ${(bytes / 1048576).toFixed(1)}MB — Webflow image limit is 4MB` };
  }
  if (bytes != null && type !== "image" && bytes > DOC_LIMIT) {
    return { code: "FILE_OVER_10MB", message: `file is ${(bytes / 1048576).toFixed(1)}MB — Webflow document limit is 10MB` };
  }
  return null;
}

function loadErrors(): Record<string, MigrateError> {
  if (!existsSync(ERRORS_FILE)) return {};
  return JSON.parse(readFileSync(ERRORS_FILE, "utf8")) as Record<string, MigrateError>;
}

function saveErrors(errors: Record<string, MigrateError>): void {
  writeFileSync(ERRORS_FILE, JSON.stringify(errors, null, 2));
}

function recordError(errors: Record<string, MigrateError>, sourceUrl: string, phase: "download" | "upload", err: unknown): MigrateError {
  const e: MigrateError = err instanceof WebflowError
    ? { phase, status: err.status, code: err.code, message: err.message, sourceUrl, at: new Date().toISOString() }
    : { phase, message: err instanceof Error ? err.message : String(err), sourceUrl, at: new Date().toISOString() };
  errors[sourceUrl] = e;
  saveErrors(errors);
  audit({ stage: `migrate:${phase}`, oldUrl: sourceUrl, error: `${e.status ?? ""} ${e.code ?? ""} ${e.message}`.trim() });
  return e;
}

async function download(sourceUrl: string): Promise<{ path: string; bytes: number; cached: boolean }> {
  const cached = cachePathFor(sourceUrl);
  if (existsSync(cached)) return { path: cached, bytes: statSync(cached).size, cached: true };
  const res = await fetch(sourceUrl, { redirect: "follow" });
  if (!res.ok) throw new WebflowError(res.status, "DOWNLOAD_FAILED", `HTTP ${res.status} for ${sourceUrl}`);
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("text/html")) {
    throw new WebflowError(res.status, "HTML_RESPONSE", `download returned an HTML page, not a file (${sourceUrl})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(cached, buf);
  return { path: cached, bytes: buf.length, cached: false };
}

/** Find-or-create the "Hubspot Migrated Asset" parent + per-type subfolders. */
export async function ensureFolders(types: Set<string>): Promise<Map<string, { id: string; name: string }>> {
  const folders = await listAssetFolders(env.webflowSiteId);
  let parent = folders.find((f) => f.displayName === PARENT_FOLDER_NAME && !f.parentFolder);
  if (!parent) {
    parent = await createAssetFolder(env.webflowSiteId, PARENT_FOLDER_NAME);
    audit({ stage: "migrate:folders", note: `created "${PARENT_FOLDER_NAME}" (${parent.id})` });
  }
  const byType = new Map<string, { id: string; name: string }>();
  for (const type of types) {
    const name = folderNameFor(type);
    if ([...byType.values()].some((f) => f.name === name)) {
      byType.set(type, [...byType.values()].find((f) => f.name === name)!);
      continue;
    }
    let sub = folders.find((f) => f.displayName === name && f.parentFolder === parent!.id);
    if (!sub) {
      sub = await createAssetFolder(env.webflowSiteId, name, parent.id);
      audit({ stage: "migrate:folders", note: `created subfolder "${name}" (${sub.id}) under "${PARENT_FOLDER_NAME}"` });
      console.log(`  folder created: ${PARENT_FOLDER_NAME}/${name}`);
    }
    byType.set(type, { id: sub.id, name });
  }
  return byType;
}

/**
 * Two phases, per the agreed workflow:
 *   1. download EVERY pending asset from its source into workspace/cache/
 *   2. upload each downloaded file into "Hubspot Migrated Asset"/<type folder>,
 *      recording the hosted Webflow URL (with the original source URL kept
 *      alongside) in workspace/url-map.json
 * Every action and every failure (status, code, message, timestamp) is written
 * to the audit log and workspace/migrate-errors.json. Idempotent throughout.
 */
export async function migrate(): Promise<void> {
  ensureWorkspace();
  if (!env.hubspotCdnDomain || !env.hubspotPortalId) {
    console.error("HUBSPOT_CDN_DOMAIN / HUBSPOT_PORTAL_ID not set in .env — refusing to migrate (source URLs would be wrong).");
    process.exitCode = 1;
    return;
  }
  if (!env.webflowToken || !env.webflowSiteId) {
    console.error("WEBFLOW_API_TOKEN / WEBFLOW_SITE_ID missing in .env — run: pnpm precheck");
    process.exitCode = 1;
    return;
  }

  const plan = loadPlan();
  if (plan.length === 0) {
    console.log("Plan is empty. Run: pnpm plan");
    return;
  }
  const urlMap = loadUrlMap();
  const errors = loadErrors();

  // pending: every unique source without a hosted URL yet, with all in-content URLs that reference it
  const pending = new Map<string, Set<string>>();
  for (const e of plan) {
    if (e.action !== "rehost" || !e.sourceUrl || urlMap[e.sourceUrl]) continue;
    if (!pending.has(e.sourceUrl)) pending.set(e.sourceUrl, new Set());
    pending.get(e.sourceUrl)!.add(e.oldUrl);
  }
  console.log(`${pending.size} unique asset(s) pending (already migrated: ${Object.keys(urlMap).length}).`);
  if (pending.size === 0) {
    console.log("Nothing to do. Next: pnpm verify");
    return;
  }

  Object.assign(migrateProgress, {
    running: true, phase: "download", total: pending.size, done: 0, ok: 0, fail: 0, skipped: 0,
    startedAt: new Date().toISOString(), finishedAt: null, lastMessage: "starting downloads",
  });

  // ---- skip what Webflow cannot accept (videos) before downloading gigabytes ----
  let skipped = 0;
  for (const [sourceUrl] of pending) {
    const reason = skipReason(classify(sourceUrl), null);
    if (reason) {
      errors[sourceUrl] = { phase: "skipped", code: reason.code, message: reason.message, sourceUrl, at: new Date().toISOString() };
      audit({ stage: "migrate:skip", oldUrl: sourceUrl, error: `${reason.code}: ${reason.message}` });
      pending.delete(sourceUrl);
      skipped++;
    }
  }
  saveErrors(errors);
  migrateProgress.skipped = skipped;
  if (skipped) console.log(`  ${skipped} asset(s) skipped up front (videos — not supported by Webflow assets).`);

  // ---- PHASE 1: download everything first ----
  console.log("\nPhase 1/2 — downloading all sources to workspace/cache/ …");
  const downloaded = new Map<string, { path: string; bytes: number }>();
  let dOk = 0;
  let dFail = 0;
  for (const [sourceUrl] of pending) {
    try {
      const d = await download(sourceUrl);
      downloaded.set(sourceUrl, d);
      delete errors[sourceUrl];
      audit({ stage: "migrate:download", oldUrl: sourceUrl, note: `${d.bytes} bytes${d.cached ? " (cache hit)" : ""}` });
      dOk++;
      if (dOk % 100 === 0) console.log(`  downloaded ${dOk}/${pending.size}`);
    } catch (err) {
      recordError(errors, sourceUrl, "download", err);
      dFail++;
    }
    migrateProgress.done = dOk + dFail;
    migrateProgress.ok = dOk;
    migrateProgress.fail = dFail;
    migrateProgress.lastMessage = `downloading ${dOk + dFail}/${pending.size}`;
  }
  saveErrors(errors);
  console.log(`  downloads: ${dOk} ok, ${dFail} failed (details in workspace/migrate-errors.json)`);

  // ---- size-based skips now that real byte counts are known ----
  for (const [sourceUrl, file] of downloaded) {
    const reason = skipReason(classify(sourceUrl), file.bytes);
    if (reason) {
      errors[sourceUrl] = { phase: "skipped", code: reason.code, message: reason.message, sourceUrl, at: new Date().toISOString() };
      audit({ stage: "migrate:skip", oldUrl: sourceUrl, error: `${reason.code}: ${reason.message}` });
      downloaded.delete(sourceUrl);
      skipped++;
    }
  }
  saveErrors(errors);
  migrateProgress.skipped = skipped;

  // ---- PHASE 2: upload into typed folders ----
  console.log(`\nPhase 2/2 — uploading into "${PARENT_FOLDER_NAME}"/<type> …`);
  Object.assign(migrateProgress, { phase: "upload", total: downloaded.size, done: 0, ok: 0, fail: 0, lastMessage: "preparing folders" });
  const types = new Set([...downloaded.keys()].map(classify));
  let folderMap: Map<string, { id: string; name: string }>;
  try {
    folderMap = await ensureFolders(types);
  } catch (err) {
    const e = err as WebflowError;
    console.error(`  ✗ cannot prepare asset folders: ${e.status ?? ""} ${e.code ?? ""} ${e.message}`);
    audit({ stage: "migrate:folders", error: `${e.status} ${e.code} ${e.message}` });
    Object.assign(migrateProgress, { running: false, phase: "done", finishedAt: new Date().toISOString(), lastMessage: `folder error: ${e.message}` });
    process.exitCode = 1;
    return;
  }

  let uOk = 0;
  let uFail = 0;
  for (const [sourceUrl, file] of downloaded) {
    const type = classify(sourceUrl);
    const folder = folderMap.get(type)!;
    try {
      const data = readFileSync(file.path);
      const fileName = assetFileName(sourceUrl);
      const created = await createAssetMeta(env.webflowSiteId, fileName, createHash("md5").update(data).digest("hex"), folder.id);
      await uploadAssetFile(created, data, fileName);
      const hostedUrl = created.hostedUrl ?? created.assetUrl;
      if (!hostedUrl) throw new WebflowError(0, "NO_HOSTED_URL", "Webflow response had no hostedUrl");
      const entry: UrlMapEntry & { oldUrls: string[]; type: string; folder: string; bytes: number } = {
        newUrl: hostedUrl,
        assetId: created.id,
        sourceUrl,
        oldUrls: [...pending.get(sourceUrl)!],
        type,
        folder: `${PARENT_FOLDER_NAME}/${folder.name}`,
        bytes: file.bytes,
        migratedAt: new Date().toISOString(),
      };
      urlMap[sourceUrl] = entry;
      saveUrlMap(urlMap); // persist after every asset so a crash loses nothing
      delete errors[sourceUrl];
      audit({ stage: "migrate:upload", oldUrl: sourceUrl, newUrl: hostedUrl, assetId: created.id, note: `${folder.name}, ${file.bytes} bytes` });
      uOk++;
      if (uOk % 50 === 0) console.log(`  uploaded ${uOk}/${downloaded.size}`);
    } catch (err) {
      recordError(errors, sourceUrl, "upload", err);
      uFail++;
    }
    migrateProgress.done = uOk + uFail;
    migrateProgress.ok = uOk;
    migrateProgress.fail = uFail;
    migrateProgress.lastMessage = `uploading ${uOk + uFail}/${downloaded.size}`;
  }
  saveErrors(errors);

  // propagate mappings onto plan entries
  for (const e of plan) {
    if (e.action !== "rehost" || !e.sourceUrl) continue;
    const mapped = urlMap[e.sourceUrl];
    if (mapped) {
      e.newUrl = mapped.newUrl;
      e.assetId = mapped.assetId;
      if (e.status === "planned") e.status = "migrated";
      e.error = undefined;
    } else if (!e.newUrl) {
      const me = errors[e.sourceUrl];
      e.status = me?.phase === "skipped" ? "skipped" : "failed";
      e.error = me ? `${me.phase}: ${me.status ?? ""} ${me.code ?? ""} ${me.message}`.trim() : "asset migration failed";
    }
  }
  savePlan(plan);

  Object.assign(migrateProgress, {
    running: false, phase: "done", finishedAt: new Date().toISOString(),
    lastMessage: `uploaded ${uOk}, failed ${uFail + dFail}, skipped ${skipped}`,
  });
  console.log(`\nDone. Uploaded ${uOk}, skipped ${skipped}, failed ${uFail + dFail} (downloads ${dFail}, uploads ${uFail}).`);
  console.log("Failures/skips with status/code/message: workspace/migrate-errors.json — re-running migrate retries only failures.");
  console.log("Next: pnpm verify");
}
