import assert from "node:assert/strict";
import test from "node:test";
import { calculateFinalLandedSalePrice, finalLandedPricingDecision } from "../../../shared/finalLandedPricing.js";

test("bulk pricing uses FINAL landed cost with buffer and profit", () => {
  assert.equal(calculateFinalLandedSalePrice(100, 20, 50), 180);
  assert.equal(calculateFinalLandedSalePrice(99.01, 10, 25), 137);
});

test("single and bulk pricing combine fixed TRY and upward rounding", () => {
  assert.equal(calculateFinalLandedSalePrice(100, 20, 50, 3, 5), 185);
  assert.deepEqual(finalLandedPricingDecision(100, 20, 50, 3, 5), {
    newSalePrice: 185,
    willUpdate: true,
    skipReason: null,
  });
  assert.equal(calculateFinalLandedSalePrice(100, 0, 0, 1.01, 10), 110);
});

test("bulk pricing cannot derive a price without FINAL landed cost", () => {
  assert.equal(calculateFinalLandedSalePrice(null, 20, 50), null);
  assert.equal(calculateFinalLandedSalePrice(undefined, 20, 50), null);
  assert.deepEqual(finalLandedPricingDecision(null, 20, 50), {
    newSalePrice: null,
    willUpdate: false,
    skipReason: "MISSING_LANDED_COST",
  });
  assert.deepEqual(finalLandedPricingDecision(0, 0, 0), {
    newSalePrice: null,
    willUpdate: false,
    skipReason: "NON_POSITIVE_PRICE",
  });
});
