import {
  BLOCKED_RESPONSE_HEADERS,
  CSP_DIRECTIVES,
  ENFORCE_MIN_TLS,
  EXTRA_SECURITY_HEADERS,
} from './config';

/**
 * The final Content-Security-Policy string, assembled once at module load
 * with the SAME join logic as the absorbed CSP worker: entries within a
 * directive joined by
 * a space, directives joined by "; ", plus a trailing ";". Identical input
 * arrays + identical join = byte-identical header to the live site.
 *
 * Keep a written porting record of every deliberate deviation from the
 * original worker (timing, guards, the X-RP-Build header, stamping
 * coverage) — it is what makes the port reviewable.
 */
export const CSP_VALUE = CSP_DIRECTIVES.map((directive) => directive.join(' ')).join('; ') + ';';

/**
 * Reject visitors on TLS < 1.2 — same check and same response as the
 * absorbed CSP worker. Runs before any origin fetch (the original checked
 * after fetching; the visitor-visible result is identical, we just skip the
 * wasted fetch).
 *
 * `request.cf` is present on every real edge request; it's only missing in
 * local dev, where the gate is skipped.
 */
export function tls_rejection(request: Request): Response | null {
  if (!ENFORCE_MIN_TLS) return null;
  const tlsVersion = request.cf?.tlsVersion;
  if (tlsVersion === undefined) return null;
  if (tlsVersion !== 'TLSv1.2' && tlsVersion !== 'TLSv1.3') {
    return new Response('You need to use TLS version 1.2 or higher.', { status: 400 });
  }
  return null;
}

/**
 * Stamp the security headers (CSP + the extras) and delete the blocked
 * legacy headers — the absorbed worker's addSecurityHeaders() behavior,
 * applied to every response this Worker returns on hosts it serves.
 */
export function apply_security_headers(response: Response, buildId?: string): Response {
  const headers = new Headers(response.headers);
  // Diagnostic marker: the deployment Version ID (from the version_metadata
  // binding, where configured). If a response carries this header but the
  // wrong CSP, something outside the Worker is overriding headers after us;
  // if it's missing entirely, the request never went through this code.
  if (buildId) {
    headers.set('X-RP-Build', buildId);
  }
  headers.set('Content-Security-Policy', CSP_VALUE);
  for (const [name, value] of Object.entries(EXTRA_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  for (const name of BLOCKED_RESPONSE_HEADERS) {
    headers.delete(name);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
