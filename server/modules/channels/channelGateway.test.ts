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
import { TrendyolGatewayTransport } from "./trendyolGatewayTransport.js";

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

test("STOCK_DISCREPANCY inventory remains physical on-hand but publishes zero sellable stock", () => {
  const { db, gateway, inventory } = setup(5);
  db.prepare("UPDATE inventory_lots SET status='STOCK_DISCREPANCY' WHERE product_id='part'").run();
  assert.equal(inventory.getProductAvailability("part").availableBaseInt, 5, "physical availability remains visible for reconciliation");

  const explicit = gateway.enqueueStockSync({ accountId: "account", productId: "part", sourceVersion: "inventory-discrepancy",
    operationId: "stock-discrepancy", actor }) as any;
  assert.equal(explicit.payload.canonicalAvailableBaseInt, 5);
  assert.equal(explicit.payload.quantityBaseInt, 0);

  const dashboard = gateway.getDashboard() as any;
  assert.equal(dashboard.mappings[0].canonicalAvailableBaseInt, 5);
  assert.equal(dashboard.mappings[0].publishableStockBaseInt, 0);
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

test("exception orders resolve and reprocess exactly once after mapping or stock remediation", () => {
  const { db, gateway, inventory } = setup(2);
  const unmapped = gateway.ingest(order({ externalEventId: "recover-map-event", externalOrderId: "recover-map-order",
    lines: [{ externalLineId: "recover-map-line", externalListingId: "recover-listing", quantityBaseInt: 1,
      actualUnitGrossMinor: 125_000, vatRateBps: 2_000 }] }), "recover-map-ingest", "channel-worker") as any;
  const mappingOrderId = String(db.prepare("SELECT id FROM channel_orders WHERE external_order_id='recover-map-order'").pluck().get());
  gateway.mapProduct({ id: "recover-map", accountId: "account", externalListingId: "recover-listing", productId: "part",
    categoryRef: "parts", operationId: "recover-map-create", actor });
  const accepted = gateway.resolveAndReprocessOrder({ orderId: mappingOrderId, operationId: "recover-map-process",
    actor, resolvedAt: "2026-09-23T10:00:00.000Z" }) as any;
  assert.equal(accepted.state, "ACCEPTED");
  assert.equal((gateway.resolveAndReprocessOrder({ orderId: mappingOrderId, operationId: "recover-map-process",
    actor, resolvedAt: "2026-09-23T10:00:00.000Z" }) as any).saleId, accepted.saleId);
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_order_lines WHERE channel_order_id=?").pluck().get(mappingOrderId), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM sales WHERE id=?").pluck().get(accepted.saleId), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_exceptions WHERE channel_order_id=? AND state='RESOLVED'").pluck().get(mappingOrderId), 1);
  assert.equal(unmapped.result.body.state, "EXCEPTION");

  const shortage = gateway.ingest(order({ externalEventId: "recover-stock-event", externalOrderId: "recover-stock-order",
    lines: [{ externalLineId: "recover-stock-line", externalListingId: "listing-part", quantityBaseInt: 2,
      actualUnitGrossMinor: 125_000, vatRateBps: 2_000 }] }), "recover-stock-ingest", "channel-worker") as any;
  assert.equal(shortage.result.body.state, "EXCEPTION");
  inventory.releaseReservation({ reservationId: accepted.reservationId, reason: "TEST_REPLENISH", operationId: "recover-stock-replenish" });
  const stockOrderId = String(db.prepare("SELECT id FROM channel_orders WHERE external_order_id='recover-stock-order'").pluck().get());
  const stockAccepted = gateway.resolveAndReprocessOrder({ orderId: stockOrderId, operationId: "recover-stock-process",
    actor, resolvedAt: "2026-09-23T10:01:00.000Z" }) as any;
  assert.equal(stockAccepted.state, "ACCEPTED");
  assert.equal(db.prepare("SELECT COUNT(*) FROM sales").pluck().get(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_reservations").pluck().get(), 2);
  db.close();
});

test("canonical changes auto-enqueue claimable jobs and disabled adapters remain fail-closed", async () => {
  const { db, gateway, inventory } = setup(5);
  db.prepare("DELETE FROM channel_outbound_jobs").run();
  inventory.reserveOrder({ reservationId: "auto-reservation", orderId: "auto-order",
    lines: [{ productId: "part", quantityBaseInt: 1 }], operationId: "auto-stock-change" });
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_outbound_jobs WHERE job_kind='STOCK'").pluck().get(), 1);
  db.prepare("UPDATE products SET sale_price=1000 WHERE id='part'").run();
  gateway.captureCanonicalProductChanges({ productId: "part", kinds: ["PRICE"], operationId: "auto-price-change", actor });
  const pricePayload = JSON.parse(String(db.prepare("SELECT payload_json FROM channel_outbound_jobs WHERE job_kind='PRICE'").pluck().get()));
  assert.equal(pricePayload.channelPriceMinor, 125_000);
  const latestAvailableAt = String(
    db.prepare("SELECT MAX(available_at) FROM channel_outbound_jobs").pluck().get()
  );
  const claimedAt = new Date(new Date(latestAvailableAt).getTime() + 1000).toISOString();

  const claimed = gateway.claimReadyOutboundJobs({ limit: 10, leaseSeconds: 30, operationId: "claim-ready",
    serviceActorId: "publisher", claimedAt }) as any[];
  assert.equal(claimed.length, 2);
  let sends = 0;
  for (const job of claimed) {
    await gateway.processClaimedOutboundJob({ jobId: job.id, leaseToken: job.leaseToken,
      operationId: `process-${job.id}`, serviceActorId: "publisher", occurredAt: "2026-09-24T10:00:01.000Z",
      publish: async () => { sends += 1; return { batchRequestId: `batch-${job.id}` }; } });
    await gateway.processClaimedOutboundJob({ jobId: job.id, leaseToken: job.leaseToken,
      operationId: `process-${job.id}`, serviceActorId: "publisher", occurredAt: "2026-09-24T10:00:01.000Z",
      publish: async () => { sends += 1; return { batchRequestId: `batch-${job.id}` }; } });
  }
  assert.equal(sends, 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_outbound_attempts WHERE state='SUCCEEDED'").pluck().get(), 2);

  gateway.configureAccount({ id: "disabled-shopify", channel: "SHOPIFY", merchantAccountId: "disabled", environment: "STAGE",
    operationId: "disabled-account", actor });
  gateway.mapProduct({ id: "disabled-map", accountId: "disabled-shopify", externalListingId: "disabled-listing", productId: "part",
    operationId: "disabled-map", actor });
  const disabledJob = gateway.captureCanonicalProductChanges({ productId: "part", kinds: ["STOCK"], operationId: "disabled-stock", actor })
    .find((job: any) => job.accountId === "disabled-shopify");
  assert.ok(disabledJob);
  assert.throws(() => gateway.claimReadyOutboundJobs({ accountId: "disabled-shopify", limit: 1, leaseSeconds: 30,
    operationId: "disabled-claim", serviceActorId: "publisher", claimedAt: "2026-09-23T10:00:00.000Z" }),
  (error: unknown) => error instanceof ChannelGatewayError && error.code === "ADAPTER_TRANSPORT_DISABLED");
  db.close();
});

test("canonical outbound transition identity allows stock and price A-B-A while retrying one transition once", async () => {
  const { db, gateway, inventory } = setup(5);
  db.prepare("DELETE FROM channel_outbound_jobs").run();

  gateway.captureCanonicalProductChanges({ productId: "part", kinds: ["STOCK"], operationId: "stock-five-first", actor,
    occurredAt: "2026-09-23T10:00:00.000Z" });
  inventory.reserveOrder({ reservationId: "transition-reservation", orderId: "transition-order",
    lines: [{ productId: "part", quantityBaseInt: 1 }], operationId: "stock-four", createdAt: "2026-09-23T10:01:00.000Z" });
  inventory.releaseReservation({ reservationId: "transition-reservation", reason: "TRANSITION_TEST",
    operationId: "stock-five-second", releasedAt: "2026-09-23T10:02:00.000Z" });

  db.prepare("UPDATE products SET sale_price=1000 WHERE id='part'").run();
  gateway.captureCanonicalProductChanges({ productId: "part", kinds: ["PRICE"], operationId: "price-a-first", actor,
    occurredAt: "2026-09-23T10:03:00.000Z" });
  db.prepare("UPDATE products SET sale_price=900 WHERE id='part'").run();
  gateway.captureCanonicalProductChanges({ productId: "part", kinds: ["PRICE"], operationId: "price-b", actor,
    occurredAt: "2026-09-23T10:04:00.000Z" });
  db.prepare("UPDATE products SET sale_price=1000 WHERE id='part'").run();
  gateway.captureCanonicalProductChanges({ productId: "part", kinds: ["PRICE"], operationId: "price-a-second", actor,
    occurredAt: "2026-09-23T10:05:00.000Z" });
  gateway.captureCanonicalProductChanges({ productId: "part", kinds: ["PRICE"], operationId: "price-a-second", actor,
    occurredAt: "2026-09-23T10:05:00.000Z" });

  assert.deepEqual((db.prepare(`SELECT payload_json FROM channel_outbound_jobs WHERE job_kind='STOCK'
    ORDER BY datetime(available_at),id`).all() as any[]).map((row) => JSON.parse(row.payload_json).quantityBaseInt), [5, 4, 5]);
  assert.deepEqual((db.prepare(`SELECT payload_json FROM channel_outbound_jobs WHERE job_kind='PRICE'
    ORDER BY datetime(available_at),id`).all() as any[]).map((row) => JSON.parse(row.payload_json).channelPriceMinor),
  [125_000, 112_500, 125_000]);
  assert.equal(db.prepare("SELECT COUNT(DISTINCT source_version) FROM channel_outbound_jobs").pluck().get(), 6);

  let sends = 0;
  const provider = { stock: -1, price: -1 };
  const claimed = gateway.claimReadyOutboundJobs({ limit: 10, leaseSeconds: 30, operationId: "transition-claim",
    serviceActorId: "publisher", claimedAt: "2026-09-23T11:00:00.000Z" }) as any[];
  for (const job of claimed) {
    await gateway.processClaimedOutboundJob({ jobId: job.id, leaseToken: job.leaseToken,
      operationId: `transition-process:${job.id}`, serviceActorId: "publisher", occurredAt: "2026-09-23T11:00:01.000Z",
      publish: async (published) => {
        sends += 1;
        if (published.kind === "STOCK") provider.stock = published.payload.quantityBaseInt;
        if (published.kind === "PRICE") provider.price = published.payload.channelPriceMinor;
        return { batchRequestId: `batch:${published.id}` };
      } });
    await gateway.processClaimedOutboundJob({ jobId: job.id, leaseToken: job.leaseToken,
      operationId: `transition-process:${job.id}`, serviceActorId: "publisher", occurredAt: "2026-09-23T11:00:01.000Z",
      publish: async () => { sends += 1; return {}; } });
  }
  assert.deepEqual(provider, { stock: 5, price: 125_000 });
  assert.equal(sends, 6);
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_outbound_attempts").pluck().get(), 6);
  db.close();
});

test("verified Trendyol stream poll enters the gateway and the verified publisher sends stock and price payloads", async () => {
  const { db, gateway } = setup(5);
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  const transport = new TrendyolGatewayTransport(gateway, async (url, _headers, options) => {
    requests.push({ url, options });
    if (url.includes("/orders/stream")) return { content: [{ shipmentPackageId: "package-1", orderNumber: "trend-order-1",
      status: "Created", currencyCode: "TRY",
      customerEmail: "customer@example.test",
      customerFirstName: "Test",
      customerLastName: "Müşteri",
      shipmentAddress: {
        fullName: "Test Müşteri",
        firstName: "Test",
        lastName: "Müşteri",
        phone: "0530 123 45 67",
        fullAddress: "Test Sokak 1",
        address1: "Test Sokak 1",
        address2: "",
        countryCode: "TR",
        city: "İstanbul",
        cityCode: 6,
        countyName: "Kadıköy",
        countyId: 347,
        district: "Caferağa",
        districtId: 1234,
        postalCode: "34710"
      },
      lastModifiedDate: 1_795_000_000_000,
      packageGrossAmount: "1250.00", packageSellerDiscount: "0.00", packageTyDiscount: "0.00",
      packageTotalDiscount: "0.00", packageTotalPrice: "1250.00",
      lines: [{ lineId: "trend-line-1", barcode: "listing-part", quantity: 1, lineGrossAmount: "1250.00",
        lineSellerDiscount: "0.00", lineTyDiscount: "0.00", lineTotalDiscount: "0.00", lineUnitPrice: "1250.00", vatRate: 20 }] }],
      hasMore: false };
    return { batchRequestId: "batch-1" };
  });
  const first = await transport.poll({ accountId: "account", sellerId: "merchant", environment: "stage", headers: { Authorization: "[secret]" },
    windowStartMs: 1_794_000_000_000, windowEndMs: 1_796_000_000_000, serviceActorId: "trendyol-poller",
    operationIdPrefix: "trendyol-poll-1", receivedAt: "2026-09-23T12:00:00.000Z" });
  assert.equal(first.accepted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM sales WHERE platform='TRENDYOL'").pluck().get(), 1);

  assert.deepEqual(
    db.prepare(`SELECT customer_name AS name,customer_phone AS phone,customer_address AS address
      FROM sales WHERE platform='TRENDYOL'`).get(),
    {
      name: "Test Müşteri",
      phone: "+905301234567",
      address: "Test Sokak 1, Kadıköy, İstanbul, 34710",
    },
  );

  const inboundRecipient = JSON.parse(String(
    db.prepare("SELECT raw_payload_json FROM channel_inbound_events WHERE external_order_id='trend-order-1' ORDER BY rowid LIMIT 1")
      .pluck().get()
  )).recipient;

  assert.equal(inboundRecipient.phone, "+905301234567");
  assert.equal(inboundRecipient.cityCode, "34");
  assert.equal(inboundRecipient.districtName, "Kadıköy");

  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_reservations").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM marketplace_orders").pluck().get(), 0);
  await transport.poll({ accountId: "account", sellerId: "merchant", environment: "stage", headers: { Authorization: "[secret]" },
    windowStartMs: 1_794_000_000_000, windowEndMs: 1_796_000_000_000, serviceActorId: "trendyol-poller",
    operationIdPrefix: "trendyol-poll-2", receivedAt: "2026-09-23T12:01:00.000Z" });
  assert.equal(db.prepare("SELECT COUNT(*) FROM sales WHERE platform='TRENDYOL'").pluck().get(), 1);

  await transport.publish({ kind: "STOCK", externalListingId: "listing-part", payload: { quantityBaseInt: 4 } },
    { sellerId: "merchant", environment: "stage", headers: { Authorization: "[secret]" } });
  await transport.publish({ kind: "PRICE", externalListingId: "listing-part", payload: { channelPriceMinor: 125_000 } },
    { sellerId: "merchant", environment: "stage", headers: { Authorization: "[secret]" } });
  const bodies = requests.filter((request) => request.options?.method === "POST")
    .map((request) => JSON.parse(String(request.options?.body)));
  assert.deepEqual(bodies, [{ items: [{ barcode: "listing-part", quantity: 4 }] },
    { items: [{ barcode: "listing-part", salePrice: 1250, listPrice: 1250 }] }]);
  db.close();
});

test("Trendyol split packages aggregate into one sale and package cancellation cannot cancel an unrelated package", async () => {
  const { db, gateway, inventory } = setup(5);
  let response: any = { content: [
    { shipmentPackageId: "split-package-a", orderNumber: "split-order", status: "Created", currencyCode: "TRY",
      customerEmail: "customer@example.test", customerFirstName: "Test", customerLastName: "Müşteri",
      shipmentAddress: {
        fullName: "Test Müşteri",
        firstName: "Test",
        lastName: "Müşteri",
        phone: "0530 123 45 67",
        fullAddress: "Test Sokak 1",
        address1: "Test Sokak 1",
        address2: "",
        countryCode: "TR",
        city: "İstanbul",
        cityCode: 34,
        countyName: "Kadıköy",
        countyId: 347,
        district: "Caferağa",
        districtId: 1234,
        postalCode: "34710"
      },
      lastModifiedDate: 1_795_000_000_001, packageGrossAmount: "1250.00", packageSellerDiscount: "0.00",
      packageTyDiscount: "0.00", packageTotalDiscount: "0.00", packageTotalPrice: "1250.00",
      lines: [{ lineId: "split-line-a", barcode: "listing-part", quantity: 1, lineGrossAmount: "1250.00",
        lineSellerDiscount: "0.00", lineTyDiscount: "0.00", lineTotalDiscount: "0.00", lineUnitPrice: "1250.00", vatRate: 20 }] },
    { shipmentPackageId: "split-package-b", orderNumber: "split-order", status: "Created", currencyCode: "TRY",
      lastModifiedDate: 1_795_000_000_002, packageGrossAmount: "1250.00", packageSellerDiscount: "0.00",
      packageTyDiscount: "0.00", packageTotalDiscount: "0.00", packageTotalPrice: "1250.00",
      lines: [{ lineId: "split-line-b", barcode: "listing-part", quantity: 1, lineGrossAmount: "1250.00",
        lineSellerDiscount: "0.00", lineTyDiscount: "0.00", lineTotalDiscount: "0.00", lineUnitPrice: "1250.00", vatRate: 20 }] },
  ], hasMore: false };
  const transport = new TrendyolGatewayTransport(gateway, async () => response);
  const poll = (prefix: string, receivedAt: string) => transport.poll({ accountId: "account", sellerId: "merchant", environment: "stage",
    headers: { Authorization: "[secret]" }, windowStartMs: 1_794_000_000_000, windowEndMs: 1_796_000_000_000,
    serviceActorId: "trendyol-poller", operationIdPrefix: prefix, receivedAt });

  assert.equal((await poll("split-first", "2026-09-23T12:00:00.000Z")).accepted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_order_packages").pluck().get(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_order_lines").pluck().get(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM sales WHERE platform='TRENDYOL'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_reservations").pluck().get(), 1);
  assert.equal(inventory.getProductAvailability("part").reservedBaseInt, 2);
  assert.equal((await poll("split-replay", "2026-09-23T12:01:00.000Z")).duplicate, 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM sales WHERE platform='TRENDYOL'").pluck().get(), 1);

  response = { content: [{ ...response.content[1], status: "Cancelled", lastModifiedDate: 1_795_000_000_003 }], hasMore: false };
  const cancelled = await poll("split-cancel-b", "2026-09-23T12:02:00.000Z");
  assert.equal(cancelled.exception, 1);
  assert.deepEqual(db.prepare(`SELECT external_package_id AS id,package_state AS state FROM channel_order_packages
    ORDER BY external_package_id`).all(), [{ id: "split-package-a", state: "ACTIVE" }, { id: "split-package-b", state: "CANCELLED" }]);
  assert.equal(db.prepare("SELECT status FROM sales WHERE platform='TRENDYOL'").pluck().get(), "Marketplace Received");
  assert.equal(inventory.getProductAvailability("part").reservedBaseInt, 2);

  response = { content: [{ ...response.content[0], status: "Returned", lastModifiedDate: 1_795_000_000_004 }], hasMore: false };
  assert.equal((await poll("split-return-b", "2026-09-23T12:03:00.000Z")).exception, 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM return_requests").pluck().get(), 0);
  assert.equal(db.prepare("SELECT status FROM sales WHERE platform='TRENDYOL'").pluck().get(), "Marketplace Received");
  assert.equal(inventory.getProductAvailability("part").reservedBaseInt, 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_order_package_versions").pluck().get(), 4);
  assert.throws(() => db.prepare("UPDATE channel_order_package_versions SET package_state='ACTIVE'").run(), /immutable/i);
  db.close();
});

test("Trendyol financial normalization conserves gross, seller discount, funded coupon, and customer net in minor units", async (t) => {
  const cases = [
    { name: "no discount", quantity: 1, gross: 10_000, seller: 0, ty: 0, customer: 10_000 },
    { name: "seller-funded discount", quantity: 1, gross: 10_000, seller: 1_000, ty: 0, customer: 9_000 },
    { name: "Trendyol-funded coupon", quantity: 1, gross: 10_000, seller: 0, ty: 2_000, customer: 8_000 },
    { name: "quantity greater than one", quantity: 2, gross: 20_000, seller: 1_000, ty: 500, customer: 18_500,
      details: [
        { lineItemId: "item-1", lineItemPrice: "92.50", lineItemSellerDiscount: "5.00", lineItemTyDiscount: "2.50" },
        { lineItemId: "item-2", lineItemPrice: "92.50", lineItemSellerDiscount: "5.00", lineItemTyDiscount: "2.50" },
      ] },
  ];
  for (const [index, financial] of cases.entries()) await t.test(financial.name, async () => {
    const { db, gateway } = setup(5);
    const unitGross = financial.gross / financial.quantity;
    const unitSeller = financial.seller / financial.quantity;
    const unitTy = financial.ty / financial.quantity;
    const unitCustomer = financial.customer / financial.quantity;
    const money = (minor: number) => (minor / 100).toFixed(2);
    const pkg = { shipmentPackageId: `finance-package-${index}`, orderNumber: `finance-order-${index}`, status: "Created",
      currencyCode: "TRY", lastModifiedDate: 1_795_000_001_000 + index,
      packageGrossAmount: money(financial.gross), packageSellerDiscount: money(financial.seller),
      packageTyDiscount: money(financial.ty), packageTotalDiscount: money(financial.seller + financial.ty),
      packageTotalPrice: money(financial.customer),
      lines: [{ lineId: `finance-line-${index}`, barcode: "listing-part", quantity: financial.quantity,
        lineGrossAmount: money(unitGross), lineSellerDiscount: money(unitSeller), lineTyDiscount: money(unitTy),
        lineTotalDiscount: money(unitSeller + unitTy), lineUnitPrice: money(unitCustomer), vatRate: 20,
        ...(financial.details ? { discountDetails: financial.details } : {}) }] };
    const transport = new TrendyolGatewayTransport(gateway, async () => ({ content: [pkg], hasMore: false }));
    const outcome = await transport.poll({ accountId: "account", sellerId: "merchant", environment: "stage",
      headers: { Authorization: "[secret]" }, windowStartMs: 1_794_000_000_000, windowEndMs: 1_796_000_000_000,
      serviceActorId: "trendyol-poller", operationIdPrefix: `finance-${index}`, receivedAt: "2026-09-23T13:00:00.000Z" });
    assert.equal(outcome.accepted, 1);
    const snapshot = db.prepare(`SELECT gross_before_discount_minor AS gross,discount_minor AS sellerDiscount,
      gross_amount_minor AS sellerRevenue,commission_terms_json AS provenance FROM sale_financial_snapshots`).get() as any;
    assert.equal(snapshot.gross, financial.gross);
    assert.equal(snapshot.sellerDiscount, financial.seller);
    assert.equal(snapshot.sellerRevenue, financial.gross - financial.seller);
    const provenance = JSON.parse(snapshot.provenance);
    assert.equal(provenance.providerFinancial.grossMinor, financial.gross);
    assert.equal(provenance.providerFinancial.sellerDiscountMinor, financial.seller);
    assert.equal(provenance.providerFinancial.trendyolDiscountMinor, financial.ty);
    assert.equal(provenance.providerFinancial.customerTotalMinor, financial.customer);
    assert.equal(financial.gross, financial.seller + financial.ty + financial.customer);
    assert.deepEqual(db.prepare(`SELECT package_gross_minor AS gross,package_seller_discount_minor AS sellerDiscount,
      package_ty_discount_minor AS trendyolDiscount,package_total_price_minor AS customerTotal FROM channel_order_packages`).get(),
    { gross: financial.gross, sellerDiscount: financial.seller, trendyolDiscount: financial.ty, customerTotal: financial.customer });
    db.close();
  });

  await t.test("unreconciled package fails closed", async () => {
    const { db, gateway } = setup();
    const transport = new TrendyolGatewayTransport(gateway, async () => ({ content: [{ shipmentPackageId: "bad-package",
      orderNumber: "bad-order", status: "Created", currencyCode: "TRY", lastModifiedDate: 1_795_000_009_000,
      packageGrossAmount: "100.00", packageSellerDiscount: "10.00", packageTyDiscount: "5.00",
      packageTotalDiscount: "15.00", packageTotalPrice: "90.00",
      lines: [{ lineId: "bad-line", barcode: "listing-part", quantity: 1, lineGrossAmount: "100.00",
        lineSellerDiscount: "10.00", lineTyDiscount: "5.00", lineTotalDiscount: "15.00", lineUnitPrice: "85.00", vatRate: 20 }] }],
      hasMore: false }));
    const outcome = await transport.poll({ accountId: "account", sellerId: "merchant", environment: "stage",
      headers: { Authorization: "[secret]" }, windowStartMs: 1_794_000_000_000, windowEndMs: 1_796_000_000_000,
      serviceActorId: "trendyol-poller", operationIdPrefix: "bad-finance", receivedAt: "2026-09-23T13:10:00.000Z" });

    assert.equal(outcome.accepted, 0);
    assert.equal(outcome.exception, 1);
    assert.equal(outcome.errors.length, 1);
    assert.equal(outcome.errors[0].orderNumber, "bad-order");
    assert.equal(outcome.errors[0].code, "TRENDYOL_FINANCIAL_RECONCILIATION_FAILED");
    assert.equal(db.prepare("SELECT COUNT(*) FROM sales").pluck().get(), 0);
    db.close();
  });
});
