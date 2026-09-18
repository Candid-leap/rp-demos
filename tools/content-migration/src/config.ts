import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKSPACE = path.join(ROOT, "workspace");

export const DIRS = {
  inbox: path.join(WORKSPACE, "inbox"),
  originals: path.join(WORKSPACE, "originals"),
  working: path.join(WORKSPACE, "working"),
  output: path.join(WORKSPACE, "output"),
  cache: path.join(WORKSPACE, "cache", "assets"),
  logs: path.join(WORKSPACE, "logs"),
};

export const PLAN_FILE = path.join(WORKSPACE, "plan.json");
export const URL_MAP_FILE = path.join(WORKSPACE, "url-map.json");

dotenv.config({ path: path.join(ROOT, ".env") });

export const env = {
  webflowToken: process.env.WEBFLOW_API_TOKEN ?? "",
  webflowSiteId: process.env.WEBFLOW_SITE_ID ?? "",
  webflowAssetFolderId: process.env.WEBFLOW_ASSET_FOLDER_ID ?? "",
  hubspotCdnDomain: process.env.HUBSPOT_CDN_DOMAIN ?? "",
  hubspotPortalId: process.env.HUBSPOT_PORTAL_ID ?? "",
  siteBaseUrl: (process.env.SITE_BASE_URL ?? "https://www.example.com").replace(/\/$/, ""),
  portalPort: Number(process.env.PORTAL_PORT ?? 4321),
};

export interface Rule {
  id: string;
  description?: string;
  /** "cloudflare" = mirrors an existing edge redirect rule; "added" = found during planning. Shown in the portal. */
  origin?: "cloudflare" | "added";
  /** Why this rule exists — displayed in the portal rules panel. */
  reasoning?: string;
  match: string;
  action: "rehost" | "rewrite";
  sourceUrl?: string;
  target?: string;
  host?: string;
  /** Strip ?query and #fragment from the download source URL (default true for rehost). */
  stripQuery?: boolean;
}

export function loadRules(): Rule[] {
  const raw = readFileSync(path.join(ROOT, "rules.json"), "utf8");
  const withEnv = raw
    .replaceAll("{{HUBSPOT_CDN_DOMAIN}}", env.hubspotCdnDomain || "{{HUBSPOT_CDN_DOMAIN}}")
    .replaceAll("{{HUBSPOT_PORTAL_ID}}", env.hubspotPortalId || "{{HUBSPOT_PORTAL_ID}}");
  return JSON.parse(withEnv) as Rule[];
}

export function ensureWorkspace(): void {
  for (const dir of Object.values(DIRS)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
