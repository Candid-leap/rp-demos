import type { Context } from 'hono';

export interface Env {
  // Comma-separated list of hostnames this Worker serves. First entry is the
  // canonical/primary host (used as a fallback where a single name is needed).
  // Subdomain matching applies to each entry — e.g. listing "www.example.com"
  // also matches any "*.example.com".
  ALLOWED_HOSTS: string;
  WEBFLOW_ORIGIN: string;
  HUBSPOT_ORIGIN: string;
}

export type AppContext = Context<{ Bindings: Env }>;
