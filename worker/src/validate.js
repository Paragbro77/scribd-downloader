export function isValidScribdUrl(u) {
  if (typeof u !== "string") return false;
  if (/^\d{5,}$/.test(u.trim())) return true;
  return /(?:scribd\.com)\/(?:document|presentation|doc|book|article|listen|embeds)\/\d+/.test(u);
}
export function parsePageSelection(sel, total) {
  const s = String(sel ?? "all").toLowerCase().trim();
  if (s === "all" || s === "") return Array.from({length: total}, (_, i) => i);
  const out = new Set();
  for (const part of s.split(",")) {
    const p = part.trim();
    if (p.includes("-")) {
      const [a, b] = p.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b > total || a > b) throw new Error("out of bounds");
      for (let i = a - 1; i < b; i++) out.add(i);
    } else {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1 || n > total) throw new Error("out of bounds");
      out.add(n - 1);
    }
  }
  if (!out.size) throw new Error("Invalid format");
  return [...out].sort((x, y) => x - y);
}
