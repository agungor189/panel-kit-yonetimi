import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { CommandExecutor } from "../commands/commandFoundation.js";
import { InventoryService } from "../inventory/inventoryService.js";
import { ProcurementService } from "../procurement/procurementService.js";
import { SalesFinancialService } from "../sales/salesFinancialService.js";
import {
  GELIVER_TRANSPORT_CONTRACT,
  ShipmentService,
  ShipmentValidationError,
  type CarrierBookingTransport,
} from "./shipmentService.js";
import { GeliverFlowService, type GeliverTransport } from "./geliverFlowService.js";
import type { Shipment, Transaction } from "@geliver/sdk";

const actor = { id: "shipping-operator", name: "Shipping Operator" };

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

const setup = () => {
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
  const inventory = new InventoryService(db);
  inventory.receiveCostedLot({ receiptId: "receipt", costSnapshotId: cost.id, receivedAt: "2026-09-23T08:00:00.000Z",
    location: { id: "pick", kind: "PICKING" }, operationId: "receive" });
  inventory.reserveOrder({ reservationId: "reservation", orderId: "sale", lines: [{ productId: "part", quantityBaseInt: 2 }], operationId: "reserve" });
  inventory.markPicked({ reservationId: "reservation", operationId: "pick" });
  db.prepare(`INSERT INTO channel_accounts
    (id,channel,merchant_account_id,environment,state,config_json) VALUES ('channel-account','TRENDYOL','merchant','STAGE','CONFIGURED','{}')`).run();
  db.prepare(`INSERT INTO channel_inbound_events
    (id,account_id,external_event_id,external_event_version,ingestion_path,event_type,raw_payload_json,raw_payload_digest,
     received_at,processing_state,sale_id) VALUES ('channel-event','channel-account','event','1','POLL','ORDER_UPSERT','{}',?,
     '2026-09-23T09:00:00.000Z','ACCEPTED','sale')`).run("c".repeat(64));
  db.prepare(`INSERT INTO channel_orders
    (id,account_id,external_order_id,latest_external_version,currency,actual_discount_minor,order_state,sale_id,reservation_id,
     first_event_id,raw_order_digest) VALUES ('channel-order','channel-account','external-order','1','TRY',0,'ACCEPTED','sale',
     'reservation','channel-event',?)`).run("d".repeat(64));
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

test("confirmed handoff dispatches once, finalizes FIFO/COGS, routes V2-12 update, notifies once, and records actual charge", () => {
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
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_outbox WHERE event_type='customer.order.shipped.v1'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_outbox WHERE event_type='customer.order.shipped.v1' AND payload_json LIKE '%DS-13%'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_outbox WHERE event_type='customer.order.shipped.v1' AND payload_json LIKE '%package_count%'").pluck().get(), 1);
  assert.throws(() => service.cancelBeforeHandoff({ shipmentId: shipment.id, reason: "TOO_LATE", operationId: "cancel-late", actor, transport }),
    (error: unknown) => error instanceof ShipmentValidationError && error.code === "RETURN_FLOW_REQUIRED");
  assert.equal(GELIVER_TRANSPORT_CONTRACT.enabled, false);
  assert.match(GELIVER_TRANSPORT_CONTRACT.disabledReason, /idempotency|100x150/i);
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
  acceptCalls = 0;
  uncertainCreateOnce = false;
  private readonly shipments = new Map<string, Shipment>();
  async create(body: any) {
    this.createCalls += 1;
    const id = `provider-${body.order.orderNumber}`;
    const shipment: Shipment = { id, order: { orderNumber: body.order.orderNumber }, offers: { percentageCompleted: 100, list: [
      { id: `offer-${id}`, providerCode: "YURTICI", providerServiceCode: "STANDART", amount: "89.90", currency: "TRY",
        amountLocal: "89.90", currencyLocal: "TRY" },
    ] } };
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
  async get(id: string) { return structuredClone(this.shipments.get(id)!); }
  async acceptOffer(offerId: string): Promise<Transaction> {
    this.acceptCalls += 1;
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
  publishTracking(id: string) { const shipment = this.shipments.get(id)!; shipment.trackingNumber = "TRACK-LATER"; shipment.trackingUrl = "https://track.geliver.test/TRACK-LATER"; }
}

const prepareLiveGeliver = () => {
  const fixture = setup();
  const shipping = new ShipmentService(fixture.db);
  const shipment = shipping.packAndPrepare({ reservationId: "reservation", operationId: "live-pack", actor }).shipment;
  shipping.definePackages({ shipmentId: shipment.id, operationId: "live-packages", actor, packages: [{ packageNumber: 1,
    measured: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1200 },
    contents: [{ productId: "part", quantityBaseInt: 2 }] }] });
  const transport = new OfficialGeliverFixture();
  const geliver = new GeliverFlowService(fixture.db, transport, { senderAddressId: "sender-address", sourceIdentifier: "https://dsdst.example" });
  return { ...fixture, shipping, shipment, transport, geliver };
};

test("verified live offers are selected by the operator; booking accepts provider-native label while tracking is nullable and refreshes later", async () => {
  const { db, inventory, shipping, shipment, transport, geliver } = prepareLiveGeliver();
  const jobs = geliver.prepareCreateJobs({ shipmentId: shipment.id, recipient, operationId: "geliver-create", actor });
  const provider = await geliver.processCreateJob(jobs[0].id);
  assert.equal(provider.offers.length, 1);
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
