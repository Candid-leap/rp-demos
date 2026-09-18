import { createHash } from "node:crypto";
import path from "node:path";
import { DIRS } from "./config.js";

/** Coarse asset type used for Webflow subfolder placement and portal grouping. */
export function classify(url: string): string {
  const ext = (url.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["mp4", "mov", "webm", "m4v"].includes(ext)) return "video";
  return ext ? `.${ext}` : "no-ext";
}

/** Webflow subfolder (inside "Hubspot Migrated Asset") for a given type. */
export function folderNameFor(type: string): string {
  if (type === "image") return "Images";
  if (type === "pdf") return "PDFs";
  if (type === "video") return "Videos";
  return "Other";
}

/** Truncate a file name to maxLen, preserving the extension. */
function capName(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  const ext = name.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? "";
  return name.slice(0, maxLen - ext.length) + ext;
}

export function cachePathFor(sourceUrl: string): string {
  const hash = createHash("sha1").update(sourceUrl).digest("hex").slice(0, 16);
  let base = "asset";
  try { base = path.basename(new URL(sourceUrl).pathname) || "asset"; } catch { /* keep default */ }
  // hash prefix guarantees uniqueness, so capping the readable part is safe (fs limit is 255 bytes)
  return path.join(DIRS.cache, `${hash}__${capName(base, 120)}`);
}

/** File name sent to Webflow: original basename, sanitized, under Webflow's 100-char limit. */
export function assetFileName(sourceUrl: string): string {
  let base = "asset";
  try { base = path.basename(new URL(sourceUrl).pathname) || "asset"; } catch { /* keep default */ }
  return capName(decodeURIComponent(base).replace(/[^\w.\-]+/g, "-"), 96);
}
