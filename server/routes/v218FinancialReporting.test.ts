import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import Database from "better-sqlite3";
import { initializeDatabase } from "../db/initialize.js";
import { CatalogService } from "../modules/catalog/catalogService.js";
import { SalesFinancialService } from "../modules/sales/salesFinancialService.js";
import { createDashboardDataRouter } from "./dashboardDataRoutes.js";
import { createInsightsRouter } from "./insightsRoutes.js";
import { createProductAnalyticsRouter } from "./productAnalyticsRoutes.js";

test("legacy dashboards report V2-09 seller revenue after discount instead of pre-discount line gross", async () => {
  const db = new Database(":memory:");
  initializeDatabase(db);
  new CatalogService(db).createProduct({ id: "report-product", sku: "REPORT-1", title: "Report product", catalog_type: "product", base_uom_code: "piece" });
  const createdAt = new Date().toISOString().slice(0, 19).replace("T", " ");
  db.prepare("INSERT INTO sales (id,order_code,total_amount,platform,status,created_at) VALUES ('report-sale','REPORT-SALE',1000,'Direct','Tamamlandı',?)").run(createdAt);
  db.prepare("INSERT INTO sale_items (id,sale_id,product_id,product_name,quantity,unit_price) VALUES ('report-line','report-sale','report-product','Report product',1,1000)").run();
  new SalesFinancialService(db).createOrderSnapshot({
    saleId: "report-sale", currency: "TRY", sourceChannel: "Direct", discountMinor: 10_000,
    commissionRatePercent: "0", commissionCalculationBasis: "GROSS_AFTER_DISCOUNT", commissionTerms: { version: "test" },
    expenses: {
      shipping: { state: "KNOWN", amountMinor: 0, currency: "TRY", provenance: { source: "test" } },
      packaging: { state: "KNOWN", amountMinor: 0, currency: "TRY", provenance: { source: "test" } },
      other: { state: "KNOWN", amountMinor: 0, currency: "TRY", provenance: { source: "test" } },
    },
    lines: [{ saleLineId: "report-line", productId: "report-product", quantity: 1, unitGrossMinor: 100_000, vatRateBps: 2_000 }],
    operationId: "report-snapshot", actor: { id: "report-owner" }, createdAt,
  });

  const app = express();
  app.use("/dashboard", createDashboardDataRouter(db));
  app.use("/analytics", createProductAnalyticsRouter(db));
  app.use("/insights", createInsightsRouter(db));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  };
  try {
    const date = createdAt.slice(0, 10);
    const dashboard = await get(`/dashboard/widgets/product-analysis/summary?dateFrom=${date}&dateTo=${date}`);
    const analytics = await get(`/analytics/products/summary?startDate=${date}&endDate=${date}`);
    const insights = await get("/insights/overview?period=30");
    const top = await get("/insights/sales/top?period=30");
    assert.equal(dashboard.total_revenue, 900);
    assert.equal(analytics.totalRevenue, 900);
    assert.equal(insights.sales.revenue_try, 900);
    assert.equal(top.items[0].revenue, 900);
    assert.equal(dashboard.revenue_basis, "SELLER_REVENUE_AFTER_DISCOUNT_GROSS_INCL_VAT");
    assert.equal(analytics.revenueBasis, "SELLER_REVENUE_AFTER_DISCOUNT_GROSS_INCL_VAT");
    assert.equal(insights.sales.revenue_basis, "SELLER_REVENUE_AFTER_DISCOUNT_GROSS_INCL_VAT");
    assert.equal(top.revenue_basis, "SELLER_REVENUE_AFTER_DISCOUNT_GROSS_INCL_VAT");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
