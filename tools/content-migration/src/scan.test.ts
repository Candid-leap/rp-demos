import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUrls, replaceUrl } from "./scan.js";

test("whole-cell plain URL", () => {
  assert.deepEqual(extractUrls("https://hs.example.com/pricing"), ["https://hs.example.com/pricing"]);
  assert.deepEqual(extractUrls("/hubfs/docs/guide.pdf"), ["/hubfs/docs/guide.pdf"]);
});

test("empty and non-URL cells", () => {
  assert.deepEqual(extractUrls(""), []);
  assert.deepEqual(extractUrls("Just a headline"), []);
});

test("img src and href in HTML", () => {
  const html = `<p>Hi</p><img src="/hs-fs/hubfs/img/a.png" alt=""><a href="https://hs.example.com/x?y=1">l</a>`;
  const urls = extractUrls(html);
  assert.ok(urls.includes("/hs-fs/hubfs/img/a.png"));
  assert.ok(urls.includes("https://hs.example.com/x?y=1"));
});

test("srcset with multiple candidates", () => {
  const html = `<img srcset="/hubfs/a-small.png 480w, /hubfs/a-big.png 1080w" src="/hubfs/a.png">`;
  const urls = extractUrls(html);
  assert.ok(urls.includes("/hubfs/a-small.png"));
  assert.ok(urls.includes("/hubfs/a-big.png"));
  assert.ok(urls.includes("/hubfs/a.png"));
});

test("css url() in style attribute", () => {
  const html = `<div style="background-image: url('/hubfs/bg.jpg')">x</div>`;
  assert.ok(extractUrls(html).includes("/hubfs/bg.jpg"));
});

test("bare URL in plain text cell", () => {
  const urls = extractUrls("See https://hs.example.com/help for details");
  assert.deepEqual(urls, ["https://hs.example.com/help"]);
});

test("filenames with parentheses are not truncated by the bare-URL pass", () => {
  const html = `<img src="https://www.example.com/hs-fs/hubfs/Image%20from%20iOS%20(4).jpg?width=300">`;
  const urls = extractUrls(html);
  assert.ok(urls.includes("https://www.example.com/hs-fs/hubfs/Image%20from%20iOS%20(4).jpg?width=300"));
  assert.ok(!urls.some((u) => u.endsWith("iOS%20")), "no truncated ghost URL");
});

test("trailing sentence punctuation is trimmed from bare URLs", () => {
  assert.deepEqual(extractUrls("Read https://hs.example.com/pricing."), ["https://hs.example.com/pricing"]);
  assert.deepEqual(extractUrls("Read https://hs.example.com/pricing, then decide"), ["https://hs.example.com/pricing"]);
});

test("trailing unbalanced paren is trimmed, balanced parens kept", () => {
  assert.deepEqual(extractUrls("(see https://hs.example.com/help)"), ["https://hs.example.com/help"]);
  const kept = extractUrls("get https://x.com/hubfs/file%20(1).pdf now");
  assert.deepEqual(kept, ["https://x.com/hubfs/file%20(1).pdf"]);
});

test("replaceUrl replaces every occurrence exactly", () => {
  const html = `<img src="/hubfs/a.png"><img src="/hubfs/a.png?w=2">`;
  const out = replaceUrl(html, "/hubfs/a.png", "https://cdn.site/a.png");
  assert.equal(out, `<img src="https://cdn.site/a.png"><img src="https://cdn.site/a.png?w=2">`);
});

test("replaceUrl no-ops on identical URLs", () => {
  assert.equal(replaceUrl("<a href='/x'>", "/x", "/x"), "<a href='/x'>");
});
