#!/usr/bin/env bash
# ============================================================================
# Read-only pre-flight audit of a live site, before anything is changed.
#
# Makes ONLY public, unauthenticated GET/HEAD requests + DNS lookups.
# Changes nothing anywhere. Safe to run any time, from any machine.
#
#   Run:      bash scripts/site-audit.sh
#   Output:   .audit/<UTC-timestamp>/   (raw logs + summary.txt)
#
# Everything it records — DNS, redirect behavior, existing security headers,
# trailing-slash and case handling, the current platform's fingerprints — is
# something the proxy must reproduce exactly. Run it first; the output is the
# specification for everything that follows.
# ============================================================================

set -uo pipefail

# Override for rehearsal/other domains:  AUDIT_APEX=example.xyz bash scripts/site-audit.sh
APEX="${AUDIT_APEX:-example.com}"
PRIMARY="${AUDIT_PRIMARY:-www.$APEX}"
CURL="curl -s --max-time 20"
UA="Mozilla/5.0 (compatible; MigrationAudit/1.0; site migration pre-flight)"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$ROOT/.audit/$STAMP"
mkdir -p "$OUT"

SUMMARY="$OUT/summary.txt"
log() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }
section() { log ""; log "======================================================"; log "== $*"; log "======================================================"; }

log "$APEX read-only audit — $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
log "Output dir: $OUT"

# ----------------------------------------------------------------------------
section "1. DNS — nameservers, records, CAA"
# ----------------------------------------------------------------------------
{
  echo "--- NS $APEX ---";            dig +short NS "$APEX" || true
  echo "--- A/AAAA $APEX ---";        dig +short A "$APEX" || true; dig +short AAAA "$APEX" || true
  echo "--- CNAME/A www ---";         dig +short CNAME "$PRIMARY" || true; dig +short A "$PRIMARY" || true
  echo "--- CAA $APEX ---";           dig +short CAA "$APEX" || true
  echo "--- existence probes (expect NXDOMAIN/empty if unused) ---"
  for h in "staging.$APEX" "webflow1.$APEX" "proxy.$APEX" "hs.$APEX" "old1.$APEX"; do
    echo "  $h -> $(dig +short "$h" | tr '\n' ' ')"
  done
} > "$OUT/dns.txt" 2>&1
log "DNS results -> dns.txt"
grep -q "cloudflare" "$OUT/dns.txt" && log "  note: 'cloudflare' appears in DNS output (see dns.txt)"

# ----------------------------------------------------------------------------
section "2. Response headers — primary, apex, http->https"
# ----------------------------------------------------------------------------
for url in "https://$PRIMARY/" "https://$APEX/" "http://$PRIMARY/" "http://$APEX/"; do
  fname="headers-$(echo "$url" | sed 's|[:/]|_|g').txt"
  $CURL -I -A "$UA" "$url" > "$OUT/$fname" 2>&1 || echo "(request failed)" >> "$OUT/$fname"
  status=$(head -1 "$OUT/$fname" | tr -d '\r')
  location=$(grep -i '^location:' "$OUT/$fname" | head -1 | tr -d '\r')
  log "  $url -> $status ${location:+| $location}"
done

# Full redirect chain from the apex (who redirects, how many hops)
$CURL -I -L -A "$UA" -o /dev/null -w '%{url_effective} (final) after %{num_redirects} redirect(s)\n' "https://$APEX/" > "$OUT/redirect-chain-apex.txt" 2>&1 || true
log "  apex redirect chain -> redirect-chain-apex.txt: $(cat "$OUT/redirect-chain-apex.txt" 2>/dev/null | head -1)"

# ----------------------------------------------------------------------------
section "3. Security & platform fingerprints on https://$PRIMARY/"
# ----------------------------------------------------------------------------
HDRS="$OUT/headers-$(echo "https://$PRIMARY/" | sed 's|[:/]|_|g').txt"
for h in server cf-ray content-security-policy x-content-type-options referrer-policy x-powered-by x-served-by x-cache cache-control set-cookie; do
  val=$(grep -i "^$h:" "$HDRS" | head -1 | tr -d '\r' | cut -c1-160)
  log "  ${val:-$h: (absent)}"
done
log "  (full values incl. complete CSP in $(basename "$HDRS"))"

# ----------------------------------------------------------------------------
section "4. robots.txt & sitemap.xml"
# ----------------------------------------------------------------------------
$CURL -A "$UA" "https://$PRIMARY/robots.txt"  > "$OUT/robots.txt"  2>&1 || true
$CURL -A "$UA" "https://$PRIMARY/sitemap.xml" > "$OUT/sitemap.xml" 2>&1 || true
log "  robots.txt  ($(wc -c < "$OUT/robots.txt" | tr -d ' ') bytes) -> robots.txt"
log "  sitemap.xml ($(wc -c < "$OUT/sitemap.xml" | tr -d ' ') bytes) -> sitemap.xml"
head -5 "$OUT/robots.txt" | sed 's/^/    | /' | tee -a "$SUMMARY" > /dev/null

# ----------------------------------------------------------------------------
section "5. URL behavior — trailing slash, case, 404, sample paths"
# ----------------------------------------------------------------------------
probe() { # probe <label> <url>
  local out; out=$($CURL -I -A "$UA" -o /dev/null -w '%{http_code} %{redirect_url}' "$2" 2>/dev/null || echo "FAIL")
  log "  $1: $2 -> $out"
  echo "$1|$2|$out" >> "$OUT/url-behavior.txt"
}
probe "trailing-slash" "https://$PRIMARY/pricing/"
probe "uppercase"      "https://$PRIMARY/PRICING"
probe "404-check"      "https://$PRIMARY/audit-404-check-xyz123"
for p in /pricing /blog /product /careers /contact; do
  probe "sample" "https://$PRIMARY$p"
done

# ----------------------------------------------------------------------------
section "6. Homepage platform fingerprint (first 8KB only)"
# ----------------------------------------------------------------------------
$CURL -A "$UA" -r 0-8191 "https://$PRIMARY/" > "$OUT/homepage-head.html" 2>&1 || true
for marker in "data-wf-domain" "data-wf-page" "generator" "website-files.com" "hs-scripts" "wp-content"; do
  hit=$(grep -o -m1 -E ".{0,60}$marker.{0,60}" "$OUT/homepage-head.html" | head -1 | cut -c1-120)
  [ -n "$hit" ] && log "  marker '$marker': ...$hit..."
done
log "  (raw first 8KB in homepage-head.html)"

# ----------------------------------------------------------------------------
section "7. TLS certificate"
# ----------------------------------------------------------------------------
curl -svI -o /dev/null --max-time 20 "https://$PRIMARY/" 2> "$OUT/tls-verbose.txt" || true
grep -iE 'subject:|issuer:|expire|SSL connection|TLSv' "$OUT/tls-verbose.txt" > "$OUT/tls.txt" || true
if [ -s "$OUT/tls.txt" ]; then sed 's/^/  /' "$OUT/tls.txt" | tee -a "$SUMMARY" > /dev/null; else log "  (no grep match — full handshake log in tls-verbose.txt)"; fi

# ----------------------------------------------------------------------------
section "Done"
# ----------------------------------------------------------------------------
log ""
log "All raw output in: $OUT"
log "Next: fold these findings into the cutover checklist — every behavior"
log "recorded here is one the proxy has to preserve."
echo "$OUT" > "$ROOT/.audit/LATEST"
