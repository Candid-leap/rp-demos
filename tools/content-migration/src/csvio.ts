import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

export interface CsvFile {
  headers: string[];
  rows: Record<string, string>[];
}

export function readCsv(filePath: string): CsvFile {
  const raw = readFileSync(filePath, "utf8");
  const rows: Record<string, string>[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

export function writeCsv(filePath: string, file: CsvFile): void {
  const out = stringify(file.rows, { header: true, columns: file.headers, bom: true });
  writeFileSync(filePath, out);
}

/** Best-effort item display name + slug from a Webflow CMS export row. */
export function itemIdentity(row: Record<string, string>): { name: string; slug: string } {
  const keys = Object.keys(row);
  const nameKey = keys.find((k) => k.toLowerCase() === "name") ?? keys[0];
  const slugKey = keys.find((k) => k.toLowerCase() === "slug");
  return { name: row[nameKey] ?? "(unnamed)", slug: slugKey ? row[slugKey] ?? "" : "" };
}
