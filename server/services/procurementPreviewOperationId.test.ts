import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../../src/lib/api.js";

test("procurement previews send without an operation ID while mutation POSTs still require one", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; operationId: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: String(init?.method),
      operationId: new Headers(init?.headers).get("X-Operation-ID"),
    });
    return new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const previews = [
      "/procurement/v1/imports/preview",
      "/procurement/v1/purchases/csv-preview",
      "/procurement/v1/purchases/purchase-1/cost-preview",
    ];
    for (const endpoint of previews) await api.post(endpoint, { sample: true });
    assert.deepEqual(requests, previews.map((endpoint) => ({
      url: `/api${endpoint}`, method: "POST", operationId: null,
    })));

    const mutations = [
      "/procurement/v1/imports/apply",
      "/procurement/v1/purchases",
      "/procurement/v1/purchases/purchase-1/costs",
      "/procurement/v1/purchases/purchase-1/finalize-costs",
      "/procurement/v1/purchases/purchase-1/cost-preview/extra",
    ];
    for (const endpoint of mutations) {
      await assert.rejects(() => api.post(endpoint, {}), /X-Operation-ID is required/);
    }
    assert.equal(requests.length, previews.length, "rejected mutations must not reach fetch");

    await api.post("/procurement/v1/purchases/purchase-1/costs", {}, { operationId: "cost-1" });
    assert.deepEqual(requests.at(-1), {
      url: "/api/procurement/v1/purchases/purchase-1/costs", method: "POST", operationId: "cost-1",
    });
    await assert.rejects(() => api.upload("/procurement/v1/purchases/purchase-1/documents", new FormData()), /X-Operation-ID is required/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
