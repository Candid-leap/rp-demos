import { appendFileSync } from "node:fs";
import path from "node:path";
import { DIRS, ensureWorkspace } from "./config.js";

export interface AuditEvent {
  stage: string;
  file?: string;
  item?: string;
  field?: string;
  oldUrl?: string;
  newUrl?: string;
  ruleId?: string;
  action?: string;
  assetId?: string;
  verify?: unknown;
  error?: string;
  note?: string;
}

export function audit(event: AuditEvent): void {
  ensureWorkspace();
  const day = new Date().toISOString().slice(0, 10);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  appendFileSync(path.join(DIRS.logs, `audit-${day}.jsonl`), line + "\n");
}
