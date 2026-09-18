import { writeFileSync } from "node:fs";
import path from "node:path";
import { DIRS, ensureWorkspace } from "../config.js";
import { readCsv, writeCsv } from "../csvio.js";
import { replaceUrl, extractUrls, byOldUrlLengthDesc } from "../scan.js";
import { loadPlan, isEffective } from "../planstore.js";
import { matchRule } from "../rules.js";
import { loadRules } from "../config.js";
import { audit } from "../log.js";

/**
 * Apply verified replacements and write corrected copies to output/ for
 * re-import into Webflow. Exact copies apart from URL substitution — all
 * other columns (including reference/multi-reference fields) pass through
 * untouched, which the equivalence report verifies cell-by-cell.
 */
export interface ExportSummary {
  ok: boolean;
  reason?: string;
  files: { file: string; rows: number; applied: number; leftovers: number; cellsChanged: number; unexpectedDiffs: number }[];
}

/** Selection: file name -> "all" or row indexes (into the working CSV). Omitted = all files, all rows. */
export type ExportSelection = Record<string, number[] | "all">;

export function exportCsvs(force: boolean, selection?: ExportSelection): ExportSummary {
  ensureWorkspace();
  const plan = loadPlan();
  if (plan.length === 0) {
    console.log("Plan is empty. Run: pnpm plan");
    return { ok: false, reason: "plan is empty — run plan first", files: [] };
  }

  const inSelection = (file: string, row: number): boolean => {
    if (!selection) return true;
    const s = selection[file];
    return s === "all" || (Array.isArray(s) && s.includes(row));
  };

  // "skipped" is an intentional decision (e.g. videos) — it never blocks export.
  const notReady = plan.filter((e) => e.status !== "verified" && e.status !== "skipped" && inSelection(e.file, e.row));
  if (notReady.length > 0 && !force) {
    const reason = `${notReady.length} selected change(s) are not verified (statuses: ${[...new Set(notReady.map((e) => e.status))].join(", ")})`;
    console.error(reason);
    console.error("Run migrate/verify first, or use --force to export anyway (unverified entries are still applied only if they have a new URL).");
    process.exitCode = 1;
    return { ok: false, reason, files: [] };
  }

  // failed/skipped are never applied, force or not — they produce no diff by definition
  const applicable = plan.filter((e) => isEffective(e) && (force || e.status === "verified") && inSelection(e.file, e.row));
  const fileNames = selection
    ? Object.keys(selection)
    : [...new Set(applicable.map((e) => e.file))];

  const rules = loadRules();
  const summary: ExportSummary = { ok: true, files: [] };
  for (const file of fileNames) {
    // longest old URL first: a prefix URL must never splice into a longer one
    const entries = applicable.filter((e) => e.file === file).sort(byOldUrlLengthDesc);
    const csv = readCsv(path.join(DIRS.working, file));
    const sel = selection?.[file];
    const rowIdxs = (!sel || sel === "all" ? csv.rows.map((_, i) => i) : [...sel].sort((a, b) => a - b))
      .filter((i) => i >= 0 && i < csv.rows.length);
    const rowSet = new Set(rowIdxs);

    let applied = 0;
    for (const e of entries) {
      const row = csv.rows[e.row];
      if (!row || row[e.field] === undefined || !rowSet.has(e.row)) continue;
      const before = row[e.field];
      const after = replaceUrl(before, e.oldUrl, e.newUrl!);
      if (after !== before) {
        row[e.field] = after;
        applied++;
        audit({
          stage: "export", file, item: e.itemName, field: e.field,
          oldUrl: e.oldUrl, newUrl: e.newUrl, ruleId: e.ruleId, action: e.action,
        });
      }
    }

    // Guardrail: count rule-matching URLs surviving in the exported rows.
    let leftovers = 0;
    for (const i of rowIdxs) {
      for (const field of csv.headers) {
        for (const url of extractUrls(csv.rows[i][field] ?? "")) {
          if (matchRule(url, rules)) leftovers++;
        }
      }
    }

    // Equivalence check: re-read the pristine working copy and diff each exported
    // cell. Every differing cell must belong to an applied plan entry.
    const pristine = readCsv(path.join(DIRS.working, file));
    const appliedCells = new Set(entries.map((e) => `${e.row} ${e.field}`));
    let cellsChanged = 0;
    let unexpectedDiffs = 0;
    const perField: Record<string, number> = {};
    for (const i of rowIdxs) {
      for (const field of pristine.headers) {
        if ((pristine.rows[i]?.[field] ?? "") !== (csv.rows[i]?.[field] ?? "")) {
          cellsChanged++;
          perField[field] = (perField[field] ?? 0) + 1;
          if (!appliedCells.has(`${i} ${field}`)) unexpectedDiffs++;
        }
      }
    }

    // No real changes -> nothing to re-import; refuse to produce a pointless file.
    if (applied === 0) {
      summary.files.push({ file, rows: 0, applied: 0, leftovers, cellsChanged: 0, unexpectedDiffs: 0 });
      audit({ stage: "export", file, note: `no real changes in selection — file NOT exported (leftover old URLs tracked: ${leftovers})` });
      console.log(`  ${file}: no real changes — not exported (${leftovers} tracked leftover URL(s) stay as-is)`);
      continue;
    }

    const outPath = path.join(DIRS.output, file);
    writeCsv(outPath, { headers: csv.headers, rows: rowIdxs.map((i) => csv.rows[i]) });
    summary.files.push({ file, rows: rowIdxs.length, applied, leftovers, cellsChanged, unexpectedDiffs });
    audit({
      stage: "export", file,
      note: `${rowIdxs.length} row(s) exported, ${applied} replacements in ${cellsChanged} cells (${Object.entries(perField).map(([f, n]) => `${f}: ${n}`).join(", ")}), ${leftovers} old URLs remain, ${unexpectedDiffs} unexpected diffs${force ? " (forced)" : ""}${selection ? " (selective)" : ""}`,
    });
    console.log(`  ${file}: ${rowIdxs.length} row(s), ${applied} replacement(s) -> output/${file}${leftovers ? `  ⚠ ${leftovers} old URL(s) still present` : ""}`);
    if (leftovers > 0) {
      console.log("    (these are entries that were skipped as unverified/failed — check the portal)");
    }
  }

  // Equivalence certificate: proof the outputs differ from the sources only by
  // the planned URL replacements.
  const totalUnexpected = summary.files.reduce((n, f) => n + f.unexpectedDiffs, 0);
  const report = [
    `# Export Equivalence Report`,
    ``,
    `Generated: ${new Date().toISOString()}${force ? "  (forced export)" : ""}${selection ? "  (selective export)" : ""}`,
    ``,
    `Certifies that each file in workspace/output/ is an exact copy of its source`,
    `rows except for planned URL replacements, verified cell-by-cell. Reference`,
    `and multi-reference columns pass through unchanged. Any "unexpected diffs"`,
    `would mean a cell changed outside the plan — the expected value is 0 everywhere.`,
    ``,
    `| File | Rows exported | Replacements applied | Cells changed | Old URLs remaining | Unexpected diffs |`,
    `|---|---|---|---|---|---|`,
    ...summary.files.map((f) => `| ${f.file} | ${f.rows} | ${f.applied} | ${f.cellsChanged} | ${f.leftovers} | ${f.unexpectedDiffs} |`),
    ``,
    totalUnexpected === 0
      ? `**Result: PASS — outputs are equivalent to sources apart from the planned URL replacements.**`
      : `**Result: FAIL — ${totalUnexpected} unexpected cell diff(s). Do not import; investigate first.**`,
    ``,
  ].join("\n");
  writeFileSync(path.join(DIRS.output, "equivalence-report.md"), report);
  writeFileSync(path.join(DIRS.output, "equivalence-report.json"), JSON.stringify(summary, null, 2));
  console.log(`\nEquivalence report: workspace/output/equivalence-report.md (${totalUnexpected === 0 ? "PASS" : "FAIL — do not import"})`);
  console.log(`Done. Re-import the file(s) in workspace/output/ via Webflow CMS import.`);
  return summary;
}
