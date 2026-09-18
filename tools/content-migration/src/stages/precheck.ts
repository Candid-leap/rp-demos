import { env, ensureWorkspace } from "../config.js";
import { loadPlan } from "../planstore.js";
import { audit } from "../log.js";
import { tokenInfo, listSites, getSite, listAssetFolders, createAssetFolder, WebflowError, type AssetFolder } from "../webflow.js";

export const PARENT_FOLDER_NAME = "Hubspot Migrated Asset";

/**
 * Read-only validation of the Webflow side (plus creating the asset folder,
 * which is the one explicitly requested write). Uploads nothing.
 */
export async function precheck(): Promise<void> {
  ensureWorkspace();
  let failed = false;
  const fail = (msg: string) => { failed = true; console.error(`  ✗ ${msg}`); };
  const ok = (msg: string) => console.log(`  ✓ ${msg}`);

  console.log("Env:");
  if (env.webflowToken) ok("WEBFLOW_API_TOKEN is set"); else fail("WEBFLOW_API_TOKEN missing in .env");
  if (env.hubspotCdnDomain && env.hubspotPortalId) ok(`HubSpot CDN configured (${env.hubspotCdnDomain}, portal ${env.hubspotPortalId})`);
  else fail("HUBSPOT_CDN_DOMAIN / HUBSPOT_PORTAL_ID missing");
  if (!env.webflowToken) { process.exitCode = 1; return; }

  const warn = (msg: string) => console.log(`  ⚠ ${msg}`);

  console.log("\nToken (informational — asset access below is the real test):");
  try {
    const info = await tokenInfo();
    const scopes = (info.authorization as { authorizedTo?: { scopes?: string[] } })?.authorizedTo?.scopes ?? [];
    ok(`token introspection ok${scopes.length ? `; scopes: ${scopes.join(", ")}` : ""}`);
  } catch (err) {
    const e = err as WebflowError;
    warn(`token introspection unavailable (${e.status ?? ""} ${e.code ?? ""}) — not required, continuing`);
  }

  console.log("\nSite (informational — sites:read scope is not required for asset upload):");
  const siteId = env.webflowSiteId;
  if (!siteId) {
    try {
      const sites = await listSites();
      fail(`WEBFLOW_SITE_ID not set; token sees: ${sites.map((s) => `"${s.displayName}" (${s.id})`).join(", ") || "no sites"}`);
    } catch {
      fail("WEBFLOW_SITE_ID not set and the token cannot list sites — add the site id to .env");
    }
  } else {
    try {
      const site = await getSite(siteId);
      ok(`site accessible: "${site.displayName}" (${site.shortName}, id ${site.id})`);
    } catch (err) {
      const e = err as WebflowError;
      if (e.code === "missing_scopes") warn(`sites:read scope not granted — fine, asset endpoints don't need it`);
      else warn(`site lookup failed (${e.status} ${e.code}) — relying on asset endpoints below`);
    }
  }

  console.log(`\nAsset folders (assets:read + assets:write — the scopes migrate actually uses):`);
  if (siteId) {
    try {
      const folders = await listAssetFolders(siteId);
      ok(`assets:read works — ${folders.length} folder(s) listable`);
      let parent = folders.find((f) => f.displayName === PARENT_FOLDER_NAME);
      if (parent) {
        ok(`"${PARENT_FOLDER_NAME}" exists (id ${parent.id})`);
      } else {
        parent = await createAssetFolder(siteId, PARENT_FOLDER_NAME);
        ok(`"${PARENT_FOLDER_NAME}" created (id ${parent.id})`);
        audit({ stage: "precheck", note: `created asset folder "${PARENT_FOLDER_NAME}" (${parent.id})` });
      }
      // Create the per-type subfolders now: requested structure + proves assets:write.
      const wanted = ["Images", "PDFs", "Videos", "Other"];
      for (const name of wanted) {
        const existing = folders.find((f) => f.displayName === name && f.parentFolder === parent.id);
        if (existing) {
          ok(`subfolder ${name} exists (id ${existing.id})`);
        } else {
          const sub = await createAssetFolder(siteId, name, parent.id);
          ok(`subfolder ${name} created (id ${sub.id}) — assets:write confirmed`);
          audit({ stage: "precheck", note: `created subfolder "${name}" (${sub.id}) under "${PARENT_FOLDER_NAME}"` });
        }
      }
    } catch (err) {
      const e = err as WebflowError;
      fail(`asset folder check failed: ${e.status ?? ""} ${e.code ?? ""} ${e.message}`);
      audit({ stage: "precheck", error: `folders: ${e.status} ${e.code} ${e.message}` });
    }
  }

  console.log("\nPlan:");
  const plan = loadPlan();
  const pending = new Set(plan.filter((e) => e.action === "rehost" && e.sourceUrl && !e.newUrl).map((e) => e.sourceUrl));
  console.log(`  · ${plan.length} planned changes; ${pending.size} unique assets awaiting download+upload`);

  console.log(failed ? "\nPre-checks FAILED — fix the above before migrate." : "\nAll pre-checks passed. Migrate is ready (downloads first, then uploads).");
  if (failed) process.exitCode = 1;
}
