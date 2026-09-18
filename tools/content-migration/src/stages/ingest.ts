import { readdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DIRS, ensureWorkspace } from "../config.js";
import { audit } from "../log.js";

/**
 * Copy inbox CSVs into originals/ (timestamped, immutable) and working/
 * (the copies the pipeline operates on). Inbox files are left in place.
 */
export function ingest(): void {
  ensureWorkspace();
  // Non-CMS inputs that also live in inbox (PDF redirect list + Finsweet template) are not ingested.
  const files = readdirSync(DIRS.inbox).filter(
    (f) => f.toLowerCase().endsWith(".csv") && !/hubspot.*pdf|fs-301/i.test(f),
  );
  if (files.length === 0) {
    console.log(`No CSV files found in ${DIRS.inbox} — drop your Webflow CMS exports there first.`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  for (const f of files) {
    const src = path.join(DIRS.inbox, f);
    const originalDest = path.join(DIRS.originals, `${stamp}__${f}`);
    copyFileSync(src, originalDest); // timestamped: never overwrites a previous archive
    const workingDest = path.join(DIRS.working, f);
    const existed = existsSync(workingDest);
    copyFileSync(src, workingDest);
    audit({ stage: "ingest", file: f, note: existed ? "working copy refreshed" : "working copy created" });
    console.log(`ingested ${f}  (archived as originals/${stamp}__${f})`);
  }
  console.log(`\n${files.length} file(s) ingested. Next: pnpm plan`);
}
