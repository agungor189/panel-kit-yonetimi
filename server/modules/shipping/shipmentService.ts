import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { OutboxMessage } from "../commands/commandFoundation.js";
import { InventoryService } from "../inventory/inventoryService.js";
import { SalesFinancialService } from "../sales/salesFinancialService.js";
import { ReconciliationScopeGuard } from "../reconciliation/reconciliationGuard.js";

type Actor = { id: string; name?: string | null };
type ShipmentState = "PREPARING" | "CARRIER_SELECTED" | "BOOKED" | "LABEL_READY" | "HANDED_OFF" | "DISPATCHED" | "CANCELLED" | "EXCEPTION";
type RecipeMeasurement = {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightGrams: number;
  recipeVersionRef: string;
  recipeHash: string;
};

export const GELIVER_TRANSPORT_CONTRACT = {
  contract: "dsdst.carrier-adapter.geliver.v1",
  provider: "GELIVER",
  verifiedAt: "2026-09-23",
  officialDocumentation: "https://docs.geliver.io",
  officialSdk: "https://github.com/GeliverApp/geliver-js",
  verifiedCapabilities: ["CREATE_SHIPMENT", "SELECT_OFFER", "LABEL_REFERENCE", "TRACKING_REFERENCE", "CANCEL_SHIPMENT"],
  enabled: false,
  disabledReason: "Geliver provider-side idempotency and an exact provider-issued 100x150/203dpi label contract are not verified; live transport is fail-closed.",
} as const;

export type CarrierBookingResult = {
  providerShipmentId: string;
  providerTransactionId?: string | null;
  carrierCode: string;
  serviceCode: string;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  label: {
    reference: string;
    sha256: string;
    mediaType: string;
    widthMm: number;
    heightMm: number;
    dpi: number;
  };
  providerResponseReference: string;
};

export interface CarrierBookingTransport {
  readonly provider: "GELIVER";
  readonly enabled: boolean;
  readonly serverIdempotencyVerified: boolean;
  bookPackage(input: {
    requestIdentity: string;
    shipmentId: string;
    packageId: string;
    packageNumber: number;
    carrierCode: string;
    serviceCode: string;
    dimensionsMm: { length: number; width: number; height: number };
    weightGrams: number;
    orderNumber: string;
    cashOnDelivery: false;
  }): CarrierBookingResult;
  cancelShipment?(input: { providerShipmentId: string; requestIdentity: string; reason: string }): {
    providerCancellationId: string;
    providerResponseReference: string;
  };
}

export class FailClosedGeliverTransport implements CarrierBookingTransport {
  readonly provider = "GELIVER" as const;
  readonly enabled = false;
  readonly serverIdempotencyVerified = false;
  bookPackage(): CarrierBookingResult {
    throw new ShipmentValidationError("GELIVER_TRANSPORT_DISABLED", GELIVER_TRANSPORT_CONTRACT.disabledReason, 503);
  }
}

export class ShipmentValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "ShipmentValidationError";
  }
}

const text = (value: unknown, field: string, max = 500) => {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new ShipmentValidationError("SHIPMENT_VALIDATION_FAILED", `${field} is invalid.`);
  }
  return result;
};
const optionalText = (value: unknown, field: string, max = 500) => value === undefined || value === null || value === ""
  ? null : text(value, field, max);
const positiveInteger = (value: unknown, field: string) => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new ShipmentValidationError("SHIPMENT_VALIDATION_FAILED", `${field} must be a positive safe integer.`);
  return Number(value);
};
const nonNegativeInteger = (value: unknown, field: string) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ShipmentValidationError("SHIPMENT_VALIDATION_FAILED", `${field} must be a non-negative safe integer.`);
  return Number(value);
};
const instant = (value: unknown, field: string) => {
  const result = text(value, field, 50);
  if (!Number.isFinite(Date.parse(result))) throw new ShipmentValidationError("SHIPMENT_VALIDATION_FAILED", `${field} must be an ISO timestamp.`);
  return result;
};
const actorInput = (actor: Actor) => ({ id: text(actor.id, "actor.id", 200), name: optionalText(actor.name, "actor.name", 200) });
const stableJson = (value: any): string => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new ShipmentValidationError("SHIPMENT_VALIDATION_FAILED", "Payload must be JSON-compatible.");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
};
const digest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const currency = (value: unknown) => {
  const result = text(value, "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) throw new ShipmentValidationError("SHIPMENT_VALIDATION_FAILED", "currency must be an ISO three-letter code.");
  return result;
};

export class ShipmentService {
  private readonly inventory: InventoryService;
  private readonly finance: SalesFinancialService;
  private readonly reconciliationGuard: ReconciliationScopeGuard;
  private readonly recipeResolver: (orderId: string, packageNumber: number) => RecipeMeasurement | null;

  constructor(private readonly db: Database.Database, options: {
    recipeResolver?: (orderId: string, packageNumber: number) => RecipeMeasurement | null;
  } = {}) {
    this.inventory = new InventoryService(db);
    this.finance = new SalesFinancialService(db);
    this.reconciliationGuard = new ReconciliationScopeGuard(db);
    this.recipeResolver = options.recipeResolver || ((orderId, packageNumber) => this.resolveRecipe(orderId, packageNumber));
  }

  private assertShipmentAllowed(shipmentId: string) {
    const error = (message: string) => new ShipmentValidationError("RECONCILIATION_SCOPE_BLOCKED", message, 409);
    this.reconciliationGuard.assertOrderForShipment(shipmentId, error);
    this.reconciliationGuard.assertShipmentSkus(shipmentId, error);
  }

  packAndPrepare(input: { reservationId: string; operationId: string; actor: Actor; packedAt?: string }) {
    const reservationId = text(input.reservationId, "reservationId");
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    const packedAt = input.packedAt ? instant(input.packedAt, "packedAt") : new Date().toISOString();
    this.reconciliationGuard.assertOrderForReservation(reservationId,
      (message) => new ShipmentValidationError("RECONCILIATION_SCOPE_BLOCKED", message, 409));
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id,created_operation_id FROM shipment_preparations WHERE reservation_id=?").get(reservationId) as any;
      if (existing) {
        if (existing.created_operation_id !== operationId) {
          throw new ShipmentValidationError("SHIPMENT_PREPARATION_EXISTS", "Packed reservation already has a shipment preparation.", 409);
        }
        return { shipment: this.getShipment(existing.id), reservation: this.inventory.getReservation(reservationId) };
      }
      const reservation = this.inventory.markPacked({ reservationId, operationId, packedAt });
      const shipmentId = `shipment:${reservationId}`;
      this.db.prepare(`INSERT INTO shipment_preparations
        (id,order_id,reservation_id,state,created_operation_id,created_at,updated_at)
        VALUES (?,?,?,'PREPARING',?,?,?)`).run(shipmentId, reservation.orderId, reservationId, operationId, packedAt, packedAt);
      this.insertStateEvent(shipmentId, null, "PREPARING", operationId, actor.id, { source: "PACKED", reservationId }, packedAt);
      return { shipment: this.getShipment(shipmentId), reservation };
    }).immediate();
  }

  definePackages(input: {
    shipmentId: string;
    packages: Array<{
      packageNumber: number;
      measured?: { lengthMm: number; widthMm: number; heightMm: number; weightGrams: number } | null;
      recipePackageNumber?: number | null;
      contents: Array<{ productId: string; quantityBaseInt: number }>;
    }>;
    operationId: string;
    actor: Actor;
  }) {
    const shipmentId = text(input.shipmentId, "shipmentId");
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    this.assertShipmentAllowed(shipmentId);
    if (!Array.isArray(input.packages) || input.packages.length === 0) {
      throw new ShipmentValidationError("PACKAGE_DEFINITION_REQUIRED", "At least one package is required.");
    }
    return this.db.transaction(() => {
      const shipment = this.requireShipment(shipmentId);
      if (shipment.state !== "PREPARING") throw new ShipmentValidationError("SHIPMENT_STATE_CONFLICT", "Packages may only be defined while preparing.", 409);
      if (Number(this.db.prepare("SELECT COUNT(*) FROM shipment_packages WHERE shipment_id=?").pluck().get(shipmentId)) !== 0) {
        throw new ShipmentValidationError("PACKAGE_SNAPSHOT_EXISTS", "Package snapshots are immutable once defined.", 409);
      }
      const numbers = input.packages.map((pack) => positiveInteger(pack.packageNumber, "packageNumber"));
      if (new Set(numbers).size !== numbers.length || [...numbers].sort((a, b) => a - b).some((value, index) => value !== index + 1)) {
        throw new ShipmentValidationError("PACKAGE_SEQUENCE_INVALID", "Package numbers must be unique and consecutive from one.");
      }
      const expected = new Map<string, number>();
      for (const row of this.db.prepare(`SELECT product_id,quantity_base_int FROM inventory_reservation_lines
        WHERE reservation_id=?`).all(shipment.reservation_id) as any[]) expected.set(row.product_id, Number(row.quantity_base_int));
      const actual = new Map<string, number>();
      const normalized = input.packages.map((pack, index) => {
        if (!Array.isArray(pack.contents) || pack.contents.length === 0) throw new ShipmentValidationError("PACKAGE_CONTENTS_REQUIRED", `packages[${index}] requires contents.`);
        const contents = pack.contents.map((item) => ({
          productId: text(item.productId, `packages[${index}].contents.productId`, 200),
          quantityBaseInt: positiveInteger(item.quantityBaseInt, `packages[${index}].contents.quantityBaseInt`),
        })).sort((left, right) => left.productId.localeCompare(right.productId));
        if (new Set(contents.map(({ productId }) => productId)).size !== contents.length) {
          throw new ShipmentValidationError("PACKAGE_CONTENTS_INVALID", "A package cannot repeat a product.");
        }
        for (const item of contents) actual.set(item.productId, (actual.get(item.productId) || 0) + item.quantityBaseInt);
        if (pack.measured) {
          return { packageNumber: numbers[index], source: "MEASURED" as const,
            lengthMm: positiveInteger(pack.measured.lengthMm, "measured.lengthMm"),
            widthMm: positiveInteger(pack.measured.widthMm, "measured.widthMm"),
            heightMm: positiveInteger(pack.measured.heightMm, "measured.heightMm"),
            weightGrams: positiveInteger(pack.measured.weightGrams, "measured.weightGrams"),
            recipeVersionRef: null, recipeHash: null, contents };
        }
        const recipeNumber = positiveInteger(pack.recipePackageNumber ?? pack.packageNumber, "recipePackageNumber");
        const recipe = this.recipeResolver(shipment.order_id, recipeNumber);
        if (!recipe) throw new ShipmentValidationError("PACKAGE_MEASUREMENTS_REQUIRED", "Measured values or a complete immutable package recipe are required.", 409);
        return { packageNumber: numbers[index], source: "RECIPE_ESTIMATE" as const,
          lengthMm: positiveInteger(recipe.lengthMm, "recipe.lengthMm"), widthMm: positiveInteger(recipe.widthMm, "recipe.widthMm"),
          heightMm: positiveInteger(recipe.heightMm, "recipe.heightMm"), weightGrams: positiveInteger(recipe.weightGrams, "recipe.weightGrams"),
          recipeVersionRef: text(recipe.recipeVersionRef, "recipe.recipeVersionRef"), recipeHash: text(recipe.recipeHash, "recipe.recipeHash", 64), contents };
      });
      if (expected.size !== actual.size || [...expected].some(([productId, quantity]) => actual.get(productId) !== quantity)) {
        throw new ShipmentValidationError("PACKAGE_CONTENTS_MISMATCH", "Package contents must exactly conserve the reservation snapshot.", 409);
      }
      const createdAt = new Date().toISOString();
      const insert = this.db.prepare(`INSERT INTO shipment_packages (
        id,shipment_id,package_number,measurement_source,length_mm,width_mm,height_mm,weight_grams,
        recipe_version_ref,recipe_hash,contents_snapshot_json,contents_snapshot_hash,created_operation_id,created_actor_id,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const pack of normalized) {
        const snapshot = { contract: "dsdst.shipment-package-contents.v1", orderId: shipment.order_id, reservationId: shipment.reservation_id, items: pack.contents };
        insert.run(randomUUID(), shipmentId, pack.packageNumber, pack.source, pack.lengthMm, pack.widthMm, pack.heightMm,
          pack.weightGrams, pack.recipeVersionRef, pack.recipeHash, stableJson(snapshot), digest(snapshot), operationId, actor.id, createdAt);
      }
      this.db.prepare("UPDATE shipment_preparations SET package_count=?,version=version+1,updated_at=? WHERE id=? AND state='PREPARING'")
        .run(normalized.length, createdAt, shipmentId);
      return this.getShipment(shipmentId).packages;
    }).immediate();
  }

  selectCarrier(input: {
    shipmentId: string;
    provider: "GELIVER";
    carrierCode: string;
    serviceCode: string;
    cashOnDelivery?: boolean;
    quote: { quoteId: string; amountMinor: number; currency: string; provenance: unknown };
    operationId: string;
    actor: Actor;
    selectedAt?: string;
  }) {
    if (input.cashOnDelivery === true) throw new ShipmentValidationError("COD_FORBIDDEN", "Cash on delivery is not supported.", 409);
    const shipmentId = text(input.shipmentId, "shipmentId");
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    const selectedAt = input.selectedAt ? instant(input.selectedAt, "selectedAt") : new Date().toISOString();
    this.assertShipmentAllowed(shipmentId);
    return this.db.transaction(() => {
      const shipment = this.getShipment(shipmentId);
      if (shipment.state !== "PREPARING") throw new ShipmentValidationError("SHIPMENT_STATE_CONFLICT", "Carrier may only be selected while preparing.", 409);
      if (shipment.packageCount < 1) throw new ShipmentValidationError("PACKAGE_DEFINITION_REQUIRED", "Packages must be defined before carrier selection.", 409);
      if (input.provider !== "GELIVER") throw new ShipmentValidationError("CARRIER_PROVIDER_UNSUPPORTED", "Only the explicit Geliver provider contract is supported.", 409);
      const quoteProvenance = stableJson(input.quote.provenance);
      const selectionId = randomUUID();
      this.db.prepare(`INSERT INTO shipment_carrier_selections (
        id,shipment_id,provider,carrier_code,service_code,quote_id,quote_amount_minor,quote_currency,quote_provenance_json,
        selected_operation_id,selected_actor_id,selected_actor_name,selected_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(selectionId, shipmentId, input.provider,
        text(input.carrierCode, "carrierCode", 100), text(input.serviceCode, "serviceCode", 100),
        text(input.quote.quoteId, "quote.quoteId", 200), nonNegativeInteger(input.quote.amountMinor, "quote.amountMinor"),
        currency(input.quote.currency), quoteProvenance, operationId, actor.id, actor.name, selectedAt);
      this.db.prepare(`UPDATE shipment_preparations SET state='CARRIER_SELECTED',carrier_selection_id=?,version=version+1,updated_at=?
        WHERE id=? AND state='PREPARING'`).run(selectionId, selectedAt, shipmentId);
      this.insertStateEvent(shipmentId, "PREPARING", "CARRIER_SELECTED", operationId, actor.id,
        { selectionId, explicitOperatorChoice: true, automaticCheapestSelection: false }, selectedAt);
      return this.getShipment(shipmentId);
    }).immediate();
  }

  requestBooking(input: { shipmentId: string; operationId: string; actor: Actor; requestedAt?: string }) {
    const shipmentId = text(input.shipmentId, "shipmentId");
    const operationId = text(input.operationId, "operationId");
    actorInput(input.actor);
    const requestedAt = input.requestedAt ? instant(input.requestedAt, "requestedAt") : new Date().toISOString();
    this.assertShipmentAllowed(shipmentId);
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM shipment_booking_jobs WHERE shipment_id=? AND created_operation_id=? ORDER BY id").all(shipmentId, operationId) as any[];
      if (existing.length > 0) return { shipment: this.getShipment(shipmentId), jobs: existing.map(({ id }) => this.getBookingJob(id)) };
      const shipment = this.getShipment(shipmentId);
      if (!shipment.carrierSelection || shipment.state !== "CARRIER_SELECTED") {
        throw new ShipmentValidationError("CARRIER_SELECTION_REQUIRED", "Explicit carrier and service selection is required before booking.", 409);
      }
      if (shipment.packages.length === 0) throw new ShipmentValidationError("PACKAGE_DEFINITION_REQUIRED", "Packages are required before booking.", 409);
      const orderNumber = text(shipment.orderNumber, "orderNumber", 200);
      const insert = this.db.prepare(`INSERT INTO shipment_booking_jobs (
        id,shipment_id,package_id,provider,request_identity,request_json,request_hash,state,available_at,created_operation_id,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,'PENDING',?,?,?,?)`);
      for (const pack of shipment.packages) {
        const requestIdentity = `dsdst:${shipmentId}:package:${pack.packageNumber}`;
        const request = { contract: "dsdst.geliver-booking-request.v1", requestIdentity, shipmentId, packageId: pack.id,
          packageNumber: pack.packageNumber, carrierCode: shipment.carrierSelection.carrierCode,
          serviceCode: shipment.carrierSelection.serviceCode, dimensionsMm: pack.dimensionsMm,
          weightGrams: pack.weightGrams, orderNumber, cashOnDelivery: false };
        insert.run(randomUUID(), shipmentId, pack.id, "GELIVER", requestIdentity, stableJson(request), digest(request),
          requestedAt, operationId, requestedAt, requestedAt);
      }
      return { shipment: this.getShipment(shipmentId), jobs: (this.db.prepare("SELECT id FROM shipment_booking_jobs WHERE shipment_id=? ORDER BY id").all(shipmentId) as any[])
        .map(({ id }) => this.getBookingJob(id)) };
    }).immediate();
  }

  processBookingJob(input: { jobId: string; transport: CarrierBookingTransport; serviceActorId: string; occurredAt?: string }) {
    const jobId = text(input.jobId, "jobId");
    const serviceActorId = text(input.serviceActorId, "serviceActorId");
    const occurredAt = input.occurredAt ? instant(input.occurredAt, "occurredAt") : new Date().toISOString();
    const prior = this.db.prepare("SELECT b.* FROM shipment_provider_bookings b JOIN shipment_booking_jobs j ON j.package_id=b.package_id WHERE j.id=?").get(jobId) as any;
    if (prior) return this.getProviderBooking(prior.id);
    if (!input.transport.enabled || !input.transport.serverIdempotencyVerified || input.transport.provider !== "GELIVER") {
      throw new ShipmentValidationError("GELIVER_TRANSPORT_DISABLED", GELIVER_TRANSPORT_CONTRACT.disabledReason, 503);
    }
    const claimed = this.db.transaction(() => {
      const job = this.db.prepare("SELECT * FROM shipment_booking_jobs WHERE id=?").get(jobId) as any;
      if (!job) throw new ShipmentValidationError("BOOKING_JOB_NOT_FOUND", "Booking job was not found.", 404);
      if (job.state === "SUCCEEDED") throw new ShipmentValidationError("BOOKING_RESULT_MISSING", "Successful booking has no immutable provider binding.", 409);
      if (job.state === "PROCESSING" || job.state === "BLOCKED_UNCERTAIN") {
        throw new ShipmentValidationError("BOOKING_OUTCOME_UNCERTAIN", "Booking outcome is uncertain and cannot be retried automatically.", 409);
      }
      if (!["PENDING", "RETRY"].includes(job.state)) throw new ShipmentValidationError("BOOKING_STATE_CONFLICT", "Booking job cannot run from its current state.", 409);
      const attempt = Number(job.attempt_count) + 1;
      this.db.prepare(`UPDATE shipment_booking_jobs SET state='PROCESSING',attempt_count=?,updated_at=? WHERE id=? AND state IN ('PENDING','RETRY')`)
        .run(attempt, occurredAt, jobId);
      const attemptId = randomUUID();
      this.db.prepare(`INSERT INTO shipment_booking_attempts (id,job_id,attempt_number,state,started_at)
        VALUES (?,?,?,'STARTED',?)`).run(attemptId, jobId, attempt, occurredAt);
      return { ...job, attempt, attemptId, request: JSON.parse(job.request_json) };
    }).immediate();
    let result: CarrierBookingResult;
    try {
      result = input.transport.bookPackage(claimed.request);
    } catch (error) {
      const definitive = (error as { definitiveFailure?: boolean })?.definitiveFailure === true;
      this.db.transaction(() => {
        this.db.prepare("UPDATE shipment_booking_attempts SET state=?,error_code=?,completed_at=? WHERE id=?")
          .run(definitive ? "DEFINITIVE_FAILURE" : "UNCERTAIN", optionalText((error as any)?.code, "error.code", 100), occurredAt, claimed.attemptId);
        this.db.prepare("UPDATE shipment_booking_jobs SET state=?,last_error_code=?,updated_at=? WHERE id=?")
          .run(definitive ? "RETRY" : "BLOCKED_UNCERTAIN", optionalText((error as any)?.code, "error.code", 100) || "PROVIDER_ERROR", occurredAt, jobId);
      }).immediate();
      throw error;
    }
    this.validateBookingResult(result, claimed.request);
    return this.db.transaction(() => {
      const bookingId = randomUUID();
      this.db.prepare(`INSERT INTO shipment_provider_bookings (
        id,shipment_id,package_id,provider,provider_shipment_id,provider_transaction_id,carrier_code,service_code,
        request_identity,request_hash,provider_response_reference,tracking_number,tracking_url,booked_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(bookingId, claimed.shipment_id, claimed.package_id, "GELIVER",
        result.providerShipmentId, result.providerTransactionId || null, result.carrierCode, result.serviceCode,
        claimed.request_identity, claimed.request_hash, result.providerResponseReference,
        result.trackingNumber || null, result.trackingUrl || null, occurredAt);
      this.db.prepare(`INSERT INTO shipment_labels (
        id,shipment_id,package_id,provider_booking_id,provider,label_reference,label_sha256,media_type,width_mm,height_mm,dpi,
        printer_compatibility,created_at
      ) VALUES (?,?,?,?,?,?,?,?,100,150,203,'XPRINTER_XP_470B_203DPI',?)`).run(randomUUID(), claimed.shipment_id,
        claimed.package_id, bookingId, "GELIVER", result.label.reference, result.label.sha256, result.label.mediaType, occurredAt);
      this.db.prepare("UPDATE shipment_booking_attempts SET state='SUCCEEDED',provider_response_reference=?,completed_at=? WHERE id=?")
        .run(result.providerResponseReference, occurredAt, claimed.attemptId);
      this.db.prepare("UPDATE shipment_booking_jobs SET state='SUCCEEDED',updated_at=? WHERE id=?").run(occurredAt, jobId);
      const remaining = Number(this.db.prepare("SELECT COUNT(*) FROM shipment_booking_jobs WHERE shipment_id=? AND state<>'SUCCEEDED'").pluck().get(claimed.shipment_id));
      if (remaining === 0) {
        const from = this.requireShipment(claimed.shipment_id).state as ShipmentState;
        this.db.prepare("UPDATE shipment_preparations SET state='BOOKED',version=version+1,updated_at=? WHERE id=? AND state='CARRIER_SELECTED'")
          .run(occurredAt, claimed.shipment_id);
        this.insertStateEvent(claimed.shipment_id, from, "BOOKED", `booking:${claimed.request_identity}`, serviceActorId,
          { provider: "GELIVER", packageCount: Number(this.db.prepare("SELECT COUNT(*) FROM shipment_packages WHERE shipment_id=?").pluck().get(claimed.shipment_id)) }, occurredAt);
        this.db.prepare("UPDATE shipment_preparations SET state='LABEL_READY',version=version+1,updated_at=? WHERE id=? AND state='BOOKED'")
          .run(occurredAt, claimed.shipment_id);
        this.insertStateEvent(claimed.shipment_id, "BOOKED", "LABEL_READY", `label:${claimed.request_identity}`, serviceActorId,
          { provider: "GELIVER", immutableLabelReferences: true }, occurredAt);
      }
      return this.getProviderBooking(bookingId);
    }).immediate();
  }

  cancelBeforeHandoff(input: { shipmentId: string; reason: string; operationId: string; actor: Actor; transport: CarrierBookingTransport; cancelledAt?: string }) {
    const shipmentId = text(input.shipmentId, "shipmentId");
    const reason = text(input.reason, "reason", 500);
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    const cancelledAt = input.cancelledAt ? instant(input.cancelledAt, "cancelledAt") : new Date().toISOString();
    this.assertShipmentAllowed(shipmentId);
    const shipment = this.requireShipment(shipmentId);
    if (["HANDED_OFF", "DISPATCHED"].includes(shipment.state)) {
      throw new ShipmentValidationError("RETURN_FLOW_REQUIRED", "After physical handoff, use the V2-10 return flow.", 409);
    }
    if (shipment.state === "CANCELLED") return shipment;
    const bookings = this.db.prepare("SELECT * FROM shipment_provider_bookings WHERE shipment_id=? ORDER BY package_id").all(shipmentId) as any[];
    const cancellations = [];
    if (bookings.length > 0) {
      if (!input.transport.enabled || !input.transport.cancelShipment) {
        throw new ShipmentValidationError("PROVIDER_CANCELLATION_UNAVAILABLE", "Provider cancellation support is required for booked shipments.", 409);
      }
      for (const booking of bookings) cancellations.push(input.transport.cancelShipment({ providerShipmentId: booking.provider_shipment_id,
        requestIdentity: `cancel:${booking.request_identity}`, reason }));
    }
    return this.db.transaction(() => {
      const current = this.requireShipment(shipmentId);
      if (["HANDED_OFF", "DISPATCHED"].includes(current.state)) throw new ShipmentValidationError("RETURN_FLOW_REQUIRED", "After physical handoff, use the V2-10 return flow.", 409);
      this.db.prepare(`INSERT INTO shipment_cancellations
        (id,shipment_id,reason,provider_cancellation_ids_json,provider_provenance_json,operation_id,actor_id,cancelled_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), shipmentId, reason,
        stableJson(cancellations.map((item) => item.providerCancellationId)), stableJson(cancellations), operationId, actor.id, cancelledAt);
      this.db.prepare("UPDATE shipment_booking_jobs SET state='CANCELLED',updated_at=? WHERE shipment_id=? AND state IN ('PENDING','RETRY')")
        .run(cancelledAt, shipmentId);
      this.db.prepare(`UPDATE shipment_preparations SET state='CANCELLED',cancellation_operation_id=?,cancelled_at=?,version=version+1,updated_at=?
        WHERE id=?`).run(operationId, cancelledAt, cancelledAt, shipmentId);
      this.insertStateEvent(shipmentId, current.state, "CANCELLED", operationId, actor.id,
        { reason, providerCancellationCount: cancellations.length }, cancelledAt);
      return this.getShipment(shipmentId);
    }).immediate();
  }

  confirmHandoff(input: {
    shipmentId: string;
    handedOffAt: string;
    handoffEvidence: unknown;
    actualCharge?: { amountMinor: number; currency: string; provenance: unknown };
    operationId: string;
    actor: Actor;
  }) {
    const shipmentId = text(input.shipmentId, "shipmentId");
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    const handedOffAt = instant(input.handedOffAt, "handedOffAt");
    this.assertShipmentAllowed(shipmentId);
    if (input.handoffEvidence === undefined || input.handoffEvidence === null) {
      throw new ShipmentValidationError("HANDOFF_EVIDENCE_REQUIRED", "Confirmed physical carrier handoff requires evidence.", 409);
    }
    return this.db.transaction(() => {
      const shipment = this.getShipment(shipmentId);
      if (shipment.state !== "LABEL_READY") throw new ShipmentValidationError("HANDOFF_NOT_READY", "Every package must be booked with provider label provenance before handoff.", 409);
      if (shipment.packages.length !== shipment.packageCount || shipment.packages.some((pack: any) => !pack.booking || !pack.label)) {
        throw new ShipmentValidationError("HANDOFF_NOT_READY", "Every package requires booking and a provider-native label; tracking may arrive later.", 409);
      }
      this.db.prepare(`UPDATE shipment_preparations SET state='HANDED_OFF',handoff_operation_id=?,handed_off_at=?,version=version+1,updated_at=?
        WHERE id=? AND state='LABEL_READY'`).run(operationId, handedOffAt, handedOffAt, shipmentId);
      this.insertStateEvent(shipmentId, "LABEL_READY", "HANDED_OFF", operationId, actor.id, input.handoffEvidence, handedOffAt);
      const reservation = this.inventory.dispatchReservation({ reservationId: shipment.reservationId, shipmentId, dispatchedAt: handedOffAt, operationId });
      const financial = this.finance.finalizeDispatch({ reservationId: shipment.reservationId, operationId, actor, finalizedAt: handedOffAt });
      if (input.actualCharge) {
        const amountMinor = nonNegativeInteger(input.actualCharge.amountMinor, "actualCharge.amountMinor");
        const chargeCurrency = currency(input.actualCharge.currency);
        const provenance = { contract: "dsdst.shipping-actual-charge.v1", shipmentId, provider: "GELIVER",
          providerBookings: shipment.packages.map((pack: any) => ({ providerShipmentId: pack.booking.providerShipmentId,
            providerTransactionId: pack.booking.providerTransactionId })), source: input.actualCharge.provenance };
        const financeOperationId = `${operationId}:shipping-expense`;
        this.db.prepare(`INSERT INTO shipment_actual_charge_facts
          (id,shipment_id,amount_minor,currency,provenance_json,finance_operation_id,recorded_at)
          VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), shipmentId, amountMinor, chargeCurrency, stableJson(provenance), financeOperationId, handedOffAt);
        this.finance.recordExpenseFact({ saleId: shipment.orderId, category: "shipping", state: "KNOWN", amountMinor,
          currency: chargeCurrency, provenance, operationId: financeOperationId, actor, recordedAt: handedOffAt });
      }
      this.db.prepare(`UPDATE shipment_preparations SET state='DISPATCHED',dispatched_at=?,version=version+1,updated_at=?
        WHERE id=? AND state='HANDED_OFF'`).run(handedOffAt, handedOffAt, shipmentId);
      this.insertStateEvent(shipmentId, "HANDED_OFF", "DISPATCHED", operationId, actor.id,
        { inventoryReservationId: reservation.id, cogsState: financial?.state ?? null }, handedOffAt);
      const finalized = this.getShipment(shipmentId);
      const channelJob = this.enqueueV212Tracking(finalized, operationId, handedOffAt);
      const policy = this.notificationPolicy(finalized.sourceChannel);
      const outbox: OutboxMessage[] = [];
      if (channelJob) outbox.push({ topic: "channels", eventType: "channels.shipment.tracking-status.requested.v1",
        aggregateType: "shipment", aggregateId: shipmentId, payload: { shipment_id: shipmentId, channel_job_id: channelJob.id } });
      if (policy.emailEnabled || policy.smsEnabled) outbox.push({ topic: "customer-notifications", eventType: "customer.order.shipped.v1",
        aggregateType: "shipment", aggregateId: shipmentId, payload: {
          shipment_id: shipmentId,
          order_no: finalized.orderNumber,
          carrier: finalized.carrierSelection.carrierCode,
          tracking: finalized.packages.map((pack: any) => ({ package_number: pack.packageNumber, tracking_number: pack.booking.trackingNumber, tracking_url: pack.booking.trackingUrl })),
          package_count: finalized.packageCount,
          channels: [...(policy.emailEnabled ? ["EMAIL"] : []), ...(policy.smsEnabled ? ["SMS"] : [])],
        } });
      return { shipment: finalized, financial, channelJob, outbox };
    }).immediate();
  }

  setNotificationPolicy(input: { sourceChannel: string; emailEnabled: boolean; smsEnabled: boolean; operationId: string; actor: Actor; updatedAt?: string }) {
    const sourceChannel = text(input.sourceChannel, "sourceChannel", 100).toUpperCase();
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    const updatedAt = input.updatedAt ? instant(input.updatedAt, "updatedAt") : new Date().toISOString();
    this.db.prepare(`INSERT INTO shipment_notification_policies
      (source_channel,email_enabled,sms_enabled,updated_operation_id,updated_actor_id,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(source_channel) DO UPDATE SET email_enabled=excluded.email_enabled,sms_enabled=excluded.sms_enabled,
      updated_operation_id=excluded.updated_operation_id,updated_actor_id=excluded.updated_actor_id,updated_at=excluded.updated_at`)
      .run(sourceChannel, input.emailEnabled ? 1 : 0, input.smsEnabled ? 1 : 0, operationId, actor.id, updatedAt);
    return this.notificationPolicy(sourceChannel);
  }

  getShipment(shipmentIdValue: string): any {
    const shipmentId = text(shipmentIdValue, "shipmentId");
    const row = this.db.prepare(`SELECT s.*,o.order_code,o.platform FROM shipment_preparations s
      JOIN sales o ON o.id=s.order_id WHERE s.id=?`).get(shipmentId) as any;
    if (!row) throw new ShipmentValidationError("SHIPMENT_NOT_FOUND", "Shipment was not found.", 404);
    const liveSelection = this.db.prepare("SELECT * FROM geliver_offer_selections WHERE shipment_id=? ORDER BY selected_at,package_id LIMIT 1").get(shipmentId) as any;
    const selection = liveSelection || (row.carrier_selection_id ? this.db.prepare("SELECT * FROM shipment_carrier_selections WHERE id=?").get(row.carrier_selection_id) as any : null);
    const recipient = this.db.prepare("SELECT * FROM shipment_recipient_snapshots WHERE shipment_id=?").get(shipmentId) as any;
    const packages = (this.db.prepare("SELECT * FROM shipment_packages WHERE shipment_id=? ORDER BY package_number").all(shipmentId) as any[]).map((pack) => {
      const nativeBooking = this.db.prepare(`SELECT b.*,s.provider_code,s.provider_service_code FROM geliver_booking_facts b
        JOIN geliver_offer_selections s ON s.package_id=b.package_id WHERE b.package_id=?`).get(pack.id) as any;
      const nativeTracking = nativeBooking ? this.db.prepare(`SELECT * FROM geliver_tracking_observations
        WHERE provider_shipment_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 1`).get(nativeBooking.provider_shipment_id) as any : null;
      const nativeLabel = nativeBooking ? this.db.prepare(`SELECT * FROM geliver_label_observations
        WHERE provider_shipment_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 1`).get(nativeBooking.provider_shipment_id) as any : null;
      const booking = nativeBooking || this.db.prepare("SELECT * FROM shipment_provider_bookings WHERE package_id=?").get(pack.id) as any;
      const label = nativeLabel || this.db.prepare("SELECT * FROM shipment_labels WHERE package_id=?").get(pack.id) as any;
      return {
        id: pack.id, packageNumber: Number(pack.package_number), measurementSource: pack.measurement_source,
        dimensionsMm: { length: Number(pack.length_mm), width: Number(pack.width_mm), height: Number(pack.height_mm) },
        weightGrams: Number(pack.weight_grams), recipeVersionRef: pack.recipe_version_ref, recipeHash: pack.recipe_hash,
        contents: JSON.parse(pack.contents_snapshot_json), contentsHash: pack.contents_snapshot_hash,
        booking: booking ? { provider: "GELIVER", providerShipmentId: booking.provider_shipment_id,
          providerTransactionId: booking.provider_transaction_id || null,
          carrierCode: booking.provider_code || booking.carrier_code, serviceCode: booking.provider_service_code || booking.service_code,
          trackingNumber: nativeBooking ? nativeTracking?.tracking_number || null : booking.tracking_number,
          trackingUrl: nativeBooking ? nativeTracking?.tracking_url || null : booking.tracking_url,
          barcode: nativeBooking ? booking.barcode || null : null,
          providerResponseReference: nativeBooking ? `sha256:${booking.response_hash}` : booking.provider_response_reference } : null,
        label: label ? (nativeLabel ? { reference: nativeLabel.label_url, responsiveReference: nativeLabel.responsive_label_url,
          sha256: nativeLabel.artifact_sha256, mediaType: nativeLabel.label_file_type, providerNative: true }
          : { reference: label.label_reference, sha256: label.label_sha256, mediaType: label.media_type,
            widthMm: Number(label.width_mm), heightMm: Number(label.height_mm), dpi: Number(label.dpi), printerCompatibility: label.printer_compatibility }) : null,
      };
    });
    const requiredContents = (this.db.prepare(`SELECT l.product_id,l.quantity_base_int,l.base_uom_code_snapshot,
      p.sku,COALESCE(p.title,p.name,p.sku) AS title FROM inventory_reservation_lines l
      JOIN products p ON p.id=l.product_id WHERE l.reservation_id=? ORDER BY p.sku,l.product_id`).all(row.reservation_id) as any[])
      .map((line) => ({ productId: line.product_id, sku: line.sku, title: line.title,
        quantityBaseInt: Number(line.quantity_base_int), baseUomCode: line.base_uom_code_snapshot }));
    return {
      id: row.id, orderId: row.order_id, orderNumber: row.order_code, sourceChannel: row.platform || "DIRECT",
      reservationId: row.reservation_id, state: row.state as ShipmentState, packageCount: Number(row.package_count), packages, requiredContents,
      recipient: recipient ? { name: recipient.name, email: recipient.email, phone: recipient.phone, address1: recipient.address1,
        address2: recipient.address2, countryCode: recipient.country_code, cityName: recipient.city_name, cityCode: recipient.city_code,
        districtName: recipient.district_name, districtID: recipient.district_id, zip: recipient.zip } : null,
      carrierSelection: selection ? (liveSelection ? { id: selection.id, provider: "GELIVER", carrierCode: selection.provider_code,
        serviceCode: selection.provider_service_code, quote: { id: selection.offer_id, amount: selection.quote_amount,
          currency: selection.quote_currency, provenance: { responseHash: selection.quote_response_hash, source: "GELIVER_LIVE_OFFER" } }, selectedAt: selection.selected_at }
        : { id: selection.id, provider: selection.provider, carrierCode: selection.carrier_code,
          serviceCode: selection.service_code, quote: { id: selection.quote_id, amountMinor: Number(selection.quote_amount_minor),
            currency: selection.quote_currency, provenance: JSON.parse(selection.quote_provenance_json) }, selectedAt: selection.selected_at }) : null,
      handedOffAt: row.handed_off_at, dispatchedAt: row.dispatched_at, cancelledAt: row.cancelled_at, version: Number(row.version),
    };
  }

  getShipmentForReservation(reservationIdValue: string) {
    const reservationId = text(reservationIdValue, "reservationId");
    const row = this.db.prepare("SELECT id FROM shipment_preparations WHERE reservation_id=?").get(reservationId) as any;
    if (!row) throw new ShipmentValidationError("SHIPMENT_NOT_FOUND", "Shipment was not found.", 404);
    return this.getShipment(row.id);
  }

  publishV212TrackingRefresh(shipmentIdValue: string, occurredAt = new Date().toISOString()) {
    const shipment = this.getShipment(shipmentIdValue);
    if (shipment.state !== "DISPATCHED") return null;
    const trackingIdentity = digest(shipment.packages.map((pack: any) => ({ packageNumber: pack.packageNumber,
      trackingNumber: pack.booking?.trackingNumber || null, trackingUrl: pack.booking?.trackingUrl || null })));
    return this.enqueueV212Tracking(shipment, `geliver-tracking:${trackingIdentity}`, occurredAt);
  }

  private requireShipment(shipmentId: string) {
    return this.db.prepare("SELECT * FROM shipment_preparations WHERE id=?").get(shipmentId) as any
      || (() => { throw new ShipmentValidationError("SHIPMENT_NOT_FOUND", "Shipment was not found.", 404); })();
  }

  private getBookingJob(jobId: string) {
    const row = this.db.prepare("SELECT * FROM shipment_booking_jobs WHERE id=?").get(jobId) as any;
    if (!row) throw new ShipmentValidationError("BOOKING_JOB_NOT_FOUND", "Booking job was not found.", 404);
    return { id: row.id, shipmentId: row.shipment_id, packageId: row.package_id, provider: row.provider,
      requestIdentity: row.request_identity, requestHash: row.request_hash, state: row.state, attemptCount: Number(row.attempt_count) };
  }

  private getProviderBooking(bookingId: string) {
    const row = this.db.prepare("SELECT * FROM shipment_provider_bookings WHERE id=?").get(bookingId) as any;
    return { id: row.id, shipmentId: row.shipment_id, packageId: row.package_id, provider: row.provider,
      providerShipmentId: row.provider_shipment_id, providerTransactionId: row.provider_transaction_id,
      carrierCode: row.carrier_code, serviceCode: row.service_code, trackingNumber: row.tracking_number,
      trackingUrl: row.tracking_url, requestIdentity: row.request_identity, bookedAt: row.booked_at };
  }

  private validateBookingResult(result: CarrierBookingResult, request: any) {
    if (!result || typeof result !== "object") throw new ShipmentValidationError("PROVIDER_RESPONSE_INVALID", "Provider booking response is invalid.", 502);
    text(result.providerShipmentId, "providerShipmentId", 300);
    text(result.providerResponseReference, "providerResponseReference", 1000);
    if (text(result.carrierCode, "carrierCode", 100) !== request.carrierCode || text(result.serviceCode, "serviceCode", 100) !== request.serviceCode) {
      throw new ShipmentValidationError("PROVIDER_SELECTION_MISMATCH", "Provider booking does not match the selected carrier/service.", 502);
    }
    if (!result.label || result.label.widthMm !== 100 || result.label.heightMm !== 150 || result.label.dpi !== 203) {
      throw new ShipmentValidationError("PROVIDER_LABEL_CONTRACT_MISMATCH", "Provider label must be exactly 100x150 mm at 203 dpi.", 502);
    }
    text(result.label.reference, "label.reference", 1000);
    text(result.trackingNumber, "trackingNumber", 300);
    if (!/^[a-f0-9]{64}$/i.test(result.label.sha256)) throw new ShipmentValidationError("PROVIDER_LABEL_CONTRACT_MISMATCH", "Provider label hash must be SHA-256.", 502);
    text(result.label.mediaType, "label.mediaType", 100);
  }

  private insertStateEvent(shipmentId: string, from: ShipmentState | null, to: ShipmentState, operationId: string, actorId: string, evidence: unknown, occurredAt: string) {
    this.db.prepare(`INSERT INTO shipment_state_events
      (id,shipment_id,from_state,to_state,operation_id,actor_id,evidence_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), shipmentId, from, to, operationId, actorId, stableJson(evidence), occurredAt);
  }

  private resolveRecipe(orderId: string, packageNumber: number): RecipeMeasurement | null {
    const rows = this.db.prepare(`SELECT p.length_mm,p.width_mm,p.height_mm,p.target_weight_grams,
        s.published_kit_version_id,s.content_hash
      FROM sale_financial_snapshots f
      JOIN sale_financial_lines l ON l.financial_snapshot_id=f.id
      JOIN sale_kit_version_snapshots s ON s.financial_line_id=l.id
      JOIN published_kit_version_packages p ON p.published_kit_version_id=s.published_kit_version_id
      WHERE f.sale_id=? AND p.package_number=?`).all(orderId, packageNumber) as any[];
    if (rows.length !== 1) return null;
    const row = rows[0];
    if (![row.length_mm, row.width_mm, row.height_mm, row.target_weight_grams].every((value) => Number.isSafeInteger(value) && Number(value) > 0)) return null;
    return { lengthMm: Number(row.length_mm), widthMm: Number(row.width_mm), heightMm: Number(row.height_mm),
      weightGrams: Number(row.target_weight_grams), recipeVersionRef: `published-kit-version:${row.published_kit_version_id}`,
      recipeHash: row.content_hash };
  }

  private notificationPolicy(sourceChannel: string) {
    const key = String(sourceChannel || "DIRECT").trim().toUpperCase();
    const row = this.db.prepare("SELECT * FROM shipment_notification_policies WHERE source_channel=?").get(key) as any;
    return { sourceChannel: key, emailEnabled: row ? Boolean(row.email_enabled) : true, smsEnabled: row ? Boolean(row.sms_enabled) : false };
  }

  private enqueueV212Tracking(shipment: any, operationId: string, occurredAt: string) {
    const channelOrder = this.db.prepare(`SELECT o.id,o.account_id FROM channel_orders o WHERE o.sale_id=? ORDER BY o.id LIMIT 1`).get(shipment.orderId) as any;
    if (!channelOrder) return null;
    const payload = { contract: "dsdst.channel-shipment-projection.v1", shipmentId: shipment.id, orderId: shipment.orderId,
      status: "DISPATCHED", carrier: shipment.carrierSelection.carrierCode, service: shipment.carrierSelection.serviceCode,
      packageCount: shipment.packageCount, packages: shipment.packages.map((pack: any) => ({ packageNumber: pack.packageNumber,
        trackingNumber: pack.booking.trackingNumber, trackingUrl: pack.booking.trackingUrl })) };
    const payloadHash = digest(payload);
    // The canonical projection content, rather than the triggering command, is the
    // publication version. Handoff and refresh replays therefore converge, while a
    // later tracking observation produces a distinct version.
    const sourceVersion = `shipment:v3:${payloadHash}`;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO channel_shipment_outbound_jobs
      (id,account_id,shipment_id,channel_order_id,job_kind,source_version,payload_json,payload_hash,state,created_operation_id,available_at)
      VALUES (?,?,?,?,'TRACKING_STATUS',?,?,?,'PENDING',?,?)
      ON CONFLICT(account_id,shipment_id,job_kind,source_version) DO NOTHING`).run(id, channelOrder.account_id, shipment.id,
      channelOrder.id, sourceVersion, stableJson(payload), payloadHash, operationId, occurredAt);
    return this.db.prepare(`SELECT id,account_id AS accountId,shipment_id AS shipmentId,state,payload_json AS payloadJson
      FROM channel_shipment_outbound_jobs WHERE account_id=? AND shipment_id=? AND source_version=?`)
      .get(channelOrder.account_id, shipment.id, sourceVersion) as any;
  }
}
