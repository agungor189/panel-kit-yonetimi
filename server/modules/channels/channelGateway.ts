import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { CommandExecutor } from "../commands/commandFoundation.js";
import { InventoryService, InventoryValidationError } from "../inventory/inventoryService.js";
import { MarketplaceSaleAcceptanceService } from "../sales/marketplaceSaleAcceptanceService.js";

export type ChannelCode = "TRENDYOL" | "HEPSIBURADA" | "N11" | "SHOPIFY";
export type CommissionRate = { numerator: number; denominator: number };

export const CHANNEL_ADAPTERS: Record<ChannelCode, {
  contract: string;
  enabledTransport: boolean;
  verifiedTransportScope: string;
  supportsWebhook: boolean;
  supportsPollingReconciliation: true;
  mayMutateCanonicalAuthority: false;
}> = {
  TRENDYOL: { contract: "dsdst.channel-adapter.trendyol.v1", enabledTransport: true,
    verifiedTransportScope: "existing-stage-production-order-poll-contract", supportsWebhook: false,
    supportsPollingReconciliation: true, mayMutateCanonicalAuthority: false },
  HEPSIBURADA: { contract: "dsdst.channel-adapter.hepsiburada.v1", enabledTransport: false,
    verifiedTransportScope: "credential-test-only; order transport disabled pending verified contract", supportsWebhook: false,
    supportsPollingReconciliation: true, mayMutateCanonicalAuthority: false },
  N11: { contract: "dsdst.channel-adapter.n11.v1", enabledTransport: false,
    verifiedTransportScope: "disabled pending verified provider contract", supportsWebhook: false,
    supportsPollingReconciliation: true, mayMutateCanonicalAuthority: false },
  SHOPIFY: { contract: "dsdst.channel-adapter.shopify.v1", enabledTransport: false,
    verifiedTransportScope: "disabled pending verified provider contract", supportsWebhook: false,
    supportsPollingReconciliation: true, mayMutateCanonicalAuthority: false },
};

export class ChannelGatewayError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "ChannelGatewayError";
  }
}

const integer = (value: unknown, field: string, minimum = 0) => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new ChannelGatewayError("CHANNEL_VALIDATION_FAILED", `${field} must be a safe integer >= ${minimum}.`);
  return Number(value);
};
const textValue = (value: unknown, field: string, max = 300) => {
  const valueText = typeof value === "string" ? value.trim() : "";
  if (!valueText || valueText.length > max || /[\u0000-\u001f\u007f]/.test(valueText)) throw new ChannelGatewayError("CHANNEL_VALIDATION_FAILED", `${field} is invalid.`);
  return valueText;
};
const stableJson = (value: any): string => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new ChannelGatewayError("CHANNEL_VALIDATION_FAILED", "Payload must be JSON-compatible.");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
};
const digest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const secretKey = /(^|_)(authorization|api_?key|token|secret|password|signature|cookie)($|_)/i;
const containsPlaintextSecretField = (value: any): boolean => {
  if (Array.isArray(value)) return value.some(containsPlaintextSecretField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => (
    (secretKey.test(key) && !/(?:_id|_ref|_reference)$/i.test(key)) || containsPlaintextSecretField(child)
  ));
};
export const redactProviderPayload = (value: any): any => {
  if (Array.isArray(value)) return value.map(redactProviderPayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, secretKey.test(key) ? "[REDACTED]" : redactProviderPayload(child)]));
};

export const calculateInverseCommissionPrice = (targetPriceMinor: number, rate: CommissionRate): number => {
  const target = integer(targetPriceMinor, "targetPriceMinor");
  const numerator = integer(rate.numerator, "rate.numerator");
  const denominator = integer(rate.denominator, "rate.denominator", 1);
  if (numerator >= denominator) throw new ChannelGatewayError("COMMISSION_RATE_INVALID", "Commission rate must be lower than one.");
  const divisor = BigInt(denominator - numerator);
  const dividend = BigInt(target) * BigInt(denominator);
  const result = (dividend + divisor - 1n) / divisor;
  const numberResult = Number(result);
  if (!Number.isSafeInteger(numberResult)) throw new ChannelGatewayError("MONEY_OVERFLOW", "Calculated channel price exceeds safe integer precision.");
  return numberResult;
};

const roundedCommission = (amountMinor: number, rate: CommissionRate): number => {
  const dividend = BigInt(amountMinor) * BigInt(rate.numerator);
  const denominator = BigInt(rate.denominator);
  const result = (dividend + denominator / 2n) / denominator;
  const numberResult = Number(result);
  if (!Number.isSafeInteger(numberResult)) throw new ChannelGatewayError("MONEY_OVERFLOW", "Commission exceeds safe integer precision.");
  return numberResult;
};
const gcd = (left: number, right: number): number => right === 0 ? Math.abs(left) : gcd(right, left % right);

type Actor = { id: string; name?: string | null };
type InboundLine = { externalLineId: string; externalListingId: string; externalSku?: string | null; quantityBaseInt: number; actualUnitGrossMinor: number; vatRateBps: number };
type InboundEvent = {
  accountId: string;
  externalEventId: string;
  externalEventVersion: string;
  externalOrderId: string;
  eventType: "ORDER_UPSERT" | "ORDER_CANCELLED" | "ORDER_RETURNED";
  ingestionPath: "WEBHOOK" | "POLL";
  currency: string;
  discountMinor: number;
  lines: InboundLine[];
  rawPayload: unknown;
  providerOccurredAt?: string | null;
  receivedAt: string;
};

export class ChannelGatewayService {
  private readonly commands: CommandExecutor;
  private readonly sales: MarketplaceSaleAcceptanceService;

  constructor(private readonly db: Database.Database) {
    this.commands = new CommandExecutor(db);
    this.sales = new MarketplaceSaleAcceptanceService(db);
  }

  configureAccount(input: { id: string; channel: ChannelCode; merchantAccountId: string; environment: "STAGE" | "PRODUCTION"; secretReference?: string | null; config?: unknown; operationId: string; actor: Actor }) {
    return this.commands.execute({ operationId: input.operationId, commandType: "channels.account.configure.v1", payload: input,
      actor: { human: input.actor }, authorization: { decision: "ALLOW", capability: "integrations:admin" } }, () => {
      const adapter = CHANNEL_ADAPTERS[input.channel];
      if (!adapter) throw new ChannelGatewayError("CHANNEL_UNSUPPORTED", "Channel is unsupported.");
      if (input.secretReference && !/^(?:env|vault|encrypted):[A-Za-z0-9._:/-]+$/.test(input.secretReference)) {
        throw new ChannelGatewayError("SECRET_REFERENCE_REQUIRED", "Credentials must use an env, vault, or encrypted secret reference.");
      }
      if (containsPlaintextSecretField(input.config)) {
        throw new ChannelGatewayError("PLAINTEXT_SECRET_FORBIDDEN", "Channel configuration cannot contain plaintext secret fields.");
      }
      const state = adapter.enabledTransport ? "CONFIGURED" : "DISABLED";
      this.db.prepare(`INSERT INTO channel_accounts (id,channel,merchant_account_id,environment,state,secret_reference,config_json)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,secret_reference=excluded.secret_reference,
        config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP`).run(input.id, input.channel, input.merchantAccountId,
        input.environment, state, input.secretReference || null, stableJson(input.config || {}));
      return { statusCode: 200, body: { id: input.id, channel: input.channel, state, adapter } };
    }).result.body;
  }

  mapProduct(input: { id: string; accountId: string; externalListingId: string; externalSku?: string | null; productId: string; categoryRef?: string | null; operationId: string; actor: Actor }) {
    return this.commands.execute({ operationId: input.operationId, commandType: "channels.product-map.v1", payload: input,
      actor: { human: input.actor }, authorization: { decision: "ALLOW", capability: "integrations:admin" } }, () => {
      if (!this.db.prepare("SELECT 1 FROM products WHERE id=?").get(input.productId)) throw new ChannelGatewayError("PRODUCT_NOT_FOUND", "Canonical product was not found.", 404);
      this.db.prepare(`INSERT INTO channel_product_mappings
        (id,account_id,external_listing_id,external_sku,product_id,category_ref) VALUES (?,?,?,?,?,?)
        ON CONFLICT(account_id,external_listing_id) DO UPDATE SET external_sku=excluded.external_sku,product_id=excluded.product_id,
        category_ref=excluded.category_ref,version=channel_product_mappings.version+1,updated_at=CURRENT_TIMESTAMP`).run(
        input.id, input.accountId, input.externalListingId, input.externalSku || null, input.productId, input.categoryRef || null);
      return { statusCode: 200, body: { id: input.id, accountId: input.accountId, productId: input.productId } };
    }).result.body;
  }

  setCommissionTerm(input: { id: string; accountId: string; productId?: string | null; categoryRef?: string | null; state: "KNOWN" | "UNKNOWN"; rate?: CommissionRate; provenance: unknown; version: number; effectiveFrom: string; operationId: string; actor: Actor }) {
    return this.commands.execute({ operationId: input.operationId, commandType: "channels.commission-term.set.v1", payload: input,
      actor: { human: input.actor }, authorization: { decision: "ALLOW", capability: "integrations:admin" } }, () => {
      if (input.state === "KNOWN") calculateInverseCommissionPrice(0, input.rate || { numerator: 1, denominator: 1 });
      this.db.prepare(`INSERT INTO channel_commission_terms
        (id,account_id,product_id,category_ref,state,rate_numerator,rate_denominator,provenance_json,version,effective_from)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.accountId, input.productId || null, input.categoryRef || null,
        input.state, input.rate?.numerator ?? null, input.rate?.denominator ?? null, stableJson(input.provenance), input.version, input.effectiveFrom);
      return { statusCode: 201, body: { id: input.id, state: input.state } };
    }).result.body;
  }

  setStockBuffer(input: { id: string; accountId: string; productId: string; bufferQuantityBaseInt: number; operationId: string; actor: Actor }) {
    const buffer = integer(input.bufferQuantityBaseInt, "bufferQuantityBaseInt");
    return this.commands.execute({ operationId: input.operationId, commandType: "channels.stock-buffer.set.v1", payload: input,
      actor: { human: input.actor }, authorization: { decision: "ALLOW", capability: "integrations:admin" } }, () => {
      this.db.prepare(`INSERT INTO channel_stock_buffers (id,account_id,product_id,buffer_quantity_base_int,version,updated_operation_id)
        VALUES (?,?,?,?,1,?) ON CONFLICT(account_id,product_id) DO UPDATE SET buffer_quantity_base_int=excluded.buffer_quantity_base_int,
        version=channel_stock_buffers.version+1,updated_operation_id=excluded.updated_operation_id,updated_at=CURRENT_TIMESTAMP`).run(
        input.id, input.accountId, input.productId, buffer, input.operationId);
      return { statusCode: 200, body: { productId: input.productId, bufferQuantityBaseInt: buffer } };
    }).result.body;
  }

  ingest(event: InboundEvent, operationId: string, serviceActorId: string) {
    const sanitized = redactProviderPayload(event.rawPayload);
    const payloadDigest = digest(sanitized);
    return this.commands.execute({ operationId, commandType: "channels.inbound.process.v1", payload: { ...event, rawPayload: sanitized },
      actor: { service: { id: serviceActorId } }, authorization: { decision: "ALLOW", capability: "channels:ingest" } }, (context) => {
      const account = this.db.prepare("SELECT * FROM channel_accounts WHERE id=?").get(event.accountId) as any;
      if (!account) throw new ChannelGatewayError("CHANNEL_ACCOUNT_NOT_FOUND", "Channel account was not found.", 404);
      const existingEvent = this.db.prepare(`SELECT e.*,o.sale_id,o.id AS channel_order_id FROM channel_inbound_events e
        LEFT JOIN channel_orders o ON o.first_event_id=e.id WHERE e.account_id=? AND e.external_event_id=? AND e.external_event_version=?`)
        .get(event.accountId, event.externalEventId, event.externalEventVersion) as any;
      if (existingEvent) return { statusCode: 200, body: { state: "DUPLICATE", saleId: existingEvent.sale_id || null, eventId: existingEvent.id } };
      const eventId = randomUUID();
      this.db.prepare(`INSERT INTO channel_inbound_events
        (id,account_id,external_event_id,external_event_version,ingestion_path,event_type,raw_payload_json,raw_payload_digest,
         provider_occurred_at,received_at,processing_state) VALUES (?,?,?,?,?,?,?,?,?,?, 'RECEIVED')`).run(
        eventId, event.accountId, event.externalEventId, event.externalEventVersion, event.ingestionPath, event.eventType,
        stableJson(sanitized), payloadDigest, event.providerOccurredAt || null, event.receivedAt);
      this.db.prepare(`UPDATE channel_accounts SET ${event.ingestionPath === "WEBHOOK" ? "last_webhook_at" : "last_poll_at"}=?,updated_at=? WHERE id=?`)
        .run(event.receivedAt, event.receivedAt, event.accountId);

      const existingOrder = this.db.prepare("SELECT * FROM channel_orders WHERE account_id=? AND external_order_id=?")
        .get(event.accountId, event.externalOrderId) as any;
      if (event.eventType !== "ORDER_UPSERT") {
        if (!existingOrder?.sale_id) return this.recordException(eventId, event.accountId, existingOrder?.id || null,
          "ORDER_VERSION_EXCEPTION", { code: "ORDER_NOT_ACCEPTED", externalOrderId: event.externalOrderId });
        const transition = this.sales.applyCancellationOrReturn({ saleId: existingOrder.sale_id, operationId, actor: { id: serviceActorId }, occurredAt: event.receivedAt });
        this.db.prepare("UPDATE channel_orders SET order_state=?,latest_external_version=?,updated_at=? WHERE id=?")
          .run(transition.state, event.externalEventVersion, event.receivedAt, existingOrder.id);
        this.db.prepare("UPDATE channel_inbound_events SET processing_state='ACCEPTED',sale_id=? WHERE id=?").run(existingOrder.sale_id, eventId);
        context.addOutbox({ topic: "channels", eventType: transition.state === "CANCELLED" ? "channel.order.cancelled.v1" : "channel.return.requested.v1",
          aggregateType: "sale", aggregateId: existingOrder.sale_id, payload: { sale_id: existingOrder.sale_id, channel_order_id: existingOrder.id } });
        return { statusCode: 200, body: { state: transition.state, saleId: existingOrder.sale_id, eventId } };
      }
      if (existingOrder?.sale_id) {
        this.db.prepare("UPDATE channel_inbound_events SET processing_state='DUPLICATE',sale_id=? WHERE id=?").run(existingOrder.sale_id, eventId);
        if (existingOrder.raw_order_digest !== payloadDigest) this.insertException(event.accountId, eventId, existingOrder.id,
          "ORDER_VERSION_EXCEPTION", { externalOrderId: event.externalOrderId, acceptedDigest: existingOrder.raw_order_digest, receivedDigest: payloadDigest });
        return { statusCode: 200, body: { state: "DUPLICATE", saleId: existingOrder.sale_id, eventId } };
      }
      if (!Array.isArray(event.lines) || event.lines.length === 0) throw new ChannelGatewayError("CHANNEL_LINES_REQUIRED", "Order lines are required.");
      const orderId = existingOrder?.id || randomUUID();
      if (!existingOrder) this.db.prepare(`INSERT INTO channel_orders
        (id,account_id,external_order_id,latest_external_version,currency,actual_discount_minor,order_state,first_event_id,raw_order_digest)
        VALUES (?,?,?,?,?,?,'RECEIVED',?,?)`).run(orderId, event.accountId, event.externalOrderId, event.externalEventVersion,
        event.currency.toUpperCase(), integer(event.discountMinor, "discountMinor"), eventId, payloadDigest);
      const acceptedLines: any[] = [];
      const termsSnapshot: any[] = [];
      let totalCommission = 0;
      let commissionBasis = 0;
      let blocking = false;
      for (const [index, line] of event.lines.entries()) {
        const mapping = this.db.prepare(`SELECT m.*,p.sale_price,p.title,p.sku,
          (SELECT v.final_sale_price_minor FROM published_kits k JOIN published_kit_versions v ON v.id=k.current_version_id WHERE k.product_id=m.product_id) AS kit_price_minor
          FROM channel_product_mappings m JOIN products p ON p.id=m.product_id
          WHERE m.account_id=? AND m.external_listing_id=? AND m.listing_state='ACTIVE'`).get(event.accountId, line.externalListingId) as any;
        const lineDigest = digest(line);
        const lineId = randomUUID();
        if (!mapping) {
          this.db.prepare(`INSERT INTO channel_order_lines
            (id,channel_order_id,external_line_id,external_listing_id,external_sku,quantity_base_int,actual_unit_gross_minor,vat_rate_bps,raw_line_digest)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(lineId, orderId, line.externalLineId, line.externalListingId, line.externalSku || null,
            integer(line.quantityBaseInt, `lines[${index}].quantityBaseInt`, 1), integer(line.actualUnitGrossMinor, `lines[${index}].actualUnitGrossMinor`),
            integer(line.vatRateBps, `lines[${index}].vatRateBps`), lineDigest);
          this.insertException(event.accountId, eventId, orderId, "CHANNEL_MAPPING_EXCEPTION",
            { externalLineId: line.externalLineId, externalListingId: line.externalListingId, externalSku: line.externalSku || null });
          blocking = true;
          continue;
        }
        const term = this.findCommissionTerm(event.accountId, mapping.product_id, mapping.category_ref, event.receivedAt);
        if (!term || term.state !== "KNOWN") {
          this.db.prepare(`INSERT INTO channel_order_lines
            (id,channel_order_id,external_line_id,external_listing_id,external_sku,mapping_id,product_id,quantity_base_int,actual_unit_gross_minor,vat_rate_bps,raw_line_digest)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(lineId, orderId, line.externalLineId, line.externalListingId, line.externalSku || null,
            mapping.id, mapping.product_id, integer(line.quantityBaseInt, "quantityBaseInt", 1), integer(line.actualUnitGrossMinor, "actualUnitGrossMinor"), integer(line.vatRateBps, "vatRateBps"), lineDigest);
          this.insertException(event.accountId, eventId, orderId, "COMMISSION_EXCEPTION", { productId: mapping.product_id, state: term?.state || "MISSING" });
          blocking = true;
          continue;
        }
        const rate = { numerator: Number(term.rate_numerator), denominator: Number(term.rate_denominator) };
        const targetMinor = mapping.kit_price_minor === null || mapping.kit_price_minor === undefined
          ? this.legacyPanelPriceMinor(mapping.sale_price) : Number(mapping.kit_price_minor);
        const expected = calculateInverseCommissionPrice(targetMinor, rate);
        const quantity = integer(line.quantityBaseInt, "quantityBaseInt", 1);
        const actual = integer(line.actualUnitGrossMinor, "actualUnitGrossMinor");
        this.db.prepare(`INSERT INTO channel_order_lines
          (id,channel_order_id,external_line_id,external_listing_id,external_sku,mapping_id,product_id,quantity_base_int,
           actual_unit_gross_minor,vat_rate_bps,commission_term_id,expected_unit_gross_minor,raw_line_digest)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(lineId, orderId, line.externalLineId, line.externalListingId, line.externalSku || null,
          mapping.id, mapping.product_id, quantity, actual, integer(line.vatRateBps, "vatRateBps"), term.id, expected, lineDigest);
        if (actual !== expected) {
          this.db.prepare(`INSERT INTO channel_price_variances
            (id,channel_order_line_id,target_price_minor,expected_channel_price_minor,actual_channel_price_minor,difference_minor,provenance_json)
            VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), lineId, targetMinor, expected, actual, actual - expected,
            stableJson({ source: "PROVIDER_ORDER", eventId: event.externalEventId, commissionTermId: term.id }));
          this.insertException(event.accountId, eventId, orderId, "PRICE_VARIANCE", { externalLineId: line.externalLineId, expected, actual });
        }
        acceptedLines.push({ externalLineId: line.externalLineId, productId: mapping.product_id, quantityBaseInt: quantity,
          actualUnitGrossMinor: actual, vatRateBps: Number(line.vatRateBps) });
        const lineBasis = actual * quantity;
        commissionBasis += lineBasis;
        totalCommission += roundedCommission(lineBasis, rate);
        termsSnapshot.push({ externalLineId: line.externalLineId, termId: term.id, version: term.version, basis: term.basis,
          rate, provenance: JSON.parse(term.provenance_json), expectedUnitGrossMinor: expected, actualUnitGrossMinor: actual });
      }
      if (blocking) return this.markOrderException(eventId, orderId);
      const divisor = commissionBasis === 0 ? 1 : gcd(totalCommission, commissionBasis);
      try {
        const accepted = this.sales.accept({ channel: account.channel, merchantAccountId: account.merchant_account_id,
          externalOrderId: event.externalOrderId, currency: event.currency.toUpperCase(), discountMinor: event.discountMinor,
          lines: acceptedLines, commission: { amountMinor: totalCommission, effectiveNumerator: totalCommission / divisor,
            effectiveDenominator: commissionBasis === 0 ? 1 : commissionBasis / divisor,
            terms: { contract: "dsdst.channel-commission-snapshot.v1", lines: termsSnapshot } },
          operationId, actor: { id: serviceActorId }, acceptedAt: event.receivedAt });
        this.db.prepare(`UPDATE channel_orders SET order_state='ACCEPTED',sale_id=?,reservation_id=?,latest_external_version=?,accepted_at=?,updated_at=? WHERE id=?`)
          .run(accepted.saleId, accepted.reservationId, event.externalEventVersion, event.receivedAt, event.receivedAt, orderId);
        this.db.prepare("UPDATE channel_inbound_events SET processing_state='ACCEPTED',sale_id=? WHERE id=?").run(accepted.saleId, eventId);
        context.addOutbox({ topic: "channels", eventType: "channel.order.accepted.v1", aggregateType: "sale", aggregateId: accepted.saleId,
          payload: { sale_id: accepted.saleId, reservation_id: accepted.reservationId, channel_order_id: orderId } });
        return { statusCode: 201, body: { state: "ACCEPTED", saleId: accepted.saleId, reservationId: accepted.reservationId, eventId } };
      } catch (error) {
        if (!(error instanceof InventoryValidationError) || error.code !== "INSUFFICIENT_AVAILABLE_STOCK") throw error;
        this.insertException(event.accountId, eventId, orderId, "STOCK_EXCEPTION", { code: error.code, message: error.message });
        return this.markOrderException(eventId, orderId);
      }
    });
  }

  updatePollingCursor(input: { accountId: string; cursorName: string; checkpointValue: string; operationId: string; serviceActorId: string; updatedAt: string }) {
    return this.commands.execute({ operationId: input.operationId, commandType: "channels.poll-cursor.advance.v1", payload: input,
      actor: { service: { id: input.serviceActorId } }, authorization: { decision: "ALLOW", capability: "channels:poll" } }, () => {
      const existing = this.db.prepare("SELECT checkpoint_version FROM channel_poll_cursors WHERE account_id=? AND cursor_name=?").get(input.accountId, input.cursorName) as any;
      const version = Number(existing?.checkpoint_version || 0) + 1;
      this.db.prepare(`INSERT INTO channel_poll_cursors (id,account_id,cursor_name,checkpoint_value,checkpoint_version,updated_operation_id,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,cursor_name) DO UPDATE SET checkpoint_value=excluded.checkpoint_value,
        checkpoint_version=excluded.checkpoint_version,updated_operation_id=excluded.updated_operation_id,updated_at=excluded.updated_at`).run(
        randomUUID(), input.accountId, input.cursorName, input.checkpointValue, version, input.operationId, input.updatedAt);
      return { statusCode: 200, body: { accountId: input.accountId, cursorName: input.cursorName, checkpointValue: input.checkpointValue, version } };
    }).result.body;
  }

  enqueueStockSync(input: { accountId: string; productId: string; sourceVersion: string; operationId: string; actor: Actor }) {
    const availability = new InventoryService(this.db).getProductAvailability(input.productId);
    const buffer = Number(this.db.prepare("SELECT buffer_quantity_base_int FROM channel_stock_buffers WHERE account_id=? AND product_id=?")
      .pluck().get(input.accountId, input.productId) || 0);
    const publishableStock = Math.max(0, availability.availableBaseInt - buffer);
    return this.enqueueOutbound({ ...input, kind: "STOCK", payload: { productId: input.productId, quantityBaseInt: publishableStock,
      canonicalAvailableBaseInt: availability.availableBaseInt, channelStockBufferBaseInt: buffer } });
  }

  enqueuePriceSync(input: { accountId: string; productId: string; sourceVersion: string; operationId: string; actor: Actor }) {
    const mapping = this.db.prepare("SELECT m.*,p.sale_price FROM channel_product_mappings m JOIN products p ON p.id=m.product_id WHERE m.account_id=? AND m.product_id=? AND m.listing_state='ACTIVE'")
      .get(input.accountId, input.productId) as any;
    if (!mapping) throw new ChannelGatewayError("CHANNEL_MAPPING_EXCEPTION", "No active listing mapping exists.", 409);
    const term = this.findCommissionTerm(input.accountId, input.productId, mapping.category_ref, new Date().toISOString());
    if (!term || term.state !== "KNOWN") throw new ChannelGatewayError("COMMISSION_UNKNOWN", "Price publication is blocked until commission terms are known.", 409);
    const kitPrice = this.db.prepare(`SELECT v.final_sale_price_minor FROM published_kits k JOIN published_kit_versions v ON v.id=k.current_version_id WHERE k.product_id=?`).pluck().get(input.productId);
    const targetPriceMinor = kitPrice === undefined ? this.legacyPanelPriceMinor(mapping.sale_price) : Number(kitPrice);
    const channelPriceMinor = calculateInverseCommissionPrice(targetPriceMinor, { numerator: Number(term.rate_numerator), denominator: Number(term.rate_denominator) });
    return this.enqueueOutbound({ ...input, kind: "PRICE", payload: { productId: input.productId, targetPriceMinor, channelPriceMinor,
      commissionTermId: term.id, commissionVersion: term.version } });
  }

  recordOutboundAttempt(input: { jobId: string; providerMutationId: string; state: "SUCCEEDED" | "FAILED" | "RATE_LIMITED"; response?: unknown; errorCode?: string | null; retryAt?: string | null; operationId: string; serviceActorId: string; occurredAt: string }) {
    return this.commands.execute({ operationId: input.operationId, commandType: "channels.outbound-attempt.record.v1", payload: input,
      actor: { service: { id: input.serviceActorId } }, authorization: { decision: "ALLOW", capability: "channels:publish" } }, () => {
      const existing = this.db.prepare("SELECT * FROM channel_outbound_attempts WHERE job_id=? AND provider_mutation_id=?").get(input.jobId, input.providerMutationId) as any;
      if (existing) return { statusCode: 200, body: { id: existing.id, state: existing.state, replayed: true as boolean } };
      const attempt = Number(this.db.prepare("SELECT attempt_count FROM channel_outbound_jobs WHERE id=?").pluck().get(input.jobId));
      if (!Number.isSafeInteger(attempt)) throw new ChannelGatewayError("OUTBOUND_JOB_NOT_FOUND", "Outbound job was not found.", 404);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO channel_outbound_attempts
        (id,job_id,provider_mutation_id,attempt_number,state,response_digest,error_code,retry_at,started_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, input.jobId, input.providerMutationId, attempt + 1, input.state,
        input.response === undefined ? null : digest(redactProviderPayload(input.response)), input.errorCode || null, input.retryAt || null, input.occurredAt, input.occurredAt);
      const jobState = input.state === "SUCCEEDED" ? "SUCCEEDED" : "RETRY";
      this.db.prepare(`UPDATE channel_outbound_jobs SET state=?,attempt_count=attempt_count+1,available_at=COALESCE(?,available_at),
        last_error_code=?,completed_at=CASE WHEN ?='SUCCEEDED' THEN ? ELSE NULL END WHERE id=?`).run(jobState, input.retryAt || null,
        input.errorCode || null, jobState, input.occurredAt, input.jobId);
      return { statusCode: 200, body: { id, state: input.state, replayed: false as boolean } };
    }).result.body;
  }

  getDashboard() {
    const now = new Date().toISOString();
    const mappings = (this.db.prepare(`SELECT m.id,m.account_id AS accountId,m.external_listing_id AS externalListingId,m.external_sku AS externalSku,
        m.product_id AS productId,p.sku,p.title,p.sale_price AS salePrice,m.category_ref AS categoryRef,m.listing_state AS listingState,
        COALESCE(b.buffer_quantity_base_int,0) AS stockBufferBaseInt,
        (SELECT v.final_sale_price_minor FROM published_kits k JOIN published_kit_versions v ON v.id=k.current_version_id WHERE k.product_id=m.product_id) AS kitPriceMinor
        FROM channel_product_mappings m JOIN products p ON p.id=m.product_id LEFT JOIN channel_stock_buffers b ON b.account_id=m.account_id AND b.product_id=m.product_id
        ORDER BY m.account_id,p.sku`).all() as any[]).map((mapping) => {
      const availability = new InventoryService(this.db).getProductAvailability(mapping.productId);
      const term = this.findCommissionTerm(mapping.accountId, mapping.productId, mapping.categoryRef, now);
      const targetPriceMinor = mapping.kitPriceMinor === null || mapping.kitPriceMinor === undefined
        ? (() => { try { return this.legacyPanelPriceMinor(mapping.salePrice); } catch { return null; } })() : Number(mapping.kitPriceMinor);
      const calculatedChannelPriceMinor = targetPriceMinor !== null && term?.state === "KNOWN"
        ? calculateInverseCommissionPrice(targetPriceMinor, { numerator: Number(term.rate_numerator), denominator: Number(term.rate_denominator) }) : null;
      return { ...mapping, targetPriceMinor, calculatedChannelPriceMinor, commissionState: term?.state || "MISSING",
        canonicalAvailableBaseInt: availability.availableBaseInt,
        publishableStockBaseInt: Math.max(0, availability.availableBaseInt - Number(mapping.stockBufferBaseInt)) };
    });
    return {
      contract: "dsdst.channel-dashboard.v1",
      adapters: CHANNEL_ADAPTERS,
      accounts: this.db.prepare(`SELECT id,channel,merchant_account_id AS merchantAccountId,environment,state,
        last_webhook_at AS lastWebhookAt,last_poll_at AS lastPollAt,last_sync_at AS lastSyncAt,last_error_code AS lastErrorCode
        FROM channel_accounts ORDER BY channel,merchant_account_id`).all(),
      mappings,
      commissionTerms: this.db.prepare(`SELECT id,account_id AS accountId,product_id AS productId,category_ref AS categoryRef,state,
        rate_numerator AS rateNumerator,rate_denominator AS rateDenominator,basis,version,effective_from AS effectiveFrom
        FROM channel_commission_terms ORDER BY account_id,product_id,category_ref,version DESC`).all(),
      exceptions: this.db.prepare(`SELECT id,account_id AS accountId,exception_type AS type,state,detail_json AS detail,
        channel_order_id AS channelOrderId,created_at AS createdAt FROM channel_exceptions WHERE state='OPEN' ORDER BY created_at DESC LIMIT 200`).all(),
      jobs: this.db.prepare(`SELECT id,account_id AS accountId,product_id AS productId,job_kind AS kind,state,attempt_count AS attemptCount,
        available_at AS availableAt,last_error_code AS lastErrorCode,created_at AS createdAt FROM channel_outbound_jobs ORDER BY created_at DESC LIMIT 200`).all(),
      cursors: this.db.prepare(`SELECT account_id AS accountId,cursor_name AS cursorName,checkpoint_value AS checkpointValue,
        checkpoint_version AS version,updated_at AS updatedAt FROM channel_poll_cursors ORDER BY account_id,cursor_name`).all(),
    };
  }

  private enqueueOutbound(input: { accountId: string; productId: string; sourceVersion: string; operationId: string; actor: Actor; kind: "STOCK" | "PRICE" | "VISIBILITY"; payload: unknown }) {
    return this.commands.execute({ operationId: input.operationId, commandType: `channels.outbound.${input.kind.toLowerCase()}.enqueue.v1`, payload: input,
      actor: { human: input.actor }, authorization: { decision: "ALLOW", capability: "integrations:admin" } }, () => {
      const mapping = this.db.prepare("SELECT id FROM channel_product_mappings WHERE account_id=? AND product_id=? AND listing_state='ACTIVE'").get(input.accountId, input.productId) as any;
      if (!mapping) throw new ChannelGatewayError("CHANNEL_MAPPING_EXCEPTION", "No active listing mapping exists.", 409);
      const payloadJson = stableJson(input.payload);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO channel_outbound_jobs
        (id,account_id,product_id,mapping_id,job_kind,source_version,payload_json,payload_hash,state,created_operation_id)
        VALUES (?,?,?,?,?,?,?,?,'PENDING',?) ON CONFLICT(account_id,product_id,job_kind,source_version) DO NOTHING`).run(
        id, input.accountId, input.productId, mapping.id, input.kind, input.sourceVersion, payloadJson,
        createHash("sha256").update(payloadJson).digest("hex"), input.operationId);
      const job = this.db.prepare("SELECT id,state,payload_json FROM channel_outbound_jobs WHERE account_id=? AND product_id=? AND job_kind=? AND source_version=?")
        .get(input.accountId, input.productId, input.kind, input.sourceVersion) as any;
      return { statusCode: 202, body: { id: job.id, state: job.state, payload: JSON.parse(job.payload_json) } };
    }).result.body;
  }

  private findCommissionTerm(accountId: string, productId: string, categoryRef: string | null, at: string) {
    return this.db.prepare(`SELECT * FROM channel_commission_terms WHERE account_id=? AND effective_from<=?
      AND (effective_to IS NULL OR effective_to>?) AND (product_id=? OR (product_id IS NULL AND category_ref=?) OR (product_id IS NULL AND category_ref IS NULL))
      ORDER BY CASE WHEN product_id=? THEN 0 WHEN category_ref=? THEN 1 ELSE 2 END,version DESC LIMIT 1`)
      .get(accountId, at, at, productId, categoryRef, productId, categoryRef) as any;
  }

  private legacyPanelPriceMinor(value: unknown) {
    const source = String(value ?? "");
    if (!/^\d+(?:\.\d{1,2})?$/.test(source)) throw new ChannelGatewayError("PANEL_TARGET_PRICE_INVALID", "Panel target price must resolve to integer minor units.", 409);
    const [whole, fraction = ""] = source.split(".");
    const result = Number(BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2)));
    if (!Number.isSafeInteger(result)) throw new ChannelGatewayError("MONEY_OVERFLOW", "Panel target price exceeds safe integer precision.");
    return result;
  }

  private insertException(accountId: string, eventId: string | null, orderId: string | null, type: string, detail: unknown) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO channel_exceptions (id,account_id,inbound_event_id,channel_order_id,exception_type,detail_json)
      VALUES (?,?,?,?,?,?)`).run(id, accountId, eventId, orderId, type, stableJson(detail));
    return id;
  }

  private markOrderException(eventId: string, orderId: string) {
    this.db.prepare("UPDATE channel_orders SET order_state='EXCEPTION',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(orderId);
    this.db.prepare("UPDATE channel_inbound_events SET processing_state='EXCEPTION' WHERE id=?").run(eventId);
    return { statusCode: 202, body: { state: "EXCEPTION", saleId: null, eventId } };
  }

  private recordException(eventId: string, accountId: string, orderId: string | null, type: string, detail: unknown) {
    this.insertException(accountId, eventId, orderId, type, detail);
    this.db.prepare("UPDATE channel_inbound_events SET processing_state='EXCEPTION' WHERE id=?").run(eventId);
    return { statusCode: 202, body: { state: "EXCEPTION", saleId: null, eventId } };
  }
}
