#!/bin/bash
# Comprehensive SSL verification for a base domain.
#
# Tests both `www.<domain>` (public-facing) and `hs.<domain>` (HubSpot
# origin), with fresh TLS handshakes that bypass session resumption.
# Probes each Cloudflare anycast IP to detect partial rollouts.
#
# Usage:
#   bash ssl-check.sh                    # defaults to example.com
#   bash ssl-check.sh example.org        # tests www.example.org + hs.example.org
#   bash ssl-check.sh example.com www    # tests only www.example.com
#   bash ssl-check.sh example.com www,api,hs  # tests three subdomains

BASE_DOMAIN="${1:-example.com}"
SUBDOMAINS="${2:-www,hs}"
SKIP_TOKEN=REPLACE-WITH-A-RANDOM-64-HEX-TOKEN

# ANSI colors
C_CYAN=$'\033[1;36m'
C_YELLOW=$'\033[1;33m'
C_GREEN=$'\033[1;32m'
C_RED=$'\033[1;31m'
C_BLUE=$'\033[1;34m'
C_DIM=$'\033[2m'
C_RESET=$'\033[0m'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

section() {
  echo
  echo "${C_BLUE}┌─────────────────────────────────────────────────────────────────┐${C_RESET}"
  printf "${C_BLUE}│  %-63s│${C_RESET}\n" "$1"
  echo "${C_BLUE}└─────────────────────────────────────────────────────────────────┘${C_RESET}"
}

cert_summary() {
  local domain="$1"
  local extra_flags="$2"
  local resolve_ip="$3"

  local connect_arg="$domain:443"
  [ -n "$resolve_ip" ] && connect_arg="$resolve_ip:443"

  echo | openssl s_client -servername "$domain" -connect "$connect_arg" $extra_flags 2>/dev/null \
    | openssl x509 -noout -subject -dates -ext subjectAltName 2>/dev/null
}

days_until() {
  python3 -c "
from datetime import datetime
try:
    e = datetime.strptime('$1', '%b %d %H:%M:%S %Y %Z')
    d = (e - datetime.utcnow()).days
    print(f'{d} days remaining (expires {e.strftime(\"%Y-%m-%d\")})')
except Exception as ex:
    print(f'(parse error: {ex})')
"
}

cert_fingerprint() {
  local domain="$1"
  echo | openssl s_client -servername "$domain" -connect "$domain:443" -no_ticket 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2
}

# Per-domain deep inspection
check_domain() {
  local domain="$1"
  local label="$2"

  section "$domain  —  $label"

  echo "${C_YELLOW}  ▸ DNS resolution${C_RESET}"
  local IPS
  IPS=$(dig +short "$domain")
  if [ -z "$IPS" ]; then
    echo "    ${C_RED}(no DNS records found — skipping further checks)${C_RESET}"
    return
  fi
  echo "$IPS" | sed 's/^/    /'
  echo

  echo "${C_YELLOW}  ▸ Default handshake (may resume cached session)${C_RESET}"
  cert_summary "$domain" "" "" | sed 's/^/    /'
  echo

  echo "${C_YELLOW}  ▸ FRESH handshake (no session resumption — current cert)${C_RESET}"
  local FRESH_OUTPUT
  FRESH_OUTPUT=$(cert_summary "$domain" "-no_ticket" "")
  if [ -z "$FRESH_OUTPUT" ]; then
    echo "    ${C_RED}(no cert returned — TLS handshake failed)${C_RESET}"
    return
  fi
  echo "$FRESH_OUTPUT" | sed 's/^/    /'
  echo

  echo "${C_YELLOW}  ▸ Days until expiry (based on fresh handshake)${C_RESET}"
  local FRESH_END
  FRESH_END=$(echo "$FRESH_OUTPUT" | grep notAfter | cut -d= -f2)
  echo "    ${C_GREEN}$(days_until "$FRESH_END")${C_RESET}"
  echo

  echo "${C_YELLOW}  ▸ Chain validation (fresh handshake)${C_RESET}"
  echo | openssl s_client -servername "$domain" -connect "$domain:443" -no_ticket -verify_return_error 2>&1 \
    | grep "Verify return code" | sed 's/^/    /'
  echo

  echo "${C_YELLOW}  ▸ Per-POP probe (each IP from DNS)${C_RESET}"
  for ip in $IPS; do
    local POP_OUTPUT POP_SUBJ POP_END
    POP_OUTPUT=$(cert_summary "$domain" "-no_ticket" "$ip")
    POP_SUBJ=$(echo "$POP_OUTPUT" | grep subject | sed 's/subject=//')
    POP_END=$(echo "$POP_OUTPUT" | grep notAfter | cut -d= -f2)
    if [ -z "$POP_SUBJ" ]; then
      printf "    via %s  →  ${C_RED}(handshake failed)${C_RESET}\n" "$ip"
    else
      printf "    via %s  →  %s  |  expires %s\n" "$ip" "$POP_SUBJ" "$POP_END"
    fi
  done
  echo

  echo "${C_YELLOW}  ▸ _acme-challenge DNS (reveals validation source)${C_RESET}"
  local ACME_CNAME ACME_TXT
  ACME_CNAME=$(dig +short "_acme-challenge.$domain" CNAME)
  ACME_TXT=$(dig +short "_acme-challenge.$domain" TXT)
  if [ -n "$ACME_CNAME" ]; then
    echo "    CNAME: $ACME_CNAME" | sed 's/^/    /'
    if echo "$ACME_CNAME" | grep -q "dcv.cloudflare.com"; then
      echo "    ${C_GREEN}→ Cloudflare-managed (DCV via Custom Hostnames or ACM)${C_RESET}"
    elif echo "$ACME_CNAME" | grep -qiE "hubspot|hs\."; then
      echo "    ${C_YELLOW}→ HubSpot-managed validation${C_RESET}"
    else
      echo "    ${C_DIM}→ Unknown validator${C_RESET}"
    fi
  elif [ -n "$ACME_TXT" ]; then
    echo "    TXT: $ACME_TXT"
    echo "    ${C_DIM}→ DNS-01 TXT validation active${C_RESET}"
  else
    echo "    ${C_DIM}(no _acme-challenge record — validation not via DNS-01)${C_RESET}"
  fi
  echo

  echo "${C_YELLOW}  ▸ Cert chain (issuer + intermediates)${C_RESET}"
  echo | openssl s_client -servername "$domain" -connect "$domain:443" -no_ticket -showcerts 2>/dev/null \
    | grep -E "^subject=|^issuer=|^ s:|^ i:" | sed 's/^/    /' | head -10
  echo

  echo "${C_YELLOW}  ▸ Response headers (Cloudflare edge fingerprint)${C_RESET}"
  curl -sI --max-time 10 "https://$domain/" 2>/dev/null \
    | grep -iE "server:|cf-ray:|cf-cache|x-served|x-origin|x-rewrite" | sed 's/^/    /'
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

echo
echo "${C_CYAN}═══════════════════════════════════════════════════════════════════${C_RESET}"
echo "${C_CYAN}  SSL Verification — $BASE_DOMAIN${C_RESET}"
echo "${C_CYAN}  Subdomains: $SUBDOMAINS${C_RESET}"
echo "${C_CYAN}  Run at: $(date '+%Y-%m-%d %H:%M %Z')${C_RESET}"
echo "${C_CYAN}═══════════════════════════════════════════════════════════════════${C_RESET}"

# ---------------------------------------------------------------------------
# Per-subdomain checks
# ---------------------------------------------------------------------------

DOMAINS=()
IFS=',' read -ra SUBS <<< "$SUBDOMAINS"
for sub in "${SUBS[@]}"; do
  full="${sub}.${BASE_DOMAIN}"
  DOMAINS+=("$full")
  case "$sub" in
    www) label="public-facing (visitors)" ;;
    hs)  label="HubSpot origin" ;;
    api) label="API endpoint" ;;
    *)   label="subdomain" ;;
  esac
  check_domain "$full" "$label"
done

# ---------------------------------------------------------------------------
# Cross-subdomain cert comparison
# ---------------------------------------------------------------------------

section "Certificate Transparency log (renewal history per subdomain)"
echo "  ${C_DIM}(querying crt.sh — may take 10–20 seconds)${C_RESET}"
echo
for d in "${DOMAINS[@]}"; do
  echo "${C_YELLOW}  ▸ $d${C_RESET}"
  CT_RAW=$(curl -sL --max-time 30 -A "Mozilla/5.0" "https://crt.sh/?q=$d&output=json&exclude=expired" 2>/dev/null)
  # crt.sh occasionally returns HTML on rate limit; retry once
  if ! echo "$CT_RAW" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    sleep 3
    CT_RAW=$(curl -sL --max-time 30 -A "Mozilla/5.0" "https://crt.sh/?q=$d&output=json" 2>/dev/null)
  fi
  echo "$CT_RAW" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if not isinstance(data, list) or not data:
        print('    (no recent CT entries — try https://crt.sh/?q=$d in browser)')
        sys.exit(0)
    seen = set()
    rows = []
    for entry in sorted(data, key=lambda x: x.get('not_before',''), reverse=True):
        # Dedupe by (not_before, name_value) since pre-cert + cert pairs are common
        key = (entry.get('not_before',''), entry.get('name_value',''))
        if key in seen: continue
        seen.add(key)
        rows.append(entry)
        if len(rows) >= 12: break
    for r in rows:
        nb = (r.get('not_before','') or '')[:10]
        na = (r.get('not_after','') or '')[:10]
        issuer = (r.get('issuer_name','') or '').replace('C=US, ','').replace('O=','').replace(', CN=', ' / ')[:40]
        names = (r.get('name_value','') or '').replace('\n', ',')[:60]
        print(f'    {nb} → {na}  |  {issuer:40s}  |  {names}')
except Exception as e:
    print(f'    (CT parse failed: {e}; try https://crt.sh/?q=$d in browser)')
" 2>/dev/null
  echo
done

if [ ${#DOMAINS[@]} -ge 2 ]; then
  section "Cross-subdomain cert fingerprint comparison"
  # Parallel arrays — bash 3.2 compatible (macOS default shell)
  FP_DOMAINS=()
  FP_VALUES=()
  for d in "${DOMAINS[@]}"; do
    fp=$(cert_fingerprint "$d")
    FP_DOMAINS+=("$d")
    FP_VALUES+=("$fp")
    echo "  $d:"
    echo "    $fp"
  done
  echo

  uniq_fps=$(printf '%s\n' "${FP_VALUES[@]}" | sort -u | wc -l | tr -d ' ')
  total=${#FP_VALUES[@]}
  if [ "$uniq_fps" -eq 1 ]; then
    echo "  ${C_GREEN}✓ All subdomains share one cert (wildcard or multi-SAN)${C_RESET}"
  elif [ "$uniq_fps" -lt "$total" ]; then
    echo "  ${C_YELLOW}△ Mixed — some subdomains share certs, others have their own${C_RESET}"
  else
    echo "  ${C_YELLOW}△ Every subdomain has a distinct cert (per-hostname provisioning)${C_RESET}"
  fi
fi

# ---------------------------------------------------------------------------
# End-to-end live fetches
# ---------------------------------------------------------------------------

section "End-to-end live fetches"

for d in "${DOMAINS[@]}"; do
  echo "${C_YELLOW}  ▸ $d${C_RESET}"
  # Add skip-redirect header only for hs subdomain on example.com
  if [[ "$d" == "hs.example.com" ]]; then
    curl -sS -o /dev/null --max-time 10 \
      -w "    ${C_GREEN}HTTP %{http_code}  |  TLS verify: %{ssl_verify_result}${C_RESET}  (0 = success)\n" \
      -H "X-Skip-HS-Redirect: $SKIP_TOKEN" \
      "https://$d/" 2>&1 || echo "    ${C_RED}(fetch failed)${C_RESET}"
  else
    curl -sS -o /dev/null --max-time 10 \
      -w "    ${C_GREEN}HTTP %{http_code}  |  TLS verify: %{ssl_verify_result}${C_RESET}  (0 = success)\n" \
      "https://$d/" 2>&1 || echo "    ${C_RED}(fetch failed)${C_RESET}"
  fi
done

# ---------------------------------------------------------------------------
# Conclusion
# ---------------------------------------------------------------------------

echo
echo "${C_CYAN}═══════════════════════════════════════════════════════════════════${C_RESET}"
echo "${C_CYAN}  Interpretation${C_RESET}"
echo "${C_CYAN}═══════════════════════════════════════════════════════════════════${C_RESET}"
echo "  ${C_DIM}• 'FRESH handshake' (-no_ticket) shows the current served cert.${C_RESET}"
echo "  ${C_DIM}• 'Per-POP probe' tests each anycast IP separately.${C_RESET}"
echo "  ${C_DIM}• If all subdomains share one cert → wildcard rollout active.${C_RESET}"
echo "  ${C_DIM}• If each has a distinct cert → per-hostname provisioning;${C_RESET}"
echo "  ${C_DIM}  each must auto-renew independently.${C_RESET}"
echo "${C_CYAN}═══════════════════════════════════════════════════════════════════${C_RESET}"
echo
