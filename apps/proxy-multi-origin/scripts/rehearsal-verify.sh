#!/usr/bin/env bash
# ============================================================================
# Rehearsal verifier — terminal checks for the proxy-multi-origin rehearsal host.
#
# Run the SAME script at every stage and compare against the stage guide:
#
#   Stage 1 (control, before anything):  routing PASS · noindex PASS ·
#                                        CSP "none" everywhere · embed NOT FOUND
#   Stage 2 (test embed published):      same as Stage 1, but embed FOUND
#                                        (browser Network tab shows the request
#                                        being ATTEMPTED — nothing blocks it)
#   Stage 3 (after CSP absorption):      CSP "present" everywhere · byte-diff
#                                        IDENTICAL · embed still FOUND in HTML
#                                        but the browser console now shows
#                                        "Refused to load…" and the request is
#                                        never sent — enforcement proven.
#
# Read-only: GET requests only. Output is also logged under .audit/.
# Usage:  bash scripts/rehearsal-verify.sh
# ============================================================================
set -u

REHEARSAL="${REHEARSAL_HOST:-rehearsal.example.net}"
LIVE="${LIVE_HOST:-www.example.com}"
TEST_PATH="${CSP_TEST_PATH:-/see-it-in-action}"

# Keep in sync with EXACT_PATHS.new in src/config.ts
NEW_PATHS=( "/" "/enterprise" "/landing/get-the-extension" "/pricing" "/product/guide" "/product/it-documentation" "/see-it-in-action" )
# A couple of unlisted paths that must fall back to the old origin
OLD_PATHS=( "/case-studies" "/blog" )

ts="$(date +%Y%m%d-%H%M%S)"
# Always log under the repo's .audit/, no matter where the script is run from.
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$repo_root/.audit"
log="$repo_root/.audit/rehearsal-verify-$ts.log"

pass=0; fail=0
ok()  { echo "  PASS  $*"; pass=$((pass+1)); }
bad() { echo "  FAIL  $*"; fail=$((fail+1)); }

# All response headers for host+path, CR stripped
hdrs() { curl -s -D - -o /dev/null "https://$1$2" | tr -d '\r'; }
# Value of one header (lowercased name match)
hval() { printf '%s\n' "$1" | awk -F': ' -v n="$2" 'tolower($1)==n{sub($1 FS,""); print; exit}'; }

{
  echo "== Rehearsal verify — $ts =="
  echo "rehearsal: $REHEARSAL   live: $LIVE   test page: $TEST_PATH"
  echo

  echo "── 1. Routing (x-origin per path) ──"
  for p in "${NEW_PATHS[@]}"; do
    h="$(hdrs "$REHEARSAL" "$p")"
    s="$(printf '%s\n' "$h" | awk '/^HTTP\//{s=$2} END{print s}')"
    o="$(hval "$h" "x-origin")"
    if [ "$o" = "new" ]; then ok "$p → $s, x-origin=new"; else bad "$p → $s, x-origin=${o:-missing} (expected new)"; fi
  done
  for p in "${OLD_PATHS[@]}"; do
    h="$(hdrs "$REHEARSAL" "$p")"
    s="$(printf '%s\n' "$h" | awk '/^HTTP\//{s=$2} END{print s}')"
    o="$(hval "$h" "x-origin")"
    if [ "$o" = "old" ]; then ok "$p → $s, x-origin=old"; else bad "$p → $s, x-origin=${o:-missing} (expected old)"; fi
  done
  echo

  echo "── 2. Noindex (x-robots-tag on every response) ──"
  for p in "/" "${OLD_PATHS[0]}"; do
    h="$(hdrs "$REHEARSAL" "$p")"
    r="$(hval "$h" "x-robots-tag")"
    case "$r" in
      *noindex*) ok "$p → x-robots-tag: $r" ;;
      *)         bad "$p → x-robots-tag: ${r:-missing} (expected noindex)" ;;
    esac
  done
  echo

  echo "── 3. CSP presence on the rehearsal host ──"
  echo "   (Stage 1–2: 'none' is CORRECT here. Stage 3: 'present' required.)"
  for p in "/" "${OLD_PATHS[0]}"; do
    h="$(hdrs "$REHEARSAL" "$p")"
    b="$(hval "$h" "x-rp-build")"
    echo "  INFO  $p → x-rp-build: ${b:-missing} (missing = new worker code not serving this request)"
    c="$(hval "$h" "content-security-policy")"
    if [ -n "$c" ]; then
      echo "  INFO  $p → CSP present (${#c} chars; starts: ${c:0:60}…)"
      echo "        (ours is ~6045 chars starting \"default-src 'self'\"; a short one is the origin's own header leaking through an old worker version)"
    else
      echo "  INFO  $p → CSP: none"
    fi
  done
  echo

  echo "── 4. CSP byte-diff vs live (meaningful at Stage 3 only) ──"
  live_csp="$(hval "$(hdrs "$LIVE" "/")" "content-security-policy")"
  for p in "/" "${OLD_PATHS[0]}"; do
    reh_csp="$(hval "$(hdrs "$REHEARSAL" "$p")" "content-security-policy")"
    if [ -z "$reh_csp" ]; then
      echo "  INFO  $p → no CSP on rehearsal yet (expected before absorption)"
    elif [ "$reh_csp" = "$live_csp" ]; then
      ok "$p → CSP byte-identical to live"
    else
      bad "$p → CSP differs from live (diff the log against a live curl to see where)"
    fi
  done
  echo

  echo "── 5. Negative test: example.com embed on $TEST_PATH ──"
  body="$(curl -s "https://$REHEARSAL$TEST_PATH")"
  if printf '%s' "$body" | grep -q 'example\.com/csp-test'; then
    echo "  INFO  embed FOUND in served HTML (Stage 2+ expected)"
    echo "        → now check the BROWSER on this page:"
    echo "          before absorption: Network tab attempts example.com (control)"
    echo "          after absorption:  Console shows 'Refused to load…' (proof)"
  else
    echo "  INFO  embed NOT FOUND (Stage 1 expected; at Stage 2 check Webflow publish)"
  fi
  echo

  echo "== $pass passed, $fail failed =="
} | tee "$log"

echo "log saved: $log"
