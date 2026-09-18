import { Hono } from 'hono';
import type { Env } from './context';
import { REDIRECTS } from './constants';
import { get_target, has_trailing_slash, proxy_fetch, rewrite_redirect } from './helpers';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c) => {
  const url = new URL(c.req.url);
  const hostname = url.hostname;

  // Parse the allowed-hosts list. First entry is the canonical/primary host
  // (used wherever a single name is required — e.g. Webflow subdomain detection).
  const allowedHosts = c.env.ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean);
  const primaryHost = allowedHosts[0];
  const primaryBase = primaryHost.startsWith('www.') ? primaryHost.slice(4) : primaryHost;

  const wfOriginHost = new URL(c.env.WEBFLOW_ORIGIN).hostname;
  const wfHost = wfOriginHost.endsWith(`.${primaryBase}`) ? wfOriginHost : null;
  const isLocalDev = hostname === 'localhost' || hostname === '127.0.0.1';

  // Does the request's hostname match any allowed host (exact or subdomain match)?
  const isAllowedHost = allowedHosts.some((h) => {
    if (hostname === h) return true;
    const base = h.startsWith('www.') ? h.slice(4) : h;
    return hostname.endsWith(`.${base}`);
  });

  // Webflow subdomain SEO protection: block crawlers and prevent indexing
  const isWebflowSubdomain = wfHost && hostname === wfHost;
  if (isWebflowSubdomain && url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /', {
      headers: { 'Content-Type': 'text/plain', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  }

  // Unknown-host passthrough (anything not in ALLOWED_HOSTS and not localdev)
  if (!isLocalDev && !isAllowedHost) {
    return fetch(c.req.raw);
  }

  // Trailing slash removal — preserve the visitor's host
  if (has_trailing_slash(url.pathname)) {
    const clean = url.pathname.slice(0, -1) + url.search;
    return c.redirect(`https://${hostname}${clean}`, 301);
  }

  // Custom robots.txt — served on any allowed host with that host's sitemap URL
  if (url.pathname === '/robots.txt' && (isAllowedHost || isLocalDev)) {
    return new Response(
      [
        '# Served by Cloudflare Worker',
        'User-agent: *',
        'Disallow: /sample-*',
        'Disallow: /blog/sample-*',
        '',
        '',
        'Disallow: /_hcms/preview/',
        'Disallow: /hs/manage-preferences/',
        'Disallow: /hs/preferences-center/',
        'Disallow: /*?*hs_preview=*',
        'Disallow: /*?*hsCacheBuster=*',
        '',
        `Sitemap: https://${hostname}/sitemap.xml`,
        '',
      ].join('\n'),
      { headers: { 'Content-Type': 'text/plain' } }
    );
  }

  // Static redirects
  const redirectTarget = REDIRECTS[url.pathname];
  if (redirectTarget) {
    return c.redirect(redirectTarget, 301);
  }

  // Route matching
  const target = get_target(url.pathname);

  const originUrl =
    target === 'webflow'
      ? `${c.env.WEBFLOW_ORIGIN}${url.pathname}${url.search}`
      : `${c.env.HUBSPOT_ORIGIN}${url.pathname}${url.search}`;

  const originHostname = new URL(target === 'webflow' ? c.env.WEBFLOW_ORIGIN : c.env.HUBSPOT_ORIGIN).hostname;

  // Proxy fetch with error handling
  const visitorIp = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '127.0.0.1';

  // Force uncompressed for HubSpot HTML — same-zone subrequests on Cloudflare's
  // edge don't auto-decompress, which breaks response.text() for rewriting
  const needsRewrite = target === 'hubspot';
  let response: Response;
  try {
    response = await proxy_fetch(c.req.raw, originUrl, originHostname, visitorIp, needsRewrite);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(`Origin unreachable: ${target}`, {
      status: 502,
      headers: {
        'Content-Type': 'text/plain',
        'X-Origin': target,
        'X-Error': message,
      },
    });
  }

  // Rewrite redirect Location headers — keep the visitor on the same host
  if (response.status >= 300 && response.status < 400) {
    response = rewrite_redirect(response, originHostname, hostname);
  }

  // Clean response headers and tag by origin for cache purging
  const headers = new Headers(response.headers);
  headers.delete('x-served-by');
  headers.delete('x-cache');
  headers.set('X-Origin', target);
  headers.set('Cache-Tag', `origin-${target}`);

  // Prevent indexing of Webflow subdomain on all responses
  if (isWebflowSubdomain) {
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  const isHtml = headers.get('content-type')?.includes('text/html');
  headers.set('X-Rewrite', isHtml ? `${originHostname}->${hostname}` : 'skip');

  if (isHtml && needsRewrite) {
    headers.delete('content-encoding');
    headers.delete('content-length');
    const text = await response.text();
    // Rewrite origin URLs to the visitor's host so internal links stay on the
    // domain they entered through (rather than being collapsed to a primary).
    const rewritten = text.replaceAll(`http://${originHostname}`, `https://${hostname}`)
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
});

export default app;
