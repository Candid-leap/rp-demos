import { ANALYTICS_ENDPOINT } from './config';

/**
 * Crawler-analytics logging, ported from the standalone analytics worker
 * this proxy absorbs, with one deliberate change: no re-fetch. The original worker fetched the URL itself to learn the
 * status — on this zone that fetch bypasses Worker routes, so during the
 * migration its logs would drift from what visitors actually got. Here the
 * log records the exact response the proxy served. Field names and
 * derivation are otherwise identical, so events match the schema the
 * analytics side already expects.
 *
 * No-op unless the ANALYTICS_KEY secret is set on the environment
 * (`wrangler secret put ANALYTICS_KEY --env <env>`) — rehearsal and local
 * dev never send events.
 */
export function log_page_view(
  request: Request,
  response: Response,
  env: Env,
  ctx: ExecutionContext
): void {
  const analyticsKey = (env as { ANALYTICS_KEY?: string }).ANALYTICS_KEY;
  if (!ANALYTICS_ENDPOINT || !analyticsKey) {
    return;
  }

  const { pathname, search } = new URL(request.url);
  const contentType = response.headers.get('content-type')?.split(';')[0];
  const queryString = search.startsWith('?') && search.length > 1 ? search.slice(1) : null;

  const log = {
    timestamp: new Date().toISOString(),
    status_code: response.status,
    request_method: request.method,
    request_path: pathname,
    query_string: queryString,
    content_type: contentType,
    client_ip: request.headers.get('CF-Connecting-IP') || null,
    hostname: request.headers.get('Host') || null,
    user_agent: request.headers.get('User-Agent') || null,
    referrer: request.headers.get('Referer') || null,
  };

  // Fire-and-forget — never delays the visitor (same as the original worker).
  ctx.waitUntil(
    fetch(ANALYTICS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': analyticsKey,
      },
      body: JSON.stringify(log),
    }).catch(() => {})
  );
}
