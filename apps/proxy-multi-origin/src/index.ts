import {
  CUSTOM_ROBOTS_TXT,
  REDIRECTS,
  REWRITE_HTML,
  STRIP_RESPONSE_HEADERS,
  STRIP_TRAILING_SLASH,
  type Origin,
} from './config';
import { get_target, has_trailing_slash, proxy_fetch, rewrite_redirect } from './helpers';
import { origin_urls } from './origins';
import { log_page_view } from './analytics';
import { apply_security_headers, tls_rejection } from './security';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // Parse the allowed-hosts list. First entry is the canonical/primary host.
    const allowedHosts = env.ALLOWED_HOSTS.split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const isLocalDev = hostname === 'localhost' || hostname === '127.0.0.1';

    // Does the request's hostname match any allowed host (exact or subdomain)?
    const isAllowedHost = allowedHosts.some((h) => {
      if (hostname === h) return true;
      const base = h.startsWith('www.') ? h.slice(4) : h;
      return hostname.endsWith(`.${base}`);
    });

    // Resolve every origin's URL and hostname once per request.
    const urls = origin_urls(env);
    const originHosts = {} as Record<Origin, string>;
    for (const [key, value] of Object.entries(urls) as [Origin, string][]) {
      originHosts[key] = new URL(value).hostname;
    }

    // Internal origin hostnames. The allowed-host guard matters: an origin
    // may be the primary host itself (see README → "Fetching the origin
    // without looping"), and the primary
    // host must never be treated as an internal origin.
    const isInternalOriginHost =
      Object.values(originHosts).includes(hostname) && allowedHosts.indexOf(hostname) === -1;

    // Noindex everything on internal origin subdomains, and everywhere when
    // the environment says so (staging).
    const forceNoindex = isInternalOriginHost || env.NOINDEX === 'true';

    // Deployment Version ID (via the version_metadata binding, where
    // configured) — stamped as X-RP-Build so any response can be traced to
    // the exact deployment in the dashboard.
    const buildId = (env as { CF_VERSION_METADATA?: { id: string } }).CF_VERSION_METADATA?.id;

    // SEO protection: internal origin subdomains must never be crawled.
    if (isInternalOriginHost && url.pathname === '/robots.txt') {
      return apply_security_headers(
        new Response('User-agent: *\nDisallow: /', {
          headers: { 'Content-Type': 'text/plain', 'X-Robots-Tag': 'noindex, nofollow' },
        }),
        buildId
      );
    }

    // Unknown-host passthrough — not ours, don't touch it (no security
    // headers stamped either: this traffic belongs to whoever owns the host).
    if (!isLocalDev && !isAllowedHost && !isInternalOriginHost) {
      return fetch(request);
    }

    // ── Absorbed from the previous CSP worker (see src/security.ts) ──

    // TLS gate — same policy and response as the absorbed worker. Logged
    // like everything else: the old setup fired its analytics call before
    // this gate, so rejected requests were logged there too.
    const tlsReject = tls_rejection(request);
    if (tlsReject) {
      log_page_view(request, tlsReject, env, ctx);
      return tlsReject;
    }

    // Every response below this point gets the security headers (CSP etc.)
    // stamped on the way out, and is logged to crawler analytics with the
    // status the visitor actually received (src/analytics.ts — replaces
    // the old worker's re-fetch, which bypassed this proxy).
    const response = apply_security_headers(await handle(), buildId);
    log_page_view(request, response, env, ctx);
    return response;

    async function handle(): Promise<Response> {
      // Trailing slash removal — preserve the visitor's host and query string.
      if (STRIP_TRAILING_SLASH && has_trailing_slash(url.pathname)) {
        const clean = url.pathname.slice(0, -1) + url.search;
        return Response.redirect(`https://${hostname}${clean}`, 301);
      }

      // Custom robots.txt (only when configured — otherwise proxied like any path).
      if (CUSTOM_ROBOTS_TXT && url.pathname === '/robots.txt' && !isInternalOriginHost) {
        return new Response(CUSTOM_ROBOTS_TXT(hostname), {
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      // Static redirects — path values stay on the visitor's host.
      const redirectTarget = REDIRECTS[url.pathname];
      if (redirectTarget) {
        const absolute = redirectTarget.startsWith('/')
          ? `https://${hostname}${redirectTarget}`
          : redirectTarget;
        return Response.redirect(absolute, 301);
      }

      // Route matching
      const target = get_target(url.pathname);
      const originBase = urls[target].replace(/\/+$/, '');
      const originHostname = originHosts[target];
      const originUrl = `${originBase}${url.pathname}${url.search}`;

      const visitorIp =
        request.headers.get('CF-Connecting-IP') ||
        request.headers.get('X-Forwarded-For') ||
        '127.0.0.1';

      // Proxy fetch with error handling
      let response: Response;
      try {
        response = await proxy_fetch(request, originUrl, originHostname, visitorIp, target);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return new Response(`Origin unreachable: ${target}`, {
          status: 502,
          headers: { 'Content-Type': 'text/plain', 'X-Origin': target, 'X-Error': message },
        });
      }

      // Rewrite redirect Location headers — keep the visitor on the same host.
      if (response.status >= 300 && response.status < 400) {
        response = rewrite_redirect(response, originHostname, hostname);
      }

      // Clean response headers and tag by origin for targeted cache purging.
      const headers = new Headers(response.headers);
      for (const name of STRIP_RESPONSE_HEADERS) {
        headers.delete(name);
      }
      headers.set('X-Origin', target);
      headers.set('Cache-Tag', `origin-${target}`);
      if (forceNoindex) {
        headers.set('X-Robots-Tag', 'noindex, nofollow');
      }

      // Optional HTML rewrite: replace origin-host URLs with the visitor's host
      // so internal links, og: tags, etc. stay on the domain they entered through.
      const isHtml = headers.get('content-type')?.includes('text/html') ?? false;
      if (isHtml && REWRITE_HTML[target]) {
        headers.delete('content-encoding');
        headers.delete('content-length');
        const text = await response.text();
        const rewritten = text
          .replaceAll(`http://${originHostname}`, `https://${hostname}`)
          .replaceAll(`https://${originHostname}`, `https://${hostname}`)
          .replaceAll(`http:\\/\\/${originHostname}`, `https:\\/\\/${hostname}`)
          .replaceAll(`https:\\/\\/${originHostname}`, `https:\\/\\/${hostname}`)
          .replaceAll(`//${originHostname}`, `//${hostname}`)
          .replaceAll(`"${originHostname}`, `"${hostname}`)
          .replaceAll(`'${originHostname}`, `'${hostname}`);
        return new Response(rewritten, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  },
} satisfies ExportedHandler<Env>;
