# Scribd Downloader — Web Version: Obscura + Cloudflare Pages + Worker + GitHub Actions

**Date:** 2026-09-09
**Status:** Approved design (Sections 1-5 approved by owner)
**Scope:** Architectural — replace Playwright with Obscura-headless via CDP, add website version (Pages frontend, Worker dispatcher, Actions runner, Release-asset download)

## 0. TL;DR — Is it possible?

Yes. Frontend on Cloudflare Pages cannot run a browser, and Workers cannot run long screenshot loops, so offloading the heavy work to GitHub Actions via `workflow_dispatch` is the correct free-compute trick.

Caveats accepted by owner:
- Not instant-direct. Queue 30s–5min + run 2–10min → frontend must poll `GET /api/jobs/:id`.
- Artifacts need auth → for anonymous public downloads use a per-job Release asset `tag=job-{job_id}` in a **public** repo. Artifact upload kept for debug only.
- Repo will accumulate releases → nightly janitor workflow deletes `job-*` releases older than 7 days.
- Free limits: ~2000 Actions min/mo (~200–400 docs), 20 concurrent runs, 2 GB per release asset.

## 1. Current state (explored 2026-09-09)

`scribdl-py/main.py` (403 lines, Python + Click):
- `load_config()` from `config.ini` (delay 0.5, scale 2, output).
- `get_filename()`, `parse_page_selection()` (`all` / `3` / `1-10`), `log_history()` to `history.json`.
- `process_download(url, output, pages, delay, scale, quiet, is_batch)`:
  - doc_id regex `/(document|presentation|doc|book|article|listen)/(\d+)` or bare digits.
  - `embed_url = https://www.scribd.com/embeds/{doc_id}/content?start_page=1&view_mode=scroll`.
  - `sync_playwright().chromium.launch(headless=True)`, context viewport 1400x2000, `device_scale_factor=scale`, abort `osano/analytics` routes.
  - `goto(embed_url, domcontentloaded, 60s)`, title from `og:title` → `.title_text` → URL slug, sanitize alnum+space.
  - `wait_for_selector(.outer_page, 15s)`, `count()` = total pages, `input()` prompt unless batch.
  - Loop selected indices: `scroll_into_view_if_needed()`, wait `img/canvas/.absimg` visible 5s, `time.sleep(delay)`, `page_element.screenshot(path=page_N.png)`, progress bar.
  - `img2pdf.convert(pngs)` → `output/*.pdf`, `history.json` append.
- CLI: single URL, `-f urls.txt -t 3` batch via ThreadPoolExecutor, `-o -p -d -s -q`.
- `requirements.txt`: `playwright==1.58.0`, `img2pdf==0.6.3`, `click==8.3.2`.

## 2. Goals / non-goals

Goals (owner-confirmed):
- Replace Playwright-bundled Chromium with Obscura-headless via CDP (`obscura serve --port 9222 --stealth` + `connect_over_cdp`).
- Website: Cloudflare Pages frontend, Worker triggers Actions, Actions does download, returns direct link.
- MVP web inputs: single URL + page range + scale (1/2) + delay. No batch textarea in v1.
- Public site with Turnstile + rate-limit. Delivery via GitHub Release/Artifact link (no R2).

Non-goals v1:
- No batch multi-URL queue, no history.json cloud sync, no user accounts, no R2/S3, no Cloudflare Browser Rendering rewrite.

## 3. Architecture & end-to-end flow (Section 1 — approved)

```
[Pages static form] --POST /api/jobs--> [Worker] --workflow_dispatch--> [Actions: download.yml]
       ^                                  |  ^                                    |
       | poll every 5s                    |  | poll GitHub API                     | upload PDF
       +---- {status, download_url} ------+  +--- run status + release asset -----+
```

1. User pastes Scribd URL, optional pages (`all` default), scale, delay, solves Turnstile, clicks Download.
2. `POST /api/jobs {url, pages, scale, delay, turnstileToken}` → Worker.
3. Worker: validate URL regex + pages syntax (mirror Python logic in JS), verify Turnstile secret, KV rate-limit `rl:{ip}` 5/hr, `job_id = crypto.randomUUID()`, `KV job:{id} = {status:queued, created}`.
4. Worker calls `POST /repos/{owner}/{repo}/actions/workflows/download.yml/dispatches {ref: main, inputs: {job_id, url, pages, scale, delay}}` with fine-grained PAT (`actions:write`, `contents:write` for releases) stored as Worker secret. Returns `{job_id}` immediately.
5. Frontend polls `GET /api/jobs/:id` every 5s with timeout ~35min. Worker returns KV if `completed/failed`, else queries GitHub: list runs `?event=workflow_dispatch`, match `name == job-{job_id}`, map `queued/in_progress → running`, `completed success → fetch /releases/tags/job-{job_id} → {status:completed, download_url: assets[0].browser_download_url, title, pages}`, `failure → {status:failed, error}`. Cache result in KV (TTL 7 days).
6. Frontend shows `queued → running → converting → completed` + title/pages + `Download PDF` anchor to `browser_download_url` + expiry note (7 days).
7. Janitor cron deletes old `job-*` releases + old workflow runs.

## 4. Obscura replacement (Section 2 — approved)

Keep all capture logic unchanged. Swap only browser boot:

- `requirements.txt`: `playwright==1.58.0` → `playwright-core` (CDP client, same API surface for locators/screenshots) + keep `img2pdf`, `click`. Pin versions in spec implementation phase after spike.
- Action setup: download `obscura` binary (~70 MB, from official release), `chmod +x`, `obscura serve --port 9222 --stealth & sleep 2`.
- `main.py` change:
  ```python
  # before
  browser = p.chromium.launch(headless=True)
  # after
  browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
  ```
  Keep `new_context(viewport={"width":1400,"height":2000}, device_scale_factor=scale)`.
- Delete manual `context.route("**/*osano*/**")` aborts — `--stealth` blocks 3520 tracker domains natively. Keep fallback abort only if spike shows Scribd ads leak through.
- Add `--non-interactive --job-id` flags: never call `input()` in Action (default `pages=all`), write `result.json {job_id, title, url, pages_requested, pages_done, filename}` next to PDF for the release step.
- Benefits: 30 MB RAM vs 200+ MB, 70 MB binary vs 300+ MB, instant startup vs ~2s, built-in anti-detect. Allows higher `-t` concurrency on 7 GB Actions runners.
- Risk + mitigation: Obscura V8 rendering vs full Chromium for Scribd `.outer_page` canvas/images + `element.screenshot()` fidelity is unproven. **Required spike before rollout:** run old vs new on 3 real docs (small/medium/large), compare page counts, blank-page rate, pixel diff, PDF size. If element screenshots fail via CDP, fallback to `page.screenshot(clip=bbox)`.

## 5. Frontend + Worker + KV (Section 3 — approved)

`frontend/` (Pages, Vite + plain TS, no framework needed):
- Single page: URL input, pages input (placeholder `all`), scale select (1 SD / 2 HD default 2), delay number (0–2 step 0.1 default 0.5), Turnstile widget, Download button, status timeline, result card, footer legal disclaimer.
- Client validation: same doc_id regex + port of `parse_page_selection` for instant errors, no dispatch on fail.
- Polling: `setInterval 5s`, backoff on 429, stop on completed/failed or 35min timeout.

`worker/` (Cloudflare Worker, Hono):
- `POST /api/jobs`: validate → Turnstile verify (`https://challenges.cloudflare.com/turnstile/v0/siteverify`) → KV `rl:{ip}` incr/expire 3600, reject >5 → uuid → `KV job:{id}` → dispatch → return `{job_id}`. CORS allowlist = Pages domain only.
- `GET /api/jobs/:id`: KV hit if terminal → return; else GitHub API with PAT → map statuses → on completed fetch release → KV put with 7-day TTL → return.
- Secrets (never in repo): `GITHUB_PAT`, `TURNSTILE_SECRET`, `ALLOWED_ORIGIN`, `REPO_OWNER`, `REPO_NAME`. KV namespace `JOBS`.
- Bindings in `wrangler.toml`: `kv_namespaces`, `vars`.

## 6. GitHub Action (Section 4 — approved)

`.github/workflows/download.yml`:
- `on: workflow_dispatch` inputs: `job_id` (required), `url` (required), `pages` (default `all`), `scale` (default `2`), `delay` (default `0.5`). `run-name: job-${{ inputs.job_id }}` for easy lookup.
- `concurrency: group: job-${{ inputs.job_id }}`. `timeout-minutes: 30`. `runs-on: ubuntu-latest`.
- Steps: checkout → setup-python 3.11 → `pip install -r scribdl-py/requirements.txt` → install obscura binary → `obscura serve --port 9222 --stealth &` → `python scribdl-py/main.py --url ... --pages ... --scale ... --delay ... --non-interactive --job-id ...` → `upload-artifact` (always, `output/*`, retention 7d, debug) → if success `softprops/action-gh-release@v2` with `tag_name: job-{job_id}`, `name: doc title`, `files: output/*.pdf + result.json`.
- Repo must be **public** for anonymous `browser_download_url` access.
- `.github/workflows/janitor.yml`: nightly cron, deletes `job-*` releases older than 7 days + prunes workflow runs via `gh` API. Prevents release spam.

## 7. Errors, abuse, testing (Section 5 — approved)

Error taxonomy (Worker terminal states):
- `invalid_url` — regex fail, 400, no dispatch.
- `invalid_pages` — pages syntax fail, 400.
- `rate_limited` — 429 + `retry_after`.
- `turnstile_failed` — 403.
- `dispatch_failed` — GitHub 4xx/5xx, 502, frontend auto-retry once with new job_id.
- `private_or_no_pages` — Action `.outer_page` count 0 → release never created, run conclusion failure → `failed` + message "private/restricted".
- `scribd_timeout` — goto 60s / wait 15s fail → `failed` + Retry button (new job_id, same inputs).
- `obscura_crash` — CDP disconnect → Action retries serve once, then `failed`.
- `release_missing` — run success but no asset → `failed`.

Abuse controls: Turnstile + 5/hr/IP KV limit + max 50 pages per job (cap `end-start`) + URL allowlist regex + PAT scoped to `actions:write, contents:write` only + CORS lockdown + frontend Turnstile token single-use.

Testing:
- Unit: keep `parse_page_selection`, `get_filename` tests; add JS mirror tests for frontend validation.
- Spike (blocking): obscura CDP vs Playwright on 3 real docs — assert equal page counts, zero blank PNGs (file size + variance check), PDF opens + page count matches.
- E2E: dispatch test job on feature branch, poll via Worker locally (`wrangler dev`), assert release asset downloads + PDF valid.
- Load: 5 concurrent dispatches, assert no cross-talk (job_id isolation), KV consistency.
- Legal: footer + README disclaimer "personal archival of content you have legal access to; respect Scribd ToS".

## 8. Repo layout (target)

```
/
  frontend/          # Pages site (Vite)
  worker/            # Cloudflare Worker (Hono) + wrangler.toml
  scribdl-py/        # existing CLI + --non-interactive + result.json (+ playwright-core)
  .github/workflows/download.yml
  .github/workflows/janitor.yml
  docs/superpowers/specs/2026-09-09-scribd-obscura-cloudflare-actions-design.md (this file)
```

## 9. Open decisions for implementation plan

- Exact `playwright-core` version + obscura binary URL (resolve during spike).
- Public repo name/owner for release downloads.
- KV TTL + rate-limit numbers final (5/hr proposed).
- Max pages cap final (50 proposed).
- Whether to keep `upload-artifact` permanently or debug-only.

## 10. Spec self-review

- Placeholder scan: no TBD/TODO left; versions pinned during implementation spike, explicitly noted above.
- Consistency: single-URL MVP everywhere; batch (`-f/-t`) stays CLI-only, not exposed on web — matches Section approvals.
- Scope: single spec covers browser swap + web vertical slice; no R2, no Browser Rendering — matches owner choices.
- Ambiguity: "direct link" defined as public Release `browser_download_url` + polling; "Obscura" defined as obscura-headless via CDP `connect_over_cdp`; delivery/protection/MVP all confirmed via Q&A.
