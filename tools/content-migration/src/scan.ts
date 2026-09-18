/**
 * URL extraction from CMS cell values. Two shapes:
 *  1. The whole cell is a URL (plain link/image fields).
 *  2. URLs embedded in HTML (src/href/srcset/poster attributes, CSS url(...), bare text).
 * Returned strings are the exact substrings as they appear in the cell, so that
 * replacement can be done with exact string substitution without disturbing markup.
 */

const ATTR_RE = /(?:src|href|poster|data-src|data-href)\s*=\s*["']([^"']+)["']/gi;
const SRCSET_RE = /srcset\s*=\s*["']([^"']+)["']/gi;
const CSS_URL_RE = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
// Parentheses are allowed (file names like "Image from iOS (4).jpg" are real);
// trailing sentence punctuation and unbalanced ")" are trimmed afterwards.
const BARE_URL_RE = /https?:\/\/[^\s"'<>\\]+/gi;

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.startsWith("/");
}

/** Trim punctuation that belongs to surrounding prose, not the URL. */
function cleanBareUrl(url: string): string {
  let u = url.replace(/[.,;:!?]+$/, "");
  while (u.endsWith(")") && (u.match(/\(/g) ?? []).length < (u.match(/\)/g) ?? []).length) {
    u = u.slice(0, -1).replace(/[.,;:!?]+$/, "");
  }
  return u;
}

export function extractUrls(cell: string): string[] {
  if (!cell) return [];
  const trimmed = cell.trim();
  const found = new Set<string>();

  const isHtml = /<[a-z][\s\S]*>/i.test(trimmed);
  if (!isHtml) {
    if (looksLikeUrl(trimmed) && !/\s/.test(trimmed)) found.add(trimmed);
    // plain-text cells can still contain absolute URLs (e.g. multi-line text fields)
    for (const m of trimmed.matchAll(BARE_URL_RE)) found.add(cleanBareUrl(m[0]));
    return [...found];
  }

  for (const m of cell.matchAll(ATTR_RE)) found.add(m[1]);
  for (const m of cell.matchAll(SRCSET_RE)) {
    for (const part of m[1].split(",")) {
      const url = part.trim().split(/\s+/)[0];
      if (url) found.add(url);
    }
  }
  for (const m of cell.matchAll(CSS_URL_RE)) found.add(m[1]);
  for (const m of cell.matchAll(BARE_URL_RE)) found.add(cleanBareUrl(m[0]));

  return [...found];
}

/** Replace every occurrence of oldUrl in the cell. Exact, regex-free global replacement. */
export function replaceUrl(cell: string, oldUrl: string, newUrl: string): string {
  if (!oldUrl || oldUrl === newUrl) return cell;
  return cell.split(oldUrl).join(newUrl);
}

/**
 * Order for applying multiple replacements to the same content: longest old URL
 * first, so a URL that is a prefix of another can never splice into it.
 */
export function byOldUrlLengthDesc(a: { oldUrl: string }, b: { oldUrl: string }): number {
  return b.oldUrl.length - a.oldUrl.length;
}
