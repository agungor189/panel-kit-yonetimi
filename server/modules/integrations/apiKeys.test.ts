import assert from "node:assert/strict";
import test from "node:test";
import { createApiKeyHasher } from "./apiKeys.js";

test("Panel API key hashing is deterministic and secret-bound", () => {
  const first = createApiKeyHasher("operations-test-hash-secret");
  const second = createApiKeyHasher("different-operations-test-secret");
  assert.equal(first("clear-key"), first("clear-key"));
  assert.notEqual(first("clear-key"), first("another-key"));
  assert.notEqual(first("clear-key"), second("clear-key"));
  assert.equal(first("clear-key").length, 64);
});

