import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePermissions } from "./permissions.js";

test("Customer Hub permission allowlist preserves only known boolean flags", () => {
  const permissions = sanitizePermissions({
    "customer_hub:view": true,
    "customer_hub:reply": false,
    "customer_hub:unknown": true,
  });
  assert.equal(permissions["customer_hub:view"], true);
  assert.equal(permissions["customer_hub:reply"], false);
  assert.equal(permissions["customer_hub:unknown"], undefined);
});
