import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SaleFinancialBreakdown } from "../../src/components/sales/SaleFinancialBreakdown.js";
import SalesForm from "../../src/components/sales/SalesForm.js";
import SaleDetailModal from "../../src/components/sales/SaleDetailModal.js";

test("new sale form excludes sale advertising and routes marketing to operating expenses", () => {
  const html = renderToStaticMarkup(React.createElement(SalesForm, { onBack() {} }));
  assert.doesNotMatch(html, /advertising_cost|Reklam \(boş = Bilinmiyor\)/);
  assert.match(html, /Marketing/);
  assert.match(html, /Gider Yönetimi/);
});

test("real Panel sale financial detail renders UNKNOWN and finalized lot values without fake zero profit", () => {
  const provisional = renderToStaticMarkup(React.createElement(SaleFinancialBreakdown, { financial: {
    state: "PROVISIONAL", currency: "TRY",
    totals: { grossMinor: 12000, vatMinor: 2000, netRevenueMinor: 10000, commissionMinor: 1000, actualCogsTryMinor: 5000, grossProfitTryMinor: 5000, provisionalNetContributionTryMinor: 4000, netContributionTryMinor: null },
    expenses: { shipping: { state: "UNKNOWN" }, packaging: { state: "UNKNOWN" }, other: { state: "UNKNOWN" } },
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
  assert.match(finalized, /Reklam \(eski kayıt, katkıya dahil değil\)/);
  assert.match(finalized, /LOT-1/);
  assert.match(finalized, /₺36,00/);
});

test("Sale Detail offers append-only facts for shipping, packaging and other without advertising", () => {
  const html = renderToStaticMarkup(React.createElement(SaleDetailModal, {
    sale: {
      id: "sale-1", order_code: "DS-1", customer_name: "Customer", status: "Hazırlanıyor", platform: "Satış Sistemi", items: [],
      financial: {
        state: "PROVISIONAL", currency: "TRY", snapshot: { id: "snapshot-1" },
        totals: { grossMinor: 12000, vatMinor: 2000, netRevenueMinor: 10000, commissionMinor: 1000, actualCogsTryMinor: 5000, grossProfitTryMinor: 5000, provisionalNetContributionTryMinor: 4000, netContributionTryMinor: null },
        expenses: { shipping: { state: "UNKNOWN" }, packaging: { state: "UNKNOWN" }, other: { state: "UNKNOWN" } }, lines: [],
      },
    },
    onClose() {},
  }));
  assert.match(html, /Gerçek satış gideri ekle/);
  assert.match(html, /Kargo/);
  assert.match(html, /Paketleme/);
  assert.match(html, /Diğer giderler/);
  assert.match(html, /0 geçerli bir gerçek tutardır/);
  assert.match(html, /V2-10 İade ve para iadesi/);
  assert.match(html, /Müşteri kargo ücretini ayrıca iade et/);
  assert.match(html, /İade oluştur/);
  assert.doesNotMatch(html, /Reklam gideri ekle|data-expense-category="advertising"/);
});
