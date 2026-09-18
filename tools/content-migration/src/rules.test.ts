import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRule } from "./rules.js";
import type { Rule } from "./config.js";

const CDN = "00000000.fs1.hubspotusercontent-na1.net";
const PORTAL = "00000000";
const rules: Rule[] = [
  { id: "hubspot-cdn-direct", match: "^https?://[0-9]+\\.fs1\\.hubspotusercontent-[a-z0-9-]+\\.net/.+$", action: "rehost", sourceUrl: "$&" },
  { id: "hubspot-legacy-cdn", match: "^https?://cdn[0-9]*\\.hubspot\\.net/hubfs/(.+)$", action: "rehost", sourceUrl: `https://${CDN}/hubfs/$1` },
  { id: "site-hosted-images", match: "^(?:https?://(?:(?:[\\w-]+\\.)*example\\.com|(?:[\\w-]+\\.)*example\\.net|newsite\\.webflow\\.io))?/hs-fs/hubfs/(.+)$", action: "rehost", sourceUrl: `https://${CDN}/hubfs/${PORTAL}/$1` },
  { id: "site-hosted-assets", match: "^(?:https?://(?:(?:[\\w-]+\\.)*example\\.com|(?:[\\w-]+\\.)*example\\.net|newsite\\.webflow\\.io))?/hubfs/(.+)$", action: "rehost", sourceUrl: `https://${CDN}/hubfs/${PORTAL}/$1` },
  { id: "external-hosted-assets", match: "^https?://[^/]+/(?:hs-fs/)?hubfs/.+$", action: "rehost", sourceUrl: "$&" },
  { id: "legacy-host-links", match: "^https?://legacy\\.example\\.com(/[^\"'\\s]*)?$", action: "rewrite", target: "$1", host: "" },
];

test("hs-fs image path, relative", () => {
  const m = matchRule("/hs-fs/hubfs/img/logo.png", rules);
  assert.equal(m?.rule.id, "site-hosted-images");
  assert.equal(m?.sourceUrl, `https://${CDN}/hubfs/${PORTAL}/img/logo.png`);
});

test("hs-fs image with absolute old host", () => {
  const m = matchRule("https://www.example.com/hs-fs/hubfs/img/logo.png", rules);
  assert.equal(m?.rule.id, "site-hosted-images");
  assert.equal(m?.sourceUrl, `https://${CDN}/hubfs/${PORTAL}/img/logo.png`);
});

test("hubfs pdf", () => {
  const m = matchRule("/hubfs/docs/guide.pdf", rules);
  assert.equal(m?.rule.id, "site-hosted-assets");
  assert.equal(m?.sourceUrl, `https://${CDN}/hubfs/${PORTAL}/docs/guide.pdf`);
});

test("already-absolute CDN URL is rehosted as-is (no doubled portal id)", () => {
  const url = `https://${CDN}/hubfs/${PORTAL}/videos/story.mp4`;
  const m = matchRule(url, rules);
  assert.equal(m?.rule.id, "hubspot-cdn-direct");
  assert.equal(m?.sourceUrl, url);
});

test("legacy cdn2.hubspot.net URL maps to current CDN without doubling the portal id", () => {
  const m = matchRule(`https://cdn2.hubspot.net/hubfs/${PORTAL}/img/old.jpg`, rules);
  assert.equal(m?.rule.id, "hubspot-legacy-cdn");
  assert.equal(m?.sourceUrl, `https://${CDN}/hubfs/${PORTAL}/img/old.jpg`);
});

test("resize query params are stripped from the download source", () => {
  const m = matchRule("https://www.example.com/hs-fs/hubfs/meme.jpg?width=680&amp;height=251&amp;name=meme.jpg", rules);
  assert.equal(m?.rule.id, "site-hosted-images");
  assert.equal(m?.sourceUrl, `https://${CDN}/hubfs/${PORTAL}/meme.jpg`);
});

test("stripQuery: false preserves the query on the source URL", () => {
  const keep = [{ ...rules.find((r) => r.id === "site-hosted-assets")!, stripQuery: false }];
  const m = matchRule("/hubfs/report.pdf?v=2", keep);
  assert.equal(m?.sourceUrl, `https://${CDN}/hubfs/${PORTAL}/report.pdf?v=2`);
});

test("hs-fs matches before hubfs (rule order)", () => {
  // /hs-fs/hubfs/... contains /hubfs/ — first-match-wins must pick hs-fs-images
  const m = matchRule("/hs-fs/hubfs/x.png", rules);
  assert.equal(m?.rule.id, "site-hosted-images");
});

test("legacy-host link keeps path and query, relative host", () => {
  const m = matchRule("https://legacy.example.com/pricing?utm=x", rules);
  assert.equal(m?.rule.id, "legacy-host-links");
  assert.equal(m?.newUrl, "/pricing?utm=x");
});

test("bare legacy host becomes /", () => {
  const m = matchRule("https://legacy.example.com", rules);
  assert.equal(m?.newUrl, "/");
});

test("configurable host on rewrite", () => {
  const hosted = [{ ...rules.find((r) => r.id === "legacy-host-links")!, host: "https://www.example.com" }];
  const m = matchRule("https://legacy.example.com/pricing", hosted);
  assert.equal(m?.newUrl, "https://www.example.com/pricing");
});

test("html-entity-encoded query string still matches", () => {
  const m = matchRule("https://legacy.example.com/x?a=1&amp;b=2", rules);
  assert.equal(m?.rule.id, "legacy-host-links");
  assert.equal(m?.newUrl, "/x?a=1&b=2");
});

test("third-party hubfs URL rehosts from its own host, not our CDN", () => {
  const url = "https://partner.example-partner.com/hubfs/Reports/lead-conversion.pdf";
  const m = matchRule(url, rules);
  assert.equal(m?.rule.id, "external-hosted-assets");
  assert.equal(m?.sourceUrl, url);
});

test("old Webflow staging host is treated as site-hosted", () => {
  const m = matchRule("https://newsite.webflow.io/hubfs/Guides/best-practices.pdf", rules);
  assert.equal(m?.rule.id, "site-hosted-assets");
  assert.equal(m?.sourceUrl, `https://${CDN}/hubfs/${PORTAL}/Guides/best-practices.pdf`);
});

test("unrelated URLs do not match", () => {
  assert.equal(matchRule("https://www.example.com/blog/post", rules), null);
  assert.equal(matchRule("/images/local.png", rules), null);
});
