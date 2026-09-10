/* Pure manifest helpers shared by the /api/manifest routes.
 * No network, no platform APIs: given Scribd embed HTML (or a JSONP body),
 * extract the document manifest. Tested by manifest.test.js.
 */

const ORIG_RE =
  /orig=\\*"?(http:\/\/html\.scribd\.com\/[^"\\]+?\/images\/(\d+)-[a-f0-9]+\.(?:jpg|png))/gi;
const ADD_BLOCK_RE =
  /pageNum:\s*(\d+)\s*,.*?contentUrl:\s*"([^"]+)"/gs;
const COUNT_RE = /"page_count":\s*(\d+)/;
const TITLE_RE = /"title":\s*"([^"\\]{2,200})"/;
const DOC_RE =
  /^\/(?:document|presentation|doc|book|article|listen|embeds)\/\d+(?:\/|$)/;

export function toHttps(url) {
  return String(url).replace(
    "http://html.scribd.com/",
    "https://html.scribdassets.com/"
  );
}

export function extractDocId(input) {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (/^\d{5,}$/.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase();
    if (host !== "scribd.com" && host !== "www.scribd.com") return null;
    if (!DOC_RE.test(parsed.pathname)) return null;
    return parsed.pathname.split("/")[2];
  } catch {
    return null;
  }
}

export function extractManifest(html) {
  const text = String(html ?? "");
  const count = COUNT_RE.exec(text);
  const title = TITLE_RE.exec(text);
  const inline = {};
  ORIG_RE.lastIndex = 0;
  let m;
  while ((m = ORIG_RE.exec(text))) {
    inline[Number(m[2])] = toHttps(m[1]);
  }
  const jsonpUrls = [];
  ADD_BLOCK_RE.lastIndex = 0;
  while ((m = ADD_BLOCK_RE.exec(text))) {
    jsonpUrls.push(m[2]);
  }
  return {
    title: title ? title[1] : "",
    pageCount: count ? Number(count[1]) : 0,
    inline,
    jsonpUrls,
  };
}

export function imageUrlFromJsonp(body) {
  ORIG_RE.lastIndex = 0;
  const m = ORIG_RE.exec(String(body ?? ""));
  return m ? toHttps(m[1]) : null;
}
