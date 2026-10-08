import assert from "node:assert/strict";
import test from "node:test";
import { buildFinalLandedPricingPreview, paginateFinalLandedPricingPreview } from "../../../shared/finalLandedPricing.js";

test("filtered pricing scope is preserved and every row remains inspectable beyond 50 products", () => {
  const filteredProducts = Array.from({ length: 73 }, (_, index) => ({
    id: `filtered-${index + 1}`,
    landed_cost_snapshot_id: `snapshot-${index + 1}`,
    landed_cost_numerator: 1_000,
    landed_cost_denominator: 1,
    landed_cost_try: 10,
    sale_price: 0,
  }));
  const preview = buildFinalLandedPricingPreview(filteredProducts, {
    bufferPercentage: 20,
    profitPercentage: 50,
    fixedTry: 0,
    roundingIncrement: 1,
  });

  assert.equal(preview.length, filteredProducts.length);
  assert.deepEqual(preview.map((row) => row.id), filteredProducts.map((row) => row.id));
  assert.equal(preview.every((row) => row.willUpdate && row.newSalePrice === 18), true);
  const firstPage = paginateFinalLandedPricingPreview(preview, 1);
  const secondPage = paginateFinalLandedPricingPreview(preview, 2);
  assert.deepEqual({ first: firstPage.rows.length, second: secondPage.rows.length, pages: secondPage.pageCount, total: secondPage.total },
    { first: 50, second: 23, pages: 2, total: 73 });
  assert.deepEqual([...firstPage.rows, ...secondPage.rows].map((row) => row.id), filteredProducts.map((row) => row.id));
});

test("pricing preview explains why kit, locked and missing FINAL Landed Cost products are skipped", () => {
  const preview = buildFinalLandedPricingPreview([
    { id: "kit", product_type: "kit", landed_cost_snapshot_id: "kit-snapshot", landed_cost_numerator: 100, landed_cost_denominator: 1, landed_cost_try: 1 },
    { id: "locked", price_locked: 1, landed_cost_snapshot_id: "locked-snapshot", landed_cost_numerator: 100, landed_cost_denominator: 1, landed_cost_try: 1 },
    { id: "missing", landed_cost_try: null },
  ], { bufferPercentage: 0, profitPercentage: 0, fixedTry: 0, roundingIncrement: 1 });

  assert.deepEqual(preview.map((row) => ({ id: row.id, willUpdate: row.willUpdate, reason: row.skipReason })), [
    { id: "kit", willUpdate: false, reason: "KIT" },
    { id: "locked", willUpdate: false, reason: "LOCKED" },
    { id: "missing", willUpdate: false, reason: "MISSING_LANDED_COST" },
  ]);
});
