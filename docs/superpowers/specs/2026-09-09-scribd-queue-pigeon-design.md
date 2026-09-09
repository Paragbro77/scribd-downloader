# Scribd Web v2 — Queue + Long Robot + Pigeon (Approved)

Date: 2026-09-09
Replaces per-job part of v1 spec (2026-09-09-scribd-obscura-cloudflare-actions-design.md).
Owner approved Parts 1-4 in simple language. Plan A chosen.

Security note: owner pasted a GitHub token + Cloudflare token + account ID in chat.
These must be revoked/rotated immediately. No secrets are stored in this repo.
All keys go only in GitHub Secrets / Cloudflare secret box (wrangler secret put).

## Simple story

1. Person pastes Scribd link + picks pages + quality + ticks captcha + presses Get.
2. Cloudflare Worker only checks captcha and saves request in D1 waiting line. It does no downloading.
3. Site shows "3 people before you" + ~wait. Browser remembers your requests.
   Close browser, come back, refresh — your links still show, download link appears when ready.
4. One long GitHub robot runs max 5h55m. It takes oldest waiting link first,
   opens Obscura browser, screenshots pages, makes HD PDF, uploads to pigeon.zip,
   saves pigeon link in D1, takes next oldest. Then next, until time ends.
5. When robot stops, it auto-starts the next robot if line not empty.
   A 15-min timer also starts robot if people wait but no robot runs.
6. If robot runs out of time mid-file, next robot restarts that file from page 1 (approved).
7. Website never shows GitHub repo, Cloudflare IDs, or keys. Only pigeon.zip link.

## Why this beats 20-at-once

GitHub free allows ~20 same-time runs. One robot per person fails at 21st person.
One long robot + fair line handles unlimited waiting people, uses minutes efficiently
(no boot per person), no failures from concurrency. Trade-off: waiting time when busy.

## Parts

### Part 1 — Line (D1)

Table `jobs`:
`id TEXT PK, url TEXT, pages TEXT DEFAULT 'all', scale INT DEFAULT 2, delay REAL DEFAULT 0.5,`
`status TEXT (queued/doing/done/failed), created_at INT, started_at INT, heartbeat_at INT,`
`finished_at INT, attempts INT DEFAULT 0, title TEXT, pages_done INT, download_url TEXT,`
`client_key TEXT (random per browser, not secret), error TEXT`

Indexes: `(status, created_at)` for oldest-first pick, `(id)` single-row reads.
Worker `POST /api/jobs`: validate URL regex (same as main.py doc_id),
validate pages syntax (port of parse_page_selection), verify Turnstile,
light rate-limit (e.g. 10/day per IP via D1, not KV, to stay free),
insert `queued`, return `{id, position}`.
`GET /api/jobs?id=...`: single-row select by id → `{status, position, title, pages_done, download_url, error}`.
`position` = count `queued` with `created_at < mine` + (1 if someone `doing`).
`GET /api/mine?client_key=...`: last 20 rows for this browser, for refresh-after-close list.

Optimization for ~10k/day free:
- Frontend polls `GET /api/jobs` max every 45s, exponential backoff when position > 20,
  pauses when tab hidden, stops on done/failed. Shows ~wait = position * avg_minutes.
- Each poll = 2 tiny indexed reads (own row + count ahead). No list scans, no joins.
- Honest limit: Workers free 100k req/day + D1 free 5M row-reads/day.
  10k jobs * (1 submit + ~40 polls * 2 reads) ≈ 810k reads + 410k req — over free Workers req.
  Mitigation in v1: 45-60s polling + backoff brings it to ~10k * 15 polls = 160k req (still over on spike days).
  If daily 10k sustained, $5 Workers Paid is expected. Code is already optimized so upgrade is config-only.

### Part 2 — Website (Pages) + Turnstile + remember

`frontend/`: static Vite page. Fields: URL, pages (`all` default), scale 1/2, delay hidden default 0.5,
`<div class="cf-turnstile" data-sitekey="SITEKEY">` + `api.js`, Get button.
On submit: POST, save `{id, url, created_at}` to `localStorage scribd_jobs`,
render My Files list from localStorage + refresh each via GET.
Queue number + est. wait shown. Footer legal note (personal archival only, respect Scribd ToS).
No GitHub/Cloudflare URLs or IDs in JS. Same-origin `/api` only. CORS locked to Pages domain.

Turnstile: need `TURNSTILE_SITEKEY` (public, in frontend) + `TURNSTILE_SECRET` (Worker secret).
Server verify: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify
{secret, response, remoteip}`. Reject on fail. One token single-use.

### Part 3 — Robot (Actions, 5h55m chained)

`.github/workflows/queue-runner.yml`:
- Triggers: `workflow_dispatch` (input `reason`), `schedule: */15 * * * *` (heal), plus self-dispatch at end.
- `timeout-minutes: 355` (5h55m, under 360 hard kill). `concurrency: group: queue-runner, cancel-in-progress: false` (only one long robot at a time).
- Env: no secrets in logs. Secrets used: `CALLBACK_SECRET` (Worker shared secret for D1 updates),
  `GH_PAT` (only for self-dispatch next run; GITHUB_TOKEN cannot trigger workflows).
- Loop script `scribdl-py/queue_worker.py`:
  ```
  deadline = now + 5h40m (leave 15m buffer)
  setup obscura serve --port 9222 --stealth
  while now < deadline:
    job = Worker GET /api/internal/next (auth CALLBACK_SECRET) → oldest queued,
          or requeue stale doing where heartbeat_at < now-10min AND attempts < 3
    if none: sleep 60s, continue (up to deadline)
    mark doing (started_at, heartbeat_at=now, attempts+1)
    run main.py --non-interactive --job-id --pages --scale --delay → output/*.pdf
    every 60s update heartbeat via Worker POST /api/internal/heartbeat
    on success:
      name = basename(pdf)
      cli = curl -s https://pigeon.zip/api/cli/up/<urlencoded name>  → parse PUT url + share url
        (verified 2026-09-09: returns `curl -T 'file' 'https://pigeon....r2.cloudflarestorage.com/...' && echo 'https://pigeon.zip/xxxx'`)
      curl -T pdf PUT-url (retry 3x)
      POST /api/internal/complete {id, download_url, title, pages_done}
    on private/no-pages/timeout: POST /api/internal/fail {id, error code}
  final step always: if queue not empty → dispatch next run via gh api (PAT), else stop.
  ```
- `scribdl-py/main.py` changes from v1 spec stay: `connect_over_cdp` to Obscura,
  `--non-interactive --job-id`, `result.json`, no `input()`. Keep viewport 1400x2000,
  scale factor, `.outer_page` loop, `img2pdf`. Spike-test Obscura screenshots on 3 real docs first.
- Pigeon limits (verified): no signup, no stated size limit, link dies after 7 days or 20 downloads.
  Fits "no size limit" ask; 20-download cap must be shown in UI ("link works 7 days / 20 downloads").
- Resume: v1 restart-from-scratch on timeout (approved). No partial PNG reuse across runs.

### Part 4 — Hide + test

- Frontend shows only `https://pigeon.zip/...` links. Never repo name, run IDs, account IDs.
- Worker `/api/internal/*` requires `Authorization: Bearer CALLBACK_SECRET`, not exposed to browser.
- `.gitignore`: `.dev.vars`, `.env*`, `output/`, `*.pdf`, `wrangler/*`.
- Secrets setup (human does in dashboards, never in chat/code):
  `GH_PAT (actions:write), CALLBACK_SECRET (random 32B), TURNSTILE_SECRET, TURNSTILE_SITEKEY (public)`.
  Rotate the tokens previously pasted in chat immediately.
- Tests after build: small doc end-to-end (submit → queued → doing → done → pigeon opens),
  close-reopen persistence via localStorage, queue position with 2 jobs, Turnstile reject without token,
  bad/private URL → failed message, stale-doing requeue, 20-download notice visible.

## Open for implementation plan

- Exact D1 schema migration file + wrangler bindings.
- Turnstile sitekey/secret creation (human in Cloudflare dashboard).
- `playwright-core` version + obscura binary URL (spike).
- Avg-minutes-per-doc estimate for wait display (measure in spike, start with 4 min).
- Janitor: delete D1 rows + localStorage prune after 7 days (pigeon expiry match).

## Self-review

- No TBD left except measured numbers explicitly marked for spike.
- Consistent: Worker trigger-only, Action does all browser work (per owner correction).
- Single spec covers queue slice; no R2, no per-job releases (replaced by pigeon per owner).
- "Direct link" = pigeon share URL via single-row D1 read; "come back" = localStorage, not ?job= link (per owner).
- Free-tier math stated honestly with backoff mitigation, not promising impossible 10k/day free with fast polling.
