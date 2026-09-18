// Collect Google-indexed /hubfs URLs (via firecrawl search) and check every one:
// live status + whether it's covered by a 301 row. Reports anything missing.
// Usage: node scripts/google-index-check.mjs
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const QUERIES = [
  "site:example.com filetype:pdf",
  "site:example.com inurl:hubfs pdf",
  "site:example.com/hubfs",
  "site:example.com hubfs ebook",
  "site:example.com hubfs playbook pdf",
  "site:example.com hubfs webinar",
  "site:example.com hubfs one pager",
];

const found = new Set();
for (const q of QUERIES) {
  try {
    const out = execSync(`firecrawl search ${JSON.stringify(q)} --limit 30 2>/dev/null`, { encoding: "utf8", timeout: 60000 });
    for (const m of out.matchAll(/https:\/\/(?:www\.)?example\.com\/hubfs\/[^\s"')]+/g)) found.add(m[0]);
  } catch { console.log(`  (query failed: ${q})`); }
}
console.log(`Google surfaced ${found.size} unique /hubfs URLs across ${QUERIES.length} queries.\n`);

// coverage set from the redirect CSV (real-world normalized)
const norm = (p) => decodeURIComponent(p).toLowerCase().replaceAll("%2b", "+").replaceAll("%2c", ",");
const csv = readFileSync(path.join(ROOT, "workspace/output/fs-301-redirects.csv"), "utf8").trim().split("\n").slice(1);
const exact = new Set();
const wildcards = [];
for (const line of csv) {
  const comma = line.startsWith('"') ? line.indexOf('",') + 1 : line.indexOf(",");
  const p = line.slice(0, comma).replaceAll('"', "");
  if (p.includes("(.*)")) wildcards.push(norm(p.slice(0, p.indexOf("(.*)"))));
  else exact.add(norm(p));
}

const rows = [];
for (const u of [...found].sort()) {
  const p = new URL(u).pathname;
  const covered = exact.has(norm(p)) || wildcards.some((w) => norm(p).startsWith(w));
  let status = 0, via = "";
  try {
    const r = await fetch(u, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(20000) });
    status = r.status;
    via = r.url.includes("website-files") ? "webflow" : r.url.includes("hubspot") ? "hubspot-cdn" : "";
  } catch { status = -1; }
  rows.push({ url: u, covered, status, via });
  console.log(`${status === 200 ? "✓" : "✕"} ${String(status).padEnd(4)} ${via.padEnd(11)} ${covered ? "row:yes" : "ROW:MISSING"} ${decodeURIComponent(p).slice(0, 80)}`);
}

const bad = rows.filter((r) => r.status !== 200);
const uncovered = rows.filter((r) => !r.covered);
console.log(`\nSummary: ${rows.length} indexed URLs | ${rows.length - bad.length} live OK | ${bad.length} FAILING | ${uncovered.length} without a redirect row`);
if (bad.length) bad.forEach((r) => console.log("  FIX NEEDED:", r.url));
writeFileSync(path.join(ROOT, "workspace/google-index-check.json"), JSON.stringify(rows, null, 2));
console.log("Saved: workspace/google-index-check.json");
