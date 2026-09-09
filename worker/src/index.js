import { isValidScribdUrl, parsePageSelection } from "./validate.js";

const now = () => Math.floor(Date.now() / 1000);

function json(data, status = 200, cors = false) {
  const headers = { "Content-Type": "application/json" };
  if (cors) headers["Access-Control-Allow-Origin"] = "*";
  return new Response(JSON.stringify(data), { status, headers });
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

function syntaxSpan(sel) {
  // Count selected page slots without a known total: reject only bad syntax.
  const s = String(sel).toLowerCase().trim();
  const out = new Set();
  for (const part of s.split(",")) {
    const p = part.trim();
    if (!p) throw new Error("Invalid format");
    if (p.includes("-")) {
      const [a, b] = p.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || a > b) {
        throw new Error("Invalid format");
      }
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1) throw new Error("Invalid format");
      out.add(n);
    }
  }
  if (!out.size) throw new Error("Invalid format");
  return out.size;
}

function checkInternalAuth(request, env) {
  const want = "Bearer " + (env.CALLBACK_SECRET || "");
  if (!env.CALLBACK_SECRET) return false;
  return request.headers.get("Authorization") === want;
}

async function queuePosition(DB, createdAt) {
  const q = await DB.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE status='queued' AND created_at < ?"
  ).bind(createdAt).first();
  const d = await DB.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE status='doing'"
  ).first();
  return (q?.n || 0) + (d?.n || 0);
}

async function handlePostJobs(request, env) {
  // Same-origin POST: enforce Origin when ALLOWED_ORIGIN is configured.
  if (env.ALLOWED_ORIGIN) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: "forbidden origin" }, 403);
    }
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  if (!isValidScribdUrl(body.url)) {
    return json({ error: "invalid scribd url" }, 400);
  }

  const pagesRaw =
    typeof body.pages === "string" && body.pages.trim() !== ""
      ? body.pages.trim()
      : "all";
  if (pagesRaw.toLowerCase() !== "all") {
    // Syntax-check only: total page count is unknown at submit time, so
    // "out of bounds" against the 100000 placeholder must NOT reject —
    // only malformed syntax and selections spanning > 50 pages do.
    let span;
    try {
      span = parsePageSelection(pagesRaw, 100000).length;
    } catch (e) {
      if (e && e.message === "Invalid format") {
        return json({ error: "invalid pages format" }, 400);
      }
      try {
        span = syntaxSpan(pagesRaw);
      } catch {
        return json({ error: "invalid pages format" }, 400);
      }
    }
    if (span > 50) {
      return json({ error: "page range too large (max 50)" }, 400);
    }
  }

  // Turnstile verify (fail closed when enabled). While TURNSTILE_SECRET is not
  // configured (widget not provisioned yet), submissions are allowed without a
  // token; as soon as the secret is set, every request must carry a valid one.
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const token = typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
  if (env.TURNSTILE_SECRET) {
    if (!token) return json({ error: "missing turnstile token" }, 400);
    let tsOk = false;
    try {
      const form = new URLSearchParams();
      form.set("secret", env.TURNSTILE_SECRET);
      form.set("response", token);
      form.set("remoteip", ip);
      const resp = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        { method: "POST", body: form }
      );
      const data = await resp.json();
      if (data && data.success === true) {
        // Reject tokens minted for another site or another widget action.
        const allowedHost = env.ALLOWED_ORIGIN
          ? new URL(env.ALLOWED_ORIGIN).hostname.toLowerCase()
          : "";
        const hostOk = !allowedHost || String(data.hostname || "").toLowerCase() === allowedHost;
        const actionOk = !data.action || data.action === "pdf-submit";
        tsOk = hostOk && actionOk;
      }
    } catch {
      tsOk = false;
    }
    if (!tsOk) return json({ error: "turnstile failed" }, 403);
  }

  // Rate limit: max 10 jobs per client_key per 24h.
  const key =
    typeof body.client_key === "string" && body.client_key
      ? body.client_key
      : "ip:" + ip;
  const dayAgo = now() - 86400;
  const cnt = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE client_key = ? AND created_at > ?"
  ).bind(key, dayAgo).first();
  if ((cnt?.n || 0) >= 10) {
    return json({ error: "rate limited" }, 429);
  }

  const scale = Number.isFinite(Number(body.scale))
    ? Number(body.scale)
    : 2;
  const delay = Number.isFinite(Number(body.delay))
    ? Number(body.delay)
    : 0.5;
  const id = crypto.randomUUID();
  const created = now();
  await env.DB.prepare(
    "INSERT INTO jobs (id, url, pages, scale, delay, status, created_at, client_key) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)"
  ).bind(id, body.url, pagesRaw, scale, delay, created, key).run();

  const position = await queuePosition(env.DB, created);
  return json({ id, position });
}

async function handleGetJob(url, env) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "missing id" }, 400, true);
  const row = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?")
    .bind(id).first();
  if (!row) return json({ error: "not found" }, 404, true);
  const position =
    row.status === "done" || row.status === "failed"
      ? 0
      : await queuePosition(env.DB, row.created_at);
  return json(
    {
      id: row.id,
      status: row.status,
      position,
      title: row.title,
      pages_done: row.pages_done,
      download_url: row.download_url,
      error: row.error,
      url: row.url,
      pages: row.pages,
    },
    200,
    true
  );
}

async function handleGetMine(url, env) {
  const key = url.searchParams.get("client_key");
  if (!key) return json({ error: "missing client_key" }, 400, true);
  const { results } = await env.DB.prepare(
    "SELECT * FROM jobs WHERE client_key = ? ORDER BY created_at DESC LIMIT 20"
  ).bind(key).all();
  return json({ jobs: results || [] }, 200, true);
}

async function handleInternalNext(env) {
  const t = now();
  let job = await env.DB.prepare(
    "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1"
  ).first();
  if (!job) {
    job = await env.DB.prepare(
      "SELECT * FROM jobs WHERE status='doing' AND heartbeat_at < ? AND attempts < 3 ORDER BY heartbeat_at ASC LIMIT 1"
    ).bind(t - 600).first();
  }
  if (!job) return json({ job: null });
  await env.DB.prepare(
    "UPDATE jobs SET status='doing', started_at=COALESCE(started_at,?), heartbeat_at=?, attempts=COALESCE(attempts,0)+1 WHERE id=?"
  ).bind(t, t, job.id).run();
  job.status = "doing";
  job.started_at = job.started_at || t;
  job.heartbeat_at = t;
  job.attempts = (job.attempts || 0) + 1;
  return json({ job });
}

export default {
  async fetch(request, env) {
    if (!env.DB) return json({ error: "no DB binding" }, 500);
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (pathname === "/api/jobs" && request.method === "POST") {
      return handlePostJobs(request, env);
    }
    if (pathname === "/api/jobs" && request.method === "GET") {
      return handleGetJob(url, env);
    }
    if (pathname === "/api/mine" && request.method === "GET") {
      return handleGetMine(url, env);
    }

    if (pathname === "/api/internal/pending-count" && request.method === "GET") {
      if (!checkInternalAuth(request, env)) return unauthorized();
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','doing')"
      ).first();
      return json({ pending: row?.n || 0 });
    }
    if (pathname === "/api/internal/next" && request.method === "GET") {
      if (!checkInternalAuth(request, env)) return unauthorized();
      return handleInternalNext(env);
    }
    if (pathname === "/api/internal/heartbeat" && request.method === "POST") {
      if (!checkInternalAuth(request, env)) return unauthorized();
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      if (!body.id) return json({ error: "missing id" }, 400);
      await env.DB.prepare("UPDATE jobs SET heartbeat_at=? WHERE id=?")
        .bind(now(), body.id).run();
      return json({ ok: true });
    }
    if (pathname === "/api/internal/complete" && request.method === "POST") {
      if (!checkInternalAuth(request, env)) return unauthorized();
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      if (!body.id) return json({ error: "missing id" }, 400);
      await env.DB.prepare(
        "UPDATE jobs SET status='done', download_url=?, title=?, pages_done=?, finished_at=? WHERE id=?"
      ).bind(body.download_url || null, body.title || null, body.pages_done ?? null, now(), body.id).run();
      return json({ ok: true });
    }
    if (pathname === "/api/internal/fail" && request.method === "POST") {
      if (!checkInternalAuth(request, env)) return unauthorized();
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      if (!body.id) return json({ error: "missing id" }, 400);
      await env.DB.prepare(
        "UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?"
      ).bind(body.error || null, now(), body.id).run();
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};
