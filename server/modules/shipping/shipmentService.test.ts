import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { CommandExecutor } from "../commands/commandFoundation.js";
import { InventoryService } from "../inventory/inventoryService.js";
import { ProcurementService } from "../procurement/procurementService.js";
import { SalesFinancialService } from "../sales/salesFinancialService.js";
import { ChannelGatewayError, ChannelGatewayService } from "../channels/channelGateway.js";
import { TrendyolGatewayTransport } from "../channels/trendyolGatewayTransport.js";
import {
  GELIVER_TRANSPORT_CONTRACT,
  ShipmentService,
  ShipmentValidationError,
  type CarrierBookingTransport,
} from "./shipmentService.js";
import { GeliverFlowService, type GeliverTransport } from "./geliverFlowService.js";
import type { Shipment, Transaction } from "@geliver/sdk";
import { ReconciliationService } from "../reconciliation/reconciliationService.js";

const actor = { id: "shipping-operator", name: "Shipping Operator" };

const addShipmentOrderBlock = (db: Database.Database, orderId: string) => {
  const key = `shipment-${orderId}`.padEnd(64, "0").slice(0, 64);
  db.prepare("INSERT INTO reconciliation_runs (id,operation_id,trigger_type,actor_type,actor_id,status,started_at) VALUES (?,?,?,?,?,'COMPLETED',?)")
    .run(`shipment-block-run-${orderId}`, `shipment-block-op-${orderId}`, "MANUAL", "HUMAN", "admin", "2026-09-23T00:00:00Z");
  db.prepare(`INSERT INTO reconciliation_findings (id,identity_key,domain,code,severity,affected_type,affected_id,source_ref,expected_json,actual_json,status,repair_status,first_run_id,last_run_id,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,'ORDER',?,?,?,?,'OPEN','APPROVAL_REQUIRED',?,?,?,?)`).run(`shipment-block-finding-${orderId}`, key, "TEST", "TEST_ORDER_BLOCK", "CRITICAL", orderId, orderId, "{}", "{}", `shipment-block-run-${orderId}`, `shipment-block-run-${orderId}`, "2026-09-23T00:00:00Z", "2026-09-23T00:00:00Z");
  db.prepare("INSERT INTO reconciliation_blocks (id,finding_id,affected_type,affected_id,status,reason,created_at) VALUES (?,?, 'ORDER',?,'ACTIVE','TEST_ORDER_BLOCK',?)")
    .run(`shipment-block-${orderId}`, `shipment-block-finding-${orderId}`, orderId, "2026-09-23T00:00:00Z");
};

class VerifiedFakeGeliverTransport implements CarrierBookingTransport {
  readonly provider = "GELIVER" as const;
  readonly enabled = true;
  readonly serverIdempotencyVerified = true;
  calls = 0;
  private readonly results = new Map<string, any>();

  bookPackage(input: any) {
    this.calls += 1;
    const prior = this.results.get(input.requestIdentity);
    if (prior) return prior;
    const result = {
      providerShipmentId: `geliver-${input.packageNumber}`,
      providerTransactionId: `tx-${input.packageNumber}`,
      carrierCode: input.carrierCode,
      serviceCode: input.serviceCode,
      trackingNumber: `TRACK-${input.packageNumber}`,
      trackingUrl: `https://tracking.invalid/${input.packageNumber}`,
      label: {
        reference: `provider-label:${input.packageNumber}`,
        sha256: "a".repeat(64),
        mediaType: "application/pdf",
        widthMm: 100,
        heightMm: 150,
        dpi: 203,
      },
      providerResponseReference: `fixture:${input.requestIdentity}`,
    };
    this.results.set(input.requestIdentity, result);
    return result;
  }

  cancelShipment(input: any) {
    return { providerCancellationId: `cancel:${input.providerShipmentId}`, providerResponseReference: "fixture:cancel" };
  }
}

const marketplaceRecipient = {
  name: "Test Customer",
  email: "customer@example.test",
  phone: "+905551112233",
  address1: "Test Sokak 1",
  address2: null,
  countryCode: "TR",
  cityName: "İstanbul",
  cityCode: "6",
  districtName: "Ümraniye",
  districtID: 0,
  zip: "34710",
};

const setup = (recipientFixture = marketplaceRecipient) => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  catalog.createProduct({ id: "part", sku: "PART", title: "Part", catalog_type: "product", base_uom_code: "piece" });
  db.prepare("INSERT INTO sales (id,order_code,total_amount,platform) VALUES ('sale','DS-13',0,'Trendyol')").run();
  db.prepare("INSERT INTO sale_items (id,sale_id,product_id,product_name,quantity,unit_price) VALUES ('sale-line','sale','part','Part',2,0)").run();
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "supplier", name: "Supplier", defaultCurrency: "TRY" });
  procurement.createPurchase({
    id: "purchase", supplierId: "supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
    lines: [{ id: "purchase-line", productId: "part", quantity: "2", quoteBasis: "piece", supplierUnitPriceMinor: 100,
      currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }],
  });
  const cost = procurement.finalizeAcquisitionCosts("purchase", { allocations: [] }).lots[0];
  procurement.approveForReceipt("purchase", "buyer");
  const inventory = new InventoryService(db);
  inventory.receiveCostedLot({ receiptId: "receipt", costSnapshotId: cost.id, receivedAt: "2026-09-23T08:00:00.000Z",
    location: { id: "pick", kind: "PICKING" }, operationId: "receive" });
  inventory.reserveOrder({ reservationId: "reservation", orderId: "sale", lines: [{ productId: "part", quantityBaseInt: 2 }], operationId: "reserve" });
  inventory.markPicked({ reservationId: "reservation", operationId: "pick" });
  db.prepare(`INSERT INTO channel_accounts
    (id,channel,merchant_account_id,environment,state,config_json) VALUES ('channel-account','TRENDYOL','merchant','STAGE','CONFIGURED','{}')`).run();
  db.prepare(`INSERT INTO channel_inbound_events
    (id,account_id,external_event_id,external_event_version,ingestion_path,event_type,raw_payload_json,raw_payload_digest,
     received_at,processing_state,sale_id) VALUES ('channel-event','channel-account','event','1','POLL','ORDER_UPSERT',?,?,
     '2026-09-23T09:00:00.000Z','ACCEPTED','sale')`).run(JSON.stringify({ recipient: recipientFixture }), "c".repeat(64));
  db.prepare(`INSERT INTO channel_orders
    (id,account_id,external_order_id,latest_external_version,currency,actual_discount_minor,order_state,sale_id,reservation_id,
     first_event_id,raw_order_digest) VALUES ('channel-order','channel-account','external-order','1','TRY',0,'ACCEPTED','sale',
     'reservation','channel-event',?)`).run("d".repeat(64));
  db.prepare(`INSERT INTO channel_order_packages
    (id,channel_order_id,external_package_id,latest_external_version,latest_provider_occurred_at,package_state,currency,
     package_gross_minor,package_seller_discount_minor,package_ty_discount_minor,package_total_discount_minor,
     package_total_price_minor,latest_event_id,financial_provenance_json,updated_at)
    VALUES ('channel-package','channel-order','trendyol-package-1','1','2026-09-23T09:00:00.000Z','ACTIVE','TRY',
      0,0,0,0,0,'channel-event','{}','2026-09-23T09:00:00.000Z')`).run();
  new SalesFinancialService(db).createOrderSnapshot({
    saleId: "sale", currency: "TRY", sourceChannel: "Trendyol", discountMinor: 0, commissionRatePercent: "0",
    commissionCalculationBasis: "GROSS_BEFORE_DISCOUNT", commissionTerms: { version: "fixture" },
    lines: [{ saleLineId: "sale-line", productId: "part", quantity: 2, unitGrossMinor: 1000, vatRateBps: 0 }],
    operationId: "sale-snapshot", actor,
  });
  return { db, inventory };
};

const command = (db: Database.Database, operationId: string, commandType: string, payload: any, handler: (context: any) => any) =>
  new CommandExecutor(db).execute<any>({ operationId, commandType, payload, actor: { human: actor },
    authorization: { decision: "ALLOW", capability: "shipping:dispatch" } }, handler);

test("PACKED creates one preparation and neither preparation nor tracking/label changes stock", () => {
  const { db, inventory } = setup();
  const service = new ShipmentService(db);
  const packed = command(db, "pack", "shipping.prepare-packed.v1", { reservationId: "reservation" }, (context) => {
    const result = service.packAndPrepare({ reservationId: "reservation", operationId: "pack", actor });
    context.addOutbox({ topic: "shipping", eventType: "shipping.preparation.created.v1", aggregateId: result.shipment.id, payload: { shipment_id: result.shipment.id } });
    return { statusCode: 200, body: result };
  });
  const replay = command(db, "pack", "shipping.prepare-packed.v1", { reservationId: "reservation" }, () => { throw new Error("must replay"); });
  assert.deepEqual(replay.result.body, packed.result.body);
  assert.equal(db.prepare("SELECT COUNT(*) FROM shipment_preparations").pluck().get(), 1);
  assert.equal(inventory.getProductAvailability("part").onHandBaseInt, 2);

  service.definePackages({ shipmentId: (packed.result.body as any).shipment.id, operationId: "packages", actor, packages: [
    { packageNumber: 1, measured: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1200 }, contents: [{ productId: "part", quantityBaseInt: 2 }] },
  ] });
  service.selectCarrier({ shipmentId: (packed.result.body as any).shipment.id, provider: "GELIVER", carrierCode: "FIXTURE",
    serviceCode: "STANDARD", quote: { quoteId: "quote-1", amountMinor: 9000, currency: "TRY", provenance: { source: "fixture" } },
    operationId: "select", actor });
  const transport = new VerifiedFakeGeliverTransport();
  const booking = service.requestBooking({ shipmentId: (packed.result.body as any).shipment.id, operationId: "book", actor });
  for (const job of booking.jobs) service.processBookingJob({ jobId: job.id, transport, serviceActorId: "carrier-worker" });
  assert.equal(db.prepare("SELECT COUNT(*) FROM shipment_labels").pluck().get(), 1);
  assert.equal(inventory.getProductAvailability("part").onHandBaseInt, 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 0);
  db.close();
});

test("PACKED snapshots the canonical marketplace recipient before Warehouse fulfillment", () => {
  const { db } = setup(marketplaceRecipient);
  db.prepare("UPDATE sales SET platform='SHOPIFY' WHERE id='sale'").run();
  db.prepare("UPDATE channel_accounts SET channel='SHOPIFY' WHERE id='channel-account'").run();

  const service = new ShipmentService(db);
  const shipment = service.packAndPrepare({
    reservationId: "reservation",
    operationId: "shopify-pack",
    actor,
  }).shipment;

  assert.deepEqual(shipment.recipient, {
    ...marketplaceRecipient,
    districtID: "0",
  });

  const snapshot = db.prepare(`SELECT name,email,phone,address1,address2,country_code,city_name,city_code,district_name,district_id,zip
    FROM shipment_recipient_snapshots WHERE shipment_id=?`).get(shipment.id);
  assert.deepEqual(snapshot, {
    name: marketplaceRecipient.name,
    email: marketplaceRecipient.email,
    phone: marketplaceRecipient.phone,
    address1: marketplaceRecipient.address1,
    address2: marketplaceRecipient.address2,
    country_code: marketplaceRecipient.countryCode,
    city_name: marketplaceRecipient.cityName,
    city_code: marketplaceRecipient.cityCode,
    district_name: marketplaceRecipient.districtName,
    district_id: "0",
    zip: marketplaceRecipient.zip,
  });

  db.close();
});

test("carrier choice is explicit, multi-package measurements prefer measured values, recipe is marked, and missing data fails closed", () => {
  const { db } = setup();
  const service = new ShipmentService(db, { recipeResolver: (_orderId, number) => number === 2
    ? { lengthMm: 400, widthMm: 250, heightMm: 120, weightGrams: 1800, recipeVersionRef: "kit:v3", recipeHash: "b".repeat(64) }
    : null });
  const { shipment } = service.packAndPrepare({ reservationId: "reservation", operationId: "pack", actor });
  assert.throws(() => service.requestBooking({ shipmentId: shipment.id, operationId: "premature-book", actor }),
    (error: unknown) => error instanceof ShipmentValidationError && error.code === "CARRIER_SELECTION_REQUIRED");
  const packages = service.definePackages({ shipmentId: shipment.id, operationId: "packages", actor, packages: [
    { packageNumber: 1, measured: { lengthMm: 301, widthMm: 201, heightMm: 101, weightGrams: 1201 },
      recipePackageNumber: 1, contents: [{ productId: "part", quantityBaseInt: 1 }] },
    { packageNumber: 2, recipePackageNumber: 2, contents: [{ productId: "part", quantityBaseInt: 1 }] },
  ] });
  assert.equal(packages[0].measurementSource, "MEASURED");
  assert.deepEqual(packages[0].dimensionsMm, { length: 301, width: 201, height: 101 });
  assert.equal(packages[1].measurementSource, "RECIPE_ESTIMATE");
  assert.equal(packages[1].recipeVersionRef, "kit:v3");
  assert.equal(db.prepare("SELECT COUNT(*) FROM shipment_packages").pluck().get(), 2);
  const missingFixture = setup();
  const missingService = new ShipmentService(missingFixture.db);
  const missingShipment = missingService.packAndPrepare({ reservationId: "reservation", operationId: "pack-missing", actor }).shipment;
  assert.throws(() => missingService.definePackages({ shipmentId: missingShipment.id, operationId: "missing", actor,
    packages: [{ packageNumber: 1, contents: [{ productId: "part", quantityBaseInt: 2 }] }] }),
  (error: unknown) => error instanceof ShipmentValidationError && error.code === "PACKAGE_MEASUREMENTS_REQUIRED");
  missingFixture.db.close();
  db.close();
});

test("named packaging types calculate immutable shipment weight from canonical product plus empty box", () => {
  const { db } = setup();
  db.prepare("UPDATE products SET weight_grams=45 WHERE id='part'").run();
  const service = new ShipmentService(db);
  const packagingType = service.createPackagingType({
    name: "Orta Koli",
    lengthMm: 400,
    widthMm: 300,
    heightMm: 250,
    emptyWeightGrams: 190,
    operationId: "box-create",
    actor,
  });
  assert.equal(service.listPackagingTypes()[0].name, "Orta Koli");
  const { shipment } = service.packAndPrepare({ reservationId: "reservation", operationId: "box-pack", actor });
  const [shipmentPackage] = service.definePackages({
    shipmentId: shipment.id,
    operationId: "box-package",
    actor,
    packages: [{
      packageNumber: 1,
      packagingTypeId: packagingType.id,
      contents: [{ productId: "part", quantityBaseInt: 2 }],
    }],
  });
  assert.equal(shipmentPackage.measurementSource, "RECIPE_ESTIMATE");
  assert.deepEqual(shipmentPackage.dimensionsMm, { length: 400, width: 300, height: 250 });
  assert.equal(shipmentPackage.weightGrams, 280);
  assert.match(shipmentPackage.recipeVersionRef, /^packaging-type:/);
  assert.equal(service.getShipment(shipment.id).requiredContents[0].unitWeightGrams, 45);
  db.close();
});

test("packaging type calculation fails closed when a product weight is missing", () => {
  const { db } = setup();
  const service = new ShipmentService(db);
  const packagingType = service.createPackagingType({
    name: "Eksik Ağırlık Test Kolisi",
    lengthMm: 300,
    widthMm: 200,
    heightMm: 150,
    emptyWeightGrams: 100,
    operationId: "missing-box-create",
    actor,
  });
  const { shipment } = service.packAndPrepare({ reservationId: "reservation", operationId: "missing-box-pack", actor });
  assert.throws(() => service.definePackages({
    shipmentId: shipment.id,
    operationId: "missing-box-package",
    actor,
    packages: [{ packageNumber: 1, packagingTypeId: packagingType.id, contents: [{ productId: "part", quantityBaseInt: 2 }] }],
  }), (error: unknown) => error instanceof ShipmentValidationError && error.code === "PRODUCT_WEIGHT_REQUIRED");
  db.close();
});

test("booking replay/retry binds one provider shipment and pre-handoff cancel never dispatches", () => {
  const { db, inventory } = setup();
  const service = new ShipmentService(db);
  const { shipment } = service.packAndPrepare({ reservationId: "reservation", operationId: "pack", actor });
  service.definePackages({ shipmentId: shipment.id, operationId: "packages", actor, packages: [{ packageNumber: 1,
    measured: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1200 }, contents: [{ productId: "part", quantityBaseInt: 2 }] }] });
  service.selectCarrier({ shipmentId: shipment.id, provider: "GELIVER", carrierCode: "FIXTURE", serviceCode: "STANDARD",
    quote: { quoteId: "quote-1", amountMinor: 9000, currency: "TRY", provenance: { source: "fixture" } }, operationId: "select", actor });
  const first = service.requestBooking({ shipmentId: shipment.id, operationId: "book", actor });
  const replay = service.requestBooking({ shipmentId: shipment.id, operationId: "book", actor });
  assert.deepEqual(replay, first);
  const transport = new VerifiedFakeGeliverTransport();
  service.processBookingJob({ jobId: first.jobs[0].id, transport, serviceActorId: "carrier-worker" });
  service.processBookingJob({ jobId: first.jobs[0].id, transport, serviceActorId: "carrier-worker" });
  assert.equal(transport.calls, 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM shipment_provider_bookings").pluck().get(), 1);
  const cancelled = service.cancelBeforeHandoff({ shipmentId: shipment.id, reason: "CUSTOMER_REQUEST", operationId: "cancel", actor, transport });
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(inventory.getProductAvailability("part").onHandBaseInt, 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 0);
  db.close();
});

test("handoff shipment projection is claimed by V2-12 and replay makes one verified Trendyol tracking/status mutation", async () => {
  const { db, inventory } = setup();
  const service = new ShipmentService(db);
  const { shipment } = service.packAndPrepare({ reservationId: "reservation", operationId: "pack", actor });
  service.definePackages({ shipmentId: shipment.id, operationId: "packages", actor, packages: [{ packageNumber: 1,
    measured: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1200 }, contents: [{ productId: "part", quantityBaseInt: 2 }] }] });
  service.selectCarrier({ shipmentId: shipment.id, provider: "GELIVER", carrierCode: "FIXTURE", serviceCode: "STANDARD",
    quote: { quoteId: "quote-1", amountMinor: 9000, currency: "TRY", provenance: { source: "fixture-quote" } }, operationId: "select", actor });
  const transport = new VerifiedFakeGeliverTransport();
  const booking = service.requestBooking({ shipmentId: shipment.id, operationId: "book", actor });
  service.processBookingJob({ jobId: booking.jobs[0].id, transport, serviceActorId: "carrier-worker" });

  const handoff = command(db, "handoff", "shipping.handoff.confirm.v1", { shipmentId: shipment.id }, (context) => {
    const result = service.confirmHandoff({ shipmentId: shipment.id, handedOffAt: "2026-09-23T12:00:00.000Z",
      handoffEvidence: { carrierReceipt: "receipt-1" }, actualCharge: { amountMinor: 9500, currency: "TRY", provenance: { providerTransactionId: "tx-1" } },
      operationId: "handoff", actor });
    for (const event of result.outbox) context.addOutbox(event);
    return { statusCode: 200, body: result.shipment };
  });
  const replay = command(db, "handoff", "shipping.handoff.confirm.v1", { shipmentId: shipment.id }, () => { throw new Error("must replay"); });
  assert.deepEqual(replay.result.body, handoff.result.body);
  assert.equal(inventory.getProductAvailability("part").onHandBaseInt, 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM sale_financial_cogs_finalizations").pluck().get(), 1);
  assert.equal(db.prepare("SELECT state FROM sale_financial_expense_facts WHERE category='SHIPPING' ORDER BY fact_version DESC LIMIT 1").pluck().get(), "KNOWN");
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_shipment_outbound_jobs").pluck().get(), 1);
  service.publishV212TrackingRefresh(shipment.id, "2026-09-23T12:00:00.500Z");
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_shipment_outbound_jobs").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_outbox WHERE event_type='customer.order.shipped.v1'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_outbox WHERE event_type='customer.order.shipped.v1' AND payload_json LIKE '%DS-13%'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_outbox WHERE event_type='customer.order.shipped.v1' AND payload_json LIKE '%package_count%'").pluck().get(), 1);
  const gateway = new ChannelGatewayService(db);
  const claimed = gateway.claimReadyOutboundJobs({ accountId: "channel-account", limit: 10, leaseSeconds: 30,
    operationId: "claim-shipment-projection", serviceActorId: "channel-publisher", claimedAt: "2026-09-23T12:00:01.000Z" }) as any[];
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].outboundType, "SHIPMENT");
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  const trendyol = new TrendyolGatewayTransport(gateway, async (url, _headers, options) => {
    requests.push({ url, options });
    return { success: true };
  });
  const process = () => gateway.processClaimedOutboundJob({ jobId: claimed[0].id, leaseToken: claimed[0].leaseToken,
    operationId: "publish-shipment-projection", serviceActorId: "channel-publisher", occurredAt: "2026-09-23T12:00:02.000Z",
    publish: (job) => trendyol.publish(job, { sellerId: "merchant", environment: "stage", headers: { Authorization: "[secret]" } }) });
  await process();
  await process();
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/shipment-packages\/trendyol-package-1\/alternative-delivery$/);
  assert.equal(requests[0].options?.method, "PUT");
  assert.deepEqual(JSON.parse(String(requests[0].options?.body)), { isPhoneNumber: false,
    trackingInfo: "https://tracking.invalid/1", params: { boxQuantity: 1 } });
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_shipment_outbound_attempts WHERE state='SUCCEEDED'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(DISTINCT provider_mutation_id) FROM channel_shipment_outbound_attempts").pluck().get(), 1);
  assert.throws(() => service.cancelBeforeHandoff({ shipmentId: shipment.id, reason: "TOO_LATE", operationId: "cancel-late", actor, transport }),
    (error: unknown) => error instanceof ShipmentValidationError && error.code === "RETURN_FLOW_REQUIRED");
  assert.equal(GELIVER_TRANSPORT_CONTRACT.enabled, false);
  assert.match(GELIVER_TRANSPORT_CONTRACT.disabledReason, /idempotency|100x150/i);
  db.close();
});

test("tracking absent at dispatch blocks without mutation; later Geliver refresh creates and publishes a new projection version", async () => {
  const { db, shipping, shipment, transport, geliver } = prepareLiveGeliver();
  const [createJob] = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "late-create", actor });
  const provider = await geliver.processCreateJob(createJob.id);
  const accept = geliver.selectOffer({ shipmentId: shipment.id, offerId: provider.offers[0].id, operationId: "late-select", actor });
  await geliver.processAcceptJob(accept.id);
  shipping.confirmHandoff({ shipmentId: shipment.id, handedOffAt: "2026-09-23T14:00:00.000Z",
    handoffEvidence: { carrierReceipt: "late-receipt" }, operationId: "late-handoff", actor });
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_shipment_outbound_jobs").pluck().get(), 1);
  const integrationFailures: any[] = [];
  const gateway = new ChannelGatewayService(db, {
    onIntegrationException(event) {
      integrationFailures.push(event);
      return Promise.reject(new Error("push unavailable"));
    },
  });
  const first = gateway.claimReadyOutboundJobs({ accountId: "channel-account", limit: 1, leaseSeconds: 30,
    operationId: "late-claim-null", serviceActorId: "channel-publisher", claimedAt: "2026-09-23T14:00:01.000Z" }) as any[];
  let sends = 0;
  await assert.rejects(() => gateway.processClaimedOutboundJob({ jobId: first[0].id, leaseToken: first[0].leaseToken,
    operationId: "late-process-null", serviceActorId: "channel-publisher", occurredAt: "2026-09-23T14:00:02.000Z",
    publish: async () => { sends += 1; return {}; } }),
  (error: unknown) => error instanceof ChannelGatewayError && error.code === "CHANNEL_TRACKING_PENDING");
  assert.equal(sends, 0);
  assert.equal(db.prepare("SELECT state FROM channel_shipment_outbound_jobs").pluck().get(), "BLOCKED");
  assert.equal(integrationFailures.length, 1);
  assert.equal(integrationFailures[0].incidentId, `channel-shipment-outbound:${first[0].id}`);
  assert.equal(integrationFailures[0].integration, "TRENDYOL");

  transport.publishTracking(provider.providerShipmentId);
  await geliver.refreshShipment(shipment.id);
  shipping.publishV212TrackingRefresh(shipment.id, "2026-09-23T14:01:00.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) FROM channel_shipment_outbound_jobs").pluck().get(), 2);
  assert.equal(db.prepare("SELECT COUNT(DISTINCT source_version) FROM channel_shipment_outbound_jobs").pluck().get(), 2);
  const second = gateway.claimReadyOutboundJobs({ accountId: "channel-account", limit: 1, leaseSeconds: 30,
    operationId: "late-claim-tracking", serviceActorId: "channel-publisher", claimedAt: "2026-09-23T14:01:01.000Z" }) as any[];
  await gateway.processClaimedOutboundJob({ jobId: second[0].id, leaseToken: second[0].leaseToken,
    operationId: "late-process-tracking", serviceActorId: "channel-publisher", occurredAt: "2026-09-23T14:01:02.000Z",
    publish: async (job) => { sends += 1; assert.equal(job.payload.packages[0].trackingNumber, "TRACK-LATER"); return {}; } });
  assert.equal(sends, 1);
  assert.deepEqual(db.prepare(`SELECT state,COUNT(*) AS count FROM channel_shipment_outbound_jobs
    GROUP BY state ORDER BY state`).all(), [{ state: "BLOCKED", count: 1 }, { state: "SUCCEEDED", count: 1 }]);
  db.close();
});

test("unverified Hepsiburada and N11 shipment adapters cannot publish", async () => {
  for (const channel of ["HEPSIBURADA", "N11"] as const) {
    const { db } = setup();
    const shipping = new ShipmentService(db);
    const shipment = shipping.packAndPrepare({ reservationId: "reservation", operationId: `disabled-pack-${channel}`, actor }).shipment;
    const gateway = new ChannelGatewayService(db);
    gateway.configureAccount({ id: `disabled-${channel}`, channel, merchantAccountId: `merchant-${channel}`, environment: "STAGE",
      operationId: `disabled-config-${channel}`, actor });
    db.prepare(`INSERT INTO channel_inbound_events
      (id,account_id,external_event_id,external_event_version,ingestion_path,event_type,raw_payload_json,raw_payload_digest,
       received_at,processing_state,sale_id) VALUES (?,?,?,?, 'POLL','ORDER_UPSERT','{}',?,'2026-09-23T15:00:00.000Z','ACCEPTED','sale')`)
      .run(`disabled-event-${channel}`, `disabled-${channel}`, `event-${channel}`, "1", "e".repeat(64));
    db.prepare(`INSERT INTO channel_orders
      (id,account_id,external_order_id,latest_external_version,currency,actual_discount_minor,order_state,sale_id,
       first_event_id,raw_order_digest) VALUES (?,?,?,'1','TRY',0,'ACCEPTED','sale',?,?)`)
      .run(`disabled-order-${channel}`, `disabled-${channel}`, `external-${channel}`, `disabled-event-${channel}`, "f".repeat(64));
    const payload = JSON.stringify({ contract: "dsdst.channel-shipment-projection.v1", shipmentId: shipment.id,
      orderId: "sale", status: "DISPATCHED", carrier: "GELIVER", service: "STANDARD", packageCount: 1,
      packages: [{ packageNumber: 1, trackingNumber: "TRACK", trackingUrl: "https://tracking.invalid/TRACK" }] });
    const payloadHash = "a".repeat(64);
    db.prepare(`INSERT INTO channel_shipment_outbound_jobs
      (id,account_id,shipment_id,channel_order_id,job_kind,source_version,payload_json,payload_hash,state,
       created_operation_id,available_at,lease_token,lease_owner,lease_expires_at)
      VALUES (?,?,?,?, 'TRACKING_STATUS',?,?,?,?,?,'2026-09-23T15:00:00.000Z','disabled-lease','worker','2026-09-23T15:01:00.000Z')`)
      .run(`disabled-job-${channel}`, `disabled-${channel}`, shipment.id, `disabled-order-${channel}`, `v-${channel}`,
        payload, payloadHash, "PENDING", `create-${channel}`);
    let sends = 0;
    await assert.rejects(() => gateway.processClaimedOutboundJob({ jobId: `disabled-job-${channel}`, leaseToken: "disabled-lease",
      operationId: `disabled-process-${channel}`, serviceActorId: "worker", occurredAt: "2026-09-23T15:00:01.000Z",
      publish: async () => { sends += 1; return {}; } }),
    (error: unknown) => error instanceof ChannelGatewayError && error.code === "ADAPTER_TRANSPORT_DISABLED");
    assert.equal(sends, 0);
    assert.equal(db.prepare("SELECT COUNT(*) FROM channel_shipment_outbound_attempts").pluck().get(), 0);
    db.close();
  }
});

test("Shopify shipment outbound is claimable and publishes tracking without marketplace package mapping", async () => {
  const { db } = setup();

  db.prepare(`
    UPDATE channel_accounts
    SET channel='SHOPIFY'
    WHERE id='channel-account'
  `).run();

  const shipping = new ShipmentService(db);

  const shipment = shipping.packAndPrepare({
    reservationId: "reservation",
    operationId: "shopify-pack",
    actor,
  }).shipment;

  shipping.definePackages({
    shipmentId: shipment.id,
    operationId: "shopify-packages",
    actor,
    packages: [{
      packageNumber: 1,
      measured: {
        lengthMm: 300,
        widthMm: 200,
        heightMm: 100,
        weightGrams: 1200,
      },
      contents: [{
        productId: "part",
        quantityBaseInt: 2,
      }],
    }],
  });

  shipping.selectCarrier({
    shipmentId: shipment.id,
    provider: "GELIVER",
    carrierCode: "GELIVER",
    serviceCode: "STANDARD",
    quote: {
      quoteId: "shopify-q",
      amountMinor: 0,
      currency: "TRY",
      provenance: {
        source: "fixture",
      },
    },
    operationId: "shopify-carrier",
    actor,
  });

  const transport =
    new VerifiedFakeGeliverTransport();

  const booking = shipping.requestBooking({
    shipmentId: shipment.id,
    operationId: "shopify-book",
    actor,
  });

  for (const job of booking.jobs) {
    shipping.processBookingJob({
      jobId: job.id,
      transport,
      serviceActorId: "geliver-worker",
    });
  }

  shipping.confirmHandoff({
    shipmentId: shipment.id,
    handedOffAt:
      "2026-09-23T16:00:00.000Z",
    handoffEvidence: {
      test: true,
    },
    operationId: "shopify-handoff",
    actor,
  });

  const gateway = new ChannelGatewayService(db);

  const claimed =
    gateway.claimReadyOutboundJobs({
      accountId: "channel-account",
      limit: 10,
      leaseSeconds: 30,
      operationId: "shopify-claim",
      serviceActorId: "shopify-worker",
      claimedAt:
        "2026-09-23T16:00:01.000Z",
    }) as any[];

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].channel, "SHOPIFY");
  assert.equal(claimed[0].outboundType, "SHIPMENT");

  let published: any = null;

  await gateway.processClaimedOutboundJob({
    jobId: claimed[0].id,
    leaseToken: claimed[0].leaseToken,
    operationId: "shopify-process",
    serviceActorId: "shopify-worker",
    occurredAt:
      "2026-09-23T16:00:02.000Z",
    publish: async (job) => {
      published = job;
      return {
        state: "SUCCEEDED",
      };
    },
  });

  assert.equal(
    published.externalOrderId,
    "external-order",
  );

  assert.equal(
    published.trackingNumber,
    "TRACK-1",
  );

  assert.equal(
    published.trackingUrl,
    "https://tracking.invalid/1",
  );

  assert.equal(
    db.prepare(`
      SELECT state
      FROM channel_shipment_outbound_jobs
    `).pluck().get(),
    "SUCCEEDED",
  );

  db.close();
});

test("COD is rejected", () => {
  const { db } = setup();
  const service = new ShipmentService(db);
  const { shipment } = service.packAndPrepare({ reservationId: "reservation", operationId: "pack", actor });
  assert.throws(() => service.selectCarrier({ shipmentId: shipment.id, provider: "GELIVER", carrierCode: "FIXTURE", serviceCode: "COD",
    cashOnDelivery: true, quote: { quoteId: "q", amountMinor: 1, currency: "TRY", provenance: { source: "fixture" } }, operationId: "cod", actor }),
  (error: unknown) => error instanceof ShipmentValidationError && error.code === "COD_FORBIDDEN");
  db.close();
});

const recipient = {
  name: "Test Customer", email: "customer@example.test", phone: "+905551112233", address1: "Test Sokak 1",
  countryCode: "TR", cityName: "İstanbul", cityCode: "34", districtName: "Kadıköy", zip: "34710",
};

class OfficialGeliverFixture implements GeliverTransport {
  readonly enabled = true;
  readonly disabledReason = null;
  createCalls = 0;
  getCalls = 0;
  acceptCalls = 0;
  uncertainCreateOnce = false;
  definitiveAcceptFailureOnce = false;
  createResponsePatch: Partial<Shipment> | null = null;
  private readonly getResponsePatches: Array<Partial<Shipment>> = [];
  private readonly shipments = new Map<string, Shipment>();
  async create(body: any) {
    this.createCalls += 1;
    const id = `provider-${body.order.orderNumber}`;
    const shipment: Shipment = { id, order: { orderNumber: body.order.orderNumber }, offers: { percentageCompleted: 100, list: [
      { id: `offer-${id}`, providerCode: "YURTICI", providerServiceCode: "STANDART", amount: "89.90", currency: "TRY",
        amountLocal: "89.90", currencyLocal: "TRY" },
    ] } };
    Object.assign(shipment, structuredClone(this.createResponsePatch || {}));
    this.shipments.set(id, shipment);
    if (this.uncertainCreateOnce) {
      this.uncertainCreateOnce = false;
      throw Object.assign(new Error("timeout after provider commit"), { status: 503, code: "UPSTREAM_TIMEOUT" });
    }
    return structuredClone(shipment);
  }
  async listByOrderNumber(orderNumber: string) {
    return [...this.shipments.values()].filter((shipment) => shipment.order?.orderNumber === orderNumber).map((item) => structuredClone(item));
  }
  async get(id: string) {
    this.getCalls += 1;
    const shipment = this.shipments.get(id)!;
    const patch = this.getResponsePatches.shift();
    if (patch) Object.assign(shipment, structuredClone(patch));
    return structuredClone(shipment);
  }
  async acceptOffer(offerId: string): Promise<Transaction> {
    this.acceptCalls += 1;
    if (this.definitiveAcceptFailureOnce) {
      this.definitiveAcceptFailureOnce = false;
      throw Object.assign(new Error("provider rejected booking"), { status: 400, code: "BOOKING_REJECTED" });
    }
    const shipment = [...this.shipments.values()].find((item) => item.offers?.list?.some((offer) => offer.id === offerId))!;
    shipment.acceptedOfferID = offerId;
    shipment.acceptedOffer = shipment.offers!.list![0];
    shipment.barcode = `barcode-${shipment.id}`;
    shipment.labelURL = `https://labels.geliver.test/${shipment.id}.pdf`;
    shipment.responsiveLabelURL = `https://labels.geliver.test/${shipment.id}.html`;
    shipment.labelFileType = "PDF";
    return { id: `transaction-${shipment.id}`, offerID: offerId, shipmentID: shipment.id, shipment: structuredClone(shipment) };
  }
  async cancel(id: string) { const shipment = this.shipments.get(id)!; shipment.cancelDate = "2026-09-23T13:00:00.000Z"; return structuredClone(shipment); }
  async downloadLabel(url: string) { return new TextEncoder().encode(`provider-native-label:${url}`); }

  async listCities(countryCode: string) {
    return [
      { name: "İstanbul", cityCode: "34", countryCode },
    ];
  }

  async listDistricts(countryCode: string, cityCode: string) {
    return [
      {
        name: "Bahçelievler",
        districtID: 108629,
        cityCode,
        countryCode,
        regionCode: "EUROPE",
      },
      {
        name: "Ümraniye",
        districtID: 108631,
        cityCode,
        countryCode,
        regionCode: "ANATOLIA",
      },
      {
        name: "Kadıköy",
        districtID: 108630,
        cityCode,
        countryCode,
        regionCode: "ANATOLIA",
      },
    ];
  }

  publishTracking(id: string) { const shipment = this.shipments.get(id)!; shipment.trackingNumber = "TRACK-LATER"; shipment.trackingUrl = "https://track.geliver.test/TRACK-LATER"; }
  queueGetResponses(...patches: Array<Partial<Shipment>>) { this.getResponsePatches.push(...patches); }
}

const prepareLiveGeliver = (recipientFixture = marketplaceRecipient, onOperationalException?: (event: { shipmentId: string; jobId: string }) => void | Promise<unknown>, flowConfig: Record<string, unknown> = {}, packageWeightGrams = 1200) => {
  const fixture = setup(recipientFixture);
  const shipping = new ShipmentService(fixture.db);
  const shipment = shipping.packAndPrepare({ reservationId: "reservation", operationId: "live-pack", actor }).shipment;
  shipping.definePackages({ shipmentId: shipment.id, operationId: "live-packages", actor, packages: [{ packageNumber: 1,
    measured: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: packageWeightGrams },
    contents: [{ productId: "part", quantityBaseInt: 2 }] }] });
  const transport = new OfficialGeliverFixture();
  const geliver = new GeliverFlowService(fixture.db, transport, {
    senderAddressId: "sender-address",
    sourceIdentifier: "https://dsdst.example",
    onOperationalException,
    logOfferPoll: () => undefined,
    ...flowConfig,
  });
  return { ...fixture, shipping, shipment, transport, geliver };
};

const readyOfferPatch = (providerId: string): Partial<Shipment> => ({
  statusCode: "GOT_OFFERS",
  offers: { percentageCompleted: 100, list: [
    { id: `offer-${providerId}`, providerCode: "YURTICI", providerServiceCode: "STANDART", amount: "89.90", currency: "TRY",
      amountLocal: "89.90", currencyLocal: "TRY" },
  ] },
});

test("Geliver create binds once and polls the same provider shipment until asynchronous offers are ready", async () => {
  let elapsedMs = 0;
  const pollLogs: any[] = [];
  const { db, shipment, transport, geliver } = prepareLiveGeliver(marketplaceRecipient, undefined, {
    offerPolling: {
      intervalMs: 1_000,
      timeoutMs: 12_000,
      now: () => elapsedMs,
      sleep: async (milliseconds: number) => { elapsedMs += milliseconds; },
    },
    logOfferPoll: (event: unknown) => pollLogs.push(event),
  });
  transport.createResponsePatch = { statusCode: "CREATED", offers: { percentageCompleted: 0, list: [] } };
  const [job] = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "async-offers", actor });
  const providerId = `provider-${job.providerOrderNumber}`;
  transport.queueGetResponses(
    { statusCode: "CREATED", offers: { percentageCompleted: 100, list: [] } },
    readyOfferPatch(providerId),
  );

  const provider = await geliver.processCreateJob(job.id);

  assert.equal(provider.offerPollingState, "READY");
  assert.equal(provider.offers.length, 1);
  assert.equal(provider.providerShipmentId, providerId);
  assert.equal(transport.createCalls, 1);
  assert.equal(transport.getCalls, 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM geliver_provider_shipments").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM geliver_offer_observations").pluck().get(), 1);
  assert.deepEqual(Object.keys(pollLogs[0]).sort(), ["elapsedMs", "hasError", "lastErrorCode", "lastErrorMessage", "offerCount",
    "percentageCompleted", "pollingAttempt", "providerShipmentId", "shipmentId", "statusCode"]);
  assert.deepEqual(pollLogs.map((entry) => ({
    shipmentId: entry.shipmentId,
    providerShipmentId: entry.providerShipmentId,
    statusCode: entry.statusCode,
    offerCount: entry.offerCount,
    percentageCompleted: entry.percentageCompleted,
    hasError: entry.hasError,
    lastErrorCode: entry.lastErrorCode,
    lastErrorMessage: entry.lastErrorMessage,
    pollingAttempt: entry.pollingAttempt,
    elapsedMs: entry.elapsedMs,
  })), [
    { shipmentId: shipment.id, providerShipmentId: providerId, statusCode: "CREATED", offerCount: 0, percentageCompleted: 0,
      hasError: false, lastErrorCode: null, lastErrorMessage: null, pollingAttempt: 0, elapsedMs: 0 },
    { shipmentId: shipment.id, providerShipmentId: providerId, statusCode: "CREATED", offerCount: 0, percentageCompleted: 100,
      hasError: false, lastErrorCode: null, lastErrorMessage: null, pollingAttempt: 1, elapsedMs: 1_000 },
    { shipmentId: shipment.id, providerShipmentId: providerId, statusCode: "GOT_OFFERS", offerCount: 1, percentageCompleted: 100,
      hasError: false, lastErrorCode: null, lastErrorMessage: null, pollingAttempt: 2, elapsedMs: 2_000 },
  ]);
  db.close();
});

test("Geliver reports COMPLETE_EMPTY only for terminal GOT_OFFERS with no offers", async () => {
  const { db, shipment, transport, geliver } = prepareLiveGeliver(marketplaceRecipient, undefined, {
    offerPolling: { intervalMs: 1_000, timeoutMs: 12_000, sleep: async () => undefined },
    logOfferPoll: () => undefined,
  });
  transport.createResponsePatch = { statusCode: "GOT_OFFERS", offers: { percentageCompleted: 100, list: [] } };
  const [job] = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "complete-empty-offers", actor });

  const provider = await geliver.processCreateJob(job.id);

  assert.equal(provider.offerPollingState, "COMPLETE_EMPTY");
  assert.equal(provider.offers.length, 0);
  assert.equal(transport.createCalls, 1);
  assert.equal(transport.getCalls, 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM geliver_provider_shipments").pluck().get(), 1);
  db.close();
});

test("Geliver offer polling times out without creating a duplicate and refresh continues on the bound shipment", async () => {
  let elapsedMs = 0;
  const { db, shipment, transport, geliver } = prepareLiveGeliver(marketplaceRecipient, undefined, {
    offerPolling: {
      intervalMs: 1_000,
      timeoutMs: 2_000,
      now: () => elapsedMs,
      sleep: async (milliseconds: number) => { elapsedMs += milliseconds; },
    },
    logOfferPoll: () => undefined,
  });
  transport.createResponsePatch = { statusCode: "CREATED", offers: { percentageCompleted: 0, list: [] } };
  const [job] = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "timeout-offers", actor });
  const providerId = `provider-${job.providerOrderNumber}`;

  const timedOut = await geliver.processCreateJob(job.id);
  assert.equal(timedOut.offerPollingState, "TIMED_OUT");
  assert.equal(timedOut.offers.length, 0);
  assert.equal(transport.createCalls, 1);

  transport.queueGetResponses(readyOfferPatch(providerId));
  const refreshed = await geliver.refreshShipment(shipment.id);
  assert.equal(refreshed[0].offerPollingState, "READY");
  assert.equal(refreshed[0].offers.length, 1);
  assert.equal(refreshed[0].providerShipmentId, providerId);
  assert.equal(transport.createCalls, 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM geliver_provider_shipments").pluck().get(), 1);

  const replayed = await geliver.processCreateJob(job.id);
  assert.equal(replayed.providerShipmentId, providerId);
  assert.equal(transport.createCalls, 1);
  db.close();
});

test("Geliver FAILED status stops polling and exposes the provider error without recreating shipment", async () => {
  const pollLogs: any[] = [];
  const { db, shipment, transport, geliver } = prepareLiveGeliver(marketplaceRecipient, undefined, {
    offerPolling: { intervalMs: 1_000, timeoutMs: 12_000, now: () => 0, sleep: async () => undefined },
    logOfferPoll: (event: unknown) => pollLogs.push(event),
  });
  transport.createResponsePatch = {
    statusCode: "FAILED",
    hasError: true,
    lastErrorCode: "ADDRESS_REJECTED",
    lastErrorMessage: "Recipient district is not serviceable",
    offers: { percentageCompleted: 0, list: [] },
  };
  const [job] = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "failed-offers", actor });

  await assert.rejects(
    () => geliver.processCreateJob(job.id),
    (error: any) => error.code === "GELIVER_PROVIDER_FAILED"
      && error.message.includes("ADDRESS_REJECTED")
      && error.message.includes("Recipient district is not serviceable"),
  );
  assert.equal(transport.createCalls, 1);
  assert.equal(transport.getCalls, 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM geliver_provider_shipments").pluck().get(), 1);
  assert.equal(db.prepare("SELECT state FROM geliver_create_jobs WHERE id=?").pluck().get(job.id), "CREATED");
  assert.deepEqual(pollLogs, [{
    shipmentId: shipment.id,
    providerShipmentId: `provider-${job.providerOrderNumber}`,
    statusCode: "FAILED",
    offerCount: 0,
    percentageCompleted: 0,
    hasError: true,
    lastErrorCode: "ADDRESS_REJECTED",
    lastErrorMessage: "Recipient district is not serviceable",
    pollingAttempt: 0,
    elapsedMs: 0,
  }]);
  db.close();
});

test("Geliver resolves Bahçelievler from a Turkish Shopify address only through provider geo data", async () => {
  const { db, shipment, geliver } = prepareLiveGeliver({
    ...marketplaceRecipient,
    address1: "Bahçelievler, Adnan Kahveci Blv., No: 1",
    phone: "5325401212",
    cityName: "İstanbul",
    countryCode: "TR",
    districtName: "",
    cityCode: "",
    districtID: null,
  });

  const resolvedRecipient = await geliver.resolveRecipient({
    shipmentId: shipment.id,
  });

  assert.equal(resolvedRecipient.phone, "+905325401212");
  assert.equal(resolvedRecipient.cityName, "İstanbul");
  assert.equal(resolvedRecipient.cityCode, "34");
  assert.equal(resolvedRecipient.districtName, "Bahçelievler");
  assert.equal(resolvedRecipient.districtID, 108629);

  db.close();
});

test("Geliver resolves Kadıköy when its exact normalized name occurs in the Shopify address", async () => {
  const { db, shipment, geliver } = prepareLiveGeliver({
    ...marketplaceRecipient,
    address1: "Caferağa Mah., Test Sokak 1",
    address2: "Kadıköy / İstanbul",
    cityName: "İstanbul",
    countryCode: "TR",
    districtName: "",
    cityCode: "",
    districtID: null,
  });

  const resolvedRecipient = await geliver.resolveRecipient({ shipmentId: shipment.id });

  assert.equal(resolvedRecipient.districtName, "Kadıköy");
  assert.equal(resolvedRecipient.districtID, 108630);

  db.close();
});

test("Geliver blocks an unknown district instead of inventing one from Shopify address text", async () => {
  const { db, shipment, geliver } = prepareLiveGeliver({
    ...marketplaceRecipient,
    address1: "Bilinmeyen Yer, Test Sokak 1",
    cityName: "İstanbul",
    countryCode: "TR",
    districtName: "",
    cityCode: "",
    districtID: null,
  });

  await assert.rejects(
    () => geliver.resolveRecipient({ shipmentId: shipment.id }),
    (error: any) => error.code === "RECIPIENT_ADDRESS_INCOMPLETE" && /ilçe/i.test(error.message),
  );

  db.close();
});

test("Geliver blocks an ambiguous Shopify address containing more than one provider district", async () => {
  const { db, shipment, geliver } = prepareLiveGeliver({
    ...marketplaceRecipient,
    address1: "Kadıköy Ümraniye bağlantı yolu, No: 1",
    cityName: "İstanbul",
    countryCode: "TR",
    districtName: "",
    cityCode: "",
    districtID: null,
  });

  await assert.rejects(
    () => geliver.resolveRecipient({ shipmentId: shipment.id }),
    (error: any) => error.code === "GELIVER_GEO_DISTRICT_AMBIGUOUS",
  );

  db.close();
});

test("Geliver prioritizes a structured Shopify district over district names in address text", async () => {
  const { db, shipment, geliver } = prepareLiveGeliver({
    ...marketplaceRecipient,
    address1: "Ümraniye bağlantı yolu, No: 1",
    cityName: "İstanbul",
    countryCode: "TR",
    districtName: "Kadıköy",
    cityCode: "",
    districtID: null,
  });

  const resolvedRecipient = await geliver.resolveRecipient({ shipmentId: shipment.id });

  assert.equal(resolvedRecipient.districtName, "Kadıköy");
  assert.equal(resolvedRecipient.districtID, 108630);

  db.close();
});

test("Geliver receives 2.03 kg when the canonical package snapshot stores 2030 grams", async () => {
  const { db, shipment, geliver } = prepareLiveGeliver(marketplaceRecipient, undefined, {}, 2030);
  const resolvedRecipient = await geliver.resolveRecipient({ shipmentId: shipment.id });

  const [job] = geliver.prepareCreateJobs({
    shipmentId: shipment.id,
    recipient: resolvedRecipient,
    operationId: "weight-kg-boundary",
    actor,
  });
  const request = JSON.parse(String(
    db.prepare("SELECT request_json FROM geliver_create_jobs WHERE id=?").pluck().get(job.id)
  ));

  assert.equal(db.prepare("SELECT weight_grams FROM shipment_packages WHERE shipment_id=?").pluck().get(shipment.id), 2030);
  assert.equal(request.weight, "2.03");
  assert.equal(request.massUnit, "kg");

  db.close();
});

test("Geliver keeps the canonical shipment recipient snapshot and sends provider-normalized geo data", async () => {
  const { db, shipment, geliver } = prepareLiveGeliver();

  const resolvedRecipient = await geliver.resolveRecipient({
    shipmentId: shipment.id,
  });

  assert.equal(resolvedRecipient.cityCode, "34");
  assert.equal(resolvedRecipient.districtID, 108631);
  assert.equal(resolvedRecipient.districtName, "Ümraniye");

  const [job] = geliver.prepareCreateJobs({
    shipmentId: shipment.id,
    recipient: resolvedRecipient,
    operationId: "auto-recipient-create",
    actor,
  });

  const snapshot = db.prepare(`
    SELECT name,email,phone,address1,country_code,city_name,city_code,district_name,zip
    FROM shipment_recipient_snapshots
    WHERE shipment_id=?
  `).get(shipment.id) as any;

  assert.deepEqual(snapshot, {
    name: marketplaceRecipient.name,
    email: marketplaceRecipient.email,
    phone: marketplaceRecipient.phone,
    address1: marketplaceRecipient.address1,
    country_code: "TR",
    city_name: "İstanbul",
    city_code: marketplaceRecipient.cityCode,
    district_name: "Ümraniye",
    zip: marketplaceRecipient.zip,
  });

  const request = JSON.parse(String(
    db.prepare("SELECT request_json FROM geliver_create_jobs WHERE id=?").pluck().get(job.id)
  ));

  assert.equal(request.recipientAddress.phone, marketplaceRecipient.phone);
  assert.equal(request.recipientAddress.cityCode, "34");
  assert.equal(request.recipientAddress.districtID, 108631);
  assert.equal(request.recipientAddress.districtName, "Ümraniye");

  db.close();
});

test("verified live offers are selected by the operator; booking accepts provider-native label while tracking is nullable and refreshes later", async () => {
  const { db, inventory, shipping, shipment, transport, geliver } = prepareLiveGeliver();
  const jobs = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "geliver-create", actor });
  const provider = await geliver.processCreateJob(jobs[0].id);
  assert.equal(provider.offers.length, 1);
  assert.equal(transport.getCalls, 0);
  assert.deepEqual(provider.offers[0], { id: provider.offers[0].id, carrier: "YURTICI", service: "STANDART", amount: "89.90",
    currency: "TRY", amountLocal: "89.90", currencyLocal: "TRY", estimatedArrivalAt: null, durationTerms: null });
  const accept = geliver.selectOffer({ shipmentId: shipment.id, offerId: provider.offers[0].id, operationId: "select-live-offer", actor });
  await geliver.processAcceptJob(accept.id);
  const booked = shipping.getShipment(shipment.id);
  assert.equal(booked.state, "LABEL_READY");
  assert.equal(booked.packages[0].booking.trackingNumber, null);
  assert.equal(booked.packages[0].booking.providerTransactionId.startsWith("transaction-"), true);
  assert.equal(booked.packages[0].label.reference.endsWith(".pdf"), true);
  assert.equal(booked.packages[0].label.mediaType, "PDF");
  assert.equal(booked.packages[0].label.providerNative, true);
  assert.match(booked.packages[0].label.sha256, /^[a-f0-9]{64}$/);
  assert.equal("dpi" in booked.packages[0].label, false);
  assert.equal(inventory.getProductAvailability("part").onHandBaseInt, 2);
  transport.publishTracking(provider.providerShipmentId);
  await geliver.refreshShipment(shipment.id);
  assert.equal(shipping.getShipment(shipment.id).packages[0].booking.trackingNumber, "TRACK-LATER");
  assert.equal(transport.acceptCalls, 1);
  db.close();
});

test("V83 live Geliver dispatch and later tracking projection reconcile cleanly", async () => {
  const { db, shipping, shipment, transport, geliver } = prepareLiveGeliver();
  const [job] = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "reconcile-create", actor });
  const provider = await geliver.processCreateJob(job.id);
  const accept = geliver.selectOffer({ shipmentId: shipment.id, offerId: provider.offers[0].id, operationId: "reconcile-select", actor });
  await geliver.processAcceptJob(accept.id);
  shipping.confirmHandoff({ shipmentId: shipment.id, handedOffAt: "2026-09-23T12:00:00.000Z", handoffEvidence: { receipt: "carrier" }, operationId: "reconcile-handoff", actor });
  transport.publishTracking(provider.providerShipmentId);
  await geliver.refreshShipment(shipment.id);
  shipping.publishV212TrackingRefresh(shipment.id, "2026-09-23T12:30:00.000Z");
  const run = new ReconciliationService(db).run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "geliver-v83-scan" });
  assert.equal(run.findings.find((finding) => finding.code === "CHANNEL_TRACKING_PROJECTION_MISMATCH"), undefined);
  db.close();
});

test("ORDER reconciliation block prevents the affected physical handoff", async () => {
  const { db, shipping, shipment, geliver } = prepareLiveGeliver();
  const [job] = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "blocked-create", actor });
  const provider = await geliver.processCreateJob(job.id);
  const accept = geliver.selectOffer({ shipmentId: shipment.id, offerId: provider.offers[0].id, operationId: "blocked-select", actor });
  await geliver.processAcceptJob(accept.id);
  addShipmentOrderBlock(db, "sale");
  assert.throws(() => shipping.confirmHandoff({ shipmentId: shipment.id, handedOffAt: "2026-09-23T12:00:00Z", handoffEvidence: { receipt: "carrier" }, operationId: "blocked-handoff", actor }),
    (error: any) => error.code === "RECONCILIATION_SCOPE_BLOCKED");
  assert.equal(shipping.getShipment(shipment.id).state, "LABEL_READY");
  db.close();
});

test("uncertain Geliver create reconciles by exact orderNumber and never creates a duplicate", async () => {
  const { db, shipment, transport, geliver } = prepareLiveGeliver();
  transport.uncertainCreateOnce = true;
  const [job] = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "uncertain-create", actor });
  await assert.rejects(() => geliver.processCreateJob(job.id), /timeout after provider commit/);
  const reconciled = await geliver.processCreateJob(job.id);
  assert.equal(reconciled.providerOrderNumber.includes("DS-13-P1-"), true);
  assert.equal(transport.createCalls, 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM geliver_provider_shipments").pluck().get(), 1);
  assert.equal(db.prepare("SELECT state FROM geliver_create_jobs WHERE id=?").pluck().get(job.id), "CREATED");
  db.close();
});

test("definitive Geliver booking failure emits one stable shipping exception", async () => {
  const notifications: Array<{ shipmentId: string; jobId: string }> = [];
  const { db, shipment, transport, geliver } = prepareLiveGeliver(marketplaceRecipient, (event) => {
    notifications.push(event);
  });
  const [createJob] = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "failed-create", actor });
  const provider = await geliver.processCreateJob(createJob.id);
  const accept = geliver.selectOffer({ shipmentId: shipment.id, offerId: provider.offers[0].id, operationId: "failed-select", actor });
  transport.definitiveAcceptFailureOnce = true;

  await assert.rejects(() => geliver.processAcceptJob(accept.id), /provider rejected booking/);
  assert.deepEqual(notifications, [{ shipmentId: shipment.id, jobId: accept.id }]);
  assert.equal(db.prepare("SELECT state FROM geliver_accept_jobs WHERE id=?").pluck().get(accept.id), "DEFINITIVE_FAILURE");
  db.close();
});

test("pre-handoff Geliver cancellation records provider evidence and never dispatches", async () => {
  const { db, inventory, shipping, shipment, geliver } = prepareLiveGeliver();
  const [job] = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "cancel-create", actor });
  const provider = await geliver.processCreateJob(job.id);
  const accept = geliver.selectOffer({ shipmentId: shipment.id, offerId: provider.offers[0].id, operationId: "cancel-select", actor });
  await geliver.processAcceptJob(accept.id);
  await geliver.cancelBeforeHandoff({ shipmentId: shipment.id, operationId: "cancel-live", actor, reason: "CUSTOMER_REQUEST" });
  assert.equal(shipping.getShipment(shipment.id).state, "CANCELLED");
  assert.equal(db.prepare("SELECT COUNT(*) FROM geliver_cancellation_facts").pluck().get(), 1);
  assert.equal(inventory.getProductAvailability("part").onHandBaseInt, 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 0);
  db.close();
});

test("safe shipment diagnostic exposes booking uncertainty consistently in list and detail", () => {
  const { db } = setup();
  const shipping = new ShipmentService(db);
  const shipment = shipping.packAndPrepare({ reservationId: "reservation", operationId: "diagnostic-pack", actor }).shipment;
  shipping.definePackages({ shipmentId: shipment.id, operationId: "diagnostic-packages", actor, packages: [{ packageNumber: 1,
    measured: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1200 }, contents: [{ productId: "part", quantityBaseInt: 2 }] }] });
  shipping.selectCarrier({ shipmentId: shipment.id, provider: "GELIVER", carrierCode: "FIXTURE", serviceCode: "STANDARD",
    quote: { quoteId: "diagnostic-quote", amountMinor: 9000, currency: "TRY", provenance: { source: "fixture" } },
    operationId: "diagnostic-select", actor });
  const booking = shipping.requestBooking({ shipmentId: shipment.id, operationId: "diagnostic-book", actor });
  db.prepare("UPDATE shipment_booking_jobs SET state='BLOCKED_UNCERTAIN',last_error_code='BOOKING_OUTCOME_UNCERTAIN' WHERE id=?")
    .run(booking.jobs[0].id);

  const expected = {
    code: "BOOKING_OUTCOME_UNCERTAIN",
    stage: "booking",
    message: "Kargo rezervasyon sonucu belirsiz. Otomatik yeniden deneme durduruldu.",
  };
  assert.deepEqual(shipping.getShipment(shipment.id).activeDiagnostic, expected);
  assert.deepEqual(shipping.listShipments().find((item) => item.id === shipment.id)?.activeDiagnostic, expected);
  db.close();
});

test("safe shipment diagnostic prioritizes blocked tracking outbound", () => {
  const { db } = setup();
  const shipping = new ShipmentService(db);
  const shipment = shipping.packAndPrepare({ reservationId: "reservation", operationId: "outbound-diagnostic-pack", actor }).shipment;
  const [shipmentPackage] = shipping.definePackages({ shipmentId: shipment.id, operationId: "outbound-diagnostic-packages", actor,
    packages: [{ packageNumber: 1, measured: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1200 },
      contents: [{ productId: "part", quantityBaseInt: 2 }] }] });
  db.prepare(`INSERT INTO geliver_create_jobs
    (id,shipment_id,package_id,request_identity,provider_order_number,request_json,request_hash,state,last_error_code,
     created_operation_id,created_at,updated_at)
    VALUES ('diagnostic-provider',?,?,'diagnostic-provider-request','diagnostic-provider-order','{}',?,
      'RECONCILE_REQUIRED','GELIVER_OUTCOME_UNCERTAIN','diagnostic-provider-create',
      '2026-09-26T12:01:00.000Z','2026-09-26T12:01:00.000Z')`)
    .run(shipment.id, shipmentPackage.id, "c".repeat(64));
  db.prepare(`INSERT INTO channel_shipment_outbound_jobs
    (id,account_id,shipment_id,channel_order_id,job_kind,source_version,payload_json,payload_hash,state,created_operation_id,
     available_at,last_error_code,created_at,updated_at)
    VALUES ('diagnostic-outbound','channel-account',?,'channel-order','TRACKING_STATUS','diagnostic-v1','{}',?,'BLOCKED',
      'diagnostic-outbound-create','2026-09-26T12:00:00.000Z','CHANNEL_TRACKING_PENDING','2026-09-26T12:00:00.000Z','2026-09-26T12:00:00.000Z')`)
    .run(shipment.id, "a".repeat(64));

  assert.deepEqual(shipping.getShipment(shipment.id).activeDiagnostic, {
    code: "CHANNEL_TRACKING_PENDING",
    stage: "tracking_outbound",
    message: "Takip bilgisi henüz hazır değil. Kanal güncellemesi bekliyor.",
  });
  db.close();
});

test("safe shipment diagnostic is null for normal shipment", () => {
  const { db } = setup();
  const shipping = new ShipmentService(db);
  const shipment = shipping.packAndPrepare({ reservationId: "reservation", operationId: "normal-diagnostic-pack", actor }).shipment;
  assert.equal(shipping.getShipment(shipment.id).activeDiagnostic, null);
  assert.equal(shipping.listShipments().find((item) => item.id === shipment.id)?.activeDiagnostic, null);
  db.close();
});

test("safe shipment diagnostic never exposes unknown provider code or payload", () => {
  const { db } = setup();
  const shipping = new ShipmentService(db);
  const shipment = shipping.packAndPrepare({ reservationId: "reservation", operationId: "secret-diagnostic-pack", actor }).shipment;
  const [shipmentPackage] = shipping.definePackages({ shipmentId: shipment.id, operationId: "secret-diagnostic-packages", actor,
    packages: [{ packageNumber: 1, measured: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1200 },
      contents: [{ productId: "part", quantityBaseInt: 2 }] }] });
  db.prepare(`INSERT INTO geliver_create_jobs
    (id,shipment_id,package_id,request_identity,provider_order_number,request_json,request_hash,state,attempt_count,
     reconciliation_count,last_error_code,created_operation_id,created_at,updated_at)
    VALUES ('secret-job',?,?,'secret-request','secret-order',?,?,'RECONCILE_REQUIRED',1,1,?,
      'secret-job-create','2026-09-26T12:00:00.000Z','2026-09-26T12:00:00.000Z')`)
    .run(shipment.id, shipmentPackage.id, JSON.stringify({ authorization: "Bearer provider-secret" }), "b".repeat(64), "TOKEN_provider-secret");

  const response = JSON.stringify(shipping.getShipment(shipment.id));
  assert.equal(response.includes("provider-secret"), false);
  assert.deepEqual(shipping.getShipment(shipment.id).activeDiagnostic, {
    code: "PROVIDER_OUTCOME_UNCERTAIN",
    stage: "provider",
    message: "Kargo sağlayıcı işleminin sonucu belirsiz. Otomatik yeniden deneme durduruldu.",
  });
  db.close();
});
