import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout } from "../server/services/applicationsSyncCommon.js";

// S2: Body-Lesen ist zeit- und grössenbegrenzt. Mit injiziertem Fetch (kein
// globalThis.fetch) bleibt der SSRF-DNS-Check aus, das Grössenlimit greift aber.

test("fetchWithTimeout bricht bei zu grossem Body ab", async () => {
  const oversized = "x".repeat(5000);
  const mockFetch = async () => new Response(oversized, { status: 200 });
  await assert.rejects(
    () => fetchWithTimeout(mockFetch, "http://quelle.example/data", { maxResponseBytes: 1000 }),
    /Grössenlimit/
  );
});

test("fetchWithTimeout liefert Body innerhalb des Limits", async () => {
  const mockFetch = async () => new Response("hallo welt", { status: 200 });
  const response = await fetchWithTimeout(mockFetch, "http://quelle.example/data", { maxResponseBytes: 1000 });
  assert.equal(response.ok, true);
  assert.equal(await response.text(), "hallo welt");
});

test("fetchWithTimeout liefert JSON-Body", async () => {
  const mockFetch = async () => new Response(JSON.stringify({ items: [1, 2, 3] }), { status: 200 });
  const response = await fetchWithTimeout(mockFetch, "http://quelle.example/api", {});
  const payload = await response.json();
  assert.deepEqual(payload.items, [1, 2, 3]);
});
