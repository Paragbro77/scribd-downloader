import worker from "./index.js";

const ENV = {
  ALLOWED_ORIGIN: "https://x.test",
  MANIFEST_RELAY: "https://relay.test",
  DB: null,
};
const ref = { Referer: "https://x.test/", "CF-Connecting-IP": "10.0.0.1" };

function stubRelay(payload, ok = true, status = 200) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => {
    assert.match(String(u), /^https:\/\/relay\.test\/manifest\?docId=\d+$/);
    return { ok, status, json: async () => payload };
  };
  return () => {
    globalThis.fetch = orig;
  };
}

import test from "node:test";
import assert from "node:assert/strict";

test("manifest route rejects bad doc id", async () => {
  const r = await worker.fetch(new Request("https://x.test/api/manifest/evil", { headers: ref }), ENV);
  assert.equal(r.status, 400);
});

test("manifest route rejects cross-origin", async () => {
  const r = await worker.fetch(
    new Request("https://x.test/api/manifest/558718376", {
      headers: { Referer: "https://evil.test/" },
    }),
    ENV
  );
  assert.equal(r.status, 403);
});

test("manifest route 503 without relay", async () => {
  const r = await worker.fetch(
    new Request("https://x.test/api/manifest/558718376", { headers: ref }),
    { ...ENV, MANIFEST_RELAY: "" }
  );
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.fallback, "queue");
});

test("manifest route relays parsed manifest", async () => {
  const restore = stubRelay({
    ok: true,
    title: "T",
    page_count: 2,
    inline: { 1: "https://html.scribdassets.com/h/images/1-aaa111.jpg" },
    jsonp_urls: ["https://html.scribdassets.com/h/pages/2-bbb222.jsonp"],
  });
  try {
    const r = await worker.fetch(
      new Request("https://x.test/api/manifest/558718376", { headers: ref }),
      ENV
    );
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.source, "relay");
    assert.equal(j.page_count, 2);
    assert.equal(j.inline["1"], "https://html.scribdassets.com/h/images/1-aaa111.jpg");
  } finally {
    restore();
  }
});

test("manifest route 502 with queue fallback when relay challenged", async () => {
  const restore = stubRelay({ ok: false, error: "challenged" }, false, 502);
  try {
    const r = await worker.fetch(
      new Request("https://x.test/api/manifest/558718376", { headers: ref }),
      ENV
    );
    assert.equal(r.status, 502);
    const j = await r.json();
    assert.equal(j.fallback, "queue");
  } finally {
    restore();
  }
});
