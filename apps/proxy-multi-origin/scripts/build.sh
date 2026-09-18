#!/usr/bin/env bash
# Builds the final Worker bundle into dist/ and stamps the top of the file
# with the local build time — so anyone looking at a dist/index.js always
# knows exactly when (and from what) it was generated.
#
# NOTE: dist/ is for review, diffing, and emergencies only. Real deploys are
# built by Cloudflare from src/ (dashboard Git-connect or `wrangler deploy`);
# dist/ is never what actually ships. (The banner also shifts the source map
# by a few lines — irrelevant for an inspection bundle.)
set -euo pipefail
cd "$(dirname "$0")/.."

# --env="" targets the top-level environment; the bundled CODE is identical
# across environments (only dashboard-held vars differ). Pass --env <name>
# explicitly to override.
pnpm exec wrangler deploy --dry-run --outdir=dist --env="" "$@" > /dev/null

stamp="$(date '+%Y-%m-%d %H:%M:%S %Z')"
commit="$(git rev-parse --short HEAD 2>/dev/null || echo 'no-git')"
dirty=""
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  dirty=" + uncommitted changes"
fi

tmp="$(mktemp)"
{
  echo "// ─────────────────────────────────────────────────────────────────────"
  echo "// proxy-multi-origin Worker bundle"
  echo "// Generated locally: $stamp"
  echo "// Source: commit $commit$dirty"
  echo "// Source of truth is src/ — deploys build from source, never from dist/."
  echo "// ─────────────────────────────────────────────────────────────────────"
  cat dist/index.js
} > "$tmp"
mv "$tmp" dist/index.js

echo "Built dist/index.js — $stamp (commit $commit$dirty)"
