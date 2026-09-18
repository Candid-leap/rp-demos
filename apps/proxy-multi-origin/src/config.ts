/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                                                                         │
 * │   ROUTING CONFIG                                                        │
 * │   This is the only file you need to edit to change where traffic        │
 * │   goes. After editing, deploy (push to the repo if the Cloudflare       │
 * │   dashboard Git integration is set up, else `wrangler deploy`).         │
 * │                                                                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ── ORIGINS ────────────────────────────────────────────────────────────────
 *
 * An "origin" is just a website the proxy can serve pages from. Two exist
 * by default:
 *
 *   'old' → the CURRENT live site (where traffic falls back to by default)
 *   'new' → the NEW site being built (pages migrate here over time)
 *
 * More origins can be added at any time — e.g. a second new site, or a
 * separate blog platform:
 *
 *   1. Extend the Origin type below:  'old' | 'new' | 'blog'
 *   2. Add its URL variable in wrangler.jsonc and map it in src/origins.ts
 *   3. TypeScript will then point out every config entry below that needs
 *      a value for the new key ('blog': [...]) — fill them in.
 *
 * The proxy doesn't know or care what platform an origin runs on — an
 * origin is just a URL.
 *
 * ── HOW ROUTING WORKS ──────────────────────────────────────────────────────
 *
 * Every request hits the Worker. The Worker checks, in order:
 *
 *   1. REDIRECTS        — exact path match → 301 redirect (checked first)
 *   2. EXACT_PATHS      — exact full path → serve from that origin
 *   3. PATHS            — first path segment (folder) → serve from that origin
 *   4. DEFAULT_ORIGIN   — no match → serve from this origin
 *
 * Exact paths (2) always beat folder matching (3). Matching is
 * case-insensitive. If the same path is listed under two origins, the
 * origin that appears first in the object wins.
 *
 * ── EXAMPLES ───────────────────────────────────────────────────────────────
 *
 * "The new /pricing page is ready"
 *   → Add '/pricing' to EXACT_PATHS.new
 *
 * "The whole /product section is rebuilt (including all subpages)"
 *   → Add 'product' to PATHS.new
 *     Routes /product, /product/anything, /product/a/b/c — everything.
 *
 * "Move /blog/one-post to the new site but keep the rest of /blog old"
 *   → Add '/blog/one-post' to EXACT_PATHS.new only.
 *
 * "The homepage is ready"
 *   → Add '/' to EXACT_PATHS.new
 *
 * "A migrated page is broken — send it back to the old site"
 *   → Remove its entry, redeploy. ~2 minutes.
 *
 * "/old-page should redirect to /new-page"
 *   → Add to REDIRECTS: { '/old-page': '/new-page' }
 *
 * "Most pages are migrated — flip the default"
 *   → Set DEFAULT_ORIGIN to 'new', then list the stragglers that must stay
 *     on the old site in PATHS.old / EXACT_PATHS.old.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. ORIGIN KEYS & DEFAULT
// ─────────────────────────────────────────────────────────────────────────────

/** Add new origin keys here (see "ORIGINS" above for the 3-step recipe). */
export type Origin = 'new' | 'old';

/**
 * Where traffic goes when a path doesn't match any list below.
 *
 * - 'old' → during migration: unknown/unlisted pages fall back to the live site
 * - 'new' → after migration: unknown pages default to the new site
 */
export const DEFAULT_ORIGIN: Origin = 'old';

// ─────────────────────────────────────────────────────────────────────────────
// 2. EXACT-PATH ROUTING (single pages)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Specific full paths served by each origin (exact match, must start with /).
 * Use for single pages when the rest of the folder stays elsewhere.
 * Checked before folder matching, so these always win.
 */
export const EXACT_PATHS: Record<Origin, string[]> = {
  // Demo inventory. In a real migration this list grows one line at a time:
  // a page is rebuilt on the new site, reviewed, its path is added here, and
  // the deploy moves live traffic for that single URL. Removing the line
  // moves it straight back.
  new: [
    '/',
    '/enterprise',
    '/landing/get-the-extension',
    '/pricing',
    '/product/guide',
    '/product/it-documentation',
    '/see-it-in-action',
  ],
  old: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. FOLDER ROUTING (whole sections)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Top-level path segments served by each origin (folder match).
 *
 * Matches the FIRST segment only: adding 'product' under `new` routes
 * /product, /product/voice, /product/anything/nested — all of it.
 *
 * Note: while DEFAULT_ORIGIN is 'old', the `old` list has no practical
 * effect (unlisted paths already go there). It matters AFTER the default
 * flips to 'new' — those paths are held back on the old site.
 *
 * Keep lists sorted alphabetically.
 */
export const PATHS: Record<Origin, string[]> = {
  new: [
    // 'product',
  ],
  old: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. REDIRECTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Static 301 redirect map. Checked BEFORE routing.
 *
 * Keys: exact pathname (must start with /).
 * Values: destination — either a path ('/new-page', kept on the same host)
 * or a full URL ('https://elsewhere.com/page').
 *
 * Prefer the new site's built-in 301 redirects (Webflow: Site Settings →
 * Publishing → 301 Redirects) for any path already routed to the new site —
 * no deploy needed there. Use this map only for paths the Worker routes to
 * the old site (those requests never reach the new site, so its redirects
 * can't fire), or when you need Worker-level control.
 *
 * Examples:
 *   '/old-pricing': '/pricing',
 *   '/webinar-2024': 'https://example.com/event',
 */
export const REDIRECTS: Record<string, string> = {};

// ─────────────────────────────────────────────────────────────────────────────
// 5. BEHAVIOR TOGGLES (rarely touched)
// ─────────────────────────────────────────────────────────────────────────────

/** 301 /path/ → /path (root "/" is never redirected). */
export const STRIP_TRAILING_SLASH = true;

/**
 * Custom robots.txt served by the Worker on allowed hosts.
 *
 * null → /robots.txt is proxied like any other path (whichever origin owns
 * it per the routing above serves its own robots.txt).
 *
 * Set to a function when the split-origin setup needs a combined robots.txt
 * that no single origin can serve alone, e.g.:
 *
 *   (host) => ['User-agent: *', 'Allow: /', '', `Sitemap: https://${host}/sitemap.xml`, ''].join('\n')
 */
export const CUSTOM_ROBOTS_TXT: ((host: string) => string) | null = null;

/**
 * Rewrite origin hostnames inside HTML responses to the visitor's host.
 *
 * Needed when an origin's published HTML contains absolute URLs pointing at
 * its internal hostname (internal links, og: tags, canonicals) that would
 * otherwise leak. Prefer fixing at the source (Webflow: <base href> +
 * canonical settings); enable per-origin only if that's not
 * possible. Costs buffering the full HTML body per request.
 */
export const REWRITE_HTML: Record<Origin, boolean> = {
  new: false,
  old: false,
};

/**
 * Extra request headers sent to a specific origin on every proxied fetch.
 *
 * Escape hatch for origin-side edge rules. Real example, implemented in
 * apps/proxy-dual-origin: the old origin had a host-level 301 back to the
 * primary domain, which would loop through the Worker — an edge Redirect
 * Rule was set to skip requests carrying an opaque marker header, sent
 * from here.
 *
 *   old: { 'X-Skip-Origin-Redirect': '<opaque-token>' },
 */
export const EXTRA_ORIGIN_HEADERS: Record<Origin, Record<string, string>> = {
  new: {},
  old: {},
};

/**
 * Response headers stripped before returning to the visitor, so nobody can
 * tell which backend served the page. Extend per origin platform.
 */
export const STRIP_RESPONSE_HEADERS: string[] = ['x-served-by', 'x-cache'];

// ─────────────────────────────────────────────────────────────────────────────
// 6. SECURITY HEADERS (ported 1:1 from the site's existing CSP worker)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Content-Security-Policy directives, copied VERBATIM from the standalone
 * CSP worker this proxy absorbs (the array passed to
 * newHeaders.set("Content-Security-Policy", ...)). The final header string is
 * assembled in src/security.ts with the same join logic, so the output is
 * byte-identical to what the live site sends today.

 * Absorbing the existing worker rather than chaining behind it is deliberate:
 * two Workers on one route means two hops, two places to debug, and an
 * ordering dependency at exactly the moment traffic is being cut over.
 *
 * During the migration this list is the single place to maintain the policy:
 * when a new-site page needs a third-party domain that isn't allowed yet, add
 * it to the matching directive below and deploy. Every entry change alters the
 * site's security posture — treat edits like any config change (internal
 * review).
 */
export const CSP_DIRECTIVES: string[][] = [
  // ⚠️ DEMO POLICY. This is a representative, deliberately small allowlist
  // that shows the SHAPE of a ported policy — not a policy to deploy as-is.
  // A real one is copied verbatim from whatever is serving the header today
  // (an existing standalone worker, an origin config, a CDN rule) and is
  // typically several hundred entries long, because every analytics, chat,
  // A/B-testing, video and form vendor the marketing site loads needs its own
  // host listed. Getting a single entry wrong takes a third-party script off
  // the page, so the port is mechanical: copy, don't rewrite.
  [
    "default-src 'self'",
    '*.example.com',
    '*.website-files.com',
    '*.webflow.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'www.google-analytics.com',
  ],
  [
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    '*.example.com',
    '*.cloudflareinsights.com',
    '*.website-files.com',
    'cdn.jsdelivr.net',
    'connect.facebook.net',
    'js.hs-scripts.com',
    'unpkg.com',
    'www.google-analytics.com',
    'www.googletagmanager.com',
  ],
  [
    "style-src 'self' 'unsafe-inline'",
    '*.website-files.com',
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
    'unpkg.com',
  ],
  [
    "font-src 'self'",
    '*.webflow.com',
    'cdn.prod.website-files.com',
    'data:',
    'fonts.gstatic.com',
  ],
  [
    "frame-src 'self'",
    '*.example.com',
    'player.vimeo.com',
    'www.googletagmanager.com',
    'www.youtube-nocookie.com',
    'www.youtube.com',
  ],
  ["worker-src 'self' blob:"],
  [
    "connect-src 'self'",
    '*.example.com',
    '*.website-files.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'www.google-analytics.com',
  ],
  ["frame-ancestors 'self'"],
  ["object-src 'none'"],
  ["base-uri 'self'"],
  [
    "img-src 'self'",
    '*.example.com',
    '*.website-files.com',
    '*.ytimg.com',
    'blob:',
    'data:',
    'www.google-analytics.com',
    'www.googletagmanager.com',
  ],
  ['upgrade-insecure-requests'],
];

/**
 * Non-CSP security headers set on every response, same values as the absorbed
 * worker's DEFAULT_SECURITY_HEADERS.
 */
export const EXTRA_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * Headers deleted from every response, same list as the absorbed worker's
 * BLOCKED_HEADERS (legacy/fingerprinting headers no origin should expose).
 */
export const BLOCKED_RESPONSE_HEADERS: string[] = [
  'Public-Key-Pins',
  'X-Powered-By',
  'X-AspNet-Version',
];

/**
 * Reject visitors on TLS < 1.2 with the same 400 response as the absorbed
 * worker. Enforced at the edge against the visitor's real TLS handshake.
 */
export const ENFORCE_MIN_TLS = true;

// ─────────────────────────────────────────────────────────────────────────────
// 7. CRAWLER ANALYTICS (ported from the analytics worker)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Endpoint the page-view log is POSTed to — same endpoint and JSON schema as
 * the standalone analytics worker this proxy absorbs, but logging the
 * response this proxy actually served instead of re-fetching the URL. Events only fire on environments where the ANALYTICS_KEY secret is
 * set (see src/analytics.ts). null disables logging everywhere.
 */
export const ANALYTICS_ENDPOINT: string | null = 'https://analytics.example-vendor.com/event';
