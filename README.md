# Reverse-Proxy Site Migration — Reference Implementations

**Two production reverse proxies that let a live website be replatformed one page at a time, with zero downtime and instant rollback.**

This repository is a sanitised, self-contained extract of two real migrations we ran. Both shipped, both carried live commercial traffic, and both are included here in full source so the technique can be reviewed rather than described.

The platform in this code is Cloudflare Workers, because that is where these two ran. **The technique is not Cloudflare-specific.** [Running this somewhere else](#running-this-somewhere-else) maps every moving part onto Azure (Front Door + Functions), AWS and a self-hosted nginx setup. Roughly 80% of the code — the routing table and everything under [The hard parts](#the-hard-parts) — is platform-independent; what changes is the fetch and header API around it.

---



## Contents

1. [The problem this solves](#the-problem-this-solves)
2. [The concept](#the-concept)
3. [Request lifecycle](#request-lifecycle)
4. [The routing table](#the-routing-table)
5. [Repository layout](#repository-layout)
6. [The two implementations](#the-two-implementations)
7. [The hard parts](#the-hard-parts)
8. [How a migration actually runs](#how-a-migration-actually-runs)
9. [Verification scripts](#verification-scripts)
10. [Infrastructure as code](#infrastructure-as-code)
11. [Running this somewhere else](#running-this-somewhere-else)
12. [Lineage and credits](#lineage-and-credits)
13. [Local development](#local-development)
14. [About this copy](#about-this-copy)

---



## The problem this solves

A company wants to move its marketing site from one platform to another — legacy CMS to a modern one, one site builder to another, a monolith to a headless stack. The usual plan is a **big-bang cutover**: rebuild everything, pick a Saturday night, flip DNS, and hope.

That plan fails in predictable ways:

- **It is all-or-nothing.** The new site cannot go live until the *last* page is rebuilt. A 400-page site means months before anything ships, and the whole thing lands at once.
- **Rollback is a DNS change**, which means TTL-bound propagation measured in hours — during which some visitors see the new site and some the old one.
- **SEO is bet on a single night.** Every URL changes hands simultaneously. A missed redirect is a ranked page turning into a 404 at exactly the moment nobody is watching.
- **Nothing can be rehearsed.** The first time the new setup handles real traffic is the moment it *is* real traffic.
- **The pressure is on the wrong people.** Content, SEO, paid media and engineering are all forced onto one date.

The reverse-proxy approach removes the date entirely.

## The concept

Put a small programmable layer in front of the domain. It sits between visitors and *both* platforms, and for every request it decides which backend should answer.

```
                        ┌──────────────────────────────┐
   visitor              │        REVERSE PROXY         │
   ───────────────────▶ │  (Worker / Front Door rule / │
   https://example.com  │   Function / nginx)          │
   /pricing             │                              │
                        │  1. redirect table?          │
                        │  2. exact path match?        │
                        │  3. folder match?            │
                        │  4. default origin           │
                        └───────┬──────────────┬───────┘
                                │              │
                  matched 'new' │              │ everything else
                                ▼              ▼
                     ┌──────────────┐   ┌──────────────┐
                     │   NEW SITE   │   │  LEGACY CMS  │
                     │  (rebuilt    │   │  (untouched, │
                     │   pages)     │   │   still live)│
                     └──────────────┘   └──────────────┘

         Visitors, search engines and analytics only ever see
         one domain. Neither backend knows the other exists.
```

The consequences are the whole point:


|                                 | Big-bang cutover             | Reverse proxy                        |
| ------------------------------- | ---------------------------- | ------------------------------------ |
| **Unit of release**             | The entire site              | One URL                              |
| **Time to first value**         | After the last page          | After the first page                 |
| **Rollback**                    | DNS change, hours            | Delete one line, redeploy, ~1–2 min  |
| **Blast radius of a mistake**   | Every page                   | The one page you just moved          |
| **Rehearsable?**                | No                           | Yes, end to end, on a domain you own |
| **Both platforms live at once** | No                           | Yes, indefinitely                    |
| **URL structure**               | Must change or be redirected | Unchanged — same domain throughout   |


The last row matters more than it looks. Because the public hostname never changes, **no URL ever moves**. There is no redirect map to maintain for migrated pages, no link equity to shepherd, no `Change of Address` in Search Console. `/pricing` is `/pricing` before and after; only the machine answering it changed.

A migration stops being an event and becomes a slider you move from 0% to 100% at whatever rate the content team can actually sustain.

## Request lifecycle

Every request runs the same sequence. Both implementations follow it; the code is `src/index.ts` in each.

1. **Host check.** Is this hostname one we serve? If not — pass the request through completely untouched. This is the fail-safe: a route attached by mistake cannot break a hostname the proxy was never configured for.
2. **Origin-hostname guard.** If the request arrived on an internal origin hostname (the new site's own subdomain, say) serve a `Disallow: /` robots and stamp `noindex`. Internal hostnames must never be crawled or indexed — that is how a migration ends up with two copies of every page in the index.
3. **TLS floor** *(multi-origin only)*. Reject TLS < 1.2 with a 400, before any origin fetch.
4. **Trailing-slash normalisation.** `301 /path/ → /path`, preserving host and query.
5. **Synthesised** `robots.txt` *(optional)*. When two backends each serve their own, neither is correct — the proxy serves a combined one with the right `Sitemap:` line for the host actually being visited.
6. **Redirect table.** Exact-path 301s, checked *before* routing, so a path can be redirected even when it lives on a backend that would otherwise answer it.
7. **Routing.** Exact path → folder → default. See below.
8. **Origin fetch.** Correct `Host` header, `X-Forwarded-*` set, `redirect: 'manual'` so redirects are ours to rewrite, plus any per-origin escape-hatch headers.
9. **Redirect rewriting.** Any `Location` pointing at the origin's internal hostname is rewritten to the visitor's hostname, so the backend's identity never leaks into the address bar.
10. **Response-header hygiene.** Strip backend fingerprints, stamp `X-Origin` (which backend answered) and `Cache-Tag` (so one backend's pages can be purged without touching the other's).
11. **HTML rewriting** *(optional, per-origin)*. Replace absolute origin URLs in the body with the visitor's host.
12. **Security headers** *(multi-origin only)*. CSP and friends stamped on *every* response, including synthesised ones and error paths.
13. **Analytics** *(multi-origin only)*. Fire-and-forget page-view log of the response actually served.



## The routing table

The entire migration state lives in one file, and it is deliberately boring:

- `apps/proxy-dual-origin/src/constants.ts`
- `apps/proxy-multi-origin/src/config.ts`

```ts
export const EXACT_PATHS: Record<Origin, string[]> = {
  new: [
    '/',
    '/pricing',
    '/product/guide',
  ],
  old: [],
};

export const PATHS: Record<Origin, string[]> = {
  new: ['product'],   // /product and everything under it
  old: [],
};

export const DEFAULT_ORIGIN: Origin = 'old';
```

Resolution order, first match wins:

1. `REDIRECTS` — exact path → 301
2. `EXACT_PATHS` — exact full path → that origin
3. `PATHS` — first path segment → that origin
4. `DEFAULT_ORIGIN` — everything unmatched

Matching is case-insensitive, and exact paths always beat folder matches — so a single page can be pulled forward out of a section that is otherwise still on the old platform, or held back from one that has otherwise moved.

**Day-to-day, the migration is this workflow:**


| Situation                        | Action                                                                  |
| -------------------------------- | ----------------------------------------------------------------------- |
| A page is rebuilt and approved   | Add its path to `EXACT_PATHS.new`, deploy                               |
| A whole section is rebuilt       | Add the segment to `PATHS.new`, deploy                                  |
| A migrated page is wrong         | Delete the line, deploy — traffic is back on the old site in ~2 minutes |
| Most of the site has moved       | Flip `DEFAULT_ORIGIN` to `'new'`, list the stragglers under `old`       |
| The old platform is switched off | Delete the old origin entirely                                          |


That last flip is the one-way door, and by the time you reach it every page on the list has already been serving live traffic for weeks.

## Repository layout

```
.
└── apps/
    ├── proxy-dual-origin/        Generation 1 — two fixed origins, Terraform-managed
    │   ├── src/
    │   │   ├── index.ts          Request pipeline
    │   │   ├── constants.ts      ◀ THE ROUTING TABLE
    │   │   ├── helpers.ts        Route matching, origin fetch, redirect rewriting
    │   │   └── context.ts        Env bindings
    │   ├── terraform/            Worker, routes, DNS and redirect rules as code
    │   ├── scripts/
    │   │   └── ssl-check.sh      Per-edge-IP TLS verification
    │   └── wrangler.jsonc
    │
    └── proxy-multi-origin/       Generation 2 — N origins, absorbed security + analytics
        ├── src/
        │   ├── index.ts          Request pipeline
        │   ├── config.ts         ◀ THE ROUTING TABLE (+ CSP, toggles)
        │   ├── origins.ts        Origin key → URL mapping
        │   ├── helpers.ts        Route matching, origin fetch, redirect rewriting
        │   ├── security.ts       CSP assembly, TLS floor, header stamping
        │   └── analytics.ts      Page-view logging
        ├── scripts/
        │   ├── site-audit.sh     Read-only pre-flight audit of the live site
        │   ├── rehearsal-verify.sh
        │   ├── golive-verify.sh  Post-cutover verification
        │   └── build.sh
        └── wrangler.jsonc        dev / staging / rehearsal / production
```



## The two implementations

Both do the same core job. The second is what the first became after a migration's worth of lessons.


|                        | `proxy-dual-origin`                              | `proxy-multi-origin`                                                                          |
| ---------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **Origins**            | Exactly 2, hardcoded as `webflow` / `hubspot`    | N, defined by a TS union — add `'blog'` and the compiler lists every place that needs a value |
| **Framework**          | Hono                                             | Plain `fetch` handler, no dependencies                                                        |
| **Config**             | Routing only                                     | Routing + behaviour toggles + security policy                                                 |
| **Security headers**   | None (a separate worker did it)                  | **Absorbs** the site's existing CSP worker — one hop instead of two                           |
| **TLS floor**          | —                                                | Rejects TLS < 1.2 at the edge                                                                 |
| **Analytics**          | —                                                | Absorbs the site's crawler-analytics worker, logging the response actually served             |
| **HTML rewriting**     | Always on for one origin                         | Per-origin toggle (it costs a full body buffer)                                               |
| **`robots.txt`**       | Hardcoded                                        | Pluggable, or proxied through                                                                 |
| **Environments**       | One, via Terraform                               | dev / staging / **rehearsal** / production                                                    |
| **Deploy**             | `terraform apply` from a committed bundle        | Git-connected dashboard deploy, or `wrangler deploy`                                          |
| **Build traceability** | —                                                | `X-RP-Build` = deployment version ID on every response                                        |
| **Infra as code**      | ✅ Terraform: Worker, routes, DNS, redirect rules | Config-as-code only                                                                           |


**Which to start from.** `proxy-multi-origin` is the better base for anything new — cleaner origin model, no framework dependency, and the environment ladder that makes the rollout rehearsable. Take `proxy-dual-origin`'s `terraform/` if the infrastructure itself needs to be code-reviewed and version-controlled, which on a client's production zone it usually should be.

## The hard parts

The routing logic above is a morning's work. Everything below is what the second and third weeks are actually spent on, and it is the reason this repository exists rather than a blog post.

### 1. Fetching the origin without looping

The proxy sits on `www.example.com`. It needs to fetch the *old* site — which also lives on `www.example.com`. Fetch it naively and the request re-enters the proxy, forever.

On Cloudflare the saving grace is that a Worker's own subrequests go straight to the DNS origin, *"ignoring any Workers mapped to the URL"*. That is why `wrangler.jsonc` carries a loud warning never to enable `global_fetch_strictly_public` — that flag turns the safe behaviour off and reintroduces the loop.

> **Porting note.** This is the single most platform-specific assumption in the codebase. Any other platform needs the equivalent guarantee, or an explicit bypass: a separate internal hostname for the origin, a private-link/origin-group binding, or a marker header the edge is configured to skip on (see #2).

### 2. The origin that redirects back at you

A real case from `proxy-dual-origin`: the legacy CMS origin hostname had a host-level `301` back to the primary domain. The proxy fetches the origin, the origin 301s to the public host, that hits the proxy again — loop.

The fix is a bypass marker. The edge redirect rule is rewritten to *skip* requests carrying a specific header, and the proxy stamps that header on its own subrequests only. See `src/helpers.ts` and `terraform/main.tf` — both sides of the contract are in the repo, with a comment on each explaining that changing one without the other reintroduces the loop.

The value is deliberately a long random token rather than `1`, so an outside client cannot trivially guess the bypass. It is a marker, not a secret — it ships in source.

### 3. Redirect `Location` leakage

The backend answers `302 Location: https://newsite.internal/thanks`. Pass that through and the visitor's address bar now shows a hostname that was never meant to be public — and that isn't covered by the site's SSL, SEO or analytics.

Every 3xx has its `Location` rewritten back onto the visitor's hostname (`rewrite_redirect()`). Note the fetch uses `redirect: 'manual'` — otherwise the platform follows the redirect server-side and the rewrite never gets a chance.

### 4. Absolute URLs baked into HTML

Site builders publish absolute URLs into the markup: canonicals, `og:` tags, internal links, JSON-LD. Proxy that HTML unchanged and every link quietly points back at the internal hostname.

Two options, in order of preference:

1. **Fix at the source** — most platforms can be told the canonical domain (Webflow: `<base href>` plus canonical settings). Free, correct, no per-request cost.
2. **Rewrite in the proxy** — buffer the body and replace origin URLs with the visitor's host. In `proxy-multi-origin` this is a per-origin toggle (`REWRITE_HTML`) precisely because it costs a full-body buffer on every HTML request.

The rewrite covers plain, escaped (`https:\/\/`), protocol-relative and quoted forms, because all four appear in real published markup.

### 5. The compression trap

This one costs an afternoon if you meet it cold. On Cloudflare, same-zone subrequests are **not** auto-decompressed. Call `response.text()` on a gzipped body and you get bytes, not HTML — the rewrite silently no-ops.

The fix is to request `Accept-Encoding: identity` for any response you intend to rewrite, and to delete `content-encoding` / `content-length` from the response you construct afterwards. Both implementations do exactly this, only for origins where rewriting is on.

### 6. Keeping the internal hostnames out of Google

During a migration the new site is reachable at its own hostname. If Google finds it, you get duplicate content against your own domain — competing with yourself at the worst possible time.

Defence in depth:

- `robots.txt` on any internal origin hostname returns `Disallow: /`
- `X-Robots-Tag: noindex, nofollow` on *every* response on those hostnames
- `NOINDEX=true` blankets whole environments (staging, rehearsal)
- The guard is careful about one edge case: **the primary host may itself be an origin** (the old site is often fetched at the public hostname). The allowed-hosts list is checked first so the public domain is never mistaken for an internal origin and noindexed.

That last bullet is a one-line check that would otherwise deindex the production site.

### 7. `robots.txt` and `sitemap.xml` with two backends

Neither backend can serve a correct `robots.txt`, because neither knows the other's paths. The proxy synthesises one — including the `Sitemap:` line pointing at *the host the visitor used*, which matters when a site answers on several domains.

`proxy-multi-origin` makes this pluggable (`CUSTOM_ROBOTS_TXT`), defaulting to proxying whichever origin owns the path.

### 8. Cache correctness and targeted purge

Every response is stamped `Cache-Tag: origin-<key>`. When the new site republishes, purge `origin-new` — the old site's cached pages are untouched. Without this you either over-purge (losing cache on the untouched platform) or under-purge (serving stale rebuilt pages).

`X-Origin` on every response makes this debuggable from the outside: `curl -I` any URL and you can see which backend answered, which is how the verification scripts assert the routing table matches reality.

### 9. Absorbing what is already on the route

Mature sites usually have a Worker on the route already — a CSP worker, an analytics beacon, an A/B testing shim. Chaining the proxy behind it means two hops, two places to debug, and an ordering dependency at exactly the moment traffic is being cut over.

`proxy-multi-origin` **absorbs** them instead:

- **CSP**: directives copied *verbatim* into `config.ts` and reassembled in `security.ts` with the identical join logic, so the emitted header is byte-identical to what the site sends today. The port is mechanical on purpose — one wrong entry silently removes a third-party script from the page. (The policy in this copy is a small illustrative stand-in; real ones run to hundreds of entries.)
- **TLS floor**: same check, same 400 response, moved *before* the origin fetch so a rejected request no longer costs a fetch.
- **Analytics**: same endpoint, same JSON schema, one deliberate change — the original re-fetched the URL to learn its status, which bypasses Worker routes and would therefore drift from what visitors actually got mid-migration. The port logs the response actually served.

Keep a written porting record of every deliberate deviation. That record is what makes the absorption reviewable by someone who did not write it.

### 10. Observability

Three headers, and they earn their keep during a cutover:


| Header       | Answers                                              |
| ------------ | ---------------------------------------------------- |
| `X-Origin`   | Which backend served this?                           |
| `X-RP-Build` | Which exact deployment served this? (version ID)     |
| `X-Rewrite`  | Was HTML rewriting applied, and between which hosts? |


`X-RP-Build` in particular resolves the two worst cutover questions instantly: if a response carries it but the wrong CSP, something *after* the proxy is overriding headers; if it is missing entirely, the request never reached the proxy at all.

### 11. Failing loudly, in the right direction

An unreachable origin returns a `502` carrying `X-Origin` and `X-Error` rather than a blank platform error page — so the failing backend names itself.

And the top-level fail-safe: **an unlisted hostname is passed through untouched.** The proxy's default posture toward anything it was not explicitly configured for is to do nothing.

## How a migration actually runs

The code above is maybe a third of the work. The sequence is the rest.

**Phase 0 — Audit.** `scripts/site-audit.sh` against the live site: DNS and nameservers, apex/www redirect behaviour, existing security headers, trailing-slash and case handling, `robots.txt`, `sitemap.xml`, TLS, platform fingerprints. Read-only, changes nothing, safe to run any time. Everything it records is a behaviour the proxy must reproduce exactly — **the audit output is the specification for everything that follows.**

**Phase 1 — Rehearsal, on a domain you own.** The whole topology, reproduced on your own zone with a throwaway site as the "new" origin: same proxy, same host-attachment shape, same fetch pattern. The client's zone is untouched and unaware. This is where you find out that non-default custom domains 301 to the default one, that same-zone fetch behaves the way the docs claim, and that your CSP port is byte-identical — on infrastructure where being wrong costs nothing. `scripts/rehearsal-verify.sh` runs the same assertions at each stage so the before/after is evidence, not opinion.

**Phase 2 — Staging on the real zone.** A hostname nobody links to, on the client's actual zone, configured exactly like production. Proves the real DNS, the real SSL issuance, the real account permissions. `NOINDEX=true` throughout.

**Phase 3 — Cutover.** Attach the proxy to the production route. At this moment the routing table is empty, so **every request still goes to the old site** — the proxy is live and provably a no-op. Verify with `scripts/golive-verify.sh`, comparing against the baseline captured in Phase 0. If anything is off, detach the route: an in-place, atomic, reversible dashboard edit.

**Phase 4 — Migrate, page by page.** Add a path, deploy, verify, repeat. Each deploy moves exactly as much traffic as you chose. This phase can run for months, at the content team's pace, with the site fully live the entire time.

**Phase 5 — Flip the default.** Once most of the site has moved, `DEFAULT_ORIGIN = 'new'` and list the stragglers under `old`. New pages now land on the new platform by default.

**Phase 6 — Decommission.** Remove the old origin. Optionally remove the proxy too — or keep it, because it is now a permanently useful piece of edge infrastructure for redirects, headers and the *next* migration.

Rollback at every phase is the same move: delete a line, or detach a route. Nothing in this sequence requires a DNS change with traffic on it.

## Verification scripts

Each script is read-only — GET/HEAD requests and DNS lookups only — and writes full raw output to a timestamped folder under `.audit/` so runs are diffable against each other.


| Script                | Phase | Checks                                                                                                                        |
| --------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| `site-audit.sh`       | 0     | DNS, NS, CAA, redirect chains, security headers, robots/sitemap, trailing-slash + case behaviour, TLS, platform fingerprints  |
| `rehearsal-verify.sh` | 1     | Routing per path, `noindex` coverage, CSP presence and byte-identity, enforcement proof via a deliberately blocked test embed |
| `golive-verify.sh`    | 3     | Every migrated path lands on the new origin, every unlisted path falls back, apex untouched, headers match baseline           |
| `ssl-check.sh`        | any   | Fresh TLS handshakes per edge IP (bypassing session resumption) to catch partial certificate rollouts                         |


`ssl-check.sh` exists because of a real incident: a certificate rolled out to some edge PoPs and not others. A single `curl` said everything was fine; visitors in one region disagreed. Probing each anycast IP individually is the only way to see it.

## Infrastructure as code

`apps/proxy-dual-origin/terraform/` manages the whole edge setup — Worker script and its variable bindings, route patterns across two zones (apex and `www` for each), the origin subdomain's DNS record, and the redirect rule with the bypass-marker expression from [hard part #2](#2-the-origin-that-redirects-back-at-you).

Worth noting: the Terraform deploys a *committed* build artefact, so `pnpm build` and commit precede `terraform apply`. It is a real trade-off — reviewable, diffable, reproducible deploys, at the cost of a build step you must not forget. `proxy-multi-origin` took the other road (Git-connected dashboard deploys, source built by the platform) and is simpler for it. Which is right depends on whether the client needs the infrastructure itself under review.

## Running this somewhere else

Nothing here depends on Cloudflare conceptually. The proxy needs four capabilities:

1. Intercept requests for a hostname **before** they reach the origin
2. Choose a backend per request, from your own logic
3. Fetch that backend with a chosen `Host` header, without looping
4. Modify response headers (and, if needed, the body)



### Azure


| What the Worker does             | Azure equivalent                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Sits in front of the domain      | **Azure Front Door** (Standard/Premium). Azure DNS is authoritative-only — it does not proxy — so Front Door is the layer that intercepts. |
| Old site / new site backends     | **Origin groups**, one per backend                                                                                                         |
| `EXACT_PATHS` / `PATHS` routing  | **Rule Set** with request-path/host match conditions and an **origin-group override** action — the routing table, no code                  |
| `REDIRECTS` map                  | Rule Set **URL redirect** action, or a Front Door route                                                                                    |
| `Host` header to the origin      | Origin's **origin host header** setting                                                                                                    |
| Trailing-slash 301               | Rule Set redirect action on a path condition                                                                                               |
| Security headers / CSP           | Rule Set **modify response header** actions                                                                                                |
| `X-Robots-Tag` on internal hosts | Rule Set condition on hostname + response-header action                                                                                    |
| TLS floor                        | Minimum TLS version on the custom domain                                                                                                   |
| Cache purge                      | Front Door purge by path or wildcard                                                                                                       |
| **HTML body rewriting**          | ⚠️ Not available in Front Door rules — needs compute (below)                                                                               |
| **Synthesised** `robots.txt`     | ⚠️ Same — needs compute                                                                                                                    |
| **Analytics beacon**             | ⚠️ Same — or handle downstream from Front Door access logs                                                                                 |
| `X-Origin` / `X-RP-Build`        | Rule Set response headers (static per rule)                                                                                                |
| Terraform                        | Same provider model — `azurerm_cdn_frontdoor_*` resources                                                                                  |


**Two shapes, depending on how much you need:**

- **Rules-only.** If you need path→backend routing, redirects and header manipulation — and *not* body rewriting — Front Door's Rule Set does the whole job with no code deployed. This covers a surprising number of migrations. The routing table becomes rules; the concepts map one to one.
- **Rules + compute.** If you need HTML rewriting, a synthesised `robots.txt`, conditional logic beyond what match conditions express, or the analytics beacon, put an **Azure Function** (or **Container App**) behind Front Door as an origin and port `src/` directly. The code is TypeScript against `fetch`, `Request` and `Response` — the routing table, matching, redirect rewriting, HTML rewriting and header hygiene all move across essentially unchanged. What is rewritten is the handler signature and the loop-avoidance strategy (hard part #1), which on Azure means pointing the origin fetch at a hostname or private origin that does not route back through Front Door.

Also available, and sometimes the right answer: **Application Gateway** (regional rather than edge; path-based routing to backend pools, header and URL rewrite, WAF) and **API Management** (heaviest, but its policy engine *can* transform response bodies, including `set-body`, which Front Door cannot).

**Where the migration lands, per phase.** Phase 0's audit script is platform-neutral and runs today. Phase 1's rehearsal works the same way on a domain you own with your own Front Door profile. Phase 3's "attach the proxy while the routing table is empty" is a Front Door route whose rules all currently point at the old origin group — still provably a no-op. And the rollback move is the same: remove a rule, or repoint the route.

### AWS

**CloudFront** as the edge, with the routing logic in a **CloudFront Function** (cheap, viewer-request, tight runtime limits — fine for routing and header work) or **Lambda@Edge** (heavier, but can do origin-response body manipulation). Origins map to CloudFront origins; `Cache-Tag`-style targeted purge becomes invalidation by path pattern.

### Fastly / Akamai

The closest fit of all. Fastly's VCL (or Compute) does origin selection, header work and even surrogate-key purge — which is a *better* match for the `Cache-Tag` pattern than anything Cloudflare offers. Akamai Property Manager expresses the same rules declaratively.

### Self-hosted

nginx or Caddy in front, the routing table expressed as `location` blocks or a small `map`, `proxy_pass` per backend with `proxy_set_header Host`, and `sub_filter` for HTML rewriting. Entirely workable; you own the availability of the proxy itself, which on a managed edge you do not.

### What ports and what does not

**Ports unchanged:** the routing table and its resolution order; the phased rollout; redirect-`Location` rewriting; HTML-rewrite string handling; the internal-hostname noindex rules and the primary-host edge case; the `robots.txt` strategy; observability headers; and the audit and verification scripts.

**Needs rework per platform:** loop avoidance (#1) — the most important thing to establish *first* on any new platform; compression handling (#5), since who decompresses what differs; cache-purge granularity; and the deployment/IaC layer.

## Lineage and credits

Both implementations descend from **[finsweet/reverse-proxy](https://github.com/finsweet/reverse-proxy)** — a Cloudflare Worker that reverse-proxies many Webflow sites into one domain under different paths. The inherited shape is visible throughout: the Hono handler, `workers_dev: false` / `preview_urls: false`, trailing-slash normalisation, the `snake_case` helper convention (`has_trailing_slash`, `build_url`, `rewrite_redirect`), and the essential insight that a Worker can make several backends look like one site.

What the Finsweet proxy solves is **subdomain consolidation** — a stable, permanent arrangement stitching many sites under one domain by path prefix. What these two solve is **migration**: a deliberately temporary arrangement where the routing table is a dial that moves from one platform to another, and everything above under [The hard parts](#the-hard-parts) exists to make that dial safe to turn on a live commercial site.

Their repository is worth reading directly — its README covers the proxied-vs-unproxied DNS distinction and the Webflow SSL handshake constraint better than we would restate here, and both apply to this work too.

It is referenced, not vendored: no code from it is copied into this repository, and at the time of writing it carries no licence file.

## Local development

Both proxies use **pnpm** and **Wrangler**.

```bash
# Either proxy
cd apps/proxy-multi-origin      # or apps/proxy-dual-origin
pnpm install
cp .dev.vars.example .dev.vars  # point the origins at real URLs
pnpm dev                        # http://localhost:8787
pnpm check                      # typecheck
```

Local dev is treated as an allowed host, so routing, redirects and header logic all exercise against whatever origins you point at. The TLS floor is skipped locally (there is no real handshake to inspect), and analytics stays silent unless `ANALYTICS_KEY` is set — which it should not be, locally.

Deployment differs per app by design — `proxy-dual-origin` via `terraform apply` from a committed bundle, `proxy-multi-origin` via Git-connected dashboard deploys or `wrangler deploy --env <name>`. See [Infrastructure as code](#infrastructure-as-code).

## About this copy

This repository is a clean extract of two client projects, prepared for external review. Both were merged into one monorepo so the two generations can be compared side by side.

**What was removed:** client and personal identifiers; real domains, hostnames, account and zone IDs, API tokens and CDN portal IDs; project documentation, runbooks, decision logs, review notes, timelines and dated engineering commentary; real page inventories; the production CSP allowlist; and committed build artefacts. Git history was not carried over.

**What was kept:** all source, in full and unmodified in behaviour. Every hostname you see is a placeholder (`example.com`, `example.net`, `newsite.webflow.io`); every credential slot is empty or marked `REPLACE-WITH-…`. The routing tables and the example CSP are representative stand-ins that show the shape of the real thing. The engineering commentary in the code — which is where most of the reasoning lives — is intact.

Nothing here is a runnable deployment as-is: fill in the origins, hostnames and account IDs and it becomes one.
