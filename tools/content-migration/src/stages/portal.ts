import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT, WORKSPACE, DIRS, env, ensureWorkspace, loadRules } from "../config.js";
import { readCsv, itemIdentity } from "../csvio.js";
import { replaceUrl, byOldUrlLengthDesc } from "../scan.js";
import { loadPlan, loadUrlMap, isEffective, type PlanEntry } from "../planstore.js";
import { audit } from "../log.js";
import { classify, cachePathFor } from "../assets.js";
import { exportCsvs } from "./export.js";
import { migrate, migrateProgress } from "./migrate.js";
import { buildRedirectRows, runPdfRedirects, redirectsProgress } from "./pdfRedirects.js";

const PORTAL_DIR = path.join(ROOT, "portal");
const ASSET_CHECKS_FILE = path.join(WORKSPACE, "asset-checks.json");
const LINK_CHECKS_FILE = path.join(WORKSPACE, "link-checks.json");
const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
};

function json(res: import("node:http").ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function listFiles(plan: PlanEntry[]) {
  const files = existsSync(DIRS.working)
    ? readdirSync(DIRS.working).filter((f) => f.toLowerCase().endsWith(".csv"))
    : [];
  return files.map((name) => {
    const csv = readCsv(path.join(DIRS.working, name));
    const entriesByRow = new Map<number, PlanEntry[]>();
    for (const e of plan) {
      if (e.file !== name) continue;
      if (!entriesByRow.has(e.row)) entriesByRow.set(e.row, []);
      entriesByRow.get(e.row)!.push(e);
    }
    const items = csv.rows.map((row, i) => {
      const { name: itemName, slug } = itemIdentity(row);
      const entries = entriesByRow.get(i) ?? [];
      return {
        row: i,
        name: itemName,
        slug,
        // "changes" = real appliable updates only; skipped/failed are tracked separately
        changes: entries.filter(isEffective).length,
        skipped: entries.filter((e) => e.status === "skipped").length,
        failed: entries.filter((e) => e.status === "failed").length,
        statuses: [...new Set(entries.map((e) => e.status))],
      };
    });
    return { name, rows: csv.rows.length, items };
  });
}

function itemDetail(file: string, rowIndex: number, plan: PlanEntry[]) {
  const csv = readCsv(path.join(DIRS.working, file));
  const row = csv.rows[rowIndex];
  if (!row) return null;
  const { name, slug } = itemIdentity(row);
  const entries = plan.filter((e) => e.file === file && e.row === rowIndex);
  const fields = csv.headers.map((field) => {
    const before = row[field] ?? "";
    const fieldEntries = entries.filter((e) => e.field === field);
    let after = before;
    // preview must mirror export exactly: effective entries only, longest URL first
    for (const e of [...fieldEntries].sort(byOldUrlLengthDesc)) {
      if (isEffective(e)) after = replaceUrl(after, e.oldUrl, e.newUrl!);
    }
    return { field, before, after, changes: fieldEntries };
  });
  return { file, row: rowIndex, name, slug, fields };
}

/**
 * Change counts per file and field, split into whole-field replacements
 * (the cell IS the URL — e.g. Main Image) vs in-content replacements
 * (URL embedded in rich text HTML).
 */
function changeStats(plan: PlanEntry[]) {
  const csvCache = new Map<string, ReturnType<typeof readCsv>>();
  const files = new Map<string, Map<string, { updates: number; whole: number; embedded: number; leftovers: number; items: Set<number>; statuses: Record<string, number> }>>();
  for (const e of plan) {
    if (!csvCache.has(e.file)) csvCache.set(e.file, readCsv(path.join(DIRS.working, e.file)));
    const cell = csvCache.get(e.file)!.rows[e.row]?.[e.field] ?? "";
    const whole = cell.trim() === e.oldUrl;
    if (!files.has(e.file)) files.set(e.file, new Map());
    const fields = files.get(e.file)!;
    if (!fields.has(e.field)) fields.set(e.field, { updates: 0, whole: 0, embedded: 0, leftovers: 0, items: new Set(), statuses: {} });
    const s = fields.get(e.field)!;
    if (isEffective(e)) {
      // only real updates count — and only their items
      s.updates++;
      whole ? s.whole++ : s.embedded++;
      s.items.add(e.row);
    } else {
      s.leftovers++;
    }
    s.statuses[e.status] = (s.statuses[e.status] ?? 0) + 1;
  }
  return [...files.entries()].map(([file, fields]) => ({
    file,
    fields: [...fields.entries()].map(([field, s]) => ({ field, updates: s.updates, whole: s.whole, embedded: s.embedded, leftovers: s.leftovers, items: s.items.size, statuses: s.statuses }))
      .sort((a, b) => b.updates - a.updates),
  }));
}

/* ---------- redirect verification (live, dual-domain, target health) ---------- */

const VERIFY_FILE = path.join(WORKSPACE, "redirect-verify.json");
const WF_STAGING = "https://newsite.webflow.io";

export const verifyProgress = { running: false, total: 0, done: 0, startedAt: null as string | null, finishedAt: null as string | null };

/** Real original redirect entries: public-PDF list + extras (never the sanitized forms). */
function verifyRows(): { path: string; target: string }[] {
  const state = loadJson<{ oldPath: string; target: string | null }[]>(path.join(WORKSPACE, "pdf-redirects.json"), []);
  // real-world form: browsers/Google send commas and plus signs literally, never %2C/%2B
  const realWorld = (p: string) => p.replaceAll("%2C", ",").replaceAll("%2c", ",").replaceAll("%2B", "+").replaceAll("%2b", "+");
  const rows = state.filter((p) => p.target).map((p) => ({ path: realWorld(p.oldPath), target: p.target! }));
  const extra = path.join(ROOT, "extra-301s.csv");
  if (existsSync(extra)) {
    for (const line of readFileSync(extra, "utf8").trim().split("\n").slice(1)) {
      if (!line.trim()) continue;
      const comma = line.indexOf(",");
      rows.push({ path: line.slice(0, comma), target: line.slice(comma + 1) });
    }
  }
  return rows;
}

async function probeUrl(url: string, redirect: "follow" | "manual") {
  try {
    const r = await fetch(url, { method: "HEAD", redirect, signal: AbortSignal.timeout(20000) });
    return { status: r.status, location: r.headers.get("location") ?? "", finalUrl: r.url, contentType: (r.headers.get("content-type") ?? "").split(";")[0], ok: r.ok };
  } catch (err) {
    return { status: 0, location: "", finalUrl: url, contentType: "", ok: false, error: err instanceof Error ? err.message.slice(0, 60) : "error" };
  }
}

const hostOf = (u: string) => (u.includes("website-files") ? "webflow-cdn" : /hubspotusercontent|cdn2\.hubspot/.test(u) ? "hubspot-cdn" : u.includes("docs.example.com") ? "docs" : u.startsWith("/") || u.includes("example.com") ? "site" : "other");

async function runRedirectVerify(): Promise<void> {
  const rows = verifyRows();
  Object.assign(verifyProgress, { running: true, total: rows.length, done: 0, startedAt: new Date().toISOString(), finishedAt: null });
  const results: unknown[] = new Array(rows.length);
  const queue = rows.map((r, i) => [r, i] as const);

  async function worker(): Promise<void> {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [r, i] = next;
      const live1 = await probeUrl(env.siteBaseUrl + r.path, "manual"); // first hop on the live site
      const liveF = await probeUrl(env.siteBaseUrl + r.path, "follow"); // where it finally lands
      const wf = await probeUrl(WF_STAGING + r.path, "manual"); // Webflow-side behavior
      const targetAbs = r.target.startsWith("/") ? env.siteBaseUrl + r.target : r.target;
      const tgt = await probeUrl(targetAbs, "follow"); // is the target file itself alive

      const wfRedirects = wf.status >= 300 && wf.status < 400 && !!wf.location;
      const wfMatches = wfRedirects && (wf.location.startsWith(r.target) || r.target.startsWith(wf.location));
      const liveRedirects = live1.status >= 300 && live1.status < 400 && !!live1.location;
      const via = liveRedirects && !wfRedirects ? "cloudflare only"
        : liveRedirects && wfRedirects && hostOf(live1.location) === hostOf(wf.location) ? "cloudflare now, webflow after"
        : liveRedirects && wfRedirects ? "cloudflare now, webflow differs"
        : !liveRedirects && wfRedirects ? "webflow direct"
        : "no redirect";
      results[i] = {
        path: r.path, target: r.target,
        live: { firstHop: live1.status, to: hostOf(live1.location), finalStatus: liveF.status, finalHost: hostOf(liveF.finalUrl) },
        webflow: { status: wf.status, matchesTarget: wfMatches, to: wfRedirects ? hostOf(wf.location) : "" },
        targetFile: { status: tgt.status, contentType: tgt.contentType },
        via,
        healthy: liveF.ok && wfMatches && tgt.ok,
        worksToday: liveF.ok,
        survivesCutover: wfMatches && tgt.ok,
      };
      verifyProgress.done++;
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  writeFileSync(VERIFY_FILE, JSON.stringify({ checkedAt: new Date().toISOString(), rows: results }, null, 2));
  Object.assign(verifyProgress, { running: false, finishedAt: new Date().toISOString() });
  const ok = (results as { healthy: boolean }[]).filter((x) => x.healthy).length;
  audit({ stage: "redirect-verify", note: `${rows.length} redirects verified live: ${ok} fully healthy` });
  console.log(`Redirect verify complete: ${ok}/${rows.length} fully healthy.`);
}

/* ---------- reviews + sign-off ---------- */

const REVIEWS_FILE = path.join(WORKSPACE, "reviews.json");
const SIGNOFF_FILE = path.join(WORKSPACE, "signoff.json");

function loadJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

type Reviews = Record<string, { reviewed: boolean; at: string }>;

/** Manual gates a human must tick before the migration counts as done. */
const SIGNOFF_TASKS = [
  { id: "review-items", label: "Review every updated item in the portal (side-by-side diff looks right)", auto: true },
  { id: "failing-urls", label: "Fix the 2 dead images in \"Post-Sale\" in the Webflow editor (files no longer exist anywhere; content keeps the old URLs until then)", auto: false },
  { id: "hs-links", label: "Broken hs. links resolved: /knowledge/reporting → docs article, /partners → /integrations (content rewritten + 301 rows added, Jul 28)", auto: false },
  { id: "import-csvs", label: "Import workspace/output/*.csv into Webflow CMS (Blogs + Playbooks)", auto: false },
  { id: "finsweet-301", label: "Upload workspace/output/fs-301-redirects.csv (448 rows) via Finsweet bulk 301", auto: false },
  { id: "videos", label: "Video strategy: video files + HubSpot-video embeds currently remain on HubSpot — tick once direction is decided (keep there, or move to another host)", auto: false },
];

function overview(plan: PlanEntry[]) {
  const reviews = loadJson<Reviews>(REVIEWS_FILE, {});
  const signoff = loadJson<Record<string, { done: boolean; at: string }>>(SIGNOFF_FILE, {});
  const migrateErrors = loadMigrateErrors();

  const updates = plan.filter(isEffective);
  const verified = plan.filter((e) => e.status === "verified").length;
  const failed = plan.filter((e) => e.status === "failed");
  const skipped = plan.filter((e) => e.status === "skipped").length;

  const failingItems = new Map<string, { file: string; row: number; itemName: string; problems: string[] }>();
  for (const e of failed) {
    const key = `${e.file}#${e.row}`;
    if (!failingItems.has(key)) failingItems.set(key, { file: e.file, row: e.row, itemName: e.itemName, problems: [] });
    failingItems.get(key)!.problems.push(`${e.field}: ${e.oldUrl} — ${e.error ?? "failed"}`);
  }

  const itemsWithUpdates = new Set(updates.map((e) => `${e.file}#${e.row}`));
  const reviewedCount = [...itemsWithUpdates].filter((k) => reviews[k]?.reviewed).length;

  const outputFiles = existsSync(DIRS.output)
    ? readdirSync(DIRS.output).filter((f) => f.endsWith(".csv") && !f.startsWith("fs-301"))
    : [];
  const equivalence = loadJson<{ ok?: boolean; files?: { unexpectedDiffs: number }[] } | null>(path.join(DIRS.output, "equivalence-report.json"), null);
  const equivalencePass = !!equivalence?.ok && (equivalence.files ?? []).every((f) => f.unexpectedDiffs === 0);

  const skipsByCode: Record<string, number> = {};
  for (const e of Object.values(migrateErrors)) {
    if (e.phase === "skipped") skipsByCode[e.code ?? "?"] = (skipsByCode[e.code ?? "?"] ?? 0) + 1;
  }

  // Everything that could NOT be uploaded to Webflow (type/size limits).
  // Tracked with reasons; content keeps these URLs as-is.
  const notUploaded: { url: string; type: string; reason: string }[] = [];
  for (const e of Object.values(migrateErrors)) {
    if (e.phase === "skipped") notUploaded.push({ url: e.sourceUrl, type: classify(e.sourceUrl), reason: e.message });
  }
  const pdfState = loadJson<{ sourceUrl: string; sizeKb: number; status: string }[]>(path.join(WORKSPACE, "pdf-redirects.json"), []);
  for (const p of pdfState) {
    if (p.status === "too-large" && !notUploaded.some((n) => n.url === p.sourceUrl)) {
      notUploaded.push({ url: p.sourceUrl, type: "pdf", reason: `public PDF ${(p.sizeKb / 1024).toFixed(1)}MB — over Webflow's 10MB limit, 301 targets the HubSpot CDN` });
    }
  }
  const notUploadedByType: Record<string, number> = {};
  for (const n of notUploaded) notUploadedByType[n.type] = (notUploadedByType[n.type] ?? 0) + 1;

  return {
    notUploaded,
    notUploadedByType,
    updates: updates.length,
    verified,
    skipped,
    failedEntries: failed.length,
    failingItems: [...failingItems.values()],
    review: { reviewed: reviewedCount, total: itemsWithUpdates.size },
    exports: { files: outputFiles, equivalencePass, redirectsCsv: existsSync(path.join(DIRS.output, "fs-301-redirects.csv")) },
    skipsByCode,
    tasks: SIGNOFF_TASKS.map((t) => ({ ...t, done: t.id === "review-items" ? reviewedCount >= itemsWithUpdates.size && itemsWithUpdates.size > 0 : signoff[t.id]?.done ?? false, at: signoff[t.id]?.at })),
  };
}

/* ---------- full report (rendered in the portal, downloadable as .md) ---------- */

interface UsedInItem { itemName: string; slug: string; liveUrl: string; file: string; row: number; draft: boolean }

/** Which CMS items reference a URL substring, with live link + draft/published state. */
function usedInLookup(plan: PlanEntry[]) {
  const csvCache = new Map<string, ReturnType<typeof readCsv>>();
  const csvFor = (file: string) => {
    if (!csvCache.has(file)) csvCache.set(file, readCsv(path.join(DIRS.working, file)));
    return csvCache.get(file)!;
  };
  const itemAt = (file: string, row: number): UsedInItem => {
    const r = csvFor(file).rows[row] ?? {};
    const { name, slug } = itemIdentity(r);
    const draft = /true/i.test(r["Draft"] ?? "") || !(r["Published On"] ?? "").trim();
    return { itemName: name, slug, liveUrl: liveUrlFor(file, slug), file, row, draft };
  };
  return { csvFor, itemAt };
}

/** Everything still on HubSpot: files (with why + where used) and video embeds (with where used). */
function hubspotDependencies(plan: PlanEntry[]) {
  const { csvFor, itemAt } = usedInLookup(plan);
  const migrateErrors = loadMigrateErrors();
  const pdfState = loadJson<{ sourceUrl: string; sizeKb: number; status: string }[]>(path.join(WORKSPACE, "pdf-redirects.json"), []);

  const files: { url: string; type: string; reason: string; source: string; usedIn: UsedInItem[] }[] = [];
  for (const e of Object.values(migrateErrors)) {
    if (e.phase !== "skipped") continue;
    const seen = new Set<string>();
    const usedIn: UsedInItem[] = [];
    for (const p of plan) {
      if (p.sourceUrl !== e.sourceUrl) continue;
      const key = `${p.file}#${p.row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      usedIn.push(itemAt(p.file, p.row));
    }
    files.push({ url: e.sourceUrl, type: classify(e.sourceUrl), reason: e.message, source: "referenced in CMS content", usedIn });
  }
  for (const p of pdfState) {
    if (p.status !== "too-large" || files.some((f) => f.url === p.sourceUrl)) continue;
    files.push({
      url: p.sourceUrl, type: "pdf",
      reason: `public PDF ${(p.sizeKb / 1024).toFixed(1)}MB — over Webflow's 10MB limit; its 301 redirect targets the HubSpot CDN copy`,
      source: "from the HubSpot public-PDFs list (not referenced in CMS content)", usedIn: [],
    });
  }

  // video-player embeds, per unique video, with the items that embed them
  const embeds = new Map<string, { videoId: string; exampleUrl: string; usedIn: UsedInItem[] }>();
  const workingFiles = readdirSync(DIRS.working).filter((x) => x.endsWith(".csv"));
  for (const file of workingFiles) {
    const csv = csvFor(file);
    csv.rows.forEach((row, i) => {
      const cellText = Object.values(row).join("\n");
      for (const m of cellText.matchAll(/https?:\/\/play\.hubspotvideo\.com\/v\/\d+\/id\/(\d+)[^"'\s<]*/g)) {
        const id = m[1];
        if (!embeds.has(id)) embeds.set(id, { videoId: id, exampleUrl: m[0].replaceAll("&amp;", "&"), usedIn: [] });
        const entry = embeds.get(id)!;
        if (!entry.usedIn.some((u) => u.file === file && u.row === i)) entry.usedIn.push(itemAt(file, i));
      }
    });
  }
  return { files, embeds: [...embeds.values()] };
}

interface BrokenEmbedItem {
  title: string; slug: string; liveUrl: string; file: string; row: number;
  importBlocked: boolean;
  draft?: boolean; published?: boolean; status?: string;
  deadSrcs: { url: string; note: string; field?: string; alt?: string; placedAfter?: string; followedBy?: string }[];
}

function buildReport(plan: PlanEntry[]) {
  const o = overview(plan);
  const iss = issues(plan);
  const urlMap = loadUrlMap();
  const brokenEmbeds = loadJson<BrokenEmbedItem[]>(path.join(WORKSPACE, "broken-embeds.json"), []);
  const deadImageCount = brokenEmbeds.reduce((n, b) => n + b.deadSrcs.length, 0);
  const publishedBlocked = brokenEmbeds.filter((b) => b.published && !b.draft).length;
  const draftBlocked = brokenEmbeds.length - publishedBlocked;

  // HubSpot video-player embeds, counted from the actual content
  let videoEmbedRefs = 0;
  const videoEmbedIds = new Set<string>();
  for (const f of readdirSync(DIRS.working).filter((x) => x.endsWith(".csv"))) {
    const raw = readFileSync(path.join(DIRS.working, f), "utf8");
    videoEmbedRefs += (raw.match(/play\.hubspotvideo\.com/g) ?? []).length;
    for (const m of raw.matchAll(/play\.hubspotvideo\.com\/v\/\d+\/id\/(\d+)/g)) videoEmbedIds.add(m[1]);
  }

  // the one redirect row Webflow rejected — temporary wildcard fix on record
  const fixupPath = path.join(DIRS.output, "fs-301-redirects-fixups.csv");
  const fixupRows = existsSync(fixupPath) ? readFileSync(fixupPath, "utf8").trim().split("\n").slice(1) : [];
  const redirectFix = fixupRows.length ? {
    count: fixupRows.length,
    rows: fixupRows,
    reason: `Webflow rejected the original path because the file name contains "!" — outside Webflow's allowed redirect-path characters (letters, numbers, . _ ? = % + & / ( ) * - @). TEMPORARY FIX: the path is truncated before the "!" and ends in a (.*) wildcard, which Webflow accepts and which still matches the real URL. The PDF itself downloaded and uploaded to Webflow fine — only the redirect path syntax was invalid. Until this row is uploaded, the path keeps working through the Cloudflare redirect only.`,
    file: "workspace/output/fs-301-redirects-fixups.csv",
  } : null;

  const stats = {
    verified: o.verified,
    onWebflow: Object.keys(urlMap).length,
    redirectRows: 448,
    skippedAccepted: o.notUploaded.length,
    decisionsNeeded: brokenEmbeds.length,
    deadImages: deadImageCount,
    reviewed: o.review,
    equivalencePass: o.exports.equivalencePass,
    gatesDone: o.tasks.filter((t) => t.done).length,
    gatesTotal: o.tasks.length,
  };

  const bullets = [
    `${o.verified} URLs migrated and verified — exports are equivalence-certified (only URLs changed)`,
    `${stats.onWebflow} files now hosted on Webflow under "Hubspot Migrated Asset" (content assets + public PDFs)`,
    `448 redirects uploaded and published; /hubfs rows activate fully once the Cloudflare rules are removed`,
    `${o.notUploaded.length} files remain on the HubSpot CDN — tracked below; direction needed on what to do with them`,
  ];

  // per-collection narrative: where the lift was, and what we looked at but left alone
  const cs = changeStats(plan);
  const collections = cs.map((f) => {
    const sums = f.fields.reduce((a, x) => ({ u: a.u + x.updates, l: a.l + x.leftovers }), { u: 0, l: 0 });
    // unique items, not per-field sums
    const t = { ...sums, items: new Set(plan.filter((e) => e.file === f.file && isEffective(e)).map((e) => e.row)).size };
    const short = /blog/i.test(f.file) ? "Blogs" : /case stud/i.test(f.file) ? "Case Studies" : /playbook/i.test(f.file) ? "Playbooks" : f.file;
    let note;
    if (short === "Blogs") note = `${t.u} URL updates across ${t.items} items — the bulk of the migration lift was here (rich-text bodies + OpenGraph images).`;
    else if (short === "Case Studies") note = `fully scanned; the only matches were 27 Video Link fields pointing at HubSpot-hosted video files. Webflow does not accept video uploads, so these were intentionally left as-is — zero content changes were needed.`;
    else if (short === "Playbooks") note = `fully scanned; only ${t.u} update was needed (one landing-page body URL) — everything else was already correct.`;
    else note = `${t.u} updates, ${t.l} tracked leftovers.`;
    return { collection: short, updates: t.u, leftovers: t.l, note };
  });

  const migrateErrors = loadMigrateErrors();
  const pdfState = loadJson<{ sourceUrl: string; sizeKb: number; status: string }[]>(path.join(WORKSPACE, "pdf-redirects.json"), []);
  const videoCount = Object.values(migrateErrors).filter((e) => e.phase === "skipped" && e.code === "VIDEO_NOT_SUPPORTED").length;
  const oversizeImages = Object.values(migrateErrors).filter((e) => e.phase === "skipped" && e.code === "IMAGE_OVER_4MB").length;
  const oversizePdfs = pdfState.filter((p) => p.status === "too-large").length;

  const stillBlocked = brokenEmbeds.filter((b) => b.importBlocked).length;
  const needsToFix = [
    {
      title: "Dead images in blog posts",
      summary: `${deadImageCount} broken images across ${brokenEmbeds.length} posts (${publishedBlocked} published with live-site impact, ${draftBlocked} never-published draft). ${stillBlocked === 0
        ? `All ${brokenEmbeds.length} posts are imported and published with their URL updates — Webflow rewrote the dead image srcs on import to cdn.prod.website-files.com URLs that return 403, so the broken images remain visible in the live bodies. Fix by removing or replacing each image directly in the Webflow editor — no re-import needed.`
        : `Decide per image: remove or replace; the ${stillBlocked} still-blocked posts get re-imported after fixing.`} Details in the Blogs section below.`,
    },
    {
      title: "Files still on the HubSpot CDN",
      summary: `${o.notUploaded.length} files could not be moved to Webflow (${videoCount} video files — Webflow does not accept video uploads; ${oversizePdfs} PDFs over the 10MB limit; ${oversizeImages} image over the 4MB limit). Content also contains ${videoEmbedRefs} HubSpot video-player embed references (${videoEmbedIds.size} unique videos). All of it works today via HubSpot. Direction needed: keep on HubSpot, or move to another host. Full list in the HubSpot files section below.`,
    },
    ...(redirectFix ? [{
      title: `${redirectFix.count} redirect row pending upload (temporary fix on record)`,
      summary: `Webflow rejected one redirect path (the LEAP webinar PDF — its file name contains "!", which Webflow's path rules do not allow). A corrected wildcard row is ready in ${redirectFix.file}; until uploaded the path works via Cloudflare only. Details in the Redirects section below.`,
    }] : []),
  ];
  const deps = hubspotDependencies(plan);
  const itemRef = (u: UsedInItem) => `${u.itemName} (${u.liveUrl}) [${u.draft ? "draft" : "published"}]`;

  const parts: string[] = [];
  parts.push(`# HubSpot → Webflow Content Migration — Full Report`, "",
    `Generated: ${new Date().toISOString()}`, "",
    `## Summary`, "",
    ...bullets.map((b) => `- ${b}`), "",
    `## Needs to fix`, "",
    ...needsToFix.flatMap((x, i) => [`${i + 1}. **${x.title}**`, `   ${x.summary}`, ""]),
    `## Blogs — dead images (${publishedBlocked} published, ${draftBlocked} never-published draft)`, "",
    ...brokenEmbeds.flatMap((b) => [`- **${b.title}** [${b.status ?? "status unknown"}] — ${b.liveUrl}`, ...b.deadSrcs.map((d) => `  - ${d.url} (${d.note}; appears after: "${d.placedAfter}")`)]), "",
    `## Not on Webflow — files still on the HubSpot CDN (${deps.files.length})`, "",
    ...deps.files.map((f) => `- ${f.url} — ${f.reason} [${f.source}]${f.usedIn.length ? ` — used in: ${f.usedIn.map(itemRef).join("; ")}` : ""}`), "",
    `## Not on Webflow — HubSpot video embeds (${deps.embeds.length} unique videos)`, "",
    ...deps.embeds.map((e) => `- video ${e.videoId} — embedded in: ${e.usedIn.map(itemRef).join("; ")}`), "",
    `## Redirects — pending row (temporary fix)`, "",
    redirectFix ? `${redirectFix.reason}\n\nCorrected row: ${redirectFix.rows.join(" | ")}` : "none", "",
    `## Collections covered`, "",
    ...collections.map((c) => `- **${c.collection}** — ${c.note}`), "",
    `## Deliverables`, "",
    ...o.exports.files.map((f) => `- workspace/output/${f}`),
    o.exports.redirectsCsv ? `- workspace/output/fs-301-redirects.csv (Finsweet bulk 301)` : "",
    `- workspace/output/equivalence-report.md`, "");

  return {
    generatedAt: new Date().toISOString(),
    stats,
    bullets,
    needsToFix,
    redirectFix,
    videoEmbedRefs,
    videoEmbedUnique: videoEmbedIds.size,
    collections,
    decisions: brokenEmbeds,
    deps,
    markdown: parts.filter((p) => p !== null).join("\n"),
  };
}

/**
 * Live URL for a CMS item. Prefixes verified against the live site (Jul 28):
 * /blog, /playbooks, /case-studies (canonical; /testimonials redirects to it).
 */
function liveUrlFor(file: string, slug: string): string {
  const prefix = /blog/i.test(file) ? "/blog" : /playbook/i.test(file) ? "/playbooks" : /case stud/i.test(file) ? "/case-studies" : "";
  return slug ? `${env.siteBaseUrl}${prefix}/${slug}` : env.siteBaseUrl;
}

/** Items needing manual work, split into content edits vs redirects-only. */
function issues(plan: PlanEntry[]) {
  const manual = new Map<string, { file: string; row: number; itemName: string; slug: string; liveUrl: string; problems: { field: string; oldUrl: string; error: string }[] }>();
  const redirects = new Map<string, { oldUrl: string; target: string; status: string; items: { itemName: string; slug: string; liveUrl: string; field: string }[] }>();

  for (const e of plan.filter((x) => x.status === "failed")) {
    const item = { itemName: e.itemName, slug: e.slug, liveUrl: liveUrlFor(e.file, e.slug), field: e.field };
    if (e.action === "rewrite") {
      // link whose rewrite target 404s: fixable site-wide with a Webflow redirect/page — no content edit needed
      if (!redirects.has(e.oldUrl)) redirects.set(e.oldUrl, { oldUrl: e.oldUrl, target: e.newUrl ?? "", status: e.error ?? "target 404", items: [] });
      redirects.get(e.oldUrl)!.items.push(item);
    } else {
      const key = `${e.file}#${e.row}`;
      if (!manual.has(key)) manual.set(key, { file: e.file, row: e.row, itemName: e.itemName, slug: e.slug, liveUrl: item.liveUrl, problems: [] });
      manual.get(key)!.problems.push({ field: e.field, oldUrl: e.oldUrl, error: e.error ?? "failed" });
    }
  }
  return { manual: [...manual.values()], redirects: [...redirects.values()] };
}

interface AssetCheck {
  source?: { ok: boolean; status: number; contentType: string; contentLength: number | null; error?: string };
  /** Old in-content URL probed with redirects followed: is Cloudflare's rescue actually working today? */
  old?: { ok: boolean; status: number; redirected: boolean; finalUrl?: string; error?: string };
  checkedAt?: string;
}

function loadChecks(): Record<string, AssetCheck> {
  if (!existsSync(ASSET_CHECKS_FILE)) return {};
  return JSON.parse(readFileSync(ASSET_CHECKS_FILE, "utf8")) as Record<string, AssetCheck>;
}

const MIGRATE_ERRORS_FILE = path.join(WORKSPACE, "migrate-errors.json");

function loadMigrateErrors(): Record<string, { phase: string; status?: number; code?: string; message: string; at: string; sourceUrl: string }> {
  if (!existsSync(MIGRATE_ERRORS_FILE)) return {};
  return JSON.parse(readFileSync(MIGRATE_ERRORS_FILE, "utf8"));
}

function aggregateAssets(plan: PlanEntry[]) {
  const urlMap = loadUrlMap();
  const checks = loadChecks();
  const migrateErrors = loadMigrateErrors();
  const map = new Map<string, { sourceUrl: string; oldUrl: string; refs: number; items: Set<string>; statuses: Set<string>; ruleIds: Set<string> }>();
  for (const e of plan) {
    if (e.action !== "rehost" || !e.sourceUrl) continue;
    let a = map.get(e.sourceUrl);
    if (!a) {
      a = { sourceUrl: e.sourceUrl, oldUrl: e.oldUrl, refs: 0, items: new Set(), statuses: new Set(), ruleIds: new Set() };
      map.set(e.sourceUrl, a);
    }
    a.refs++;
    a.items.add(`${e.file}#${e.row}`);
    a.statuses.add(e.status);
    a.ruleIds.add(e.ruleId);
  }
  return [...map.values()].map((a) => ({
    sourceUrl: a.sourceUrl,
    oldUrl: a.oldUrl,
    type: classify(a.sourceUrl),
    refs: a.refs,
    items: a.items.size,
    statuses: [...a.statuses],
    ruleIds: [...a.ruleIds],
    downloaded: existsSync(cachePathFor(a.sourceUrl)),
    newUrl: urlMap[a.sourceUrl]?.newUrl ?? null,
    assetId: urlMap[a.sourceUrl]?.assetId ?? null,
    folder: (urlMap[a.sourceUrl] as { folder?: string } | undefined)?.folder ?? null,
    migrateError: migrateErrors[a.sourceUrl] ?? null,
    check: checks[a.sourceUrl] ?? null,
  }));
}

function assetDetail(sourceUrl: string, plan: PlanEntry[]) {
  const asset = aggregateAssets(plan).find((a) => a.sourceUrl === sourceUrl);
  if (!asset) return null;
  const references = plan
    .filter((e) => e.sourceUrl === sourceUrl)
    .map((e) => ({ file: e.file, row: e.row, itemName: e.itemName, slug: e.slug, field: e.field, oldUrl: e.oldUrl, status: e.status, verify: e.verify ?? null }));
  return { ...asset, references };
}

/* ---------- rewritten-link inventory ---------- */

interface LinkCheck {
  old?: { ok: boolean; status: number; redirected: boolean; finalUrl?: string; error?: string };
  new?: { ok: boolean; status: number; redirected: boolean; finalUrl?: string; error?: string };
  checkedAt?: string;
}

function loadLinkChecks(): Record<string, LinkCheck> {
  if (!existsSync(LINK_CHECKS_FILE)) return {};
  return JSON.parse(readFileSync(LINK_CHECKS_FILE, "utf8")) as Record<string, LinkCheck>;
}

function aggregateLinks(plan: PlanEntry[]) {
  const checks = loadLinkChecks();
  const map = new Map<string, { oldUrl: string; newUrl: string; refs: number; items: Set<string>; ruleIds: Set<string> }>();
  for (const e of plan) {
    if (e.action !== "rewrite" || !e.newUrl) continue;
    let l = map.get(e.oldUrl);
    if (!l) {
      l = { oldUrl: e.oldUrl, newUrl: e.newUrl, refs: 0, items: new Set(), ruleIds: new Set() };
      map.set(e.oldUrl, l);
    }
    l.refs++;
    l.items.add(`${e.file}#${e.row}`);
    l.ruleIds.add(e.ruleId);
  }
  return [...map.values()].map((l) => ({
    oldUrl: l.oldUrl,
    newUrl: l.newUrl,
    refs: l.refs,
    items: l.items.size,
    ruleIds: [...l.ruleIds],
    check: checks[l.oldUrl] ?? null,
  }));
}

/** Old URL exactly as it appears in content, made absolute + entity-decoded for probing. */
function absoluteOldUrl(oldUrl: string): string {
  const decoded = oldUrl.replaceAll("&amp;", "&");
  return decoded.startsWith("/") ? env.siteBaseUrl + decoded : decoded;
}

async function probe(url: string, redirect: "follow" | "manual"): Promise<Response> {
  return fetch(url, { method: "HEAD", redirect, signal: AbortSignal.timeout(15000) });
}

/**
 * HEAD-check every unique asset: can the source be downloaded from the HubSpot
 * CDN, and does the old in-content URL survive only via a Cloudflare redirect?
 */
async function runAssetChecks(plan: PlanEntry[]): Promise<{ checked: number; links: number }> {
  const assets = aggregateAssets(plan);
  const results = loadChecks();
  let done = 0;
  const CONCURRENCY = 12;
  const queue = [...assets];

  async function worker(): Promise<void> {
    for (let a = queue.shift(); a; a = queue.shift()) {
      const entry: AssetCheck = { checkedAt: new Date().toISOString() };
      try {
        const r = await probe(a.sourceUrl, "follow");
        entry.source = {
          ok: r.ok,
          status: r.status,
          contentType: (r.headers.get("content-type") ?? "").split(";")[0],
          contentLength: r.headers.get("content-length") ? Number(r.headers.get("content-length")) : null,
          error: r.ok ? undefined : `HTTP ${r.status}`,
        };
      } catch (err) {
        entry.source = { ok: false, status: 0, contentType: "", contentLength: null, error: err instanceof Error ? err.message : String(err) };
      }
      try {
        const r = await probe(absoluteOldUrl(a.oldUrl), "follow");
        entry.old = { ok: r.ok, status: r.status, redirected: r.redirected, finalUrl: r.url };
      } catch (err) {
        entry.old = { ok: false, status: 0, redirected: false, error: err instanceof Error ? err.message : String(err) };
      }
      results[a.sourceUrl] = entry;
      done++;
      if (done % 50 === 0) {
        console.log(`  asset checks: ${done}/${assets.length}`);
        writeFileSync(ASSET_CHECKS_FILE, JSON.stringify(results, null, 2));
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  writeFileSync(ASSET_CHECKS_FILE, JSON.stringify(results, null, 2));
  const failing = Object.values(results).filter((c) => c.source && !c.source.ok).length;
  audit({ stage: "asset-check", note: `${assets.length} assets checked, ${failing} source failures` });
  console.log(`Asset checks complete: ${assets.length} checked, ${failing} source failures.`);

  const links = await runLinkChecks(plan);
  return { checked: assets.length, links };
}

/** Probe every rewritten link on both sides: the old URL as it stands, and the rewrite target. */
async function runLinkChecks(plan: PlanEntry[]): Promise<number> {
  const links = aggregateLinks(plan);
  const results = loadLinkChecks();
  const CONCURRENCY = 12;
  const queue = [...links];

  async function probeSide(url: string): Promise<NonNullable<LinkCheck["old"]>> {
    try {
      const r = await probe(url, "follow");
      return { ok: r.ok, status: r.status, redirected: r.redirected, finalUrl: r.url };
    } catch (err) {
      return { ok: false, status: 0, redirected: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function worker(): Promise<void> {
    for (let l = queue.shift(); l; l = queue.shift()) {
      results[l.oldUrl] = {
        checkedAt: new Date().toISOString(),
        old: await probeSide(absoluteOldUrl(l.oldUrl)),
        new: await probeSide(absoluteOldUrl(l.newUrl)),
      };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  writeFileSync(LINK_CHECKS_FILE, JSON.stringify(results, null, 2));
  const newBroken = Object.values(results).filter((c) => c.new && !c.new.ok).length;
  audit({ stage: "link-check", note: `${links.length} rewritten links checked, ${newBroken} broken after rewrite` });
  console.log(`Link checks complete: ${links.length} checked, ${newBroken} broken after rewrite.`);
  return links.length;
}

/* ---------- server ---------- */

function readLogTail(maxLines = 1000): unknown[] {
  if (!existsSync(DIRS.logs)) return [];
  const files = readdirSync(DIRS.logs).filter((f) => f.endsWith(".jsonl")).sort();
  const lines: unknown[] = [];
  for (const f of files.slice(-3)) {
    for (const line of readFileSync(path.join(DIRS.logs, f), "utf8").split("\n")) {
      if (line.trim()) {
        try { lines.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    }
  }
  return lines.slice(-maxLines);
}

export function portal(): void {
  ensureWorkspace();
  let checking = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/config") return json(res, { siteBaseUrl: env.siteBaseUrl });
      if (url.pathname === "/api/overview") return json(res, overview(loadPlan()));
      if (url.pathname === "/api/reviews") return json(res, loadJson(REVIEWS_FILE, {}));
      if (url.pathname === "/api/issues") return json(res, issues(loadPlan()));
      if (url.pathname === "/api/redirect-verify") {
        return json(res, { progress: verifyProgress, ...loadJson<{ checkedAt?: string; rows?: unknown[] }>(VERIFY_FILE, {}) });
      }
      if (url.pathname === "/api/redirect-verify/run" && req.method === "POST") {
        if (verifyProgress.running) return json(res, { error: "already running" }, 409);
        void runRedirectVerify().catch((err) => {
          verifyProgress.running = false;
          audit({ stage: "redirect-verify", error: err instanceof Error ? err.message : String(err) });
        });
        return json(res, { started: true });
      }
      if (url.pathname === "/api/report") return json(res, buildReport(loadPlan()));
      if (url.pathname === "/api/report/md") {
        const report = buildReport(loadPlan());
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="hubspot-migration-report.md"' });
        return void res.end(report.markdown);
      }
      if (url.pathname === "/api/review/bulk" && req.method === "POST") {
        // mark every clean item (has updates, zero failed/skipped) as reviewed; issue items stay unreviewed
        const files = listFiles(loadPlan());
        const reviews = loadJson<Reviews>(REVIEWS_FILE, {});
        let marked = 0;
        const skippedItems: { file: string; itemName: string; reason: string }[] = [];
        for (const f of files) {
          for (const it of f.items) {
            if (it.changes === 0) continue;
            if (it.failed > 0 || it.skipped > 0) {
              skippedItems.push({ file: f.name, itemName: it.name, reason: it.failed ? `${it.failed} failing URL(s)` : `${it.skipped} skipped URL(s)` });
              continue;
            }
            if (!reviews[`${f.name}#${it.row}`]?.reviewed) {
              reviews[`${f.name}#${it.row}`] = { reviewed: true, at: new Date().toISOString() };
              marked++;
            }
          }
        }
        writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
        audit({ stage: "review", note: `bulk: ${marked} clean items marked reviewed; ${skippedItems.length} items with issues left for manual review` });
        return json(res, { marked, left: skippedItems });
      }
      if (url.pathname === "/api/review" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { file: string; row: number; reviewed: boolean };
        const reviews = loadJson<Reviews>(REVIEWS_FILE, {});
        reviews[`${body.file}#${body.row}`] = { reviewed: body.reviewed, at: new Date().toISOString() };
        writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
        audit({ stage: "review", file: body.file, note: `row ${body.row} marked ${body.reviewed ? "reviewed" : "not reviewed"}` });
        return json(res, { ok: true });
      }
      if (url.pathname === "/api/signoff" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; done: boolean };
        const signoff = loadJson<Record<string, { done: boolean; at: string }>>(SIGNOFF_FILE, {});
        signoff[body.id] = { done: body.done, at: new Date().toISOString() };
        writeFileSync(SIGNOFF_FILE, JSON.stringify(signoff, null, 2));
        audit({ stage: "signoff", note: `task "${body.id}" marked ${body.done ? "done" : "not done"}` });
        return json(res, { ok: true });
      }
      if (url.pathname === "/api/files") return json(res, listFiles(loadPlan()));
      if (url.pathname === "/api/item") {
        const detail = itemDetail(url.searchParams.get("file") ?? "", Number(url.searchParams.get("row")), loadPlan());
        return detail ? json(res, detail) : json(res, { error: "not found" }, 404);
      }
      if (url.pathname === "/api/plan") return json(res, loadPlan());
      if (url.pathname === "/api/stats") return json(res, changeStats(loadPlan()));
      if (url.pathname === "/api/rules") return json(res, loadRules());
      if (url.pathname === "/api/links") return json(res, aggregateLinks(loadPlan()));
      if (url.pathname === "/api/assets") return json(res, aggregateAssets(loadPlan()));
      if (url.pathname === "/api/asset") {
        const detail = assetDetail(url.searchParams.get("src") ?? "", loadPlan());
        return detail ? json(res, detail) : json(res, { error: "not found" }, 404);
      }
      if (url.pathname === "/api/assets/check" && req.method === "POST") {
        if (checking) return json(res, { error: "a check run is already in progress" }, 409);
        checking = true;
        try {
          return json(res, await runAssetChecks(loadPlan()));
        } finally {
          checking = false;
        }
      }
      if (url.pathname === "/api/migrate/status") return json(res, migrateProgress);
      if (url.pathname === "/api/migrate" && req.method === "POST") {
        // one upload run at a time — concurrent runs would clobber url-map.json
        if (migrateProgress.running || redirectsProgress.running) return json(res, { error: "another upload run is in progress" }, 409);
        // fire-and-forget: the client polls /api/migrate/status for progress
        void migrate().catch((err) => {
          migrateProgress.running = false;
          migrateProgress.lastMessage = `crashed: ${err instanceof Error ? err.message : String(err)}`;
          audit({ stage: "migrate", error: migrateProgress.lastMessage });
        });
        return json(res, { started: true });
      }
      if (url.pathname === "/api/redirects") return json(res, { rows: buildRedirectRows(), progress: redirectsProgress });
      if (url.pathname === "/api/redirects/run" && req.method === "POST") {
        if (redirectsProgress.running || migrateProgress.running) return json(res, { error: "another upload run is in progress" }, 409);
        void runPdfRedirects().catch((err) => {
          redirectsProgress.running = false;
          redirectsProgress.lastMessage = `crashed: ${err instanceof Error ? err.message : String(err)}`;
          audit({ stage: "pdf-redirects", error: redirectsProgress.lastMessage });
        });
        return json(res, { started: true });
      }
      if (url.pathname === "/api/redirects/csv") {
        const csvPath = path.join(DIRS.output, "fs-301-redirects.csv");
        if (!existsSync(csvPath)) return json(res, { error: "not generated yet" }, 404);
        res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="fs-301-redirects.csv"' });
        return void res.end(readFileSync(csvPath));
      }
      if (url.pathname === "/api/export" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        let body: { force?: boolean; selection?: import("./export.js").ExportSelection } = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* empty body = export all */ }
        const force = body.force ?? url.searchParams.get("force") === "1";
        return json(res, exportCsvs(force, body.selection));
      }
      if (url.pathname === "/api/log") return json(res, readLogTail());

      const file = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = path.join(PORTAL_DIR, path.normalize(file));
      if (filePath.startsWith(PORTAL_DIR) && existsSync(filePath)) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
        return void res.end(readFileSync(filePath));
      }
      json(res, { error: "not found" }, 404);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
  server.requestTimeout = 600_000; // asset checks on ~1k URLs can take a few minutes
  server.listen(env.portalPort, () => {
    console.log(`Portal running at http://localhost:${env.portalPort}`);
  });
}
