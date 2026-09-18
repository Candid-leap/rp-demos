// Final end-to-end URL verification: every Webflow-hosted URL, every original
// URL (direct or via Cloudflare redirect), every Finsweet 301 path and target.
// Results -> workspace/final-check.json + a line in the audit log.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WS = path.join(ROOT, "workspace");
const J = (p, fb) => (existsSync(path.join(WS, p)) ? JSON.parse(readFileSync(path.join(WS, p), "utf8")) : fb);
const SITE = "https://www.example.com";

const urlMap = J("url-map.json", {});
const plan = J("plan.json", []);
const migrateErrors = J("migrate-errors.json", {});

const decode = (s) => s.replaceAll("&amp;", "&");
const absolutize = (u) => (u.startsWith("/") ? SITE + decode(u) : decode(u));

// url -> { categories: Set, expectFile: bool }
const targets = new Map();
const add = (url, category, expectFile = false) => {
  if (!url) return;
  const key = absolutize(url);
  if (!targets.has(key)) targets.set(key, { categories: new Set(), expectFile: false });
  targets.get(key).categories.add(category);
  if (expectFile) targets.get(key).expectFile = true;
};

for (const [source, entry] of Object.entries(urlMap)) {
  add(entry.newUrl, "webflow-hosted", true);
  add(source, "original-source");
}
for (const e of plan) {
  if (e.newUrl && e.status !== "skipped") add(e.newUrl, e.action === "rehost" ? "webflow-hosted" : "rewrite-target", e.action === "rehost");
  add(e.oldUrl, "original-in-content");
}
const fs301 = path.join(WS, "output", "fs-301-redirects.csv");
if (existsSync(fs301)) {
  for (const line of readFileSync(fs301, "utf8").trim().split("\n").slice(1)) {
    const comma = line.startsWith('"') ? line.indexOf('",') + 1 : line.indexOf(",");
    const p = line.slice(0, comma).replaceAll('"', "");
    const t = line.slice(comma + 1).replaceAll('"', "");
    add(p, "301-path");
    add(t, "301-target", true);
  }
}

const knownDead = new Set([
  ...Object.values(migrateErrors).filter((e) => e.phase !== "skipped").map((e) => absolutize(e.sourceUrl)),
  ...plan.filter((e) => e.status === "failed").map((e) => absolutize(e.oldUrl)),
]);

const entries = [...targets.entries()];
console.log(`Checking ${entries.length} unique URLs (${knownDead.size} known-dead expected to fail)…`);

const results = {};
let done = 0;
async function probe(url) {
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(20000) });
    }
    return { ok: res.ok, status: res.status, redirected: res.redirected, contentType: (res.headers.get("content-type") ?? "").split(";")[0], finalUrl: res.url };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

const queue = [...entries];
async function worker() {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [url, meta] = next;
    const r = await probe(url);
    let verdict = r.ok ? "ok" : "fail";
    if (r.ok && meta.expectFile && r.contentType.startsWith("text/html")) verdict = "wrong-type";
    if (!r.ok && knownDead.has(url)) verdict = "known-dead";
    results[url] = { ...r, categories: [...meta.categories], verdict };
    done++;
    if (done % 250 === 0) console.log(`  ${done}/${entries.length}`);
  }
}
await Promise.all(Array.from({ length: 14 }, worker));

const byVerdict = {};
const byCategory = {};
for (const [url, r] of Object.entries(results)) {
  byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  for (const c of r.categories) {
    byCategory[c] ??= { total: 0, ok: 0, redirected: 0, fail: 0, knownDead: 0, wrongType: 0 };
    byCategory[c].total++;
    if (r.verdict === "ok") { byCategory[c].ok++; if (r.redirected) byCategory[c].redirected++; }
    else if (r.verdict === "known-dead") byCategory[c].knownDead++;
    else if (r.verdict === "wrong-type") byCategory[c].wrongType++;
    else byCategory[c].fail++;
  }
}

const unexpected = Object.entries(results).filter(([, r]) => r.verdict === "fail" || r.verdict === "wrong-type");
const out = {
  checkedAt: new Date().toISOString(),
  totalUrls: entries.length,
  byVerdict,
  byCategory,
  unexpectedFailures: unexpected.map(([url, r]) => ({ url, status: r.status, error: r.error, contentType: r.contentType, categories: r.categories })),
  knownDead: Object.entries(results).filter(([, r]) => r.verdict === "known-dead").map(([url, r]) => ({ url, status: r.status })),
};
writeFileSync(path.join(WS, "final-check.json"), JSON.stringify(out, null, 2));

const day = new Date().toISOString().slice(0, 10);
appendFileSync(path.join(WS, "logs", `audit-${day}.jsonl`),
  JSON.stringify({ ts: new Date().toISOString(), stage: "final-check", note: `${entries.length} URLs checked: ${byVerdict.ok ?? 0} ok, ${unexpected.length} unexpected failures, ${byVerdict["known-dead"] ?? 0} known-dead confirmed` }) + "\n");

console.log("\n=== FINAL CHECK ===");
console.log("verdicts:", JSON.stringify(byVerdict));
for (const [c, s] of Object.entries(byCategory)) {
  console.log(`  ${c.padEnd(20)} total ${String(s.total).padStart(5)} | ok ${String(s.ok).padStart(5)} (${s.redirected} via redirect) | known-dead ${s.knownDead} | UNEXPECTED ${s.fail + s.wrongType}`);
}
if (unexpected.length) {
  console.log("\nUNEXPECTED FAILURES:");
  for (const [url, r] of unexpected.slice(0, 40)) console.log(`  ${r.status ?? ""} ${r.error ?? ""} ${r.contentType ?? ""} :: ${url.slice(0, 130)}`);
}
console.log("\nSaved: workspace/final-check.json");
