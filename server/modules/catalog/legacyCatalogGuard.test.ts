import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { rejectLegacyCatalogMutation } from "./legacyCatalogGuard.js";

let baseUrl = "";
let server: ReturnType<express.Express["listen"]>;

before(async () => {
  const app = express();
  app.use("/api/products", rejectLegacyCatalogMutation);
  app.use("/api/products", (_req, res) => res.json({ passed: true }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

test("legacy product identity create/update/delete paths fail closed", async () => {
  for (const [method, path] of [["POST", ""], ["POST", "/import"], ["POST", "/bulk-import"], ["PUT", "/p1"], ["DELETE", "/p1"]] as const) {
    const response = await fetch(`${baseUrl}/api/products${path}`, { method });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as any).error.code, "CANONICAL_CATALOG_COMMAND_REQUIRED");
  }
});

test("legacy reads and non-identity image/pricing paths remain available", async () => {
  assert.equal((await fetch(`${baseUrl}/api/products`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/products/bulk-pricing`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/products/p1/images`, { method: "POST" })).status, 200);
});
