// Worker route (client-side pipeline): manifest fetch happens on the visitor.
// This pure-TLS probe is the only thing runnable on edge infra; it returns the
// raw bytes the Worker sees, so the frontend can decide manifest-first vs
// queue-fallback. Mounted at /api/edge-probe by index.js.
import { extractDocId, extractManifest } from "./manifest.js";

// Worker route (client-side pipeline): manifest fetch happens on the visitor.
// This pure-TLS probe is the only thing runnable on edge infra; it returns the
// raw bytes the Worker sees, so the frontend can decide manifest-first vs
// queue-fallback. Mounted at /api/edge-probe by index.js.
export async function handleEdgeProbe(url, ua, accessKey) {
  const docId = extractDocId(url.searchParams.get("u") || url.searchParams.get("url") || "");
  if (!docId) return { probe: "edge", ok: false, error: "invalid scribd url" };
  if (!accessKey) return { probe: "edge", ok: false, error: "manifest relay not configured" };
  const embed =
    `https://www.scribd.com/embeds/${docId}/content` +
    `?start_page=1&view_mode=scroll&access_key=${accessKey}`;
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
