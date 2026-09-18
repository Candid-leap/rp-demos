/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                                                                       │
 * │   ROUTING CONFIG                                                      │
 * │   This is the only file you need to edit to change where traffic      │
 * │   goes. After editing, run:                                           │
 * │                                                                       │
 * │     pnpm build && cd terraform && terraform apply                     │
 * │                                                                       │
 * │   Terraform only updates the Worker script — DNS and routes are       │
 * │   not recreated.                                                      │
 * │                                                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Keep a shared page inventory (a spreadsheet works well) as the source of
 * truth for which pages have been rebuilt — this file is the machine-readable
 * projection of it.
 *
 *
 * ── HOW ROUTING WORKS ──────────────────────────────────────────────────────
 *
 * Every request hits the Worker. The Worker looks at the FIRST segment
 * of the URL path and decides where to send it:
 *
 *   /product/voice-ai   → first segment is "product"
 *   /blog/my-post       → first segment is "blog"
 *   /pricing            → first segment is "pricing"
 *   /                   → no segment (root) — always goes to Webflow
 *
 * The Worker checks in this order:
 *
 *   1. REDIRECTS             — exact path match → 301 redirect (checked first)
 *   2. WEBFLOW_EXACT_PATHS   — exact full path → serve from Webflow
 *   3. HUBSPOT_EXACT_PATHS   — exact full path → serve from HubSpot
 *   4. WEBFLOW_PATHS         — first segment match → serve from Webflow
 *   5. HUBSPOT_PATHS         — first segment match → serve from HubSpot
 *   6. DEFAULT_ORIGIN        — no match → serve from this origin
 *
 * Exact paths (steps 2-3) take priority over folder matching (steps 4-5).
 * If a path matches both, exact wins.
 *
 *
 * ── EXAMPLES ───────────────────────────────────────────────────────────────
 *
 * "I want /resources to go to Webflow (entire folder)"
 *   → Add 'resources' to WEBFLOW_PATHS
 *
 * "I want /event/annual-summit on Webflow but other /event/* pages on HubSpot"
 *   → Add '/event/annual-summit' to WEBFLOW_EXACT_PATHS
 *     Do NOT add 'event' to WEBFLOW_PATHS (that would wildcard everything)
 *
 * "I want /blog/specific-post on Webflow but rest of /blog on HubSpot"
 *   → Add '/blog/specific-post' to WEBFLOW_EXACT_PATHS
 *     Exact paths are checked before folder matching, so this works.
 *
 * "I want /old-page to redirect to /new-page"
 *   → Add to REDIRECTS: { '/old-page': 'https://www.example.com/new-page' }
 *
 * "I want /blog/old-post to redirect somewhere"
 *   → Add to REDIRECTS: { '/blog/old-post': 'https://example.com/target' }
 *     Redirects are checked BEFORE routing, so this works even though
 *     /blog normally goes to HubSpot.
 *
 * "I want to flip the default so everything goes to Webflow"
 *   → Change DEFAULT_ORIGIN to 'webflow'. Now only paths in HUBSPOT_PATHS
 *     and HUBSPOT_EXACT_PATHS stay on HubSpot.
 *
 * "I added a new page in Webflow under /product/new-thing"
 *   → No change needed. 'product' is already in WEBFLOW_PATHS, so all
 *     /product/* subpaths are automatically served from Webflow.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. DEFAULT ORIGIN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where traffic goes when a path doesn't match any list below.
 *
 * - 'hubspot' → during migration, new/unknown pages fall back to HubSpot
 * - 'webflow' → after migration, new/unknown pages default to Webflow
 */
export const DEFAULT_ORIGIN: 'webflow' | 'hubspot' = 'hubspot';

// ─────────────────────────────────────────────────────────────────────────────
// 2. WEBFLOW PATHS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Top-level path segments served by Webflow.
 *
 * IMPORTANT: This matches the FIRST segment only. Adding 'product' routes
 * ALL of these to Webflow:
 *   /product
 *   /product/voice-ai
 *   /product/data-bridge
 *   /product/anything/nested/deep
 *
 * Keep this list sorted alphabetically for readability.
 */
export const WEBFLOW_PATHS: string[] = [
  'authors',
  'careers',
  'case-studies',
  'customers',
  'event',
  'integrations',
  'landing',
  'product',
  'sales',
  'solutions',
  'testimonials',
  'blog',
  'playbooks',
  'contact',
  'demo',
  'offers',
  'legal',
];

// ─────────────────────────────────────────────────────────────────────────────
// 3. EXACT-PATH ROUTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WEBFLOW_EXACT_PATHS — Specific full paths served by Webflow.
 *
 * Use this when you need a specific page on Webflow but the rest of
 * that folder should stay on HubSpot (or the default origin).
 *
 * These are full path matches (case-sensitive, must start with /).
 * Unlike WEBFLOW_PATHS which matches only the first segment,
 * these match the entire pathname.
 *
 * Example: '/event/annual-summit' routes only that exact page to
 * Webflow. Other /event/* pages still go to the default origin.
 */
export const WEBFLOW_EXACT_PATHS: string[] = [
  // Demo inventory. In a real migration this list grows page by page as the
  // new site is built — each entry is one page that has been rebuilt and
  // signed off. Sorted alphabetically (root first) so diffs stay readable.
  '/',
  '/404',
  '/become-a-partner',
  '/blog',
  '/careers',
  '/case-studies',
  '/competitor-comparison',
  '/contact',
  '/demo',
  '/get-a-demo',
  '/integrations',
  '/legal',
  '/offers',
  '/playbooks',
  '/pricing',
  '/refer',
  '/resources',
  '/sitemap.xml',
  '/thankyou',
];

/**
 * HUBSPOT_EXACT_PATHS — Specific full paths served by HubSpot.
 *
 * Same as above but for HubSpot. Use when DEFAULT_ORIGIN is 'webflow'
 * and you need to hold back specific pages on HubSpot.
 */
export const HUBSPOT_EXACT_PATHS: string[] = [
  // e.g. '/event/legacy-landing-page'
];

// ─────────────────────────────────────────────────────────────────────────────
// 4. HUBSPOT PATHS (folder-based)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Top-level path segments that ALWAYS stay on HubSpot.
 *
 * While DEFAULT_ORIGIN is 'hubspot', this list has no practical effect
 * because unlisted paths already go to HubSpot. It becomes important
 * AFTER you flip DEFAULT_ORIGIN to 'webflow' — these paths will be
 * held back on HubSpot while everything else moves to Webflow.
 */
export const HUBSPOT_PATHS: string[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// 5. REDIRECTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Static 301 redirect map. Checked BEFORE routing.
 *
 * Keys are exact pathname matches (case-sensitive, must start with /).
 * Values are the full destination URL.
 *
 * Use this for:
 *   - Specific pages that moved to a different URL
 *   - Blog slugs that need to redirect
 *   - Landing pages that expired
 *   - Any one-off redirect that needs Worker-level control
 *
 * For bulk redirects (hundreds of URLs), use Cloudflare Bulk Redirect
 * Lists in Terraform instead — they're more efficient and don't require
 * a Worker redeploy.
 *
 * Examples:
 *   '/old-pricing':         'https://www.example.com/pricing',
 *   '/blog/old-post':       'https://www.example.com/blog/new-post',
 *   '/webinar-2024':        'https://www.example.com/event/annual-summit',
 *   '/apply':               'https://jobs.example-ats.com/careers',
 */
export const REDIRECTS: Record<string, string> = {};

