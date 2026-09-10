/* export.js — client-side pipeline (v2).
 * Every fetch here runs in the VISITOR's browser on their own residential IP.
 * No datacenter proxy, no CORS proxies needed:
 *   embed manifest  <- fetched via tiny same-origin Worker hop (/api/manifest/*)
 *                      because www.scribd.com sends no ACAO header.
 *   jsonp + images  <- fetched directly from html.scribdassets.com
 *                      (sends Access-Control-Allow-Origin: *, verified).
 *   PDF             <- assembled locally with vendored pdf-lib, downloaded.
 */

const ORIG_RE =
  /orig=\\*"?(http:\/\/html\.scribd\.com\/[^"\\]+?\/images\/(\d+)-[a-f0-9]+\.(?:jpg|png))/gi;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function toHttps(u) {
  return String(u).replace(
    "http://html.scribd.com/",
    "https://html.scribdassets.com/"
  );
}

export function extractDocId(input) {
  if (typeof input !== "string") return null;
  const v = input.trim();
  if (/^\d{5,}$/.test(v)) return v;
  try {
    const p = new URL(v);
    if (!["http:", "https:"].includes(p.protocol)) return null;
    const h = p.hostname.toLowerCase();
    if (h !== "scribd.com" && h !== "www.scribd.com") return null;
    if (!/^\/(?:document|presentation|doc|book|article|listen|embeds)\/\d+(?:\/|$)/.test(p.pathname)) return null;
    return p.pathname.split("/")[2];
  } catch {
    return null;
  }
}

export function extractManifest(html) {
  const text = String(html ?? "");
  const count = /"page_count":\s*(\d+)/.exec(text);
  const title = /"title":\s*"([^"\\]{2,200})"/.exec(text);
  const inline = new Map();
  ORIG_RE.lastIndex = 0;
  let m;
  while ((m = ORIG_RE.exec(text))) inline.set(Number(m[2]), toHttps(m[1]));
  const jsonpUrls = [];
  const blockRe = /pageNum:\s*(\d+)\s*,.*?contentUrl:\s*"([^"]+)"/gs;
  while ((m = blockRe.exec(text))) jsonpUrls.push(m[2]);
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

async function fetchText(url) {
  const r = await fetch(url, { referrer: "https://www.scribd.com/" });
  if (!r.ok) throw new Error("fetch failed: " + r.status);
  return r.text();
}

async function fetchImage(url) {
  const r = await fetch(url, { referrer: "https://www.scribd.com/" });
  if (!r.ok) throw new Error("image failed: " + r.status);
  const blob = await r.blob();
  if (!blob.type.startsWith("image/")) throw new Error("not an image: " + blob.type);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Full client-side export. onProgress(frac, label) is optional. */
export async function exportScribdPdf(input, selection, onProgress) {
  const { PDFDocument } = window.PDFLib;
  const docId = extractDocId(input);
  if (!docId) throw new Error("not a scribd document url");
  onProgress?.(0.02, "loading manifest…");
  const html = await fetchText(`/api/manifest/${docId}`);
  if (/Client Challenge/i.test(html) && !/page_count/.test(html)) {
    throw new Error("scribd challenged this network — try the queue below");
  }
  const man = extractManifest(html);
  if (!man.pageCount) throw new Error("could not read document info");

  // Resolve page -> image url: inline 1..3 first.
  const byPage = new Map(man.inline);
  const jobs = man.jsonpUrls.map((u) => async () => {
    const img = imageUrlFromJsonp(await fetchText(u));
    if (img) {
      const n = Number(/\/images\/(\d+)-/.exec(img)?.[1]);
      if (n) byPage.set(n, img);
    }
  });
  // Fetch jsonp with modest concurrency.
  let di = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (di < jobs.length) {
      const j = jobs[di++];
      try {
        await j();
      } catch {
        /* one bad page must not kill the export */
      }
      onProgress?.(0.05 + (0.25 * di) / jobs.length, `reading pages ${di}/${jobs.length}…`);
    }
  });
  await Promise.all(workers);

  let wanted = [...byPage.keys()].sort((a, b) => a - b);
  const sel = String(selection ?? "all").trim().toLowerCase();
  if (sel && sel !== "all") {
    const want = new Set();
    for (const part of sel.split(",")) {
      const p = part.trim();
      const mm = /^(\d+)(?:-(\d+))?$/.exec(p);
      if (!mm) throw new Error("bad page selection");
      const a = Number(mm[1]);
      const b = Number(mm[2] ?? mm[1]);
      for (let i = a; i <= b; i++) want.add(i);
    }
    wanted = wanted.filter((n) => want.has(n));
  }
  if (!wanted.length) throw new Error("no pages available for that selection");

  const pdf = await PDFDocument.create();
  let done = 0;
  for (const n of wanted) {
    const bytes = await fetchImage(byPage.get(n));
    let img;
    try {
      img = await pdf.embedJpg(bytes);
    } catch {
      img = await pdf.embedPng(bytes);
    }
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    done++;
    onProgress?.(0.3 + (0.65 * done) / wanted.length, `page ${done}/${wanted.length}…`);
    await sleep(0);
  }
  onProgress?.(0.97, "building pdf…");
  const out = await pdf.save();
  const name = (man.title || "document").replace(/[<>:\"/\\|?*]/g, "").trim() || "document";
  return { bytes: out, filename: `${name}.pdf`, pages: wanted.length, total: man.pageCount };
}

