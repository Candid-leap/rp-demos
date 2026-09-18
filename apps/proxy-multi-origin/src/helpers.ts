import {
  DEFAULT_ORIGIN,
  EXACT_PATHS,
  EXTRA_ORIGIN_HEADERS,
  PATHS,
  REWRITE_HTML,
  type Origin,
} from './config';

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

// Sets are built once at module load — the lists are static config, not
// request state. Everything is lowercased so matching is case-insensitive.
// Origin order = key order in config.ts; on a conflict the earlier key wins.
const ORIGIN_ORDER = Object.keys(EXACT_PATHS) as Origin[];

const exactSets = {} as Record<Origin, Set<string>>;
const folderSets = {} as Record<Origin, Set<string>>;
for (const origin of ORIGIN_ORDER) {
  exactSets[origin] = new Set(EXACT_PATHS[origin].map((p) => p.toLowerCase()));
  folderSets[origin] = new Set(PATHS[origin].map((p) => p.toLowerCase()));
}

/**
 * Determine which origin serves this request.
 *
 * Check order:
 *   1. Exact full-path match (e.g. '/pricing')
 *   2. Folder match on the first segment (e.g. 'product' matches /product/*)
 *   3. DEFAULT_ORIGIN
 */
export function get_target(pathname: string): Origin {
  const normalized = pathname.toLowerCase();

  // Exact path match takes priority
  for (const origin of ORIGIN_ORDER) {
    if (exactSets[origin].has(normalized)) return origin;
  }

  // Folder-based match on the first segment
  const firstSegment = normalized.split('/')[1] ?? '';
  if (firstSegment) {
    for (const origin of ORIGIN_ORDER) {
      if (folderSets[origin].has(firstSegment)) return origin;
    }
  }

  return DEFAULT_ORIGIN;
}

// ---------------------------------------------------------------------------
// Proxy helpers
// ---------------------------------------------------------------------------

/**
 * Rewrites the Location header on redirect responses so the origin's
 * hostname doesn't leak to visitors.
 */
export function rewrite_redirect(
  response: Response,
  origin_host: string,
  visitor_host: string
): Response {
  const location = response.headers.get('Location');
  if (!location) return response;

  const rewritten = location.replace(
    new RegExp(`https?://${escape_regex(origin_host)}`, 'gi'),
    `https://${visitor_host}`
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
 * Fetch from the target origin with the correct Host header and forwarding
 * headers. Uses redirect: 'manual' so the Worker can intercept and rewrite
 * Location headers instead of following them server-side.
 */
export async function proxy_fetch(
  request: Request,
  target_url: string,
  origin_hostname: string,
  visitor_ip: string,
  origin: Origin
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('Host', origin_hostname);
  headers.set('X-Forwarded-Host', new URL(request.url).hostname);
  headers.set('X-Forwarded-For', visitor_ip);
  headers.set('X-Forwarded-Proto', 'https');

  for (const [name, value] of Object.entries(EXTRA_ORIGIN_HEADERS[origin])) {
    headers.set(name, value);
  }

  // When rewriting HTML we need the uncompressed body — same-zone subrequests
  // on Cloudflare's edge are not auto-decompressed, which breaks response.text().
  if (REWRITE_HTML[origin]) {
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
