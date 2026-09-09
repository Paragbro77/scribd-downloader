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
    for (const it of load()) {
      const r = await fetch("/api/jobs?id=" + it.id); const j = await r.json();
      it.status = j.status; it.position = j.position; it.download_url = j.download_url; it.title = j.title; it.error = j.error;
    }
    save(load()); render();
    const waiting = load().filter(x => x.status === "queued" || x.status === "doing").length;
    const maxPos = Math.max(0, ...load().map(x => x.position || 0));
    clearInterval(timer); timer = null;
    if (waiting) { const wait = maxPos > 20 ? 90000 : 45000; timer = setInterval(async () => { clearInterval(timer); timer = null; poll(); }, wait); }
  };
  tick();
}
function render() {
  mine.innerHTML = load().slice().reverse().map(it =>
    `<li>${it.title || it.url} — ${it.status || "?"}${it.position ? ` (#${it.position}, ~${it.position * AVG_MIN} min)` : ""} ${it.download_url ? `<a href="${it.download_url}">Download PDF</a>` : ""} ${it.error ? `<em>${it.error}</em>` : ""}</li>`).join("");
}
render(); poll();
