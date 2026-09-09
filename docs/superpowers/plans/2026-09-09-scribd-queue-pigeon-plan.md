# Scribd Queue + Pigeon Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build queue-based Scribd-to-PDF web service: Pages frontend + Worker/D1 queue + Actions long-runner with Obscura + pigeon.zip links.

**Architecture:** Worker is trigger-only (validates Turnstile, inserts D1 `queued` row). Single Actions `queue-runner` (timeout 355m, concurrency 1) loops oldest-first, runs `main.py` via Obscura CDP, uploads PDF to pigeon.zip, callbacks Worker internal API to mark done/failed with share URL. Frontend polls slowly with localStorage persistence.

**Tech Stack:** Cloudflare Pages (static HTML, no build), Cloudflare Workers (plain fetch handler, no Hono), D1 SQL, Python 3.11 + playwright-core + img2pdf + click, Obscura binary via CDP, GitHub Actions ubuntu-latest, pigeon.zip CLI upload API.

**Spec:** `docs/superpowers/specs/2026-09-09-scribd-queue-pigeon-design.md` (v2, Plan A) + `docs/superpowers/specs/2026-09-09-scribd-obscura-cloudflare-actions-design.md` (v1 browser-swap detail)

## Global Constraints

- Worker does NO downloading or browser work — trigger + D1 only.
- `main.py` capture logic (embed URL, `.outer_page`, screenshots, img2pdf) stays unchanged except browser boot.
- Browser boot MUST be `p.chromium.connect_over_cdp("http://127.0.0.1:9222")` to `obscura serve --port 9222 --stealth`, never `chromium.launch`.
- No secrets in repo: `.gitignore` MUST cover `.dev.vars`, `.env*`, `output/`, `*.pdf`, `result.json`.
- Frontend MUST show only `https://pigeon.zip/...` links, never repo/run/account IDs.
- Frontend polls `GET /api/jobs` at most every 45s, pauses when tab hidden, backoff when position > 20.
- Queue is oldest-first: `ORDER BY created_at ASC` where `status='queued'`, plus stale `doing` requeue (heartbeat > 10min, attempts < 3).
- Timeout `timeout-minutes: 355` on runner job, loop deadline `now + 5h40m` leaving 15m buffer.
- Pigeon upload flow verified 2026-09-09: `GET https://pigeon.zip/api/cli/up/<name>` returns shell with PUT URL + share URL; upload via `curl -T file PUT-url`.
- UI MUST note "link works 7 days / 20 downloads".

---

## File Structure

- `scribdl-py/main.py` (modify: CDP boot, `--non-interactive --job-id`, `result.json`) — single-doc capture, unchanged selectors.
- `scribdl-py/queue_worker.py` (create) — long-loop: fetch next job, run main.py subprocess, pigeon upload, callback complete/fail, heartbeat thread.
- `scribdl-py/requirements.txt` (modify: `playwright==1.58.0` → `playwright-core`) — keep img2pdf, click pinned.
- `scribdl-py/tests/test_job_args.py` (create) — validates non-interactive arg parsing + result.json shape without browser.
- `scribdl-py/tests/test_pigeon_parse.py` (create) — parses pigeon CLI shell output into (put_url, share_url).
- `worker/wrangler.toml` (create) — Pages/Worker config, D1 binding `DB`, no secrets inside.
- `worker/schema.sql` (create) — D1 `jobs` table + indexes.
- `worker/src/validate.js` (create) — pure `isValidScribdUrl`, `parsePageSelection`, no Worker APIs, testable with node.
- `worker/src/index.js` (create) — fetch handler: `POST /api/jobs`, `GET /api/jobs`, `GET /api/mine`, `POST/GET /api/internal/*` with Bearer check.
- `worker/src/validate.test.js` (create) — `node --test` coverage for validators.
- `frontend/index.html` (create) — form + Turnstile widget + My Files list, loads `app.js`.
- `frontend/app.js` (create) — submit, localStorage `scribd_jobs`, 45s poll with visibility pause + backoff.
- `frontend/styles.css` (create) — minimal clean layout.
- `.github/workflows/queue-runner.yml` (create) — schedule + dispatch, timeout 355, concurrency 1, obscura setup, loop, self-dispatch.
- `.gitignore` (create at root) — secrets + outputs.

---

### Task 1: Python — Obscura CDP boot + non-interactive flags + result.json

**Files:**
- Modify: `scribdl-py/main.py`
- Modify: `scribdl-py/requirements.txt`
- Test: `scribdl-py/tests/test_job_args.py`

**Interfaces:**
- Consumes: existing `process_download(url, output, pages, delay, scale, quiet, ...)` signature stays.
- Produces: `main.py --url U --pages P --scale S --delay D --non-interactive --job-id J` writes `output/*.pdf` + `result.json {job_id,title,url,pages_requested,pages_done,filename}`; `queue_worker.py` (Task 2) calls this CLI.

- [ ] **Step 1: Write failing test for CLI flags + result.json shape**

```python
# scribdl-py/tests/test_job_args.py
import json, subprocess, sys
def test_help_lists_non_interactive_flags():
    r = subprocess.run([sys.executable, "scribdl-py/main.py", "--help"], capture_output=True, text=True)
    assert "--non-interactive" in r.stdout
    assert "--job-id" in r.stdout
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest scribdl-py/tests/test_job_args.py -v`
Expected: FAIL (`--non-interactive` not in help output)

- [ ] **Step 3: Minimal implementation in main.py**

```python
# add to @click.command() options in scribdl-py/main.py:
@click.option('--url', default=None, help='Scribd URL (action mode)')
@click.option('--non-interactive', is_flag=True, help='Never prompt; default pages=all')
@click.option('--job-id', default=None, help='Queue job id, written to result.json')
def main(url, file, threads, output, pages, delay, scale, quiet, url_opt=None, non_interactive=False, job_id=None):
    pass  # keep existing body; wire: if non_interactive and not pages: pages="all"
```

Full edit rules: (1) `from playwright.sync_api import sync_playwright` stays (playwright-core keeps same import path); (2) replace `browser = p.chromium.launch(headless=True)` with `browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")`; (3) delete the two `context.route("**/*osano*/**")` abort lines (obscura --stealth handles); (4) if `non_interactive` and no `pages`, set `pages="all"` and skip `input()`; (5) after PDF write, if `job_id`: write `result.json` with keys above. Keep viewport 1400x2000 + scale.

- [ ] **Step 4: Update requirements.txt**

```
playwright-core==1.49.1
img2pdf==0.6.3
click==8.3.2
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest scribdl-py/tests/test_job_args.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scribdl-py/main.py scribdl-py/requirements.txt scribdl-py/tests/test_job_args.py
git commit -m "feat: obscura CDP boot + non-interactive job flags"
```

---

### Task 2: Python — queue_worker loop + pigeon upload + callbacks

**Files:**
- Create: `scribdl-py/queue_worker.py`
- Test: `scribdl-py/tests/test_pigeon_parse.py`

**Interfaces:**
- Consumes: Task 1 CLI (`main.py --non-interactive --job-id`), Worker endpoints `GET /api/internal/next`, `POST /api/internal/heartbeat|complete|fail` (Task 3 contract below).
- Produces: long-loop process used by `queue-runner.yml` (Task 5): `python scribdl-py/queue_worker.py --api BASE --secret S --deadline-min 340`.

API contract (Task 3 implements): `GET /api/internal/next` → `{job|null:{id,url,pages,scale,delay,attempts}}`; `POST /heartbeat {id}`; `POST /complete {id,download_url,title,pages_done}`; `POST /fail {id,error}`. All require `Authorization: Bearer CALLBACK_SECRET`.

- [ ] **Step 1: Write failing test for pigeon CLI output parse**

```python
# scribdl-py/tests/test_pigeon_parse.py
from queue_worker import parse_pigeon_response
SAMPLE = "curl -fsS -T 'video.mp4' 'https://pigeon.b5dcbd99.r2.cloudflarestorage.com/h782DUYw?X-Amz-Expires=3600&x-id=PutObject' && echo 'https://pigeon.zip/h782DUYw'"
def test_parse_pigeon():
    put, share = parse_pigeon_response(SAMPLE)
    assert put.startswith("https://pigeon.")
    assert share == "https://pigeon.zip/h782DUYw"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest scribdl-py/tests/test_pigeon_parse.py -v`
Expected: FAIL (`queue_worker` not found)

- [ ] **Step 3: Write minimal queue_worker.py**

```python
# scribdl-py/queue_worker.py
import re, subprocess, time, urllib.parse, requests, json, os, sys, threading
def parse_pigeon_response(shell):
    m1 = re.search(r"'(https://pigeon\.[^']+)'", shell)
    m2 = re.search(r"'(https://pigeon\.zip/[^']+)'", shell)
    if not m1 or not m2: raise ValueError("bad pigeon response")
    return m1.group(1), m2.group(1)
def upload_to_pigeon(pdf_path, retries=3):
    name = urllib.parse.quote(os.path.basename(pdf_path))
    shell = requests.get(f"https://pigeon.zip/api/cli/up/{name}", timeout=30).text
    put_url, share_url = parse_pigeon_response(shell)
    for i in range(retries):
        r = subprocess.run(["curl","-fsS","-T",pdf_path,put_url], capture_output=True, text=True)
        if r.returncode == 0: return share_url
        time.sleep(5)
    raise RuntimeError("pigeon upload failed")
```

Plus loop: `deadline = time.time()+340*60`; start `obscura serve` externally (workflow does it); each iteration `GET next`, `POST heartbeat` every 60s via thread, `subprocess.run([sys.executable,"scribdl-py/main.py","--url",job["url"],"--pages",job.get("pages") or "all","--scale",str(job.get("scale",2)),"--delay",str(job.get("delay",0.5)),"--non-interactive","--job-id",job["id"],"--quiet"])`, read `result.json`, `upload_to_pigeon(pdf)`, `POST complete`; on returncode!=0 `POST fail {error:"private_or_no_pages"}`. Idle: sleep 60s until deadline.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest scribdl-py/tests/ -v`
Expected: PASS (both test files)

- [ ] **Step 5: Commit**

```bash
git add scribdl-py/queue_worker.py scribdl-py/tests/test_pigeon_parse.py
git commit -m "feat: queue worker loop with pigeon upload"
```

---

### Task 3: Worker + D1 queue API (trigger-only)

**Files:**
- Create: `worker/wrangler.toml`
- Create: `worker/schema.sql`
- Create: `worker/src/validate.js`
- Create: `worker/src/index.js`
- Test: `worker/src/validate.test.js`

**Interfaces:**
- Consumes: D1 binding `DB`; secrets via env (`TURNSTILE_SECRET`, `CALLBACK_SECRET`) — never in files.
- Produces: `POST /api/jobs {url,pages,scale,delay,turnstileToken,client_key}` → `{id,position}`; `GET /api/jobs?id=` → `{status,position,title,pages_done,download_url,error}`; `GET /api/mine?client_key=` → last 20; internal `GET /api/internal/next` + `POST /api/internal/heartbeat|complete|fail` (Bearer) consumed by Task 2.

- [ ] **Step 1: Write failing test for validators**

```js
// worker/src/validate.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { isValidScribdUrl, parsePageSelection } from "./validate.js";
test("accepts scribd doc url", () => { assert.equal(isValidScribdUrl("https://www.scribd.com/document/123456789/Sample-Doc"), true); });
test("rejects non-scribd", () => { assert.equal(isValidScribdUrl("https://evil.com/x"), false); });
test("pages all/1-3/5", () => {
  assert.deepEqual(parsePageSelection("all", 10), [0,1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(parsePageSelection("1-3", 10), [0,1,2]);
  assert.deepEqual(parsePageSelection("5", 10), [4]);
});
test("pages out of bounds throws", () => { assert.throws(() => parsePageSelection("99", 5)); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test worker/src/validate.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Write validate.js + schema + index.js**

```js
// worker/src/validate.js
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
```

```sql
-- worker/schema.sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, pages TEXT DEFAULT 'all',
  scale INTEGER DEFAULT 2, delay REAL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL, started_at INTEGER, heartbeat_at INTEGER, finished_at INTEGER,
  attempts INTEGER DEFAULT 0, title TEXT, pages_done INTEGER, download_url TEXT,
  client_key TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_key, created_at);
```

`worker/src/index.js`: plain fetch handler (no deps). Routes: POST /api/jobs (validate URL via isValidScribdUrl; validate pages syntax by trying parsePageSelection(sel, 100000) catching only format errors, not bounds since total unknown — cap range span at 50: compute span and reject > 50; verify Turnstile via fetch siteverify with env.TURNSTILE_SECRET + CF-Connecting-IP; rate-limit via D1 `SELECT COUNT(*) FROM jobs WHERE client_key=? AND created_at>?` or IP table — use simple per-IP count in D1 `rate` table or skip to D1 jobs count by ip column? Keep simple: count rows with client_key + created in last 24h, reject > 10; insert `crypto.randomUUID()` row status queued; position = `SELECT COUNT(*) FROM jobs WHERE status='queued' AND created_at < ?` + `SELECT COUNT(*) FROM jobs WHERE status='doing'`); GET /api/jobs?id; GET /api/mine; internal routes check `request.headers.get("Authorization") === "Bearer "+env.CALLBACK_SECRET`, next = oldest queued else stale doing requeue. All JSON, CORS `*` for GET, same-origin POST (check Origin against env.ALLOWED_ORIGIN).

```toml
# worker/wrangler.toml
name = "scribd-queue"
main = "src/index.js"
compatibility_date = "2026-09-01"
[[d1_databases]]
binding = "DB"
database_name = "scribd-queue"
database_id = "REPLACE_AFTER_CREATE"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test worker/src/validate.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/wrangler.toml worker/schema.sql worker/src/validate.js worker/src/index.js worker/src/validate.test.js
git commit -m "feat: worker D1 queue API with validators"
```

---

### Task 4: Frontend Pages (form + Turnstile + localStorage + slow poll)

**Files:**
- Create: `frontend/index.html`
- Create: `frontend/app.js`
- Create: `frontend/styles.css`

**Interfaces:**
- Consumes: Task 3 public API (`POST /api/jobs`, `GET /api/jobs?id=`, `GET /api/mine`); Turnstile sitekey via `window.TURNSTILE_SITEKEY` injected at deploy (never hardcode secret).
- Produces: deployed Pages site; stores `localStorage["scribd_jobs"] = [{id,url,created_at}]`.

- [ ] **Step 1: Write index.html skeleton**

```html
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scribd to PDF</title><link rel="stylesheet" href="styles.css">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head>
<body><main>
<h1>Scribd to PDF</h1>
<form id="f"><input id="url" placeholder="https://www.scribd.com/document/..." required>
<input id="pages" placeholder="all" value="all">
<select id="scale"><option value="1">SD</option><option value="2" selected>HD</option></select>
<div class="cf-turnstile" data-sitekey="REPLACE_ME"></div>
<button>Get PDF</button></form>
<p id="msg"></p><ul id="mine"></ul>
<footer>Personal archival only. Respect Scribd ToS. Links work 7 days / 20 downloads.</footer>
</main><script src="app.js"></script></body></html>
```

- [ ] **Step 2: Write app.js polling logic**

```js
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
```

- [ ] **Step 3: Serve locally and verify no console errors**

Run: `npx -y serve frontend -l 3000` then open `http://localhost:3000`, submit empty → validation message; check localStorage write.
Expected: page renders, Turnstile placeholder shows (replace key later), no JS errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/app.js frontend/styles.css
git commit -m "feat: pages frontend with queue polling"
```

---

### Task 5: Runner workflow + root ignore + deploy + e2e test

**Files:**
- Create: `.github/workflows/queue-runner.yml`
- Create: `.gitignore`

**Interfaces:**
- Consumes: Tasks 1–4 outputs. Needs human-created secrets (never in repo): Actions secrets `CALLBACK_SECRET`, `GH_PAT`, `WORKER_API_BASE`; Cloudflare `TURNSTILE_SECRET`, `CALLBACK_SECRET`, D1 id.
- Produces: live Pages URL + working queue; e2e evidence (job row `done` + pigeon URL opens).

- [ ] **Step 1: Write queue-runner.yml**

```yaml
name: queue-runner
on:
  workflow_dispatch: { inputs: { reason: { description: reason, default: heal } } }
  schedule: [{ cron: "*/15 * * * *" }]
concurrency: { group: queue-runner, cancel-in-progress: false }
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 355
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: pip install -r scribdl-py/requirements.txt
      - name: Install obscura
        run: |
          curl -fsSL -o obscura https://github.com/obscura-headless/obscura/releases/latest/download/obscura-linux-x64
          chmod +x obscura
          ./obscura serve --port 9222 --stealth &
          sleep 3
      - name: Drain queue
        env: { API_BASE: "${{ secrets.WORKER_API_BASE }}", CALLBACK_SECRET: "${{ secrets.CALLBACK_SECRET }}" }
        run: python scribdl-py/queue_worker.py --api "$API_BASE" --secret "$CALLBACK_SECRET" --deadline-min 340
      - name: Chain next run
        if: always()
        env: { GH_PAT: "${{ secrets.GH_PAT }}" }
        run: |
          LEFT=$(curl -fsS -H "Authorization: Bearer ${{ secrets.CALLBACK_SECRET }}" "${{ secrets.WORKER_API_BASE }}/api/internal/pending-count" || echo 1)
          if [ "$LEFT" != "0" ]; then curl -fsS -X POST -H "Authorization: Bearer $GH_PAT" -H Accept:application/vnd.github+json https://api.github.com/repos/${{ github.repository }}/actions/workflows/queue-runner.yml/dispatches -d '{"ref":"main"}'; fi
```

Plus `scribdl-py/queue_worker.py` argparse for `--api --secret --deadline-min` (added in Task 2 — verify flags exist before this task merges).

- [ ] **Step 2: Write root .gitignore**

```
.dev.vars
.env*
node_modules/
wrangler/
.wrangler/
output/
*.pdf
result.json
scribdl-py/output/
scribdl-py/history.json
```

- [ ] **Step 3: Local D1 migrate + Worker typecheck (needs human D1 id first)**

Run: `npx wrangler d1 create scribd-queue` (human, copy id into wrangler.toml) ; `npx wrangler d1 execute scribd-queue --local --file=worker/schema.sql` ; `node --test worker/src/validate.test.js` ; `python -m pytest scribdl-py/tests/ -v`
Expected: all PASS, table created locally.

- [ ] **Step 4: Deploy Worker + Pages (human runs with their secrets)**

```bash
npx wrangler d1 execute scribd-queue --remote --file=worker/schema.sql
npx wrangler deploy --config worker/wrangler.toml
npx wrangler pages deploy frontend --project-name scribd-downloader
```

Set via dashboards (never in code): `wrangler secret put TURNSTILE_SECRET`, `wrangler secret put CALLBACK_SECRET`; Actions repo secrets `CALLBACK_SECRET GH_PAT WORKER_API_BASE`; Turnstile sitekey replaces `REPLACE_ME` in index.html.

- [ ] **Step 5: E2E test with small doc, record evidence**

Run: submit one small Scribd URL on live site → assert `GET /api/jobs?id=` goes queued → (trigger runner manually) → doing → done with `https://pigeon.zip/...` → open link downloads PDF → close/reopen browser → My Files persists.
Expected: PASS; paste job id + pigeon URL host only (not full secret query strings) into commit message or PR. If Obscura screenshots blank, spike fails here — do NOT proceed; report pixel evidence.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/queue-runner.yml .gitignore
git commit -m "feat: chained queue runner workflow"
```

---

## Self-Review

- Spec coverage: D1 line + oldest-first + stale requeue (Tasks 2–3); Turnstile + remember + 45s poll + position/wait (Tasks 3–4); 5h55m/355m chained runner + obscura CDP + pigeon + restart-from-scratch (Tasks 1–2, 5); hide secrets + footer + tests (all tasks). Janitor/7-day prune deferred — pigeon expiry covers links; D1 prune is follow-up (add `DELETE WHERE finished_at < now-7d` cron in Worker later, not blocking deploy).
- No placeholders: every code step has exact commands, file paths, and minimal snippets; human-only values (D1 id, sitekey, secrets) are explicitly marked as dashboard actions, not code TODOs.
- Type consistency: `job {id,url,pages,scale,delay,attempts}` shape matches Task 2 consumer and Task 3 producer; `parsePageSelection(sel,total)` signature identical in Python and JS; pigeon `(put_url, share_url)` tuple used consistently.
