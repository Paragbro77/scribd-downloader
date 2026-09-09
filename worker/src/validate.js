const MAX_SELECTION_CHARS = 500;
const MAX_SELECTION_PARTS = 100;
const MAX_SELECTION_PAGES = 50;

function selectionText(sel) {
  const s = String(sel ?? "all").toLowerCase().trim();
  if (s.length > MAX_SELECTION_CHARS) throw new Error("Invalid format");
  return s;
}

function parseParts(sel) {
  const s = selectionText(sel);
  if (s === "all" || s === "") return new Set();
  const parts = s.split(",");
  if (parts.length > MAX_SELECTION_PARTS) throw new Error("Invalid format");
  const out = new Set();
  for (const part of parts) {
    const p = part.trim();
    if (!/^\d+(?:-\d+)?$/.test(p)) throw new Error("Invalid format");
    if (p.includes("-")) {
      const sides = p.split("-");
      if (sides.length !== 2) throw new Error("Invalid format");
      const a = Number(sides[0]);
      const b = Number(sides[1]);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a) {
        throw new Error("Invalid format");
      }
      if (b - a + 1 > MAX_SELECTION_PAGES) throw new Error("Range too large");
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      const n = Number(p);
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid format");
      out.add(n);
    }
    if (out.size > MAX_SELECTION_PAGES) throw new Error("Range too large");
  }
  return out;
}

export function isValidScribdUrl(u) {
  if (typeof u !== "string") return false;
  const value = u.trim();
  if (/^\d{5,}$/.test(value)) return true;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== "scribd.com" && host !== "www.scribd.com") return false;
    return /^\/(?:document|presentation|doc|book|article|listen|embeds)\/\d+(?:\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function parsePageSelection(sel, total) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Invalid total");
  const pages = parseParts(sel);
  if (selectionText(sel) === "all" || selectionText(sel) === "") {
    return Array.from({length: total}, (_, i) => i);
  }
  for (const page of pages) {
    if (page > total) throw new Error("out of bounds");
  }
  return [...pages].map((page) => page - 1).sort((a, b) => a - b);
}

export function countPageSelection(sel) {
  const s = selectionText(sel);
  if (s === "all" || s === "") return null;
  return parseParts(s).size;
}
