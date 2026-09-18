import {
  DEFAULT_ORIGIN,
  WEBFLOW_PATHS,
  WEBFLOW_EXACT_PATHS,
  HUBSPOT_PATHS,
  HUBSPOT_EXACT_PATHS,
} from './constants';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Returns true when the pathname ends with a trailing slash (ignoring root). */
export function has_trailing_slash(pathname: string): boolean {
  return pathname.length > 1 && pathname.endsWith('/');
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

export type Target = 'webflow' | 'hubspot';

// Folder-based (first segment)
const webflowFolderSet = new Set(WEBFLOW_PATHS);
const hubspotFolderSet = new Set(HUBSPOT_PATHS);

// Exact full-path matching
const webflowExactSet = new Set(WEBFLOW_EXACT_PATHS);
const hubspotExactSet = new Set(HUBSPOT_EXACT_PATHS);

/**
 * Determine which origin serves this request.
 *
 * Check order:
 *   1. Exact full-path match (e.g. '/event/annual-summit')
 *   2. Folder match on first segment (e.g. 'product' matches /product/*)
 *   3. Default origin
 *
 * Root (/) always goes to Webflow.
 */
export function get_target(pathname: string): Target {
  // Root — always Webflow
  if (pathname === '/') return 'webflow';

  // Normalize to lowercase for case-insensitive matching
  const normalized = pathname.toLowerCase();

  // Exact path match takes priority
  if (webflowExactSet.has(normalized)) return 'webflow';
  if (hubspotExactSet.has(normalized)) return 'hubspot';

  // Folder-based match on first segment
  const firstSegment = normalized.split('/')[1] ?? '';
  if (firstSegment && webflowFolderSet.has(firstSegment)) return 'webflow';
  if (firstSegment && hubspotFolderSet.has(firstSegment)) return 'hubspot';

  return DEFAULT_ORIGIN;
}

// ---------------------------------------------------------------------------
// Proxy helpers
// ---------------------------------------------------------------------------

/**
 * Rewrites Location headers on redirect responses so the origin's hostname
 * doesn't leak to visitors.
 */
export function rewrite_redirect(response: Response, origin_host: string, primary_host: string): Response {
  const location = response.headers.get('Location');
  if (!location) return response;

  const rewritten = location.replace(
    new RegExp(`https?://${escape_regex(origin_host)}`, 'gi'),
    `https://${primary_host}`
  );

  if (rewritten === location) return response;

  const headers = new Headers(response.headers);
  headers.set('Location', rewritten);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Fetch from the target origin with correct Host header and forwarding headers.
 * Uses redirect: 'manual' so we can intercept and rewrite Location headers.
 */
export async function proxy_fetch(
  request: Request,
  target_url: string,
  origin_hostname: string,
  visitor_ip: string,
  forceIdentity: boolean = false
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('Host', origin_hostname);
  headers.set('X-Forwarded-Host', new URL(request.url).hostname);
  headers.set('X-Forwarded-For', visitor_ip);
  headers.set('X-Forwarded-Proto', 'https');
  // Paired with the edge Redirect Rule on the legacy-CMS origin host: that
  // rule 301s the origin host back to the public host, which would loop when
  // the proxy fetches the origin. The rule is written to SKIP requests
  // carrying this header, so the proxy's own subrequests pass through.
  //
  // The value is an opaque marker, not a secret (it ships in source) — it is
  // only long and random so an outside client can't guess the bypass the way
  // it could with a trivial "1". Generate one with `openssl rand -hex 32` and
  // set the SAME value here and in the rule expression
  // (terraform/main.tf → hs_subdomain_redirect). Changing one side without
  // the other reintroduces the redirect loop.
  headers.set('X-Skip-HS-Redirect', 'REPLACE-WITH-A-RANDOM-64-HEX-TOKEN');
  if (forceIdentity) {
    headers.set('Accept-Encoding', 'identity');
  }

  return fetch(target_url, {
    method: request.method,
    headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    redirect: 'manual',
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function escape_regex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
