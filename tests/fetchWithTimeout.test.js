import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout } from "../server/services/applicationsSyncCommon.js";

// S2: Body-Lesen ist zeit- und grössenbegrenzt. Mit injiziertem Fetch (kein
// globalThis.fetch) bleibt der SSRF-DNS-Check aus, das Grössenlimit greift aber.

test("fetchWithTimeout bricht bei zu grossem Body ab", async () => {
  const oversized = "x".repeat(5000);
  const mockFetch = async () => new Response(oversized, { status: 200 });
  await assert.rejects(
    () => fetchWithTimeout(mockFetch, "http://quelle.example/data", { maxResponseBytes: 1000, enforceSsrf: false }),
    /Grössenlimit/
  );
});

test("fetchWithTimeout liefert Body innerhalb des Limits", async () => {
  const mockFetch = async () => new Response("hallo welt", { status: 200 });
  const response = await fetchWithTimeout(mockFetch, "http://quelle.example/data", {
    maxResponseBytes: 1000,
    enforceSsrf: false
  });
  assert.equal(response.ok, true);
  assert.equal(await response.text(), "hallo welt");
});

test("fetchWithTimeout liefert JSON-Body", async () => {
  const mockFetch = async () => new Response(JSON.stringify({ items: [1, 2, 3] }), { status: 200 });
  const response = await fetchWithTimeout(mockFetch, "http://quelle.example/api", { enforceSsrf: false });
  const payload = await response.json();
  assert.deepEqual(payload.items, [1, 2, 3]);
});

test("fetchWithTimeout erzwingt SSRF-Schutz auch bei injiziertem Fetch", async () => {
  const mockFetch = async () => new Response("sollte nicht geholt werden", { status: 200 });
  await assert.rejects(
    () => fetchWithTimeout(mockFetch, "http://127.0.0.1/internal", { maxResponseBytes: 1000 }),
    /SSRF/
  );
});

test("fetchWithTimeout verwendet den verbindungsgebundenen SSRF-Dispatcher", async () => {
  const dispatchers = [];
  const mockFetch = async (_resource, options) => {
    dispatchers.push(options.dispatcher);
    return new Response("ok", { status: 200 });
  };
  mockFetch.supportsSsrfDispatcher = true;

  await fetchWithTimeout(mockFetch, "http://93.184.216.34/data", { maxResponseBytes: 1000 });

  assert.equal(dispatchers.length, 1);
  assert.ok(dispatchers[0], "geschützter Request muss einen Dispatcher erhalten");
});

test("fetchWithTimeout lehnt Fetch-Implementierungen ohne sicheren Dispatcher fail-closed ab", async () => {
  const incompatibleFetch = async () => new Response("unsicher", { status: 200 });

  await assert.rejects(
    () => fetchWithTimeout(incompatibleFetch, "http://93.184.216.34/data", { maxResponseBytes: 1000 }),
    /verbindungsgebundenen DNS-Lookup/
  );
});
