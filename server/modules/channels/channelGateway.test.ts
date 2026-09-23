import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { InventoryService } from "../inventory/inventoryService.js";
import { ProcurementService } from "../procurement/procurementService.js";
import { SalesFinancialService } from "../sales/salesFinancialService.js";
import { authoredKitContentHash, PublishedKitService } from "../kits/publishedKitService.js";
import { calculateInverseCommissionPrice, CHANNEL_ADAPTERS, ChannelGatewayError, ChannelGatewayService } from "./channelGateway.js";

const actor = { id: "channel-admin", name: "Channel Admin" };

const setup = (stock = 5) => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  new CatalogService(db).createProduct({ id: "part", sku: "PART-1", title: "Part", catalog_type: "product", base_uom_code: "piece" });
  db.prepare("UPDATE products SET sale_price=1000 WHERE id='part'").run();
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "supplier", name: "Supplier", defaultCurrency: "TRY" });
  procurement.createPurchase({ id: "purchase", supplierId: "supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
    invoiceNumber: "INV-CHANNEL", invoiceDate: "2026-09-23", lines: [{ id: "purchase-line", productId: "part", quantity: String(stock),
      quoteBasis: "piece", supplierUnitPriceMinor: 100, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }] });
  const cost = procurement.finalizeAcquisitionCosts("purchase", { allocations: [] }).lots[0];
  new InventoryService(db).receiveCostedLot({ receiptId: "receipt", costSnapshotId: cost.id, receivedAt: "2026-09-23T08:00:00.000Z",
    location: { id: "pick", kind: "PICKING" }, operationId: "receive-channel-stock" });
  const gateway = new ChannelGatewayService(db);
  gateway.configureAccount({ id: "account", channel: "TRENDYOL", merchantAccountId: "merchant", environment: "STAGE",
    secretReference: "env:TRENDYOL_KEY", operationId: "configure-account", actor });
  gateway.mapProduct({ id: "mapping", accountId: "account", externalListingId: "listing-part", externalSku: "EXT-PART",
    productId: "part", categoryRef: "parts", operationId: "map-part", actor });
  gateway.setCommissionTerm({ id: "term-20", accountId: "account", productId: "part", state: "KNOWN",
    rate: { numerator: 1, denominator: 5 }, provenance: { source: "merchant-contract", version: "2026-09" },
    version: 1, effectiveFrom: "2026-09-01T00:00:00.000Z", operationId: "term-part", actor });
  return { db, gateway, inventory: new InventoryService(db) };
};

const order = (overrides: Record<string, unknown> = {}) => ({
  accountId: "account", externalEventId: "event-1", externalEventVersion: "1", externalOrderId: "order-1",
  eventType: "ORDER_UPSERT" as const, ingestionPath: "WEBHOOK" as const, currency: "TRY", discountMinor: 0,
  lines: [{ externalLineId: "line-1", externalListingId: "listing-part", externalSku: "EXT-PART",
    quantityBaseInt: 2, actualUnitGrossMinor: 120_000, vatRateBps: 2_000 }],
  rawPayload: { order: "order-1", authorization: "Bearer plaintext-secret", nested: { api_key: "secret-key" } },
  providerOccurredAt: "2026-09-23T09:00:00.000Z", receivedAt: "2026-09-23T09:00:01.000Z", ...overrides,
});

test("inverse commission pricing and all four adapter contracts are exact and fail-closed", () => {
  assert.equal(calculateInverseCommissionPrice(100_000, { numerator: 1, denominator: 5 }), 125_000);
  assert.deepEqual(Object.keys(CHANNEL_ADAPTERS).sort(), ["HEPSIBURADA", "N11", "SHOPIFY", "TRENDYOL"]);
  for (const adapter of Object.values(CHANNEL_ADAPTERS)) {
    assert.equal(adapter.mayMutateCanonicalAuthority, false);
    assert.equal(adapter.supportsPollingReconciliation, true);
  }
  assert.equal(CHANNEL_ADAPTERS.TRENDYOL.enabledTransport, true);
  assert.equal(CHANNEL_ADAPTERS.HEPSIBURADA.enabledTransport, false);
  assert.equal(CHANNEL_ADAPTERS.N11.enabledTransport, false);
  assert.equal(CHANNEL_ADAPTERS.SHOPIFY.enabledTransport, false);
});

test("webhook and poll converge once, reserve immediately, preserve actual price and immutable commission provenance", () => {
  const { db, gateway, inventory } = setup();
  const first = gateway.ingest(order(), "ingest-order-1", "channel-worker");
  assert.equal(first.result.body.state, "ACCEPTED");
  assert.equal(db.prepare("SELECT COUNT(*) FROM sales").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_reservations").pluck().get(), 1);
  assert.deepEqual(inventory.getProductAvailability("part"), { productId: "part", baseUomCode: "piece", onHandBaseInt: 5, reservedBaseInt: 2, availableBaseInt: 3 });
  const saleId = (first.result.body as any).saleId;
  const snapshotBefore = db.prepare("SELECT * FROM sale_financial_snapshots WHERE sale_id=?").get(saleId) as any;
  assert.equal(db.prepare("SELECT unit_gross_minor FROM sale_financial_lines WHERE financial_snapshot_id=?").pluck().get(snapshotBefore.id), 120_000);
  assert.equal(snapshotBefore.commission_amount_minor, 48_000);
  assert.match(snapshotBefore.commission_terms_json, /merchant-contract/);
  assert.deepEqual(db.prepare(`SELECT target_price_minor AS target,expected_channel_price_minor AS expected,
    actual_channel_price_minor AS actual,difference_minor AS difference FROM channel_price_variances`).get(),
  { target: 100_000, expected: 125_000, actual: 120_000, difference: -5_000 });
  const raw = String(db.prepare("SELECT raw_payload_json FROM channel_inbound_events WHERE external_event_id='event-1'").pluck().get());
  assert.doesNotMatch(raw, /plaintext-secret|secret-key/);
  assert.match(raw, /\[REDACTED\]/);
  assert.throws(() => db.prepare("UPDATE channel_order_lines SET actual_unit_gross_minor=1").run(), /immutable/i);
  assert.throws(() => db.prepare("UPDATE channel_inbound_events SET raw_payload_json='{}'").run(), /immutable/i);
  assert.throws(() => db.prepare("UPDATE channel_commission_terms SET rate_numerator=0").run(), /immutable/i);

  const commandReplay = gateway.ingest(order(), "ingest-order-1", "channel-worker");
  assert.equal(commandReplay.replayed, true);
  const pollReplay = gateway.ingest(order({ externalEventId: "poll-event-1", ingestionPath: "POLL" }), "ingest-poll-order-1", "channel-worker");
  assert.equal(pollReplay.result.body.state, "DUPLICATE");
  assert.equal(db.prepare("SELECT COUNT(*) FROM sales").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_reservations").pluck().get(), 1);
  assert.deepEqual(db.prepare("SELECT * FROM sale_financial_snapshots WHERE sale_id=?").get(saleId), snapshotBefore);
  assert.throws(() => db.prepare("UPDATE sale_financial_snapshots SET commission_terms_json='{}' WHERE sale_id=?").run(saleId), /immutable/i);
  db.close();
});

test("unmapped SKU and insufficient stock create explicit exceptions without products, sales, or negative stock", () => {
  const { db, gateway, inventory } = setup(2);
  const productsBefore = Number(db.prepare("SELECT COUNT(*) FROM products").pluck().get());
  const unmapped = gateway.ingest(order({ externalEventId: "event-unmapped", externalOrderId: "order-unmapped",
    lines: [{ externalLineId: "unknown-line", externalListingId: "not-mapped", externalSku: "UNKNOWN", quantityBaseInt: 1,
      actualUnitGrossMinor: 100_000, vatRateBps: 2_000 }] }), "ingest-unmapped", "channel-worker");
  assert.equal(unmapped.result.body.state, "EXCEPTION");
  assert.equal(db.prepare("SELECT exception_type FROM channel_exceptions WHERE channel_order_id IS NOT NULL ORDER BY created_at LIMIT 1").pluck().get(), "CHANNEL_MAPPING_EXCEPTION");
  assert.equal(db.prepare("SELECT COUNT(*) FROM products").pluck().get(), productsBefore);
  assert.equal(db.prepare("SELECT COUNT(*) FROM sales").pluck().get(), 0);

  const shortage = gateway.ingest(order({ externalEventId: "event-short", externalOrderId: "order-short",
    lines: [{ externalLineId: "short-line", externalListingId: "listing-part", quantityBaseInt: 3,
      actualUnitGrossMinor: 125_000, vatRateBps: 2_000 }] }), "ingest-short", "channel-worker");
  assert.equal(shortage.result.body.state, "EXCEPTION");
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_exceptions WHERE exception_type='STOCK_EXCEPTION'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM sales").pluck().get(), 0);
  assert.deepEqual(inventory.getProductAvailability("part"), { productId: "part", baseUomCode: "piece", onHandBaseInt: 2, reservedBaseInt: 0, availableBaseInt: 2 });
  db.close();
});

test("stock buffer is outbound-only; cursor and retry state are durable and replay-safe; unknown commission blocks price", () => {
  const { db, gateway, inventory } = setup();
  gateway.setStockBuffer({ id: "buffer", accountId: "account", productId: "part", bufferQuantityBaseInt: 2,
    operationId: "buffer-part", actor });
  const before = inventory.getProductAvailability("part");
  const stock = gateway.enqueueStockSync({ accountId: "account", productId: "part", sourceVersion: "inventory-v1", operationId: "stock-job", actor }) as any;
  assert.equal(stock.payload.quantityBaseInt, 3);
  assert.deepEqual(inventory.getProductAvailability("part"), before);
  const price = gateway.enqueuePriceSync({ accountId: "account", productId: "part", sourceVersion: "price-v1", operationId: "price-job", actor }) as any;
  assert.equal(price.payload.channelPriceMinor, 125_000);
  const firstAttempt = gateway.recordOutboundAttempt({ jobId: price.id, providerMutationId: "provider-mutation-1", state: "RATE_LIMITED",
    errorCode: "RATE_LIMIT", retryAt: "2026-09-23T10:01:00.000Z", operationId: "attempt-1", serviceActorId: "worker", occurredAt: "2026-09-23T10:00:00.000Z" }) as any;
  const retry = gateway.recordOutboundAttempt({ jobId: price.id, providerMutationId: "provider-mutation-1", state: "RATE_LIMITED",
    errorCode: "RATE_LIMIT", retryAt: "2026-09-23T10:01:00.000Z", operationId: "attempt-1", serviceActorId: "worker", occurredAt: "2026-09-23T10:00:00.000Z" }) as any;
  assert.deepEqual(retry, firstAttempt);
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_outbound_attempts").pluck().get(), 1);
  gateway.updatePollingCursor({ accountId: "account", cursorName: "orders", checkpointValue: "cursor-1",
    operationId: "cursor-1", serviceActorId: "poller", updatedAt: "2026-09-23T10:00:00.000Z" });
  const cursorReplay = gateway.updatePollingCursor({ accountId: "account", cursorName: "orders", checkpointValue: "cursor-1",
    operationId: "cursor-1", serviceActorId: "poller", updatedAt: "2026-09-23T10:00:00.000Z" });
  assert.equal((cursorReplay as any).version, 1);
  assert.deepEqual(db.prepare("SELECT checkpoint_value AS value,checkpoint_version AS version FROM channel_poll_cursors").get(), { value: "cursor-1", version: 1 });

  gateway.configureAccount({ id: "n11", channel: "N11", merchantAccountId: "merchant-n11", environment: "STAGE",
    operationId: "configure-n11", actor });
  gateway.mapProduct({ id: "n11-map", accountId: "n11", externalListingId: "n11-listing", productId: "part",
    operationId: "map-n11", actor });
  assert.throws(() => gateway.enqueuePriceSync({ accountId: "n11", productId: "part", sourceVersion: "price-v1",
    operationId: "n11-price", actor }), (error: unknown) => error instanceof ChannelGatewayError && error.code === "COMMISSION_UNKNOWN");
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_outbound_jobs WHERE account_id='n11'").pluck().get(), 0);
  assert.throws(() => gateway.configureAccount({ id: "bad-secret", channel: "SHOPIFY", merchantAccountId: "bad",
    environment: "STAGE", secretReference: "plaintext-secret", config: { access_token: "also-plaintext" },
    operationId: "bad-secret", actor }), (error: unknown) => error instanceof ChannelGatewayError && error.code === "SECRET_REFERENCE_REQUIRED");
  db.close();
});

test("pre-dispatch cancellation releases reservation", () => {
  const { db, gateway, inventory } = setup();
  const accepted = gateway.ingest(order(), "ingest-cancel-base", "channel-worker");
  assert.equal(inventory.getProductAvailability("part").reservedBaseInt, 2);
  const cancelled = gateway.ingest(order({ externalEventId: "cancel-event", externalEventVersion: "2", eventType: "ORDER_CANCELLED",
    lines: [], receivedAt: "2026-09-23T10:00:00.000Z" }), "ingest-cancel", "channel-worker");
  assert.equal(cancelled.result.body.state, "CANCELLED");
  assert.equal(inventory.getProductAvailability("part").reservedBaseInt, 0);
  assert.equal(db.prepare("SELECT status FROM sales WHERE id=?").pluck().get((accepted.result.body as any).saleId), "İptal Edildi");
  db.close();
});

test("channel kit order reserves the exact published V2-11 version and components", () => {
  const { db, gateway } = setup(5);
  const versionRef = String(db.prepare("SELECT catalog_version_ref FROM products WHERE id='part'").pluck().get());
  const source = {
    workspaceKitId: "channel-kit", workspaceVersionId: "channel-kit-v1", publishedKitId: null,
    sku: "CHANNEL-KIT", title: "Channel Kit", components: [{ productId: "part", catalogVersionRef: versionRef, quantityBaseInt: 2, role: "PART" }],
    packagingPlan: { packageCount: 1, instructionVersion: "pack:v1", installationGuideVersion: "guide:v1",
      packages: [{ packageNumber: 1, items: [{ productId: "part", quantityBaseInt: 2 }] }] },
    finalSalePriceMinor: 100_000, currency: "TRY",
  };
  const proposal = { ...source, authoredContentHash: authoredKitContentHash(source) };
  const publisher = new PublishedKitService(db);
  const preview = publisher.preview(proposal);
  const published = publisher.publish({ proposal, approvedContentHash: preview.contentHash, approvedPolicyHash: preview.corePolicyHash,
    operationId: "publish-channel-kit", actor: { id: "owner" }, publishedAt: "2026-09-23T08:30:00.000Z" });
  gateway.mapProduct({ id: "kit-map", accountId: "account", externalListingId: "listing-kit", productId: published.productId,
    categoryRef: "kits", operationId: "map-kit", actor });
  gateway.setCommissionTerm({ id: "kit-term", accountId: "account", productId: published.productId, state: "KNOWN",
    rate: { numerator: 1, denominator: 5 }, provenance: { source: "kit-contract" }, version: 1,
    effectiveFrom: "2026-09-01T00:00:00.000Z", operationId: "term-kit", actor });
  const accepted = gateway.ingest(order({ externalEventId: "kit-event", externalOrderId: "kit-order",
    lines: [{ externalLineId: "kit-line", externalListingId: "listing-kit", quantityBaseInt: 1,
      actualUnitGrossMinor: 125_000, vatRateBps: 2_000 }] }), "ingest-kit", "channel-worker");
  const saleId = (accepted.result.body as any).saleId;
  assert.equal(db.prepare(`SELECT published_kit_version_id FROM sale_kit_version_snapshots s
    JOIN sale_financial_lines l ON l.id=s.financial_line_id JOIN sale_financial_snapshots f ON f.id=l.financial_snapshot_id
    WHERE f.sale_id=?`).pluck().get(saleId), published.versionId);
  assert.deepEqual(db.prepare(`SELECT product_id AS productId,quantity_base_int AS quantity FROM inventory_reservation_lines
    WHERE reservation_id=?`).all((accepted.result.body as any).reservationId), [{ productId: "part", quantity: 2 }]);
  db.close();
});

test("post-dispatch channel return opens V2-10 workflow without direct restock or refund", () => {
  const { db, gateway, inventory } = setup();
  const accepted = gateway.ingest(order({ lines: [{ externalLineId: "line-1", externalListingId: "listing-part", quantityBaseInt: 1,
    actualUnitGrossMinor: 125_000, vatRateBps: 2_000 }] }), "ingest-return-base", "channel-worker");
  const saleId = (accepted.result.body as any).saleId;
  const reservationId = (accepted.result.body as any).reservationId;
  inventory.markPicked({ reservationId, operationId: "pick" });
  inventory.markPacked({ reservationId, operationId: "pack" });
  inventory.dispatchReservation({ reservationId, shipmentId: "shipment", dispatchedAt: "2026-09-23T10:00:00.000Z", operationId: "dispatch" });
  new SalesFinancialService(db).finalizeDispatch({ reservationId, operationId: "dispatch", actor: { id: "warehouse" }, finalizedAt: "2026-09-23T10:00:00.000Z" });
  const before = inventory.getProductAvailability("part");
  const returned = gateway.ingest(order({ externalEventId: "return-event", externalEventVersion: "2", eventType: "ORDER_RETURNED",
    lines: [], receivedAt: "2026-09-23T11:00:00.000Z" }), "ingest-return", "channel-worker");
  assert.equal(returned.result.body.state, "RETURN_REQUESTED");
  assert.equal(db.prepare("SELECT COUNT(*) FROM return_requests WHERE sale_id=?").pluck().get(saleId), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM return_receipts").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM refund_payments").pluck().get(), 0);
  assert.deepEqual(inventory.getProductAvailability("part"), before);
  db.close();
});
