terraform {
  required_version = ">= 1.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ---------------------------------------------------------------------------
# Locals
# ---------------------------------------------------------------------------

locals {
  webflow_origin_host = replace(replace(var.webflow_origin, "https://", ""), "http://", "")
  # "webflow1.example.com" → "webflow1"
  webflow_subdomain = split(".", local.webflow_origin_host)[0]
}

# ---------------------------------------------------------------------------
# Worker Script
# ---------------------------------------------------------------------------

# IMPORTANT: dist/index.js is committed to git. Always run `pnpm build`
# and commit dist/ before applying. Terraform deploys whatever is in git.
resource "cloudflare_worker_script" "proxy" {
  account_id = var.cloudflare_account_id
  name       = var.worker_name

  content = file("${path.module}/../dist/index.js")
  module  = true

  plain_text_binding {
    name = "ALLOWED_HOSTS"
    text = var.allowed_hosts
  }

  plain_text_binding {
    name = "WEBFLOW_ORIGIN"
    text = var.webflow_origin
  }

  plain_text_binding {
    name = "HUBSPOT_ORIGIN"
    text = var.hubspot_origin
  }
}

# ---------------------------------------------------------------------------
# Worker Routes
# ---------------------------------------------------------------------------

resource "cloudflare_worker_route" "wildcard" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "${var.domain}/*"
  script_name = cloudflare_worker_script.proxy.name
}

resource "cloudflare_worker_route" "bare" {
  zone_id     = var.cloudflare_zone_id
  pattern     = var.domain
  script_name = cloudflare_worker_script.proxy.name
}

# Apex example.com — same Worker handles it.
resource "cloudflare_worker_route" "apex_wildcard" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "example.com/*"
  script_name = cloudflare_worker_script.proxy.name
}

resource "cloudflare_worker_route" "apex_bare" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "example.com"
  script_name = cloudflare_worker_script.proxy.name
}

# Secondary zone — www + apex. Conditional on that zone-ID variable being set.
resource "cloudflare_worker_route" "wildcard_ai" {
  count       = var.cloudflare_zone_id_ai != "" ? 1 : 0
  zone_id     = var.cloudflare_zone_id_ai
  pattern     = "www.example.net/*"
  script_name = cloudflare_worker_script.proxy.name
}

resource "cloudflare_worker_route" "bare_ai" {
  count       = var.cloudflare_zone_id_ai != "" ? 1 : 0
  zone_id     = var.cloudflare_zone_id_ai
  pattern     = "www.example.net"
  script_name = cloudflare_worker_script.proxy.name
}

resource "cloudflare_worker_route" "apex_ai_wildcard" {
  count       = var.cloudflare_zone_id_ai != "" ? 1 : 0
  zone_id     = var.cloudflare_zone_id_ai
  pattern     = "example.net/*"
  script_name = cloudflare_worker_script.proxy.name
}

resource "cloudflare_worker_route" "apex_ai_bare" {
  count       = var.cloudflare_zone_id_ai != "" ? 1 : 0
  zone_id     = var.cloudflare_zone_id_ai
  pattern     = "example.net"
  script_name = cloudflare_worker_script.proxy.name
}

resource "cloudflare_worker_route" "webflow_wildcard" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "${local.webflow_origin_host}/*"
  script_name = cloudflare_worker_script.proxy.name
}

resource "cloudflare_worker_route" "webflow_bare" {
  zone_id     = var.cloudflare_zone_id
  pattern     = local.webflow_origin_host
  script_name = cloudflare_worker_script.proxy.name
}

# ---------------------------------------------------------------------------
# DNS — Webflow subdomain
# ---------------------------------------------------------------------------

# CNAME to proxy.webflow.com for the Webflow origin subdomain.
# Subdomain is derived from webflow_origin automatically.
resource "cloudflare_record" "webflow_subdomain" {
  zone_id = var.cloudflare_zone_id
  name    = local.webflow_subdomain
  content = "proxy.webflow.com"
  type    = "CNAME"
  proxied = true
  ttl     = 1 # Auto when proxied
}

# ---------------------------------------------------------------------------
# Redirect Rule — hs.example.com → www.example.com (path-preserving)
# ---------------------------------------------------------------------------
# 301 the hs. subdomain to www, preserving path
# and query so deep links and SEO value are retained. The hs. DNS record is
# managed outside Terraform and must stay proxied for CF to intercept.
resource "cloudflare_ruleset" "hs_subdomain_redirect" {
  zone_id     = var.cloudflare_zone_id
  name        = "hs-subdomain-redirect"
  description = "301 hs.example.com → https://www.example.com preserving path and query"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules {
    action      = "redirect"
    description = "hs.* → www.* (path + query preserved)"
    enabled     = true
    # Skip when the Worker's proxy_fetch stamps a matching unguessable token
    # on X-Skip-HS-Redirect. The literal "1" sentinel was trivially spoofable
    # by any external client, which would bypass the redirect and reach HubSpot
    # directly. Token must match the value in src/helpers.ts; changing either
    # side in isolation causes a 301 loop on same-zone subrequests.
    expression = "(http.host eq \"hs.example.com\" and not any(http.request.headers[\"x-skip-hs-redirect\"][*] eq \"REPLACE-WITH-A-RANDOM-64-HEX-TOKEN\"))"

    action_parameters {
      from_value {
        status_code           = 301
        preserve_query_string = true

        target_url {
          expression = "concat(\"https://www.example.com\", http.request.uri.path)"
        }
      }
    }
  }
}
