import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SaleFinancialBreakdown } from "../../src/components/sales/SaleFinancialBreakdown.js";

test("real Panel sale financial detail renders UNKNOWN and finalized lot values without fake zero profit", () => {
  const provisional = renderToStaticMarkup(React.createElement(SaleFinancialBreakdown, { financial: {
    state: "PROVISIONAL", currency: "TRY",
    totals: { grossMinor: 12000, vatMinor: 2000, netRevenueMinor: 10000, commissionMinor: 1000, actualCogsTryMinor: 5000, grossProfitTryMinor: 5000, provisionalNetContributionTryMinor: 4000, netContributionTryMinor: null },
    expenses: { shipping: { state: "UNKNOWN" }, packaging: { state: "UNKNOWN" }, advertising: { state: "UNKNOWN" }, other: { state: "UNKNOWN" } },
    lines: [],
  } }));
  assert.match(provisional, /Bilinmiyor/);
  assert.match(provisional, /nihai net kâr değildir/);
  assert.doesNotMatch(provisional, /Net katkı<\/dt><dd[^>]*>₺0,00/);

  const finalized = renderToStaticMarkup(React.createElement(SaleFinancialBreakdown, { financial: {
    state: "FINAL", currency: "TRY",
    totals: { grossMinor: 12000, vatMinor: 2000, netRevenueMinor: 10000, commissionMinor: 1000, actualCogsTryMinor: 5000, grossProfitTryMinor: 5000, provisionalNetContributionTryMinor: 3600, netContributionTryMinor: 3600 },
    expenses: { shipping: { state: "KNOWN", amountTryMinor: 100 }, packaging: { state: "KNOWN", amountTryMinor: 100 }, advertising: { state: "KNOWN", amountTryMinor: 100 }, other: { state: "KNOWN", amountTryMinor: 100 } },
    lines: [{ id: "line", productSku: "SKU", productTitle: "Product", cogsAllocations: [{ inventoryLotId: "LOT-1", quantityBaseInt: 2, baseUomCode: "piece", costTryMinor: 5000 }] }],
  } }));
  assert.match(finalized, /Kesinleşti/);
  assert.match(finalized, /LOT-1/);
  assert.match(finalized, /₺36,00/);
});
