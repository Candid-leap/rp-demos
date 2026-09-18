output "worker_name" {
  description = "Deployed Cloudflare Worker name"
  value       = cloudflare_worker_script.proxy.name
}

output "worker_routes" {
  description = "Active Worker route patterns"
  value = [
    cloudflare_worker_route.wildcard.pattern,
    cloudflare_worker_route.bare.pattern,
  ]
}

output "webflow_cname" {
  description = "Webflow subdomain CNAME record"
  value       = "${cloudflare_record.webflow_subdomain.hostname} → proxy.webflow.com (proxied)"
}
