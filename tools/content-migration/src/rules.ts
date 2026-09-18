import type { Rule } from "./config.js";

export interface RuleMatch {
  rule: Rule;
  /** For rehost: the URL to download the asset from. */
  sourceUrl?: string;
  /** For rewrite: the final URL to place in content. Rehost URLs are resolved at migrate time. */
  newUrl?: string;
}

/**
 * HTML attribute values in exports may encode & as &amp;. Rules match on the
 * decoded form; replacement still happens on the raw cell string.
 */
function decodeEntities(url: string): string {
  return url.replaceAll("&amp;", "&");
}

export function matchRule(rawUrl: string, rules: Rule[]): RuleMatch | null {
  const url = decodeEntities(rawUrl);
  for (const rule of rules) {
    const re = new RegExp(rule.match);
    if (!re.test(url)) continue;
    if (rule.action === "rehost") {
      let sourceUrl = url.replace(re, rule.sourceUrl ?? "");
      // Resize/cache-buster params (?width=680&height=...) would otherwise make
      // the same file look like several distinct assets.
      if (rule.stripQuery !== false) sourceUrl = sourceUrl.split(/[?#]/)[0];
      return { rule, sourceUrl };
    }
    // rewrite
    let target = url.replace(re, rule.target ?? "");
    if (target === "") target = "/";
    const host = rule.host ?? "";
    return { rule, newUrl: host + target };
  }
  return null;
}
