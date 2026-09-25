import { createHash, randomUUID } from "node:crypto";
import { GeliverClient, GeliverError, type Offer, type Shipment, type Transaction } from "@geliver/sdk";
import type Database from "better-sqlite3";
import { ShipmentValidationError } from "./shipmentService.js";
import { ReconciliationScopeGuard } from "../reconciliation/reconciliationGuard.js";

type Actor = { id: string; name?: string | null };
type GeliverCreateRequest = {
  senderAddressID: string;
  recipientAddress: RecipientInput;
  length: string; width: string; height: string; distanceUnit: "cm";
  weight: string; massUnit: "kg"; productPaymentOnDelivery: false;
  order: { sourceCode: "SDK"; sourceIdentifier: string; orderNumber: string; totalAmount?: string; totalAmountCurrency?: string };
};
export type RecipientInput = {
  name: string; email: string; phone?: string | null; address1: string; address2?: string | null;
  countryCode: string; cityName: string; cityCode: string; districtName: string; districtID?: string | number | null; zip?: string | null;
};

const canonical = (value: any): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const required = (value: unknown, field: string, max = 500): string => {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new ShipmentValidationError("SHIPMENT_VALIDATION_FAILED", `${field} is invalid.`);
  }
  return result;
};
const optional = (value: unknown, field: string, max = 500): string | null => value == null || value === "" ? null : required(value, field, max);
const optionalInteger = (value: unknown, field: string): number | undefined => {
  if (value == null || value === "") return undefined;
  const source = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(source)) throw new ShipmentValidationError("SHIPMENT_VALIDATION_FAILED", `${field} is invalid.`);
  const result = Number(source);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new ShipmentValidationError("SHIPMENT_VALIDATION_FAILED", `${field} is invalid.`);
  }
  return result;
};
const at = () => new Date().toISOString();
const money = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

export const VERIFIED_GELIVER_CONTRACT = {
  contract: "dsdst.carrier-adapter.geliver.v2",
  provider: "GELIVER",
  verifiedAt: "2026-09-23",
  sdk: "@geliver/sdk@1.3.0",
  officialDocumentation: "https://docs.geliver.io",
  officialSdk: "https://github.com/GeliverApp/geliver-js",
  semantics: ["shipments.create", "shipments.list(orderNumber)", "shipments.get", "transactions.acceptOffer", "shipments.cancel"],
  providerIdempotencyDocumented: false,
  automaticUncertainMutationRetry: false,
  trackingMayArriveLater: true,
  providerNativeLabel: true,
} as const;

export interface GeliverTransport {
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  create(body: GeliverCreateRequest): Promise<Shipment>;
  listByOrderNumber(orderNumber: string): Promise<Shipment[]>;
  get(providerShipmentId: string): Promise<Shipment>;
  acceptOffer(offerId: string): Promise<Transaction>;
  cancel(providerShipmentId: string): Promise<Shipment>;
  downloadLabel(url: string): Promise<Uint8Array>;
}

export class GeliverSdkTransport implements GeliverTransport {
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  private readonly client: GeliverClient | null;
  readonly senderAddressId: string | null;
  readonly sourceIdentifier: string | null;
  readonly mode: "test" | "live";

  constructor(config: { token?: string; senderAddressId?: string; sourceIdentifier?: string; baseUrl?: string; timeoutMs?: number; mode?: string } = {}) {
    const token = config.token?.trim() || "";
    this.mode = config.mode?.trim().toLowerCase() === "live" ? "live" : "test";
    this.senderAddressId = config.senderAddressId?.trim() || null;
    this.sourceIdentifier = config.sourceIdentifier?.trim() || null;
    this.enabled = Boolean(token && this.senderAddressId && this.sourceIdentifier);
    this.disabledReason = this.enabled ? null : "GELIVER_TOKEN, GELIVER_SENDER_ADDRESS_ID and GELIVER_SOURCE_IDENTIFIER are required.";
    this.client = this.enabled ? new GeliverClient({ token, baseUrl: config.baseUrl?.trim() || undefined,
      timeoutMs: config.timeoutMs || 20_000, maxRetries: 0, userAgent: "DSDST-Panel/V2-13" }) : null;
  }
  static fromEnvironment() {
    return new GeliverSdkTransport({ token: process.env.GELIVER_TOKEN, senderAddressId: process.env.GELIVER_SENDER_ADDRESS_ID,
      sourceIdentifier: process.env.GELIVER_SOURCE_IDENTIFIER, baseUrl: process.env.GELIVER_API_BASE_URL,
      timeoutMs: process.env.GELIVER_TIMEOUT_MS ? Number(process.env.GELIVER_TIMEOUT_MS) : undefined,
      mode: process.env.GELIVER_MODE });
  }
  private api() {
    if (!this.client) throw new ShipmentValidationError("GELIVER_TRANSPORT_DISABLED", this.disabledReason || "Geliver transport is disabled.", 503);
    return this.client;
  }
  create(body: GeliverCreateRequest) {
    return this.mode === "test"
      ? this.api().shipments.createTest(body)
      : this.api().shipments.create(body);
  }
  async listByOrderNumber(orderNumber: string) { return (await this.api().shipments.list({ orderNumber, limit: 50, page: 1 })).data; }
  get(providerShipmentId: string) { return this.api().shipments.get(providerShipmentId); }
  acceptOffer(offerId: string) { return this.api().transactions.acceptOffer(offerId); }
  cancel(providerShipmentId: string) { return this.api().shipments.cancel(providerShipmentId); }
  downloadLabel(url: string) { return this.api().shipments.downloadLabelByUrl(url); }
}

export class DisabledGeliverTransport implements GeliverTransport {
  readonly enabled = false;
  readonly disabledReason = "Geliver live configuration is incomplete.";
  private fail(): never { throw new ShipmentValidationError("GELIVER_TRANSPORT_DISABLED", this.disabledReason, 503); }
  create(): Promise<Shipment> { return Promise.reject(this.fail()); }
  listByOrderNumber(): Promise<Shipment[]> { return Promise.reject(this.fail()); }
  get(): Promise<Shipment> { return Promise.reject(this.fail()); }
  acceptOffer(): Promise<Transaction> { return Promise.reject(this.fail()); }
  cancel(): Promise<Shipment> { return Promise.reject(this.fail()); }
  downloadLabel(): Promise<Uint8Array> { return Promise.reject(this.fail()); }
}

const errorInfo = (error: unknown) => {
  const status = error instanceof GeliverError ? error.status : Number((error as any)?.status || 0);
  const code = optional((error as any)?.code, "providerErrorCode", 100) || (status ? `HTTP_${status}` : "GELIVER_OUTCOME_UNCERTAIN");
  const definitive = status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
  return { code, definitive };
};

export class GeliverFlowService {
  private readonly reconciliationGuard: ReconciliationScopeGuard;
  constructor(private readonly db: Database.Database, private readonly transport: GeliverTransport,
    private readonly config: { senderAddressId: string | null; sourceIdentifier: string | null }) {
    this.reconciliationGuard = new ReconciliationScopeGuard(db);
  }

  private assertShipmentAllowed(shipmentId: string) {
    const error = (message: string) => new ShipmentValidationError("RECONCILIATION_SCOPE_BLOCKED", message, 409);
    this.reconciliationGuard.assertOrderForShipment(shipmentId, error);
    this.reconciliationGuard.assertShipmentSkus(shipmentId, error);
  }

  contract() { return { ...VERIFIED_GELIVER_CONTRACT, enabled: this.transport.enabled, disabledReason: this.transport.disabledReason }; }

  prepareCreateJobs(input: { shipmentId: string; recipient?: RecipientInput | null; operationId: string; actor: Actor; requestedAt?: string }) {
    if (!this.transport.enabled) throw new ShipmentValidationError("GELIVER_TRANSPORT_DISABLED", this.transport.disabledReason || "Geliver is disabled.", 503);
    const senderAddressID = required(this.config.senderAddressId, "GELIVER_SENDER_ADDRESS_ID", 300);
    const sourceIdentifier = required(this.config.sourceIdentifier, "GELIVER_SOURCE_IDENTIFIER", 500);
    const shipmentId = required(input.shipmentId, "shipmentId", 200);
    this.assertShipmentAllowed(shipmentId);
    const operationId = required(input.operationId, "operationId", 200);
    const actorId = required(input.actor.id, "actor.id", 200);
    const requestedAt = input.requestedAt || at();
    const recipient = this.recipient(input.recipient ?? this.recipientFromChannelOrder(shipmentId));
    return this.db.transaction(() => {
      const shipment = this.db.prepare(`SELECT p.*,s.order_code,f.currency,f.gross_amount_minor
        FROM shipment_preparations p JOIN sales s ON s.id=p.order_id
        LEFT JOIN sale_financial_snapshots f ON f.sale_id=p.order_id WHERE p.id=?`).get(shipmentId) as any;
      if (!shipment) throw new ShipmentValidationError("SHIPMENT_NOT_FOUND", "Shipment was not found.", 404);
      if (shipment.state !== "PREPARING") {
        const existing = this.db.prepare("SELECT id FROM geliver_create_jobs WHERE shipment_id=? ORDER BY id").all(shipmentId) as any[];
        if (existing.length) return existing.map((row) => this.job(row.id));
        throw new ShipmentValidationError("SHIPMENT_STATE_CONFLICT", "Geliver shipment creation requires PREPARING state.", 409);
      }
      const packages = this.db.prepare("SELECT * FROM shipment_packages WHERE shipment_id=? ORDER BY package_number").all(shipmentId) as any[];
      if (!packages.length || packages.length !== Number(shipment.package_count)) {
        throw new ShipmentValidationError("PACKAGE_DATA_REQUIRED", "Complete package measurements are required before Geliver creation.", 409);
      }
      const priorRecipient = this.db.prepare("SELECT snapshot_hash FROM shipment_recipient_snapshots WHERE shipment_id=?").get(shipmentId) as any;
      const recipientHash = hash(recipient);
      if (priorRecipient && priorRecipient.snapshot_hash !== recipientHash) throw new ShipmentValidationError("RECIPIENT_SNAPSHOT_CONFLICT", "Recipient snapshot is immutable.", 409);
      if (!priorRecipient) this.db.prepare(`INSERT INTO shipment_recipient_snapshots
        (id,shipment_id,name,email,phone,address1,address2,country_code,city_name,city_code,district_name,district_id,zip,snapshot_hash,created_operation_id,created_actor_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), shipmentId, recipient.name, recipient.email, recipient.phone,
        recipient.address1, recipient.address2, recipient.countryCode, recipient.cityName, recipient.cityCode, recipient.districtName,
        recipient.districtID, recipient.zip, recipientHash, operationId, actorId, requestedAt);
      for (const pack of packages) {
        const providerOrderNumber = `${shipment.order_code}-P${pack.package_number}-${hash(pack.id).slice(0, 8)}`;
        const request: GeliverCreateRequest = {
          senderAddressID,
          recipientAddress: recipient,
          length: (Number(pack.length_mm) / 10).toString(), width: (Number(pack.width_mm) / 10).toString(),
          height: (Number(pack.height_mm) / 10).toString(), distanceUnit: "cm",
          weight: (Number(pack.weight_grams) / 1000).toString(), massUnit: "kg", productPaymentOnDelivery: false,
          order: { sourceCode: "SDK", sourceIdentifier, orderNumber: providerOrderNumber,
            ...(Number.isSafeInteger(shipment.gross_amount_minor) ? { totalAmount: money(Number(shipment.gross_amount_minor)), totalAmountCurrency: shipment.currency } : {}) },
        };
        const requestIdentity = `geliver:create:${shipmentId}:${pack.id}`;
        this.db.prepare(`INSERT INTO geliver_create_jobs
          (id,shipment_id,package_id,request_identity,provider_order_number,request_json,request_hash,state,created_operation_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'PENDING',?,?,?) ON CONFLICT(package_id) DO NOTHING`).run(randomUUID(), shipmentId, pack.id,
          requestIdentity, providerOrderNumber, canonical(request), hash(request), operationId, requestedAt, requestedAt);
      }
      return (this.db.prepare("SELECT id FROM geliver_create_jobs WHERE shipment_id=? ORDER BY provider_order_number").all(shipmentId) as any[])
        .map((row) => this.job(row.id));
    }).immediate();
  }

  async processCreateJob(jobIdValue: string) {
    const jobId = required(jobIdValue, "jobId", 200);
    const job = this.db.prepare("SELECT * FROM geliver_create_jobs WHERE id=?").get(jobId) as any;
    if (!job) throw new ShipmentValidationError("GELIVER_CREATE_JOB_NOT_FOUND", "Geliver create job was not found.", 404);
    this.assertShipmentAllowed(job.shipment_id);
    const bound = this.db.prepare("SELECT provider_shipment_id FROM geliver_provider_shipments WHERE create_job_id=?").get(jobId) as any;
    if (bound) return this.refreshProviderShipment(bound.provider_shipment_id);
    if (job.state === "RECONCILE_REQUIRED" || job.state === "PROCESSING") return this.reconcileCreate(job);
    if (job.state !== "PENDING") throw new ShipmentValidationError("GELIVER_CREATE_STATE_CONFLICT", "Geliver create job cannot run.", 409);
    const startedAt = at();
    const attemptId = randomUUID();
    this.db.transaction(() => {
      this.db.prepare("UPDATE geliver_create_jobs SET state='PROCESSING',attempt_count=attempt_count+1,updated_at=? WHERE id=? AND state='PENDING'").run(startedAt, jobId);
      this.db.prepare(`INSERT INTO geliver_create_attempts (id,job_id,attempt_number,state,started_at)
        SELECT ?,?,attempt_count,'STARTED',? FROM geliver_create_jobs WHERE id=?`).run(attemptId, jobId, startedAt, jobId);
    }).immediate();
    try {
      const response = await this.transport.create(JSON.parse(job.request_json));
      return this.bindCreated(jobId, response, "CREATE_RESPONSE", attemptId);
    } catch (error) {
      const info = errorInfo(error);
      this.db.transaction(() => {
        this.db.prepare("UPDATE geliver_create_attempts SET state=?,error_code=?,completed_at=? WHERE id=?")
          .run(info.definitive ? "DEFINITIVE_FAILURE" : "UNCERTAIN", info.code, at(), attemptId);
        this.db.prepare("UPDATE geliver_create_jobs SET state=?,last_error_code=?,updated_at=? WHERE id=?")
          .run(info.definitive ? "DEFINITIVE_FAILURE" : "RECONCILE_REQUIRED", info.code, at(), jobId);
      }).immediate();
      throw error;
    }
  }

  private async reconcileCreate(job: any) {
    const matches = (await this.transport.listByOrderNumber(job.provider_order_number))
      .filter((shipment) => shipment.order?.orderNumber === job.provider_order_number);
    this.db.prepare("UPDATE geliver_create_jobs SET reconciliation_count=reconciliation_count+1,updated_at=? WHERE id=?").run(at(), job.id);
    if (matches.length === 1) return this.bindCreated(job.id, matches[0], "ORDER_NUMBER_RECONCILIATION", null);
    if (matches.length > 1) throw new ShipmentValidationError("GELIVER_DUPLICATE_PROVIDER_SHIPMENT", "More than one Geliver shipment has the request orderNumber.", 502);
    throw new ShipmentValidationError("GELIVER_CREATE_RECONCILIATION_PENDING", "No exact Geliver orderNumber match was found; create will not be retried automatically.", 409);
  }

  private bindCreated(jobId: string, shipment: Shipment, source: "CREATE_RESPONSE" | "ORDER_NUMBER_RECONCILIATION", attemptId: string | null) {
    const providerId = required(shipment.id, "providerShipment.id", 300);
    const expectedOrderNumber = (this.db.prepare("SELECT provider_order_number FROM geliver_create_jobs WHERE id=?").pluck().get(jobId) as string);
    if (shipment.order?.orderNumber && shipment.order.orderNumber !== expectedOrderNumber) {
      throw new ShipmentValidationError("GELIVER_CREATE_RESPONSE_MISMATCH", "Geliver response orderNumber does not match the durable request identity.", 502);
    }
    const responseHash = hash(shipment);
    const now = at();
    this.db.transaction(() => {
      const job = this.db.prepare("SELECT * FROM geliver_create_jobs WHERE id=?").get(jobId) as any;
      this.db.prepare(`INSERT INTO geliver_provider_shipments
        (id,shipment_id,package_id,create_job_id,provider_shipment_id,provider_order_number,barcode,accepted_offer_id,provider_state_code,response_hash,source,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(create_job_id) DO NOTHING`).run(randomUUID(), job.shipment_id, job.package_id,
        job.id, providerId, job.provider_order_number, optional(shipment.barcode, "barcode", 300), optional(shipment.acceptedOfferID, "acceptedOfferID", 300),
        optional(shipment.statusCode, "statusCode", 100), responseHash, source, now);
      this.db.prepare("UPDATE geliver_create_jobs SET state='CREATED',updated_at=? WHERE id=?").run(now, jobId);
      if (attemptId) this.db.prepare("UPDATE geliver_create_attempts SET state='SUCCEEDED',response_hash=?,completed_at=? WHERE id=?")
        .run(responseHash, now, attemptId);
      else this.db.prepare(`INSERT INTO geliver_create_attempts (id,job_id,attempt_number,state,response_hash,started_at,completed_at)
        SELECT ?,?,attempt_count+1,'RECONCILED',?,?,? FROM geliver_create_jobs WHERE id=?`).run(randomUUID(), jobId, responseHash, now, now, jobId);
      this.observe(job.shipment_id, providerId, shipment, now);
    }).immediate();
    return this.viewProviderShipment(providerId);
  }

  async refreshShipment(shipmentIdValue: string) {
    const shipmentId = required(shipmentIdValue, "shipmentId", 200);
    const rows = this.db.prepare("SELECT provider_shipment_id FROM geliver_provider_shipments WHERE shipment_id=? ORDER BY package_id").all(shipmentId) as any[];
    if (!rows.length) throw new ShipmentValidationError("GELIVER_SHIPMENT_NOT_CREATED", "Create Geliver shipments before refreshing offers.", 409);
    for (const row of rows) await this.refreshProviderShipment(row.provider_shipment_id);
    return this.getLiveState(shipmentId);
  }

  private async refreshProviderShipment(providerShipmentId: string) {
    const response = await this.transport.get(providerShipmentId);
    const artifactHash = await this.labelArtifactHash(response);
    const parent = this.db.prepare("SELECT shipment_id FROM geliver_provider_shipments WHERE provider_shipment_id=?").get(providerShipmentId) as any;
    if (!parent) throw new ShipmentValidationError("GELIVER_PROVIDER_SHIPMENT_NOT_BOUND", "Geliver shipment is not bound locally.", 409);
    this.db.transaction(() => { this.observe(parent.shipment_id, providerShipmentId, response, at(), artifactHash); this.reconcileAccepted(response, providerShipmentId, artifactHash); }).immediate();
    return this.viewProviderShipment(providerShipmentId);
  }

  selectOffer(input: { shipmentId: string; offerId: string; operationId: string; actor: Actor; selectedAt?: string }) {
    const shipmentId = required(input.shipmentId, "shipmentId", 200);
    this.assertShipmentAllowed(shipmentId);
    const offerId = required(input.offerId, "offerId", 300);
    const operationId = required(input.operationId, "operationId", 200);
    const actorId = required(input.actor.id, "actor.id", 200);
    const selectedAt = input.selectedAt || at();
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM geliver_offer_selections WHERE selected_operation_id=?").get(operationId) as any;
      if (existing) return this.acceptJobBySelection(existing.id);
      const offer = this.db.prepare(`SELECT o.*,p.shipment_id,p.package_id FROM geliver_offer_observations o
        JOIN geliver_provider_shipments p ON p.provider_shipment_id=o.provider_shipment_id
        WHERE p.shipment_id=? AND o.offer_id=? ORDER BY o.observed_at DESC LIMIT 1`).get(shipmentId, offerId) as any;
      if (!offer) throw new ShipmentValidationError("GELIVER_OFFER_NOT_FOUND", "Select an observed live Geliver offer.", 404);
      if (this.db.prepare("SELECT 1 FROM geliver_offer_selections WHERE package_id=?").get(offer.package_id)) {
        throw new ShipmentValidationError("GELIVER_OFFER_ALREADY_SELECTED", "This package already has an immutable offer selection.", 409);
      }
      const selectionId = randomUUID();
      this.db.prepare(`INSERT INTO geliver_offer_selections
        (id,shipment_id,package_id,provider_shipment_id,offer_id,provider_code,provider_service_code,quote_amount,quote_currency,
         quote_response_hash,selected_operation_id,selected_actor_id,selected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(selectionId,
        shipmentId, offer.package_id, offer.provider_shipment_id, offer.offer_id, offer.provider_code, offer.provider_service_code,
        offer.amount, offer.currency, offer.response_hash, operationId, actorId, selectedAt);
      const jobId = randomUUID();
      const requestIdentity = `geliver:accept:${offer.provider_shipment_id}:${offer.offer_id}`;
      this.db.prepare(`INSERT INTO geliver_accept_jobs
        (id,shipment_id,package_id,selection_id,request_identity,request_hash,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'PENDING',?,?)`).run(jobId, shipmentId, offer.package_id, selectionId, requestIdentity,
        hash({ offerId, providerShipmentId: offer.provider_shipment_id }), selectedAt, selectedAt);
      const selected = Number(this.db.prepare("SELECT COUNT(*) FROM geliver_offer_selections WHERE shipment_id=?").pluck().get(shipmentId));
      const packageCount = Number(this.db.prepare("SELECT package_count FROM shipment_preparations WHERE id=?").pluck().get(shipmentId));
      if (selected === packageCount) this.advanceState(shipmentId, "PREPARING", "CARRIER_SELECTED", operationId, actorId,
        { provider: "GELIVER", selectionType: "LIVE_OFFER", packageCount }, selectedAt);
      return this.jobAccept(jobId);
    }).immediate();
  }

  async processAcceptJob(jobIdValue: string) {
    const jobId = required(jobIdValue, "jobId", 200);
    const job = this.db.prepare(`SELECT j.*,s.offer_id,s.provider_shipment_id FROM geliver_accept_jobs j
      JOIN geliver_offer_selections s ON s.id=j.selection_id WHERE j.id=?`).get(jobId) as any;
    if (!job) throw new ShipmentValidationError("GELIVER_ACCEPT_JOB_NOT_FOUND", "Geliver accept job was not found.", 404);
    this.assertShipmentAllowed(job.shipment_id);
    const fact = this.db.prepare("SELECT id FROM geliver_booking_facts WHERE accept_job_id=?").get(jobId) as any;
    if (fact) return this.viewProviderShipment(job.provider_shipment_id);
    if (job.state === "RECONCILE_REQUIRED" || job.state === "PROCESSING") {
      const response = await this.transport.get(job.provider_shipment_id);
      this.db.prepare("UPDATE geliver_accept_jobs SET reconciliation_count=reconciliation_count+1,updated_at=? WHERE id=?").run(at(), jobId);
      if (response.acceptedOfferID === job.offer_id) return this.bindAccepted(job, null, response, "SHIPMENT_RECONCILIATION", null,
        await this.labelArtifactHash(response));
      throw new ShipmentValidationError("GELIVER_ACCEPT_RECONCILIATION_PENDING", "Offer acceptance is not confirmed; acceptOffer will not be retried automatically.", 409);
    }
    if (job.state !== "PENDING") throw new ShipmentValidationError("GELIVER_ACCEPT_STATE_CONFLICT", "Geliver accept job cannot run.", 409);
    const attemptId = randomUUID(); const now = at();
    this.db.transaction(() => {
      this.db.prepare("UPDATE geliver_accept_jobs SET state='PROCESSING',attempt_count=attempt_count+1,updated_at=? WHERE id=?").run(now, jobId);
      this.db.prepare(`INSERT INTO geliver_accept_attempts (id,job_id,attempt_number,state,started_at)
        SELECT ?,?,attempt_count,'STARTED',? FROM geliver_accept_jobs WHERE id=?`).run(attemptId, jobId, now, jobId);
    }).immediate();
    try {
      const transaction = await this.transport.acceptOffer(job.offer_id);
      if (transaction.offerID && transaction.offerID !== job.offer_id) throw new ShipmentValidationError("GELIVER_ACCEPT_RESPONSE_MISMATCH", "Geliver accepted a different offer.", 502);
      const response = transaction.shipment || await this.transport.get(job.provider_shipment_id);
      return this.bindAccepted(job, transaction, response, "ACCEPT_RESPONSE", attemptId, await this.labelArtifactHash(response));
    } catch (error) {
      const info = errorInfo(error);
      this.db.transaction(() => {
        this.db.prepare("UPDATE geliver_accept_attempts SET state=?,error_code=?,completed_at=? WHERE id=?")
          .run(info.definitive ? "DEFINITIVE_FAILURE" : "UNCERTAIN", info.code, at(), attemptId);
        this.db.prepare("UPDATE geliver_accept_jobs SET state=?,last_error_code=?,updated_at=? WHERE id=?")
          .run(info.definitive ? "DEFINITIVE_FAILURE" : "RECONCILE_REQUIRED", info.code, at(), jobId);
      }).immediate();
      throw error;
    }
  }

  private bindAccepted(job: any, transaction: Transaction | null, response: Shipment,
    source: "ACCEPT_RESPONSE" | "SHIPMENT_RECONCILIATION", attemptId: string | null, artifactHash: string | null) {
    if (response.id && response.id !== job.provider_shipment_id) throw new ShipmentValidationError("GELIVER_ACCEPT_RESPONSE_MISMATCH", "Geliver shipment identity changed.", 502);
    const responseHash = hash({ transaction, shipment: response }); const now = at();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO geliver_booking_facts
        (id,shipment_id,package_id,accept_job_id,provider_shipment_id,provider_transaction_id,offer_id,barcode,response_hash,source,booked_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(accept_job_id) DO NOTHING`).run(randomUUID(), job.shipment_id, job.package_id,
        job.id, job.provider_shipment_id, transaction?.id || null, job.offer_id, optional(response.barcode, "barcode", 300), responseHash, source, now);
      this.db.prepare("UPDATE geliver_accept_jobs SET state='ACCEPTED',updated_at=? WHERE id=?").run(now, job.id);
      if (attemptId) this.db.prepare("UPDATE geliver_accept_attempts SET state='SUCCEEDED',response_hash=?,completed_at=? WHERE id=?").run(responseHash, now, attemptId);
      else this.db.prepare(`INSERT INTO geliver_accept_attempts (id,job_id,attempt_number,state,response_hash,started_at,completed_at)
        SELECT ?,?,attempt_count+1,'RECONCILED',?,?,? FROM geliver_accept_jobs WHERE id=?`).run(randomUUID(), job.id, responseHash, now, now, job.id);
      this.observe(job.shipment_id, job.provider_shipment_id, response, now, artifactHash);
      this.advanceReadiness(job.shipment_id, now);
    }).immediate();
    return this.viewProviderShipment(job.provider_shipment_id);
  }

  async cancelBeforeHandoff(input: { shipmentId: string; operationId: string; actor: Actor; reason: string; cancelledAt?: string }) {
    const shipmentId = required(input.shipmentId, "shipmentId", 200); const operationId = required(input.operationId, "operationId", 200);
    const actorId = required(input.actor.id, "actor.id", 200); const reason = required(input.reason, "reason", 500); const cancelledAt = input.cancelledAt || at();
    const state = this.db.prepare("SELECT state FROM shipment_preparations WHERE id=?").get(shipmentId) as any;
    if (!state) throw new ShipmentValidationError("SHIPMENT_NOT_FOUND", "Shipment was not found.", 404);
    if (["HANDED_OFF", "DISPATCHED"].includes(state.state)) throw new ShipmentValidationError("RETURN_FLOW_REQUIRED", "After handoff use the V2-10 return flow.", 409);
    if (state.state === "CANCELLED") return;
    const providers = this.db.prepare("SELECT provider_shipment_id FROM geliver_provider_shipments WHERE shipment_id=?").all(shipmentId) as any[];
    const evidence: Array<{ providerShipmentId: string; responseHash: string }> = [];
    for (const provider of providers) {
      const already = this.db.prepare("SELECT response_hash FROM geliver_cancellation_facts WHERE provider_shipment_id=?").get(provider.provider_shipment_id) as any;
      if (already) { evidence.push({ providerShipmentId: provider.provider_shipment_id, responseHash: already.response_hash }); continue; }
      const current = await this.transport.get(provider.provider_shipment_id);
      const response = current.cancelDate ? current : await this.transport.cancel(provider.provider_shipment_id);
      evidence.push({ providerShipmentId: provider.provider_shipment_id, responseHash: hash(response) });
    }
    this.db.transaction(() => {
      for (const item of evidence) this.db.prepare(`INSERT INTO geliver_cancellation_facts
        (id,shipment_id,provider_shipment_id,response_hash,cancelled_at) VALUES (?,?,?,?,?) ON CONFLICT(provider_shipment_id) DO NOTHING`)
        .run(randomUUID(), shipmentId, item.providerShipmentId, item.responseHash, cancelledAt);
      this.db.prepare(`INSERT INTO shipment_cancellations
        (id,shipment_id,reason,provider_cancellation_ids_json,provider_provenance_json,operation_id,actor_id,cancelled_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(shipment_id) DO NOTHING`).run(randomUUID(), shipmentId, reason,
        canonical(evidence.map((item) => item.providerShipmentId)), canonical(evidence), operationId, actorId, cancelledAt);
      this.db.prepare("UPDATE geliver_create_jobs SET state='CANCELLED',updated_at=? WHERE shipment_id=? AND state='PENDING'").run(cancelledAt, shipmentId);
      this.db.prepare("UPDATE geliver_accept_jobs SET state='CANCELLED',updated_at=? WHERE shipment_id=? AND state='PENDING'").run(cancelledAt, shipmentId);
      this.db.prepare(`UPDATE shipment_preparations SET state='CANCELLED',cancellation_operation_id=?,cancelled_at=?,version=version+1,updated_at=? WHERE id=?`)
        .run(operationId, cancelledAt, cancelledAt, shipmentId);
      this.db.prepare(`INSERT INTO shipment_state_events
        (id,shipment_id,from_state,to_state,operation_id,actor_id,evidence_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), shipmentId, state.state, "CANCELLED", operationId, actorId, canonical({ reason, providerCount: evidence.length }), cancelledAt);
    }).immediate();
  }

  getLiveState(shipmentIdValue: string) {
    const shipmentId = required(shipmentIdValue, "shipmentId", 200);
    const providerRows = this.db.prepare("SELECT provider_shipment_id FROM geliver_provider_shipments WHERE shipment_id=? ORDER BY package_id").all(shipmentId) as any[];
    return providerRows.map((row) => this.viewProviderShipment(row.provider_shipment_id));
  }

  private observe(shipmentId: string, providerId: string, shipment: Shipment, observedAt: string, artifactHash: string | null = null) {
    const responseHash = hash(shipment);
    for (const offer of shipment.offers?.list || []) this.observeOffer(providerId, offer, observedAt);
    this.db.prepare(`INSERT INTO geliver_tracking_observations
      (id,provider_shipment_id,tracking_number,tracking_url,provider_state_code,response_hash,observed_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider_shipment_id,response_hash) DO NOTHING`).run(randomUUID(), providerId,
      optional(shipment.trackingNumber, "trackingNumber", 300), optional(shipment.trackingUrl, "trackingUrl", 1000),
      optional(shipment.statusCode, "statusCode", 100), responseHash, observedAt);
    if (shipment.labelURL) this.db.prepare(`INSERT INTO geliver_label_observations
      (id,provider_shipment_id,label_url,responsive_label_url,label_file_type,artifact_sha256,response_hash,observed_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(provider_shipment_id,label_url,response_hash) DO NOTHING`).run(randomUUID(), providerId,
      required(shipment.labelURL, "labelURL", 2000), optional(shipment.responsiveLabelURL, "responsiveLabelURL", 2000),
      optional(shipment.labelFileType, "labelFileType", 30), artifactHash, responseHash, observedAt);
    this.advanceReadiness(shipmentId, observedAt);
  }

  private observeOffer(providerId: string, offer: Offer, observedAt: string) {
    if (!offer.id || !offer.providerCode || !offer.providerServiceCode || !offer.amount || !offer.currency) return;
    const responseHash = hash(offer);
    this.db.prepare(`INSERT INTO geliver_offer_observations
      (id,provider_shipment_id,offer_id,provider_code,provider_service_code,amount,currency,amount_local,currency_local,
       estimated_arrival_at,duration_terms,response_hash,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider_shipment_id,offer_id,response_hash) DO NOTHING`).run(randomUUID(), providerId, offer.id,
      offer.providerCode, offer.providerServiceCode, String(offer.amount), offer.currency, optional(offer.amountLocal, "amountLocal", 100),
      optional(offer.currencyLocal, "currencyLocal", 10), optional(offer.estimatedArrivalTime, "estimatedArrivalTime", 100),
      optional(offer.durationTerms, "durationTerms", 300), responseHash, observedAt);
  }

  private reconcileAccepted(response: Shipment, providerId: string, artifactHash: string | null) {
    if (!response.acceptedOfferID) return;
    const job = this.db.prepare(`SELECT j.*,s.offer_id,s.provider_shipment_id FROM geliver_accept_jobs j
      JOIN geliver_offer_selections s ON s.id=j.selection_id WHERE s.provider_shipment_id=? AND j.state IN ('PROCESSING','RECONCILE_REQUIRED')`).get(providerId) as any;
    if (job && response.acceptedOfferID === job.offer_id) this.bindAccepted(job, null, response, "SHIPMENT_RECONCILIATION", null, artifactHash);
  }

  private async labelArtifactHash(shipment: Shipment) {
    if (!shipment.labelURL) return null;
    const bytes = await this.transport.downloadLabel(shipment.labelURL);
    if (!bytes.byteLength) throw new ShipmentValidationError("GELIVER_LABEL_ARTIFACT_EMPTY", "Geliver label artifact is empty.", 502);
    return createHash("sha256").update(bytes).digest("hex");
  }

  private advanceReadiness(shipmentId: string, occurredAt: string) {
    const packageCount = Number(this.db.prepare("SELECT package_count FROM shipment_preparations WHERE id=?").pluck().get(shipmentId));
    const bookings = Number(this.db.prepare("SELECT COUNT(*) FROM geliver_booking_facts WHERE shipment_id=?").pluck().get(shipmentId));
    const labels = Number(this.db.prepare(`SELECT COUNT(DISTINCT b.package_id) FROM geliver_booking_facts b
      JOIN geliver_label_observations l ON l.provider_shipment_id=b.provider_shipment_id WHERE b.shipment_id=?`).pluck().get(shipmentId));
    const row = this.db.prepare("SELECT state FROM shipment_preparations WHERE id=?").get(shipmentId) as any;
    if (bookings === packageCount && row?.state === "CARRIER_SELECTED") {
      this.advanceState(shipmentId, "CARRIER_SELECTED", "BOOKED", `geliver:booked:${shipmentId}`, "geliver-worker", { packageCount }, occurredAt);
    }
    const current = this.db.prepare("SELECT state FROM shipment_preparations WHERE id=?").pluck().get(shipmentId);
    if (labels === packageCount && current === "BOOKED") {
      this.advanceState(shipmentId, "BOOKED", "LABEL_READY", `geliver:labels:${shipmentId}`, "geliver-worker", { providerNativeLabels: true }, occurredAt);
    }
  }

  private advanceState(shipmentId: string, from: string, to: string, operationId: string, actorId: string, evidence: unknown, occurredAt: string) {
    const changed = this.db.prepare("UPDATE shipment_preparations SET state=?,version=version+1,updated_at=? WHERE id=? AND state=?")
      .run(to, occurredAt, shipmentId, from).changes;
    if (changed) this.db.prepare(`INSERT INTO shipment_state_events
      (id,shipment_id,from_state,to_state,operation_id,actor_id,evidence_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), shipmentId, from, to, operationId, actorId, canonical(evidence), occurredAt);
  }

  private viewProviderShipment(providerId: string) {
    const row = this.db.prepare(`SELECT p.*,j.state AS create_state,b.provider_transaction_id,b.barcode AS booking_barcode,
      a.state AS accept_state,s.provider_code,s.provider_service_code,s.offer_id AS selected_offer_id,s.quote_amount,s.quote_currency
      FROM geliver_provider_shipments p JOIN geliver_create_jobs j ON j.id=p.create_job_id
      LEFT JOIN geliver_booking_facts b ON b.provider_shipment_id=p.provider_shipment_id
      LEFT JOIN geliver_accept_jobs a ON a.id=b.accept_job_id
      LEFT JOIN geliver_offer_selections s ON s.package_id=p.package_id WHERE p.provider_shipment_id=?`).get(providerId) as any;
    const offers = this.db.prepare(`SELECT o.* FROM geliver_offer_observations o JOIN
      (SELECT offer_id,MAX(observed_at) latest FROM geliver_offer_observations WHERE provider_shipment_id=? GROUP BY offer_id) x
      ON x.offer_id=o.offer_id AND x.latest=o.observed_at WHERE o.provider_shipment_id=? ORDER BY CAST(o.amount AS REAL),o.offer_id`).all(providerId, providerId) as any[];
    const tracking = this.db.prepare("SELECT * FROM geliver_tracking_observations WHERE provider_shipment_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 1").get(providerId) as any;
    const label = this.db.prepare("SELECT * FROM geliver_label_observations WHERE provider_shipment_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 1").get(providerId) as any;
    return { provider: "GELIVER", providerShipmentId: providerId, packageId: row.package_id, providerOrderNumber: row.provider_order_number,
      createState: row.create_state, bookingState: row.accept_state || null, providerTransactionId: row.provider_transaction_id || null,
      barcode: row.booking_barcode || row.barcode || null,
      selectedOffer: row.selected_offer_id ? { id: row.selected_offer_id, carrier: row.provider_code, service: row.provider_service_code,
        amount: row.quote_amount, currency: row.quote_currency } : null,
      offers: offers.map((offer) => ({ id: offer.offer_id, carrier: offer.provider_code, service: offer.provider_service_code,
        amount: offer.amount, currency: offer.currency, amountLocal: offer.amount_local, currencyLocal: offer.currency_local,
        estimatedArrivalAt: offer.estimated_arrival_at, durationTerms: offer.duration_terms })),
      tracking: { number: tracking?.tracking_number || null, url: tracking?.tracking_url || null, stateCode: tracking?.provider_state_code || null },
      label: label ? { url: label.label_url, responsiveUrl: label.responsive_label_url, fileType: label.label_file_type,
        artifactSha256: label.artifact_sha256 } : null };
  }

  private job(id: string) {
    const row = this.db.prepare("SELECT * FROM geliver_create_jobs WHERE id=?").get(id) as any;
    return { id: row.id, shipmentId: row.shipment_id, packageId: row.package_id, requestIdentity: row.request_identity,
      providerOrderNumber: row.provider_order_number, state: row.state, attemptCount: Number(row.attempt_count), reconciliationCount: Number(row.reconciliation_count) };
  }
  private jobAccept(id: string) {
    const row = this.db.prepare("SELECT * FROM geliver_accept_jobs WHERE id=?").get(id) as any;
    return { id: row.id, shipmentId: row.shipment_id, packageId: row.package_id, selectionId: row.selection_id,
      requestIdentity: row.request_identity, state: row.state, attemptCount: Number(row.attempt_count), reconciliationCount: Number(row.reconciliation_count) };
  }
  private acceptJobBySelection(id: string) {
    const row = this.db.prepare("SELECT id FROM geliver_accept_jobs WHERE selection_id=?").get(id) as any;
    return this.jobAccept(row.id);
  }
  private recipientFromChannelOrder(shipmentId: string): RecipientInput {
    const row = this.db.prepare(`
      SELECT e.raw_payload_json
      FROM shipment_preparations p
      JOIN channel_orders o ON o.sale_id=p.order_id
      JOIN channel_inbound_events e ON e.id=o.first_event_id
      WHERE p.id=?
      LIMIT 1
    `).get(shipmentId) as any;

    if (!row?.raw_payload_json) {
      throw new ShipmentValidationError(
        "RECIPIENT_ADDRESS_INCOMPLETE",
        "Shipment has no marketplace recipient snapshot; recipient must be supplied manually.",
        409,
      );
    }

    let recipient: any;
    try {
      recipient = JSON.parse(row.raw_payload_json)?.recipient;
    } catch (_) {
      recipient = null;
    }

    const requiredFields = [
      "name",
      "email",
      "phone",
      "address1",
      "countryCode",
      "cityName",
      "cityCode",
      "districtName",
    ];

    const missing = requiredFields.filter((field) =>
      !String(recipient?.[field] ?? "").trim()
    );

    if (missing.length > 0) {
      throw new ShipmentValidationError(
        "RECIPIENT_ADDRESS_INCOMPLETE",
        `Marketplace recipient is incomplete: ${missing.join(", ")}`,
        409,
      );
    }

    return {
      name: String(recipient.name).trim(),
      email: String(recipient.email).trim(),
      phone: String(recipient.phone).trim(),
      address1: String(recipient.address1).trim(),
      address2: recipient.address2 ? String(recipient.address2).trim() : null,
      countryCode: String(recipient.countryCode).trim(),
      cityName: String(recipient.cityName).trim(),
      cityCode: String(recipient.cityCode).trim(),
      districtName: String(recipient.districtName).trim(),
      districtID: recipient.districtID ?? null,
      zip: recipient.zip ? String(recipient.zip).trim() : null,
    };
  }

  private recipient(input: RecipientInput) {
    return { name: required(input?.name, "recipient.name", 200), email: required(input?.email, "recipient.email", 320),
      phone: optional(input?.phone, "recipient.phone", 50) || undefined, address1: required(input?.address1, "recipient.address1", 500),
      address2: optional(input?.address2, "recipient.address2", 500) || undefined,
      countryCode: required(input?.countryCode, "recipient.countryCode", 3).toUpperCase(), cityName: required(input?.cityName, "recipient.cityName", 100),
      cityCode: required(input?.cityCode, "recipient.cityCode", 30), districtName: required(input?.districtName, "recipient.districtName", 100),
      districtID: optionalInteger(input?.districtID, "recipient.districtID"), zip: optional(input?.zip, "recipient.zip", 30) || undefined };
  }
}
