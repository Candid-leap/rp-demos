import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { PLAN_FILE, URL_MAP_FILE } from "./config.js";

export type EntryStatus = "planned" | "mapped" | "migrated" | "verified" | "failed" | "skipped";

export interface VerifyResult {
  ok: boolean;
  status: number;
  contentType: string;
  finalUrl: string;
  checkedAt: string;
  error?: string;
}

export interface PlanEntry {
  id: string;
  file: string;
  row: number;
  itemName: string;
  slug: string;
  field: string;
  oldUrl: string;
  ruleId: string;
  action: "rehost" | "rewrite";
  sourceUrl?: string;
  newUrl?: string;
  assetId?: string;
  status: EntryStatus;
  error?: string;
  verify?: VerifyResult;
}

export interface UrlMapEntry {
  newUrl: string;
  assetId?: string;
  sourceUrl?: string;
  migratedAt?: string;
}

/**
 * A real, appliable update: has a new URL and is not failed/skipped.
 * Skipped and failed entries produce NO diff — they are tracked leftovers,
 * never counted as changes and never applied (even with --force).
 */
export function isEffective(e: Pick<PlanEntry, "newUrl" | "status">): boolean {
  return !!e.newUrl && e.status !== "failed" && e.status !== "skipped";
}

export function entryId(e: Pick<PlanEntry, "file" | "row" | "field" | "oldUrl">): string {
  return createHash("sha1").update(`${e.file}\n${e.row}\n${e.field}\n${e.oldUrl}`).digest("hex").slice(0, 12);
}

export function loadPlan(): PlanEntry[] {
  if (!existsSync(PLAN_FILE)) return [];
  return JSON.parse(readFileSync(PLAN_FILE, "utf8")) as PlanEntry[];
}

export function savePlan(plan: PlanEntry[]): void {
  writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
}

export function loadUrlMap(): Record<string, UrlMapEntry> {
  if (!existsSync(URL_MAP_FILE)) return {};
  return JSON.parse(readFileSync(URL_MAP_FILE, "utf8")) as Record<string, UrlMapEntry>;
}

export function saveUrlMap(map: Record<string, UrlMapEntry>): void {
  writeFileSync(URL_MAP_FILE, JSON.stringify(map, null, 2));
}
