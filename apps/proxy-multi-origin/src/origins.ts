import type { Origin } from './config';

/**
 * Maps every origin key to its URL from the environment.
 *
 * Adding an origin? Add its variable in wrangler.jsonc (all environments),
 * run `pnpm types`, then map it here. TypeScript enforces that every key in
 * the Origin type has a URL — miss one and the build fails.
 */
export function origin_urls(env: Env): Record<Origin, string> {
  return {
    old: env.OLD_SITE_ORIGIN,
    new: env.NEW_SITE_ORIGIN,
  };
}
