import { env, ensureWorkspace } from "../config.js";
import { loadPlan, savePlan, type PlanEntry, type VerifyResult } from "../planstore.js";
import { audit } from "../log.js";

function resolveUrl(url: string): string {
  return url.startsWith("/") ? env.siteBaseUrl + url : url;
}

const ASSET_TYPE_RE = /^(image\/|application\/pdf|application\/octet-stream|video\/|audio\/|font\/|application\/zip)/;

async function check(entry: PlanEntry): Promise<VerifyResult> {
  const target = resolveUrl(entry.newUrl!);
  try {
    const res = await fetch(target, { redirect: "follow" });
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    let ok = res.ok;
    let error: string | undefined;
    if (ok && entry.action === "rehost" && !ASSET_TYPE_RE.test(contentType)) {
      ok = false;
      error = `unexpected content-type for an asset: ${contentType || "(none)"}`;
    }
    if (!res.ok) error = `HTTP ${res.status}`;
    return { ok, status: res.status, contentType, finalUrl: res.url, checkedAt: new Date().toISOString(), error };
  } catch (err) {
    return {
      ok: false, status: 0, contentType: "", finalUrl: target,
      checkedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** HTTP-check every planned new URL; every result lands in plan.json + audit log. */
export async function verify(): Promise<void> {
  ensureWorkspace();
  const plan = loadPlan();
  if (plan.length === 0) {
    console.log("Plan is empty. Run: pnpm plan");
    return;
  }

  const targets = plan.filter((e) => e.newUrl);
  const skipped = plan.length - targets.length;
  if (skipped > 0) console.log(`${skipped} entrie(s) have no new URL yet (run migrate first) — skipping those.`);

  // Verify each unique URL once, then fan results out to entries.
  const unique = new Map<string, PlanEntry>();
  for (const e of targets) if (!unique.has(e.newUrl!)) unique.set(e.newUrl!, e);

  const results = new Map<string, VerifyResult>();
  let ok = 0;
  let bad = 0;
  for (const [url, entry] of unique) {
    const result = await check(entry);
    results.set(url, result);
    result.ok ? ok++ : bad++;
    console.log(`  ${result.ok ? "✓" : "✗"} ${url}${result.error ? ` — ${result.error}` : ""}`);
  }

  for (const e of targets) {
    const result = results.get(e.newUrl!)!;
    e.verify = result;
    e.status = result.ok ? "verified" : "failed";
    e.error = result.error;
    audit({
      stage: "verify", file: e.file, item: e.itemName, field: e.field,
      oldUrl: e.oldUrl, newUrl: e.newUrl, ruleId: e.ruleId, action: e.action, verify: result,
    });
  }
  savePlan(plan);

  console.log(`\nVerified ${ok} URL(s) OK, ${bad} failing, ${skipped} pending migration.`);
  console.log(bad === 0 && skipped === 0 ? "All green. Next: pnpm export" : "Fix failures (or re-run migrate) before export.");
}
