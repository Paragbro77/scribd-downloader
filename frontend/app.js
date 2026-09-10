/* Instant export: browser -> same-origin manifest hop -> CDN images -> local PDF. */
document.getElementById("instant-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("instant-btn");
  const prog = document.getElementById("instant-progress");
  const say = (frac, label) => {
    const pct = Math.round(frac * 100);
    prog.textContent = `${pct}% — ${label}`;
  };
  btn.disabled = true;
  try {
    const { exportScribdPdf } = await import("./export.js");
    const url = document.getElementById("instant-url").value;
    const pages = document.getElementById("instant-pages").value || "all";
    say(0.01, "starting…");
    const { bytes, filename, pages: n, total } = await exportScribdPdf(url, pages, say);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
    say(1, `done — ${n}/${total} pages saved as ${filename}`);
  } catch (err) {
    prog.textContent = `Export failed: ${err.message || err}`;
  } finally {
    btn.disabled = false;
  }
});

const KEY = "scribd_jobs";
const AVG_MIN = 4;
const load = () => JSON.parse(localStorage.getItem(KEY) || "[]");
const save = (a) => localStorage.setItem(KEY, JSON.stringify(a.slice(-20)));
let timer = null;
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = document.querySelector("[name=cf-turnstile-response]")?.value;
  const body = { url: url.value.trim(), pages: pages.value.trim() || "all", scale: Number(scale.value), delay: 0.5, turnstileToken: token, client_key: getKey() };
  const r = await fetch("/api/jobs", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { msg.textContent = j.error || "error"; return; }
  const a = load(); a.push({ id: j.id, url: body.url, created_at: Date.now() }); save(a); render(); poll();
  if (window.turnstile) turnstile.reset();
});
function getKey() { let k = localStorage.getItem("scribd_key"); if (!k) { k = crypto.randomUUID(); localStorage.setItem("scribd_key", k); } return k; }
async function poll() {
  if (timer) return;
  const tick = async () => {
    if (document.hidden) return;
    const items = load();
    for (const it of items) {
      const r = await fetch("/api/jobs?id=" + it.id); const j = await r.json();
      it.status = j.status; it.position = j.position; it.download_url = j.download_url; it.title = j.title; it.error = j.error;
    }
    save(items); render();
    const waiting = items.filter(x => x.status === "queued" || x.status === "doing").length;
    const maxPos = Math.max(0, ...items.map(x => x.position || 0));
    clearInterval(timer); timer = null;
    if (waiting) { const wait = maxPos > 20 ? 90000 : 45000; timer = setInterval(async () => { clearInterval(timer); timer = null; poll(); }, wait); }
  };
  tick();
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function render() {
  mine.innerHTML = load().slice().reverse().map(it => {
    const ok = typeof it.download_url === "string" && it.download_url.startsWith("https://pigeon.zip/");
    return `<li>${esc(it.title || it.url)} — ${esc(it.status || "?")}${it.position ? ` (#${it.position}, ~${it.position * AVG_MIN} min)` : ""} ${ok ? `<a href="${it.download_url}">Download PDF</a>` : ""} ${it.error ? `<em>${esc(it.error)}</em>` : ""}</li>`; }).join("");
}
render(); poll();
// Restore history after a refresh or on a fresh browser where localStorage
// was cleared: pull the server's view of this client's recent jobs.
(async () => {
  try {
    const r = await fetch("/api/mine?client_key=" + encodeURIComponent(getKey()));
    if (!r.ok) return;
    const j = await r.json();
    if (!j.jobs || !j.jobs.length) return;
    const merged = load().slice();
    const known = new Set(merged.map(x => x.id));
    for (const x of j.jobs) {
      if (known.has(x.id)) continue;
      merged.push({ id: x.id, url: x.url, status: x.status, download_url: x.download_url, title: x.title, error: x.error, created_at: x.created_at });
    }
    if (merged.length > load().length) { save(merged); render(); poll(); }
  } catch {}
})();
