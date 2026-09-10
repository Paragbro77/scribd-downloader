import test from "node:test";
import assert from "node:assert/strict";
import {
  toHttps,
  extractDocId,
  extractManifest,
  imageUrlFromJsonp,
} from "./manifest.js";

const HTML = `<script>window.x={"page_count":30,"title":"Lower_Secondary_Science_8_workbook_answers"}</script>
<img class=\\"absimg\\" orig=\\"http://html.scribd.com/abc123/images/1-aaa111.jpg\\"/>
<img class=\\"absimg\\" orig=\\"http://html.scribd.com/abc123/images/2-bbb222.jpg\\"/>
<script>docManager.addPage({ pageNum: 4 , fonts: [46], contentUrl: "https://html.scribdassets.com/abc123/pages/4-ccc333.jsonp" });</script>
<script>docManager.addPage({ pageNum: 5 , fonts: [46], contentUrl: "https://html.scribdassets.com/abc123/pages/5-ddd444.jsonp" });</script>`;

const JSONP_JPG =
  'window.page4_callback(["<div><img class=\\"absimg\\" orig=\\"http://html.scribd.com/abc123/images/4-ccc333.jpg\\"/></div>"]);';
const JSONP_PNG =
  'window.page13_callback(["<div><img class=\\"absimg\\" orig=\\"http://html.scribd.com/abc123/images/13-eee555.png\\"/></div>"]);';
const JSONP_TEXT_ONLY = 'window.page7_callback(["<div class=\\"newpage\\">no images here</div>"]);';

test("toHttps upgrades scribd image host", () => {
  assert.equal(
    toHttps("http://html.scribd.com/abc123/images/1-aaa111.jpg"),
    "https://html.scribdassets.com/abc123/images/1-aaa111.jpg"
  );
});

test("extractDocId from url and bare id", () => {
  assert.equal(
    extractDocId("https://www.scribd.com/document/558718376/Some-Title"),
    "558718376"
  );
  assert.equal(extractDocId("558718376"), "558718376");
  assert.equal(extractDocId("https://evil.com/document/123456789/x"), null);
  assert.equal(extractDocId("not a url"), null);
});

test("extractManifest finds title, count, inline images, jsonp urls", () => {
  const m = extractManifest(HTML);
  assert.equal(m.title, "Lower_Secondary_Science_8_workbook_answers");
  assert.equal(m.pageCount, 30);
  assert.equal(m.inline[1], "https://html.scribdassets.com/abc123/images/1-aaa111.jpg");
  assert.equal(m.inline[2], "https://html.scribdassets.com/abc123/images/2-bbb222.jpg");
  assert.deepEqual(m.jsonpUrls, [
    "https://html.scribdassets.com/abc123/pages/4-ccc333.jsonp",
    "https://html.scribdassets.com/abc123/pages/5-ddd444.jsonp",
  ]);
});

test("extractManifest tolerates empty input", () => {
  const m = extractManifest("<html>Client Challenge</html>");
  assert.equal(m.pageCount, 0);
  assert.equal(m.title, "");
  assert.deepEqual(m.jsonpUrls, []);
});

test("imageUrlFromJsonp handles jpg, png and text-only pages", () => {
  assert.equal(
    imageUrlFromJsonp(JSONP_JPG),
    "https://html.scribdassets.com/abc123/images/4-ccc333.jpg"
  );
  assert.equal(
    imageUrlFromJsonp(JSONP_PNG),
    "https://html.scribdassets.com/abc123/images/13-eee555.png"
  );
  assert.equal(imageUrlFromJsonp(JSONP_TEXT_ONLY), null);
});
