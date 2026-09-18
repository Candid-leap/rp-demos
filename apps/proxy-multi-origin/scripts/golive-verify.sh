#!/usr/bin/env bash
# ============================================================================
# Go-live verifier — post-swap checks for www.example.com (production).
#
# Run right after the www.example.com/* route is swapped to the proxy Worker.
# Read-only: HEAD/GET requests only, nothing is changed. Every full response
# header block is saved under .audit/golive-<timestamp>/ so the run is
# auditable and diffable against a later run.
#
# Usage:  bash scripts/golive-verify.sh
#         HOST=www.example.com bash scripts/golive-verify.sh   # override target
#
# Run it once before the swap to capture a baseline, then again after.
# ============================================================================
set -u

HOST="${HOST:-www.example.com}"
NEW_ORIGIN_HOST="${NEW_ORIGIN_HOST:-webflow1.example.com}"
TIMEOUT=20

# Keep in sync with EXACT_PATHS.new in src/config.ts.
NEW_PATHS=(
  "/"
  "/enterprise"
  "/landing/get-the-extension"
  "/pricing"
  "/product/guide"
  "/product/it-documentation"
  "/see-it-in-action"
)
# Unlisted paths that must fall back to the OLD origin.
OLD_PATHS=( "/case-studies" "/not-a-real-page-xyz-12345" )

ts="$(date +%Y%m%d-%H%M%S)"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
outdir="$repo_root/.audit/golive-$ts"
mkdir -p "$outdir"

pass=0; fail=0; warn=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
note() { echo "  WARN  $*"; warn=$((warn+1)); }

# Fetch headers for a URL, save the full block, echo the saved file path.
save_headers() {
  local url="$1" slug
  slug="$(echo "$url" | sed -E 's#https?://##; s#[/?:]#_#g')"
  local f="$outdir/$slug.headers.txt"
  curl -sSI "$url" --max-time "$TIMEOUT" > "$f" 2>&1
  echo "$f"
}

# Grep a header value (case-insensitive) from a saved header file.
hval() { grep -i "^$2:" "$1" | tail -1 | sed -E 's/^[^:]+:[[:space:]]*//' | tr -d '\r'; }
status_of() { grep -iE '^HTTP/' "$1" | tail -1 | awk '{print $2}'; }

echo "=================================================================="
echo " Go-live verification — https://$HOST"
echo " $(date)"
echo " Saving full responses to: $outdir"
echo "=================================================================="

echo
echo "── Migrated paths (expect 200 · x-origin: new) ───────────────────"
for p in "${NEW_PATHS[@]}"; do
  f="$(save_headers "https://$HOST$p")"
  st="$(status_of "$f")"; org="$(hval "$f" x-origin)"; build="$(hval "$f" x-rp-build)"
  if [ "$st" = "200" ] && [ "$org" = "new" ]; then
    ok "$p → $st · x-origin:$org · build:${build:0:8}"
  else
    bad "$p → ${st:-NO-RESPONSE} · x-origin:${org:-none} (expected 200/new)"
  fi
done

echo
echo "── Old fallback paths (expect x-origin: old) ─────────────────────"
for p in "${OLD_PATHS[@]}"; do
  f="$(save_headers "https://$HOST$p")"
  st="$(status_of "$f")"; org="$(hval "$f" x-origin)"
  if [ "$org" = "old" ]; then
    ok "$p → $st · x-origin:$org"
  else
    bad "$p → ${st:-NO-RESPONSE} · x-origin:${org:-none} (expected x-origin:old)"
  fi
done

echo
echo "── Security headers on the homepage ──────────────────────────────"
home="$outdir/${HOST}_.headers.txt"
[ -f "$home" ] || home="$(save_headers "https://$HOST/")"
csp="$(hval "$home" content-security-policy)"
xrobots="$(hval "$home" x-robots-tag)"
xcto="$(hval "$home" x-content-type-options)"
if [ -n "$csp" ]; then ok "content-security-policy present (${#csp} chars)"; else bad "content-security-policy MISSING"; fi
if [ -z "$xrobots" ]; then ok "no x-robots-tag on / (production is indexable)"; else bad "x-robots-tag present on / → '$xrobots' (production should be indexable!)"; fi
if [ "$xcto" = "nosniff" ]; then ok "x-content-type-options: nosniff"; else note "x-content-type-options: '${xcto:-none}'"; fi

echo
echo "── Redirects / other hosts (expect UNCHANGED from baseline) ──────"
apex="$(save_headers "https://example.com/")"
if [ "$(status_of "$apex")" = "301" ] && echo "$(hval "$apex" location)" | grep -q "www.example.com"; then
  ok "example.com → 301 → $(hval "$apex" location)  (Webflow's own redirect, not us)"
else
  bad "example.com apex → ${$(status_of "$apex"):-?} / $(hval "$apex" location) (expected 301→www)"
fi
[ -z "$(hval "$apex" x-origin)" ] && ok "apex carries no x-origin (never routed through Worker)" || bad "apex has x-origin:$(hval "$apex" x-origin) — apex is being routed!"

alt="$(save_headers "https://example.org/")"
ok "example.org → $(status_of "$alt") → $(hval "$alt" location)  (secondary brand domain — record & compare to baseline)"

alt2="$(save_headers "https://www.example-app.com/")"
ok "www.example-app.com → $(status_of "$alt2") → $(hval "$alt2" location)  (product domain — record & compare to baseline)"

echo
echo "── robots.txt / sitemap.xml ──────────────────────────────────────"
rob="$(save_headers "https://$HOST/robots.txt")"
ok "robots.txt → $(status_of "$rob") · x-origin:$(hval "$rob" x-origin) · x-robots-tag:'$(hval "$rob" x-robots-tag)'"
sm="$(save_headers "https://$HOST/sitemap.xml")"
ok "sitemap.xml → $(status_of "$sm") · x-origin:$(hval "$sm" x-origin)"

echo
echo "── Hostname-leak scan (new-origin host must not appear in HTML) ──"
leakfile="$outdir/homepage.body.html"
curl -sS "https://$HOST/" --max-time "$TIMEOUT" -o "$leakfile" 2>/dev/null
leaks="$(grep -o "$NEW_ORIGIN_HOST" "$leakfile" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${leaks:-0}" -eq 0 ]; then ok "no '$NEW_ORIGIN_HOST' in homepage HTML"; else note "'$NEW_ORIGIN_HOST' appears ${leaks}x in homepage HTML (check REWRITE_HTML / canonical)"; fi
# Canonical + robots meta in the body
grep -oiE '<link[^>]*rel="canonical"[^>]*>' "$leakfile" | head -1 | sed 's/^/  canonical: /'
grep -oiE '<meta[^>]*name="robots"[^>]*>' "$leakfile" | head -1 | sed 's/^/  robots-meta: /'

echo
echo "=================================================================="
echo " RESULT: $pass passed · $fail failed · $warn warnings"
echo " Full responses saved under: $outdir"
echo "=================================================================="
[ "$fail" -eq 0 ]
