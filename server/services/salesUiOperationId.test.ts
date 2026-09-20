import assert from "node:assert/strict";
import test from "node:test";
import { api, createRetryOperation } from "../../src/lib/api.js";

test("sales UI API calls require a client operation ID and preserve it for the same retry payload", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; operationId: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: String(init?.method || "GET"),
      operationId: new Headers(init?.headers).get("x-operation-id"),
    });
    return new Response(JSON.stringify({ success: true, sale: { id: "sale-1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(() => api.post("/sales", { total_amount: 1 }), /X-Operation-ID is required/);
    await assert.rejects(() => api.put("/sales/sale-1", { status: "Hazırlanıyor" }), /X-Operation-ID is required/);
    await assert.rejects(() => api.patch("/sales/sale-1/status", { status: "İptal Edildi" }), /X-Operation-ID is required/);

    const operation = createRetryOperation("sale-create");
    const payload = { total_amount: 10, items: [{ product_id: "part", quantity: 1 }] };
    const firstId = operation.idFor(payload);
    await api.post("/sales", payload, { operationId: firstId });
    const retryId = operation.idFor({ total_amount: 10, items: [{ product_id: "part", quantity: 1 }] });
    await api.post("/sales", payload, { operationId: retryId });
    assert.equal(retryId, firstId);

    const changedId = operation.idFor({ ...payload, total_amount: 11 });
    assert.notEqual(changedId, firstId);
    const updateOperation = createRetryOperation("sale-update");
    const updatePayload = { status: "Hazırlanıyor" };
    await api.put("/sales/sale-1", updatePayload, { operationId: updateOperation.idFor(updatePayload) });
    const statusOperation = createRetryOperation("sale-status");
    const statusPayload = { status: "İptal Edildi" };
    await api.patch("/sales/sale-1/status", statusPayload, { operationId: statusOperation.idFor(statusPayload) });

    assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
      { url: "/api/sales", method: "POST" },
      { url: "/api/sales", method: "POST" },
      { url: "/api/sales/sale-1", method: "PUT" },
      { url: "/api/sales/sale-1/status", method: "PATCH" },
    ]);
    assert.ok(requests.every(({ operationId }) => typeof operationId === "string" && operationId.length > 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
