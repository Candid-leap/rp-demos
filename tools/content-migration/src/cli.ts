import { ingest } from "./stages/ingest.js";
import { precheck } from "./stages/precheck.js";
import { plan } from "./stages/plan.js";
import { migrate } from "./stages/migrate.js";
import { verify } from "./stages/verify.js";
import { exportCsvs } from "./stages/export.js";
import { runPdfRedirects } from "./stages/pdfRedirects.js";
import { portal } from "./stages/portal.js";

const command = process.argv[2];
const force = process.argv.includes("--force");

switch (command) {
  case "ingest": ingest(); break;
  case "precheck": await precheck(); break;
  case "plan": plan(); break;
  case "migrate": await migrate(); break;
  case "verify": await verify(); break;
  case "export": exportCsvs(force); break;
  case "pdf-redirects": await runPdfRedirects(); break;
  case "portal": portal(); break;
  default:
    console.log(`Usage: pnpm <stage>

  ingest    copy inbox/*.csv into originals/ (immutable) and working/
  precheck  validate Webflow token/site/scopes, create "Hubspot Migrated Asset" folder
  plan      scan all fields of all items, write plan.json (read-only)
  migrate   download HubSpot assets, upload to Webflow, record url-map.json
  verify    HTTP-check every new URL (status + content-type)
  export    write corrected CSVs to output/ (refuses unverified; --force to override)
  portal    review UI at http://localhost:4321
`);
    process.exitCode = command ? 1 : 0;
}
