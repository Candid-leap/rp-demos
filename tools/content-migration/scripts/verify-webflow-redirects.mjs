// Verify every Finsweet 301 row on BOTH domains:
//   - www.example.com   (live site — Cloudflare still in front today)
//   - newsite.webflow.io    (Webflow-side — what happens after Cloudflare rules are removed)
// Prints a table with one row per redirect. Usage: node scripts/verify-webflow-redirects.mjs
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const LIVE = "https://www.example.com";
const WF = "https://newsite.webflow.io";

// Real original paths (not the sanitized/wildcarded CSV forms) — the truth test.
const state = JSON.parse(readFileSync(path.join(ROOT, "workspace/pdf-redirects.json"), "utf8"));
const rows = state.filter((p) => p.target).map((p) => ({ path: p.oldPath, target: p.target }));
const extra = path.join(ROOT, "extra-301s.csv");
try {
  for (const line of readFileSync(extra, "utf8").trim().split("\n").slice(1)) {
    if (!line.trim()) continue;
    const comma = line.indexOf(",");
    rows.push({ path: line.slice(0, comma), target: line.slice(comma + 1) });
  }
} catch { /* no extras */ }
console.log(`Checking ${rows.length} redirect rows on ${LIVE} and ${WF} …\n`);

async function head(url, redirect) {
  try {
    return await fetch(url, { method: "HEAD", redirect, signal: AbortSignal.timeout(20000) });
  } catch {
    return null;
  }
}

const results = new Array(rows.length);
const queue = rows.map((r, i) => [r, i]);
async function worker() {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [r, i] = next;
    const testPath = r.path; // real original path — exactly what browsers/Google request

    // live site (follow redirects to wherever it lands today)
    let live = "ERR";
    const lr = await head(LIVE + testPath, "follow");
    if (lr) {
      const via = lr.url.includes("website-files") ? "webflow" : lr.url.includes("hubspotusercontent") ? "hubspot" : "site";
      live = lr.ok ? `${lr.status} ${via}` : `${lr.status}`;
    }

    // webflow side (manual: inspect the 301 target)
    let wf = "ERR";
    let wfOk = false;
    const wr = await head(WF + testPath, "manual");
    if (wr) {
      const loc = wr.headers.get("location") ?? "";
      if (wr.status >= 300 && wr.status < 400 && loc) {
        const want = r.target.replaceAll("(.*)", "");
        wfOk = loc.startsWith(want) || want.startsWith(loc);
        wf = wfOk ? "301 ok" : "301 WRONG";
      } else {
        wf = `${wr.status}`;
      }
    }
    results[i] = { path: r.path, live, liveOk: live.startsWith("200"), wf, wfOk };
  }
}
await Promise.all(Array.from({ length: 12 }, worker));

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const shorten = (p) => {
  const d = decodeURIComponent(p);
  return d.length <= 66 ? d : d.slice(0, 40) + "…" + d.slice(-25);
};
console.log(pad("#", 4) + pad("LIVE (www)", 13) + pad("WEBFLOW", 11) + "PATH");
console.log("-".repeat(100));
results.forEach((r, i) => {
  const mark = r.liveOk && r.wfOk ? "  " : "✕ ";
  console.log(mark + pad(i + 1, 4) + pad(r.live, 13) + pad(r.wf, 11) + shorten(r.path));
});

const liveOk = results.filter((r) => r.liveOk).length;
const wfOk = results.filter((r) => r.wfOk).length;
const bothBad = results.filter((r) => !r.liveOk && !r.wfOk);
console.log("-".repeat(100));
console.log(`LIVE (www):  ${liveOk}/${rows.length} resolve today`);
console.log(`WEBFLOW:     ${wfOk}/${rows.length} redirect correctly (post-Cloudflare behavior)`);
if (wfOk === rows.length) console.log("\n✓ ALL rows verified on the Webflow side — safe to remove the Cloudflare rules.");
else console.log(`\n✕ ${rows.length - wfOk} row(s) not working on the Webflow side (marked ✕ above).`);
if (bothBad.length) console.log(`⚠ ${bothBad.length} row(s) failing on BOTH sides.`);
