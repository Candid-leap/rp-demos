variable "cloudflare_api_token" {
  description = "Cloudflare API token with Worker Scripts, Worker Routes, and DNS permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for example.com"
  type        = string
}

variable "cloudflare_zone_id_ai" {
  description = "Cloudflare zone ID for example.net. Empty disables .ai zone routes."
  type        = string
  default     = ""
}

variable "domain" {
  description = "Primary domain the Worker serves (e.g. www.example.com). Also used for the existing wildcard/bare Worker routes."
  type        = string
}

variable "domain_ai" {
  description = "Secondary primary domain on example.net (e.g. www.example.net). Empty to disable."
  type        = string
  default     = ""
}

variable "allowed_hosts" {
  description = "Comma-separated list of every hostname this Worker should serve. First entry is canonical/primary. Bound into the Worker as ALLOWED_HOSTS."
  type        = string
}

variable "webflow_origin" {
  description = "Full Webflow origin URL (e.g. https://webflow1.example.com)"
  type        = string
}

variable "hubspot_origin" {
  description = "Full HubSpot origin URL (e.g. https://www.example.com)"
  type        = string
}

variable "worker_name" {
  description = "Name of the Cloudflare Worker"
  type        = string
  default     = "proxy-dual-origin"
}

