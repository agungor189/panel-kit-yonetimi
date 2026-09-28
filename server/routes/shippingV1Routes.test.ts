import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { initializeDatabase } from "../db/initialize.js";
import { CatalogService } from "../modules/catalog/catalogService.js";
import { InventoryService } from "../modules/inventory/inventoryService.js";
import { ProcurementService } from "../modules/procurement/procurementService.js";
import { SalesFinancialService } from "../modules/sales/salesFinancialService.js";
import { ShipmentService, type CarrierBookingTransport } from "../modules/shipping/shipmentService.js";
import { createShippingV1Router } from "./shippingV1Routes.js";

const actor = { id: "bulk-dispatcher", name: "Bulk Dispatcher" };

class VerifiedBookingTransport implements CarrierBookingTransport {
  readonly provider = "GELIVER" as const;
  readonly enabled = true;
  readonly serverIdempotencyVerified = true;

  bookPackage(input: any) {
    const identity = Buffer.from(input.requestIdentity).toString("base64url");
    return {
      providerShipmentId: `provider-${identity}`,
      providerTransactionId: `transaction-${identity}`,
      carrierCode: input.carrierCode,
      serviceCode: input.serviceCode,
      trackingNumber: `TRACK-${identity}`,
      trackingUrl: `https://tracking.invalid/${identity}`,
      label: {
        reference: `provider-label:${identity}`,
        sha256: "a".repeat(64),
        mediaType: "application/pdf",
        widthMm: 100,
        heightMm: 150,
        dpi: 203,
      },
      providerResponseReference: `fixture:${identity}`,
    };
  }
}

async function fixture(states: Array<"LABEL_READY" | "PREPARING">) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  new CatalogService(db).createProduct({
    id: "bulk-part",
    sku: "BULK-PART",
    title: "Bulk part",
    catalog_type: "product",
    base_uom_code: "piece",
  });
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "bulk-supplier", name: "Bulk Supplier", defaultCurrency: "TRY" });
  procurement.createPurchase({
    id: "bulk-purchase",
    supplierId: "bulk-supplier",
    acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
    lines: [{
      id: "bulk-purchase-line",
      productId: "bulk-part",
      quantity: "100",
      quoteBasis: "piece",
      supplierUnitPriceMinor: 100,
      currency: "TRY",
      vatMode: "EXCLUDED",
      vatRateBps: 0,
    }],
  });
  const costSnapshot = procurement.finalizeAcquisitionCosts("bulk-purchase", { allocations: [] }).lots[0];
  const inventory = new InventoryService(db);
  inventory.receiveCostedLot({
    receiptId: "bulk-receipt",
    costSnapshotId: costSnapshot.id,
    receivedAt: "2026-09-26T08:00:00.000Z",
    location: { id: "bulk-pick", kind: "PICKING" },
    operationId: "bulk-receive",
  });

  const shipping = new ShipmentService(db);
  const financials = new SalesFinancialService(db);
  const transport = new VerifiedBookingTransport();
  const shipmentIds: string[] = [];

  for (const [index, targetState] of states.entries()) {
    const suffix = String(index + 1);
    const saleId = `bulk-sale-${suffix}`;
    const reservationId = `bulk-reservation-${suffix}`;
    db.prepare("INSERT INTO sales (id,order_code,total_amount,platform) VALUES (?,?,0,'Direct')")
      .run(saleId, `BULK-ORDER-${suffix}`);
    db.prepare(`INSERT INTO sale_items (id,sale_id,product_id,product_name,quantity,unit_price)
      VALUES (?,?,?,?,1,0)`).run(`bulk-line-${suffix}`, saleId, "bulk-part", "Bulk part");
    inventory.reserveOrder({
      reservationId,
      orderId: saleId,
      lines: [{ productId: "bulk-part", quantityBaseInt: 1 }],
      operationId: `bulk-reserve-${suffix}`,
    });
    inventory.markPicked({ reservationId, operationId: `bulk-pick-${suffix}` });
    financials.createOrderSnapshot({
      saleId,
      currency: "TRY",
      sourceChannel: "Direct",
      discountMinor: 0,
      commissionRatePercent: "0",
      commissionCalculationBasis: "GROSS_BEFORE_DISCOUNT",
      commissionTerms: { version: "bulk-fixture" },
      lines: [{ saleLineId: `bulk-line-${suffix}`, productId: "bulk-part", quantity: 1, unitGrossMinor: 1000, vatRateBps: 0 }],
      operationId: `bulk-financial-${suffix}`,
      actor,
    });
    const shipment = shipping.packAndPrepare({ reservationId, operationId: `bulk-pack-${suffix}`, actor }).shipment;
    shipmentIds.push(shipment.id);
    if (targetState === "PREPARING") continue;
    shipping.definePackages({
      shipmentId: shipment.id,
      operationId: `bulk-packages-${suffix}`,
      actor,
      packages: [{
        packageNumber: 1,
        measured: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 500 },
        contents: [{ productId: "bulk-part", quantityBaseInt: 1 }],
      }],
    });
    shipping.selectCarrier({
      shipmentId: shipment.id,
      provider: "GELIVER",
      carrierCode: "FIXTURE",
      serviceCode: "STANDARD",
      quote: { quoteId: `bulk-quote-${suffix}`, amountMinor: 100, currency: "TRY", provenance: { source: "fixture" } },
      operationId: `bulk-carrier-${suffix}`,
      actor,
    });
    const booking = shipping.requestBooking({ shipmentId: shipment.id, operationId: `bulk-booking-${suffix}`, actor });
    for (const job of booking.jobs) shipping.processBookingJob({ jobId: job.id, transport, serviceActorId: "fixture-worker" });
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: actor.id, username: actor.name } as typeof req.user;
    next();
  });
  const allow: express.RequestHandler = (_req, _res, next) => next();
  const authorizeDispatch: express.RequestHandler = (req, res, next) => req.headers["x-test-dispatch"] === "allow"
    ? next()
    : res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "shipping:dispatch required" } });
  app.use("/api/shipping/v1", createShippingV1Router({
    db,
    authorizeRead: allow,
    authorizePrepare: allow,
    authorizeManage: allow,
    authorizeDispatch,
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not start");
  const baseUrl = `http://127.0.0.1:${address.port}/api/shipping/v1`;

  const bulkHandoff = (batchOperationId: string, ids = shipmentIds, authorized = true) => fetch(`${baseUrl}/shipments/bulk-handoff`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-operation-id": batchOperationId,
      ...(authorized ? { "x-test-dispatch": "allow" } : {}),
    },
    body: JSON.stringify({
      shipmentIds: ids,
      handedOffAt: "2026-09-26T12:00:00.000Z",
      handoffEvidence: { kind: "BATCH_CARRIER_RECEIPT", reference: "dock-batch-1" },
    }),
  });

  return {
    baseUrl,
    db,
    inventory,
    shipping,
    shipmentIds,
    bulkHandoff,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => {
      db.close();
      if (error) reject(error); else resolve();
    })),
  };
}

test("packaging type commands are idempotent and drive canonical package weight", async () => {
  const context = await fixture(["PREPARING"]);
  try {
    context.db.prepare("UPDATE products SET weight_grams=310 WHERE id='bulk-part'").run();
    const create = () => fetch(`${context.baseUrl}/packaging-types`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operation-id": "box-small-create" },
      body: JSON.stringify({
        name: "Küçük Koli",
        lengthMm: 300,
        widthMm: 200,
        heightMm: 100,
        emptyWeightGrams: 190,
      }),
    });

    const created = await create();
    assert.equal(created.status, 201);
    const createdBody = await created.json() as any;
    assert.equal(createdBody.idempotent, false);
    assert.equal(createdBody.data.name, "Küçük Koli");

    const replayed = await create();
    assert.equal(replayed.status, 201);
    assert.equal((await replayed.json() as any).idempotent, true);

    const listed = await fetch(`${context.baseUrl}/packaging-types`);
    assert.equal(listed.status, 200);
    const listBody = await listed.json() as any;
    assert.equal(listBody.data.length, 1);

    const packaged = await fetch(`${context.baseUrl}/shipments/${context.shipmentIds[0]}/packages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operation-id": "package-with-small-box" },
      body: JSON.stringify({
        packages: [{
          packageNumber: 1,
          packagingTypeId: createdBody.data.id,
          contents: [{ productId: "bulk-part", quantityBaseInt: 1 }],
        }],
      }),
    });
    assert.equal(packaged.status, 201);
    const packagedBody = await packaged.json() as any;
    assert.deepEqual(packagedBody.data[0].dimensionsMm, { length: 300, width: 200, height: 100 });
    assert.equal(packagedBody.data[0].weightGrams, 500);
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM command_outbox WHERE event_type='shipping.packaging-type.created.v1'").pluck().get(), 1);
  } finally { await context.close(); }
});

test("three LABEL_READY shipments dispatch through the canonical handoff flow", async () => {
  const context = await fixture(["LABEL_READY", "LABEL_READY", "LABEL_READY"]);
  try {
    const response = await context.bulkHandoff("bulk-three-ready");
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body.summary, { requested: 3, dispatched: 3, failed: 0, alreadyProcessed: 0 });
    assert.ok(body.data.every((item: any) => item.success && item.resultingState === "DISPATCHED"));
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 3);
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM sale_financial_cogs_finalizations").pluck().get(), 3);
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM shipment_state_events WHERE to_state='HANDED_OFF' AND evidence_json=?").pluck()
      .get(JSON.stringify({ kind: "BATCH_CARRIER_RECEIPT", reference: "dock-batch-1" })), 3);
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM command_outbox WHERE event_type='shipping.dispatched.v1'").pluck().get(), 3);
    assert.equal(context.inventory.getProductAvailability("bulk-part").onHandBaseInt, 97);
  } finally { await context.close(); }
});

test("mixed batch keeps successful dispatches when one shipment is not ready", async () => {
  const context = await fixture(["LABEL_READY", "LABEL_READY", "PREPARING"]);
  try {
    const response = await context.bulkHandoff("bulk-mixed");
    const body = await response.json() as any;
    assert.deepEqual(body.summary, { requested: 3, dispatched: 2, failed: 1, alreadyProcessed: 0 });
    assert.deepEqual(body.data.map((item: any) => item.success), [true, true, false]);
    assert.equal(body.data[2].errorCode, "HANDOFF_NOT_READY");
    assert.equal(context.shipping.getShipment(context.shipmentIds[0]).state, "DISPATCHED");
    assert.equal(context.shipping.getShipment(context.shipmentIds[1]).state, "DISPATCHED");
    assert.equal(context.shipping.getShipment(context.shipmentIds[2]).state, "PREPARING");
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 2);
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM sale_financial_cogs_finalizations").pluck().get(), 2);
  } finally { await context.close(); }
});

test("batch replay and an already DISPATCHED shipment never duplicate stock or finance", async () => {
  const context = await fixture(["LABEL_READY"]);
  try {
    const first = await context.bulkHandoff("bulk-replay");
    assert.equal(first.status, 200);
    const ledgerAfterFirst = context.db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get();
    const financeAfterFirst = context.db.prepare("SELECT COUNT(*) FROM sale_financial_cogs_finalizations").pluck().get();
    const stateEventsAfterFirst = context.db.prepare("SELECT COUNT(*) FROM shipment_state_events").pluck().get();
    const outboxAfterFirst = context.db.prepare("SELECT COUNT(*) FROM command_outbox").pluck().get();

    const replay = await context.bulkHandoff("bulk-replay");
    const replayBody = await replay.json() as any;
    assert.deepEqual(replayBody.summary, { requested: 1, dispatched: 0, failed: 0, alreadyProcessed: 1 });
    assert.equal(replayBody.batchReplayed, true);
    assert.equal(replayBody.data[0].replayed, true);

    const newBatch = await context.bulkHandoff("bulk-already-dispatched");
    const newBatchBody = await newBatch.json() as any;
    assert.deepEqual(newBatchBody.summary, { requested: 1, dispatched: 0, failed: 1, alreadyProcessed: 0 });
    assert.equal(newBatchBody.data[0].errorCode, "HANDOFF_NOT_READY");
    assert.equal(newBatchBody.data[0].resultingState, "DISPATCHED");
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), ledgerAfterFirst);
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM sale_financial_cogs_finalizations").pluck().get(), financeAfterFirst);
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM shipment_state_events").pluck().get(), stateEventsAfterFirst);
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM command_outbox").pluck().get(), outboxAfterFirst);
  } finally { await context.close(); }
});

test("bulk handoff requires shipping:dispatch permission", async () => {
  const context = await fixture(["LABEL_READY"]);
  try {
    const response = await context.bulkHandoff("bulk-forbidden", context.shipmentIds, false);
    assert.equal(response.status, 403);
    assert.equal((await response.json() as any).error.code, "FORBIDDEN");
    const duplicate = await context.bulkHandoff("bulk-duplicate", [context.shipmentIds[0], context.shipmentIds[0]]);
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as any).error.code, "BULK_HANDOFF_DUPLICATE_SHIPMENT");
    assert.equal(context.shipping.getShipment(context.shipmentIds[0]).state, "LABEL_READY");
    assert.equal(context.db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 0);
  } finally { await context.close(); }
});
