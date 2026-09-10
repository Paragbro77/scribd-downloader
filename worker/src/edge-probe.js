// Worker route (client-side pipeline): manifest fetch happens on the visitor.
// This pure-TLS probe is the only thing runnable on edge infra; it returns the
// raw bytes the Worker sees, so the frontend can decide manifest-first vs
// queue-fallback. Mounted at /api/edge-probe by index.js.
import { extractDocId, extractManifest, manifestRateOk } from "./manifest.js";

const EMBED_KEY_HINT =
  "set SCRIBD_ACCESS_KEY (Worker var) to the public key visible in any embed HTML";

function embedUrl(docId, accessKey) {
  return (
    `https://www.scribd.com/embeds/${docId}/content` +
    `?start_page=1&view_mode=scroll&access_key=${accessKey}`
  );
}

// Same-origin manifest-HTML hop for the browser pipeline: the visitor's
// browser calls /api/manifest-html/<docId> (same origin, no CORS gate) and the
// Worker forwards the raw embed-page bytes fetched with the visitor's own UA
// string. Challenge outcome follows the request path — residential visitors
// get document HTML, datacenter egress gets challenge bytes (fail honestly).
async function handleManifestHtml(request, env, url) {
  if (env.ALLOWED_ORIGIN) {
    const host = new URL(env.ALLOWED_ORIGIN).hostname.toLowerCase();
    let sameOrigin = false;
    try {
      const origin = request.headers.get("Origin") || "";
      const referer = request.headers.get("Referer") || "";
      if (origin) sameOrigin = new URL(origin).hostname.toLowerCase() === host;
      else if (referer) sameOrigin = new URL(referer).hostname.toLowerCase() === host;
      else sameOrigin = new URL(request.url).hostname.toLowerCase() === host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      return new Response(JSON.stringify({ error: "forbidden origin" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  const docId = url.pathname
    .slice("/api/manifest-html/".length)
    .split("/")[0]
    .trim();
  if (!/^\d{5,}$/.test(docId)) {
    return new Response(JSON.stringify({ error: "invalid doc id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (!manifestRateOk(ip)) {
    return new Response(JSON.stringify({ error: "rate limited", fallback: "queue" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!env.SCRIBD_ACCESS_KEY) {
    return new Response(
      JSON.stringify({ error: "manifest relay not configured", fallback: "queue" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(embedUrl(docId, env.SCRIBD_ACCESS_KEY), {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          request.headers.get("User-Agent") ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.scribd.com/",
      },
    });
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 300 * 1024) {
      return new Response(JSON.stringify({ error: "manifest too large", fallback: "queue" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(buf, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "upstream unreachable", fallback: "queue" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Worker route (client-side pipeline): manifest fetch happens on the visitor.
// This pure-TLS probe is the only thing runnable on edge infra; it returns the
// raw bytes the Worker sees, so the frontend can decide manifest-first vs
// queue-fallback. Mounted at /api/edge-probe by index.js.
export async function handleEdgeProbe(url, ua, accessKey) {
  const docId = extractDocId(url.searchParams.get("u") || url.searchParams.get("url") || "");
  if (!docId) return { probe: "edge", ok: false, error: "invalid scribd url" };
  if (!accessKey) {
    return { probe: "edge", ok: false, error: "manifest relay not configured", hint: EMBED_KEY_HINT };
  }
  const embed = embedUrl(docId, accessKey);
  try {
    const r = await fetch(embed, {
      headers: {
        "User-Agent":
          ua ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.scribd.com/",
      },
    });
    const t = await r.text();
    const m = extractManifest(t);
    const title = /<title>(.*?)<\/title>/s.exec(t);
    return {
      probe: "edge",
      ok: true,
      status: r.status,
      len: t.length,
      addPage: m.jsonpUrls.length,
      pageCount: m.pageCount,
      title: m.title || (title ? title[1].slice(0, 80) : null),
      challenged: t.includes("Client Challenge"),
      note: "edge fetch lacks TLS impersonation; Client Challenge on cloud IPs is expected",
    };
  } catch (e) {
    return { probe: "edge", ok: false, error: String(e).slice(0, 200) };
  }
}

export { embedUrl, handleManifestHtml };

