import assert from "node:assert/strict";
import test from "node:test";
import { chunkItems, PRODUCT_IMAGE_CLIENT_BATCH_SIZE, PRODUCT_IMAGE_SERVER_BATCH_LIMIT } from "../../shared/productImageBatch";

test("product images are split into bounded sequential batches", () => {
  assert.equal(PRODUCT_IMAGE_CLIENT_BATCH_SIZE, 25);
  assert.equal(PRODUCT_IMAGE_SERVER_BATCH_LIMIT, 50);
  assert.deepEqual(chunkItems(Array.from({ length: 50 }, (_, index) => index)).map((batch) => batch.length), [25, 25]);
  assert.deepEqual(chunkItems(Array.from({ length: 100 }, (_, index) => index)).map((batch) => batch.length), [25, 25, 25, 25]);
  assert.deepEqual(chunkItems(Array.from({ length: 185 }, (_, index) => index)).map((batch) => batch.length), [25, 25, 25, 25, 25, 25, 25, 10]);
  assert.deepEqual(chunkItems(Array.from({ length: 300 }, (_, index) => index)).map((batch) => batch.length), Array(12).fill(25));
});

test("chunking never drops or reorders files", () => {
  const files = Array.from({ length: 300 }, (_, index) => `SKU-${index + 1}.png`);
  assert.deepEqual(chunkItems(files).flat(), files);
});
