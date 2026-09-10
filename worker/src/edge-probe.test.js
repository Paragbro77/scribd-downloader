import test from "node:test";
import assert from "node:assert/strict";
import { handleEdgeProbe } from "./edge-probe.js";

test("edge-probe rejects invalid url without fetching", async () => {
  const r = await handleEdgeProbe(
    new URL("https://x.test/api/edge-probe?u=https://evil.com/x"),
    "UA",
    "K"
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid scribd url");
});

test("edge-probe needs an access key", async () => {
  const r = await handleEdgeProbe(
    new URL("https://x.test/api/edge-probe?u=558718376"),
    "UA",
    ""
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "manifest relay not configured");
});

test("edge-probe reports challenge shape on stubbed fetch", async () => {
  const orig = globalThis.fetch;
  let seen = "";
  globalThis.fetch = async (u) => {
    seen = String(u);
    return {
      status: 200,
      headers: { get: () => "text/html" },
      text: async () =>
        "<html><head><title>Client Challenge</title></head><body>challenge</body></html>",
    };
  };
  try {
    const r = await handleEdgeProbe(
      new URL("https://x.test/api/edge-probe?u=558718376"),
      "UA",
      "K"
    );
    assert.equal(r.ok, true);
    assert.equal(r.addPage, 0);
    assert.equal(r.challenged, true);
    assert.match(seen, /access_key=K$/);
  } finally {
    globalThis.fetch = orig;
  }
});
