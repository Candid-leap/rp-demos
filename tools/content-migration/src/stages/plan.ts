import { readdirSync } from "node:fs";
import path from "node:path";
import { DIRS, ensureWorkspace, loadRules } from "../config.js";
import { readCsv, itemIdentity } from "../csvio.js";
import { extractUrls } from "../scan.js";
import { matchRule } from "../rules.js";
import { entryId, loadPlan, loadUrlMap, savePlan, type PlanEntry } from "../planstore.js";
import { audit } from "../log.js";

/**
 * Scan every cell of every row of every working CSV, match URLs against the
 * rules, and write plan.json. Read-only: no downloads, no uploads, no edits.
 */
export function plan(): PlanEntry[] {
  ensureWorkspace();
  const rules = loadRules();
  const urlMap = loadUrlMap();
  const files = readdirSync(DIRS.working).filter((f) => f.toLowerCase().endsWith(".csv"));
  if (files.length === 0) {
    console.log("No working CSVs. Run: pnpm ingest");
    return [];
  }

  // Re-planning must not lose migrate/verify state: carry statuses forward by entry id.
  const previous = new Map(loadPlan().map((e) => [e.id, e]));
  let carried = 0;

  const entries: PlanEntry[] = [];
  for (const file of files) {
    const csv = readCsv(path.join(DIRS.working, file));
    csv.rows.forEach((row, rowIndex) => {
      const { name, slug } = itemIdentity(row);
      for (const field of csv.headers) {
        const cell = row[field] ?? "";
        for (const url of extractUrls(cell)) {
          const match = matchRule(url, rules);
          if (!match) continue;
          const known = match.newUrl ?? urlMap[url]?.newUrl ?? (match.sourceUrl ? urlMap[match.sourceUrl]?.newUrl : undefined);
          const entry: PlanEntry = {
            id: entryId({ file, row: rowIndex, field, oldUrl: url }),
            file,
            row: rowIndex,
            itemName: name,
            slug,
            field,
            oldUrl: url,
            ruleId: match.rule.id,
            action: match.rule.action,
            sourceUrl: match.sourceUrl,
            newUrl: known,
            status: known ? (match.rule.action === "rehost" ? "mapped" : "planned") : "planned",
          };
          const old = previous.get(entry.id);
          // a rewrite whose rule now computes a different target must NOT carry
          // the stale result — it gets re-verified as a fresh entry
          const targetChanged = entry.action === "rewrite" && old?.newUrl !== undefined && old.newUrl !== entry.newUrl;
          if (old && !targetChanged && ["verified", "failed", "skipped", "migrated"].includes(old.status)) {
            entry.status = old.status;
            entry.newUrl = old.newUrl ?? entry.newUrl;
            entry.assetId = old.assetId;
            entry.verify = old.verify;
            entry.error = old.error;
            carried++;
          }
          entries.push(entry);
        }
      }
    });
  }

  savePlan(entries);
  audit({ stage: "plan", note: `${entries.length} URL matches planned across ${files.length} file(s); ${carried} statuses carried over from previous plan` });

  const byRule = new Map<string, number>();
  for (const e of entries) byRule.set(e.ruleId, (byRule.get(e.ruleId) ?? 0) + 1);
  console.log(`Planned ${entries.length} change(s) across ${files.length} file(s):`);
  for (const [ruleId, count] of byRule) console.log(`  ${ruleId}: ${count}`);
  const rehosts = new Set(
    entries.filter((e) => e.action === "rehost" && !e.newUrl && e.status !== "skipped" && e.status !== "failed").map((e) => e.sourceUrl),
  );
  const tracked = entries.filter((e) => e.status === "skipped" || e.status === "failed").length;
  console.log(`Unique assets to migrate: ${rehosts.size}${tracked ? `  (${tracked} tracked leftovers excluded)` : ""}`);
  console.log("\nReview in the portal (pnpm portal), then: pnpm migrate");
  return entries;
}
