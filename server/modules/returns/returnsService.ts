import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { roundRatio } from "../finance/money.js";

export type ReturnReason = "CUSTOMER_CHANGED_MIND" | "WRONG_PRODUCT" | "DAMAGED" | "MISSING_PART" | "INCOMPATIBLE" | "OTHER";
export type ReturnDisposition = "SELLABLE" | "DAMAGED" | "MISSING_NOT_RECEIVED";
type Actor = { id: string; name?: string | null };

const reasons = new Set<ReturnReason>(["CUSTOMER_CHANGED_MIND", "WRONG_PRODUCT", "DAMAGED", "MISSING_PART", "INCOMPATIBLE", "OTHER"]);
const dispositions = new Set<ReturnDisposition>(["SELLABLE", "DAMAGED", "MISSING_NOT_RECEIVED"]);
const marketplaceChannels = new Set(["trendyol", "hepsiburada", "amazon", "n11"]);

export class ReturnsValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "ReturnsValidationError";
  }
}

const text = (value: unknown, field: string, max = 300) => {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new ReturnsValidationError("RETURN_VALIDATION_FAILED", `${field} is invalid.`);
  }
  return result;
};

const optionalText = (value: unknown, field: string, max = 1000) => value === undefined || value === null || value === ""
  ? null
  : text(value, field, max);

const positiveInteger = (value: unknown, field: string) => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new ReturnsValidationError("RETURN_VALIDATION_FAILED", `${field} must be a positive integer.`);
  return Number(value);
};

const nonNegativeInteger = (value: unknown, field: string) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ReturnsValidationError("RETURN_VALIDATION_FAILED", `${field} must be a non-negative integer.`);
  return Number(value);
};

const instant = (value: unknown, field: string) => {
  const result = text(value, field, 50);
  if (!Number.isFinite(Date.parse(result))) throw new ReturnsValidationError("RETURN_VALIDATION_FAILED", `${field} must be an ISO timestamp.`);
  return result;
};

const actorInput = (actor: Actor) => ({ id: text(actor?.id, "actor.id"), name: optionalText(actor?.name, "actor.name", 200) });

const proportionalDelta = (original: number, previousQuantity: number, nextQuantity: number, originalQuantity: number, field: string) => {
  const previous = roundRatio(BigInt(original) * BigInt(previousQuantity), BigInt(originalQuantity), `${field}.previous`);
  const next = roundRatio(BigInt(original) * BigInt(nextQuantity), BigInt(originalQuantity), `${field}.next`);
  return next - previous;
};

const isMarketplace = (sourceChannel: string, accountType?: string | null) => (
  accountType === "platform" || marketplaceChannels.has(sourceChannel.trim().toLocaleLowerCase("tr-TR"))
);

export class ReturnsService {
  constructor(private readonly db: Database.Database) {}

  createReturnRequest(input: {
    saleId: string;
    lines: Array<{ financialLineId: string; quantityBaseInt: number; reasonCode: ReturnReason; explanation?: string | null }>;
    customerShippingRefund?: { selected: boolean; amountMinor: number };
    operationId: string;
    actor: Actor;
    requestedAt?: string;
  }) {
    const saleId = text(input.saleId, "saleId");
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    const requestedAt = input.requestedAt ? instant(input.requestedAt, "requestedAt") : new Date().toISOString();
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new ReturnsValidationError("RETURN_LINES_REQUIRED", "At least one return line is required.");
    const normalizedLines = input.lines.map((line, index) => {
      const financialLineId = text(line.financialLineId, `lines[${index}].financialLineId`);
      const quantityBaseInt = positiveInteger(line.quantityBaseInt, `lines[${index}].quantityBaseInt`);
      if (!reasons.has(line.reasonCode)) throw new ReturnsValidationError("RETURN_REASON_REQUIRED", `lines[${index}].reasonCode is required.`);
      const explanation = optionalText(line.explanation, `lines[${index}].explanation`);
      if (line.reasonCode === "OTHER" && !explanation) throw new ReturnsValidationError("RETURN_REASON_EXPLANATION_REQUIRED", "OTHER return reason requires an explanation.");
      return { financialLineId, quantityBaseInt, reasonCode: line.reasonCode, explanation };
    });
    if (new Set(normalizedLines.map(({ financialLineId }) => financialLineId)).size !== normalizedLines.length) {
      throw new ReturnsValidationError("RETURN_LINE_DUPLICATE", "A financial line may appear only once in a return request.");
    }
    const shippingSelected = input.customerShippingRefund?.selected === true;
    const shippingAmount = nonNegativeInteger(input.customerShippingRefund?.amountMinor ?? 0, "customerShippingRefund.amountMinor");
    if (!shippingSelected && shippingAmount !== 0) throw new ReturnsValidationError("SHIPPING_REFUND_INVALID", "Unselected customer shipping refund must be zero.");

    return this.db.transaction(() => {
      const sale = this.db.prepare(`SELECT s.id,s.cash_account_id,a.type AS account_type,f.*
        FROM sales s
        JOIN sale_financial_snapshots f ON f.sale_id=s.id
        LEFT JOIN cash_accounts a ON a.id=s.cash_account_id
        WHERE s.id=?`).get(saleId) as any;
      if (!sale) {
        const legacy = this.db.prepare("SELECT id FROM sales WHERE id=?").get(saleId);
        throw new ReturnsValidationError(legacy ? "LEGACY_RETURN_UNKNOWN" : "SALE_NOT_FOUND", legacy
          ? "Sale has no V2-09/V2-10 facts and remains legacy/unknown."
          : "Sale was not found.", legacy ? 409 : 404);
      }
      const reservation = this.db.prepare("SELECT status FROM inventory_reservations WHERE order_id=?").get(saleId) as any;
      if (reservation?.status !== "DISPATCHED") throw new ReturnsValidationError("PRE_DISPATCH_USE_CANCELLATION", "A sale that has not been dispatched must use cancellation, not a return.", 409);
      const finalization = this.db.prepare("SELECT id FROM sale_financial_cogs_finalizations WHERE financial_snapshot_id=?").get(sale.id);
      if (!finalization) throw new ReturnsValidationError("RETURN_COGS_PROVENANCE_REQUIRED", "The dispatched sale has no immutable V2-09 COGS finalization.", 409);

      const returnId = randomUUID();
      this.db.prepare(`INSERT INTO return_requests
        (id,sale_id,financial_snapshot_id,currency,request_operation_id,requested_by_actor_id,requested_by_actor_name,requested_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(returnId, saleId, sale.id, sale.currency, operationId, actor.id, actor.name, requestedAt);

      const insertLine = this.db.prepare(`INSERT INTO return_request_lines
        (id,return_id,financial_line_id,sale_line_id,quantity_base_int,reason_code,reason_explanation,created_at)
        VALUES (?,?,?,?,?,?,?,?)`);
      const insertMoney = this.db.prepare(`INSERT INTO return_financial_reversal_allocations
        (id,return_id,return_line_id,financial_line_id,quantity_base_int,gross_before_discount_minor,discount_minor,
         gross_minor,vat_minor,net_minor,gross_base_try_minor,vat_base_try_minor,net_base_try_minor,fx_observation_id,
         fx_rate_numerator,fx_rate_denominator,fx_source,fx_observed_at,fx_direction,formula_version,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertCogs = this.db.prepare(`INSERT INTO return_cogs_reversal_allocations
        (id,return_id,return_line_id,original_cogs_allocation_id,financial_line_id,component_product_id,inventory_lot_id,
         acquisition_cost_snapshot_id,quantity_base_int,base_uom_code_snapshot,cost_base_try_minor,
         original_dispatch_operation_id,formula_version,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

      for (const lineInput of normalizedLines) {
        const line = this.db.prepare("SELECT * FROM sale_financial_lines WHERE id=? AND financial_snapshot_id=?")
          .get(lineInput.financialLineId, sale.id) as any;
        if (!line) throw new ReturnsValidationError("RETURN_LINE_NOT_FOUND", "Return line does not belong to the immutable sale snapshot.", 404);
        const alreadyReturned = Number(this.db.prepare(`SELECT COALESCE(SUM(rl.quantity_base_int),0)
          FROM return_request_lines rl JOIN return_requests r ON r.id=rl.return_id
          WHERE r.financial_snapshot_id=? AND rl.financial_line_id=?`).pluck().get(sale.id, line.id));
        const nextReturned = alreadyReturned + lineInput.quantityBaseInt;
        if (nextReturned > Number(line.quantity_base_int)) throw new ReturnsValidationError("RETURN_QUANTITY_EXCEEDED", "Cumulative returned quantity cannot exceed the immutable original sale quantity.", 409);
        const returnLineId = randomUUID();
        insertLine.run(returnLineId, returnId, line.id, line.sale_line_id, lineInput.quantityBaseInt, lineInput.reasonCode, lineInput.explanation, requestedAt);
        const amount = (column: string) => proportionalDelta(Number(line[column]), alreadyReturned, nextReturned, Number(line.quantity_base_int), column);
        // Derive dependent amounts from independently conserved anchors so every
        // partial allocation satisfies the same exact money identities as the
        // immutable original, including awkward VAT/discount rounding splits.
        const grossBeforeDiscountMinor = amount("gross_before_discount_minor");
        const grossMinor = amount("gross_amount_minor");
        const netMinor = amount("net_revenue_minor");
        const grossBaseTryMinor = amount("gross_amount_base_try_minor");
        const netBaseTryMinor = amount("net_revenue_base_try_minor");
        insertMoney.run(randomUUID(), returnId, returnLineId, line.id, lineInput.quantityBaseInt,
          grossBeforeDiscountMinor, grossBeforeDiscountMinor - grossMinor, grossMinor,
          grossMinor - netMinor, netMinor, grossBaseTryMinor,
          grossBaseTryMinor - netBaseTryMinor, netBaseTryMinor, sale.fx_observation_id,
          sale.fx_rate_numerator, sale.fx_rate_denominator, sale.fx_source, sale.fx_observed_at, sale.fx_direction,
          "dsdst.return-financial-reversal.v1", requestedAt);

        const components = this.db.prepare(`SELECT component_product_id,quantity_base_int
          FROM sale_financial_line_components WHERE financial_line_id=? ORDER BY component_sequence`).all(line.id) as any[];
        for (const component of components) {
          const originalComponentQuantity = Number(component.quantity_base_int);
          if (originalComponentQuantity % Number(line.quantity_base_int) !== 0) {
            throw new ReturnsValidationError("RETURN_COMPONENT_ALLOCATION_INVALID", "Sale-time component quantity cannot be conserved as integer return units.", 409);
          }
          const componentPerSaleUnit = originalComponentQuantity / Number(line.quantity_base_int);
          let required = lineInput.quantityBaseInt * componentPerSaleUnit;
          let skip = alreadyReturned * componentPerSaleUnit;
          const allocations = this.db.prepare(`SELECT a.*,l.received_at FROM sale_financial_cogs_allocations a
            JOIN inventory_lots l ON l.id=a.inventory_lot_id
            WHERE a.financial_line_id=? AND a.component_product_id=?
            ORDER BY l.received_at,a.inventory_lot_id,a.id`).all(line.id, component.component_product_id) as any[];
          for (const allocation of allocations) {
            const allocationQuantity = Number(allocation.quantity_base_int);
            if (skip >= allocationQuantity) { skip -= allocationQuantity; continue; }
            const previouslyAllocated = skip;
            const take = Math.min(required, allocationQuantity - previouslyAllocated);
            skip = 0;
            if (take <= 0) continue;
            const cost = proportionalDelta(Number(allocation.cost_base_try_minor), previouslyAllocated, previouslyAllocated + take, allocationQuantity, "return COGS");
            insertCogs.run(randomUUID(), returnId, returnLineId, allocation.id, line.id, allocation.component_product_id,
              allocation.inventory_lot_id, allocation.acquisition_cost_snapshot_id, take, allocation.base_uom_code_snapshot,
              cost, allocation.dispatch_operation_id, "dsdst.return-original-fifo-cogs.v1", requestedAt);
            required -= take;
            if (required === 0) break;
          }
          if (required !== 0) throw new ReturnsValidationError("RETURN_COGS_ALLOCATION_MISMATCH", "Return cannot be mapped to the original dispatched component allocations.", 409);
        }
      }

      this.db.prepare(`INSERT INTO customer_shipping_refund_facts
        (id,return_id,amount_minor,currency,selected,operation_id,actor_id,recorded_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), returnId, shippingAmount, sale.currency, shippingSelected ? 1 : 0, operationId, actor.id, requestedAt);
      if (isMarketplace(sale.source_channel, sale.account_type)) {
        this.db.prepare(`INSERT INTO marketplace_commission_reversal_facts
          (id,return_id,state,original_commission_terms_json,recorded_at) VALUES (?,?,'PENDING_SETTLEMENT',?,?)`)
          .run(randomUUID(), returnId, sale.commission_terms_json, requestedAt);
      }
      return this.getReturn(returnId);
    }).immediate();
  }

  receiveReturn(input: {
    returnId: string;
    lines: Array<{ returnLineId: string; quantityBaseInt: number; disposition: ReturnDisposition; locationId?: string | null }>;
    operationId: string;
    actor: Actor;
    receivedAt?: string;
  }) {
    const returnId = text(input.returnId, "returnId");
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    const receivedAt = input.receivedAt ? instant(input.receivedAt, "receivedAt") : new Date().toISOString();
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new ReturnsValidationError("RETURN_RECEIPT_LINES_REQUIRED", "At least one inspected line is required.");

    return this.db.transaction(() => {
      const request = this.db.prepare("SELECT * FROM return_requests WHERE id=?").get(returnId) as any;
      if (!request) throw new ReturnsValidationError("RETURN_NOT_FOUND", "Return request was not found.", 404);
      const receiptId = randomUUID();
      this.db.prepare(`INSERT INTO return_receipts
        (id,return_id,receipt_operation_id,received_by_actor_id,received_by_actor_name,received_at) VALUES (?,?,?,?,?,?)`)
        .run(receiptId, returnId, operationId, actor.id, actor.name, receivedAt);
      const products = new Set<string>();

      for (const [index, raw] of input.lines.entries()) {
        const returnLineId = text(raw.returnLineId, `lines[${index}].returnLineId`);
        const quantity = positiveInteger(raw.quantityBaseInt, `lines[${index}].quantityBaseInt`);
        if (!dispositions.has(raw.disposition)) throw new ReturnsValidationError("RETURN_DISPOSITION_REQUIRED", "Every inspected quantity requires a valid disposition.");
        const requestLine = this.db.prepare("SELECT * FROM return_request_lines WHERE id=? AND return_id=?").get(returnLineId, returnId) as any;
        if (!requestLine) throw new ReturnsValidationError("RETURN_LINE_NOT_FOUND", "Return line was not found.", 404);
        const inspected = Number(this.db.prepare(`SELECT COALESCE(SUM(l.quantity_base_int),0) FROM return_receipt_lines l
          JOIN return_receipts r ON r.id=l.receipt_id WHERE r.return_id=? AND l.return_line_id=?`).pluck().get(returnId, returnLineId));
        if (inspected + quantity > Number(requestLine.quantity_base_int)) throw new ReturnsValidationError("RETURN_RECEIPT_QUANTITY_EXCEEDED", "Inspected quantity cannot exceed the approved return quantity.", 409);

        let location: any = null;
        const locationId = raw.disposition === "MISSING_NOT_RECEIVED" ? null : text(raw.locationId, `lines[${index}].locationId`);
        if (locationId) {
          location = this.db.prepare("SELECT id,role FROM warehouse_location_slots WHERE (id=? OR code=?) AND active=1").get(locationId, locationId) as any;
          if (!location) throw new ReturnsValidationError("RETURN_LOCATION_INVALID", "Return destination must be an active warehouse location.", 409);
          if (raw.disposition === "DAMAGED" && location.role !== "QUARANTINE") throw new ReturnsValidationError("RETURN_QUARANTINE_REQUIRED", "DAMAGED returns must be placed in a QUARANTINE location.", 409);
          if (raw.disposition === "SELLABLE" && location.role === "QUARANTINE") throw new ReturnsValidationError("RETURN_SELLABLE_LOCATION_INVALID", "SELLABLE returns require a non-quarantine active location.", 409);
        }

        const receiptLineId = randomUUID();
        this.db.prepare(`INSERT INTO return_receipt_lines
          (id,receipt_id,return_line_id,quantity_base_int,disposition,location_id,inspected_at) VALUES (?,?,?,?,?,?,?)`)
          .run(receiptLineId, receiptId, returnLineId, quantity, raw.disposition, location?.id ?? null, receivedAt);

        const cogs = this.db.prepare(`SELECT * FROM return_cogs_reversal_allocations
          WHERE return_line_id=? ORDER BY component_product_id,inventory_lot_id,id`).all(returnLineId) as any[];
        const components = new Map<string, any[]>();
        for (const allocation of cogs) components.set(allocation.component_product_id, [...(components.get(allocation.component_product_id) || []), allocation]);
        for (const [productId, allocations] of components) {
          const totalComponent = allocations.reduce((sum, row) => sum + Number(row.quantity_base_int), 0);
          if (totalComponent % Number(requestLine.quantity_base_int) !== 0) throw new ReturnsValidationError("RETURN_COMPONENT_ALLOCATION_INVALID", "Return component quantity cannot be inspected as integer units.", 409);
          let required = quantity * (totalComponent / Number(requestLine.quantity_base_int));
          for (const allocation of allocations) {
            const used = Number(this.db.prepare(`SELECT COALESCE(SUM(quantity_base_int),0) FROM return_receipt_inventory_allocations
              WHERE return_cogs_reversal_allocation_id=?`).pluck().get(allocation.id));
            const available = Number(allocation.quantity_base_int) - used;
            const take = Math.min(required, available);
            if (take <= 0) continue;
            const cost = proportionalDelta(Number(allocation.cost_base_try_minor), used, used + take, Number(allocation.quantity_base_int), "receipt return cost");
            const receiptAllocationId = randomUUID();
            let ledgerEventId: string | null = null;
            if (raw.disposition === "SELLABLE") {
              ledgerEventId = randomUUID();
              const changed = this.db.prepare("UPDATE inventory_lots SET on_hand_base_int=on_hand_base_int+?,status='USABLE',updated_at=? WHERE id=?")
                .run(take, receivedAt, allocation.inventory_lot_id);
              if (changed.changes !== 1) throw new ReturnsValidationError("ORIGINAL_INVENTORY_LOT_NOT_FOUND", "Original dispatched lot is unavailable.", 409);
              const locationKind = location.role === "PICKING" || location.role === "MIXED" ? "PICKING" : "RESERVE";
              this.db.prepare(`INSERT INTO inventory_lot_location_balances
                (id,lot_id,location_id,location_kind,quantity_base_int,active,physical_state,updated_at)
                VALUES (?,?,?,?,?,1,'CONFIRMED',?)
                ON CONFLICT(lot_id,location_id) DO UPDATE SET quantity_base_int=quantity_base_int+excluded.quantity_base_int,
                  active=1,physical_state='CONFIRMED',updated_at=excluded.updated_at`)
                .run(randomUUID(), allocation.inventory_lot_id, location.id, locationKind, take, receivedAt);
              this.db.prepare(`INSERT INTO inventory_ledger_events
                (id,operation_id,event_type,product_id,lot_id,order_id,quantity_delta_base_int,base_uom_code_snapshot,
                 reason_code,reference_type,reference_id,occurred_at)
                VALUES (?,?, 'RETURN',?,?,?,?,?,'RETURN_SELLABLE','return_receipt_line',?,?)`)
                .run(ledgerEventId, operationId, productId, allocation.inventory_lot_id, request.sale_id, take,
                  allocation.base_uom_code_snapshot, receiptLineId, receivedAt);
              products.add(productId);
            }
            this.db.prepare(`INSERT INTO return_receipt_inventory_allocations
              (id,receipt_line_id,return_cogs_reversal_allocation_id,component_product_id,original_inventory_lot_id,
               original_acquisition_cost_snapshot_id,quantity_base_int,cost_base_try_minor,disposition,inventory_ledger_event_id,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(receiptAllocationId, receiptLineId, allocation.id, productId,
              allocation.inventory_lot_id, allocation.acquisition_cost_snapshot_id, take, cost, raw.disposition, ledgerEventId, receivedAt);
            if (raw.disposition === "DAMAGED") {
              this.db.prepare(`INSERT INTO return_quarantine_facts
                (id,receipt_inventory_allocation_id,location_id,quantity_base_int,quarantined_at) VALUES (?,?,?,?,?)`)
                .run(randomUUID(), receiptAllocationId, location.id, take, receivedAt);
              this.db.prepare(`INSERT INTO return_loss_facts
                (id,return_id,receipt_inventory_allocation_id,amount_base_try_minor,original_acquisition_cost_snapshot_id,
                 original_cogs_allocation_id,operation_id,actor_id,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`)
                .run(randomUUID(), returnId, receiptAllocationId, cost, allocation.acquisition_cost_snapshot_id,
                  allocation.original_cogs_allocation_id, operationId, actor.id, receivedAt);
            }
            required -= take;
            if (required === 0) break;
          }
          if (required !== 0) throw new ReturnsValidationError("RETURN_RECEIPT_ALLOCATION_MISMATCH", "Inspected quantity exceeds remaining original return allocation.", 409);
        }
      }
      for (const productId of products) {
        this.db.prepare(`UPDATE products SET central_stock=COALESCE((SELECT SUM(on_hand_base_int) FROM inventory_lots WHERE product_id=?),0),updated_at=? WHERE id=?`)
          .run(productId, receivedAt, productId);
      }
      return this.getReturn(returnId);
    }).immediate();
  }

  approveRefund(input: {
    returnId: string;
    amountMinor: number;
    cashAccountId?: string | null;
    approvalReference: string;
    operationId: string;
    actor: Actor;
    approvedAt?: string;
  }) {
    const returnId = text(input.returnId, "returnId");
    const amountMinor = positiveInteger(input.amountMinor, "amountMinor");
    const approvalReference = text(input.approvalReference, "approvalReference", 500);
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    const approvedAt = input.approvedAt ? instant(input.approvedAt, "approvedAt") : new Date().toISOString();
    return this.db.transaction(() => {
      const request = this.db.prepare(`SELECT r.*,f.source_channel,s.cash_account_id,a.type AS original_account_type
        FROM return_requests r JOIN sale_financial_snapshots f ON f.id=r.financial_snapshot_id
        JOIN sales s ON s.id=r.sale_id LEFT JOIN cash_accounts a ON a.id=s.cash_account_id WHERE r.id=?`).get(returnId) as any;
      if (!request) throw new ReturnsValidationError("RETURN_NOT_FOUND", "Return request was not found.", 404);
      const incomplete = Number(this.db.prepare(`SELECT COUNT(*) FROM return_request_lines l WHERE l.return_id=? AND l.quantity_base_int<>
        COALESCE((SELECT SUM(rl.quantity_base_int) FROM return_receipt_lines rl JOIN return_receipts rr ON rr.id=rl.receipt_id
          WHERE rr.return_id=l.return_id AND rl.return_line_id=l.id),0)`).pluck().get(returnId));
      if (incomplete !== 0) throw new ReturnsValidationError("RETURN_INSPECTION_INCOMPLETE", "Refund approval requires completed warehouse inspection.", 409);
      const reversible = Number(this.db.prepare(`SELECT COALESCE(SUM(gross_minor),0) FROM return_financial_reversal_allocations WHERE return_id=?`).pluck().get(returnId));
      const shipping = Number(this.db.prepare("SELECT amount_minor FROM customer_shipping_refund_facts WHERE return_id=?").pluck().get(returnId));
      const paid = Number(this.db.prepare("SELECT COALESCE(SUM(amount_minor),0) FROM refund_payments WHERE return_id=?").pluck().get(returnId));
      if (paid + amountMinor > reversible + shipping) throw new ReturnsValidationError("REFUND_AMOUNT_EXCEEDED", "Cumulative refunds cannot exceed returned gross plus the selected customer shipping refund.", 409);

      const approvalId = randomUUID();
      const paymentId = randomUUID();
      const marketplace = isMarketplace(request.source_channel, request.original_account_type);
      this.db.prepare(`INSERT INTO refund_approvals
        (id,return_id,amount_minor,currency,approval_reference,approval_operation_id,approved_by_actor_id,approved_by_actor_name,approved_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(approvalId, returnId, amountMinor, request.currency, approvalReference, operationId, actor.id, actor.name, approvedAt);
      this.db.prepare(`INSERT INTO refund_payments
        (id,return_id,approval_id,amount_minor,currency,payment_mode,payment_operation_id,paid_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(paymentId, returnId, approvalId, amountMinor, request.currency, marketplace ? "MARKETPLACE_SETTLEMENT" : "DIRECT_CASH_BANK", operationId, approvedAt);
      if (marketplace) {
        if (input.cashAccountId) throw new ReturnsValidationError("MARKETPLACE_REFUND_CASH_FORBIDDEN", "Marketplace refunds use settlement/receivable flow and cannot decrease physical cash.", 409);
        this.db.prepare(`INSERT INTO refund_settlement_postings
          (id,refund_payment_id,state,amount_minor,currency,operation_id,recorded_at) VALUES (?,?,'PENDING_SETTLEMENT',?,?,?,?)`)
          .run(randomUUID(), paymentId, amountMinor, request.currency, operationId, approvedAt);
      } else {
        const cashAccountId = text(input.cashAccountId, "cashAccountId");
        const account = this.db.prepare("SELECT id,currency,type FROM cash_accounts WHERE id=? AND is_active=1").get(cashAccountId) as any;
        if (!account || account.type === "platform") throw new ReturnsValidationError("REFUND_CASH_ACCOUNT_INVALID", "Direct refund requires a selected active cash/bank account.", 409);
        if (String(account.currency).toUpperCase() !== request.currency) throw new ReturnsValidationError("REFUND_ACCOUNT_CURRENCY_MISMATCH", "Refund account currency must match the original sale currency.", 409);
        const legacyCashId = randomUUID();
        this.db.prepare(`INSERT INTO cash_transactions
          (id,account_id,type,amount,currency,exchange_rate_at_transaction,source_type,source_id,description,transaction_date)
          VALUES (?,?,'OUT',?,?,1,'v2_return_refund_projection',?,'V2-10 approved return refund',?)`)
          .run(legacyCashId, cashAccountId, amountMinor / 100, request.currency, paymentId, approvedAt);
        this.db.prepare(`INSERT INTO refund_cash_postings
          (id,refund_payment_id,cash_account_id,direction,amount_minor,currency,legacy_cash_transaction_id,operation_id,posted_at)
          VALUES (?,?,?,'OUT',?,?,?,?,?)`).run(randomUUID(), paymentId, cashAccountId, amountMinor, request.currency, legacyCashId, operationId, approvedAt);
      }
      return this.getReturn(returnId);
    }).immediate();
  }

  listApprovedReturns() {
    return (this.db.prepare("SELECT id FROM return_requests ORDER BY requested_at,id").all() as Array<{ id: string }>).map(({ id }) => this.getReturn(id))
      .filter((item) => item.inspection.remainingQuantityBaseInt > 0);
  }

  getSaleReturns(saleIdValue: string) {
    const saleId = text(saleIdValue, "saleId");
    const ids = this.db.prepare("SELECT id FROM return_requests WHERE sale_id=? ORDER BY requested_at,id").all(saleId) as Array<{ id: string }>;
    if (ids.length === 0) {
      const sale = this.db.prepare("SELECT status,return_reason,returned_at FROM sales WHERE id=?").get(saleId) as any;
      if (!sale) throw new ReturnsValidationError("SALE_NOT_FOUND", "Sale was not found.", 404);
      if (["İade", "İade Edildi"].includes(sale.status)) return { contract: "dsdst.returns.v1", saleId, legacyUnknown: true, legacy: sale, returns: [] };
    }
    return { contract: "dsdst.returns.v1", saleId, legacyUnknown: false, returns: ids.map(({ id }) => this.getReturn(id)) };
  }

  getReturn(returnIdValue: string): any {
    const returnId = text(returnIdValue, "returnId");
    const request = this.db.prepare(`SELECT r.*,f.source_channel,a.type AS original_account_type
      FROM return_requests r JOIN sale_financial_snapshots f ON f.id=r.financial_snapshot_id
      JOIN sales s ON s.id=r.sale_id LEFT JOIN cash_accounts a ON a.id=s.cash_account_id
      WHERE r.id=?`).get(returnId) as any;
    if (!request) throw new ReturnsValidationError("RETURN_NOT_FOUND", "Return request was not found.", 404);
    const lines = (this.db.prepare(`SELECT l.*,f.product_id,f.product_sku_snapshot,f.product_title_snapshot,f.quantity_base_int AS original_quantity,
        a.gross_before_discount_minor,a.discount_minor,a.gross_minor,a.vat_minor,a.net_minor,a.gross_base_try_minor,a.vat_base_try_minor,a.net_base_try_minor
      FROM return_request_lines l JOIN sale_financial_lines f ON f.id=l.financial_line_id
      JOIN return_financial_reversal_allocations a ON a.return_line_id=l.id WHERE l.return_id=? ORDER BY f.line_sequence`).all(returnId) as any[])
      .map((line) => {
        const dispositions = this.db.prepare(`SELECT rl.disposition,COALESCE(SUM(rl.quantity_base_int),0) AS quantity
          FROM return_receipt_lines rl JOIN return_receipts rr ON rr.id=rl.receipt_id
          WHERE rr.return_id=? AND rl.return_line_id=? GROUP BY rl.disposition`).all(returnId, line.id) as any[];
        return {
          id: line.id, financialLineId: line.financial_line_id, saleLineId: line.sale_line_id, productId: line.product_id,
          sku: line.product_sku_snapshot, title: line.product_title_snapshot, originalQuantityBaseInt: line.original_quantity,
          returnQuantityBaseInt: line.quantity_base_int, reasonCode: line.reason_code, explanation: line.reason_explanation,
          reversal: { grossBeforeDiscountMinor: line.gross_before_discount_minor, discountMinor: line.discount_minor,
            grossMinor: line.gross_minor, vatMinor: line.vat_minor, netMinor: line.net_minor,
            grossTryMinor: line.gross_base_try_minor, vatTryMinor: line.vat_base_try_minor, netTryMinor: line.net_base_try_minor },
          dispositions: Object.fromEntries(dispositions.map((row) => [row.disposition, Number(row.quantity)])),
          cogs: (this.db.prepare(`SELECT component_product_id AS componentProductId,inventory_lot_id AS inventoryLotId,
            acquisition_cost_snapshot_id AS acquisitionCostSnapshotId,quantity_base_int AS quantityBaseInt,
            cost_base_try_minor AS costTryMinor,original_dispatch_operation_id AS dispatchOperationId
            FROM return_cogs_reversal_allocations WHERE return_line_id=? ORDER BY component_product_id,inventory_lot_id`).all(line.id) as any[]),
        };
      });
    const requestedQuantity = lines.reduce((sum, line) => sum + Number(line.returnQuantityBaseInt), 0);
    const inspectedQuantity = lines.reduce((sum, line) => sum + Object.values(line.dispositions as Record<string, number>).reduce((a, b) => a + b, 0), 0);
    const reversal = (field: string) => lines.reduce((sum, line) => sum + Number(line.reversal[field]), 0);
    const refunded = Number(this.db.prepare("SELECT COALESCE(SUM(amount_minor),0) FROM refund_payments WHERE return_id=?").pluck().get(returnId));
    const shipping = this.db.prepare("SELECT selected,amount_minor,currency FROM customer_shipping_refund_facts WHERE return_id=?").get(returnId) as any;
    const commission = this.db.prepare("SELECT state FROM marketplace_commission_reversal_facts WHERE return_id=?").get(returnId) as any;
    const returnLoss = Number(this.db.prepare("SELECT COALESCE(SUM(amount_base_try_minor),0) FROM return_loss_facts WHERE return_id=?").pluck().get(returnId));
    const refunds = this.db.prepare(`SELECT p.id,p.amount_minor AS amountMinor,p.currency,p.payment_mode AS paymentMode,p.paid_at AS paidAt,
      a.approval_reference AS approvalReference,a.approved_by_actor_id AS approvedByActorId
      FROM refund_payments p JOIN refund_approvals a ON a.id=p.approval_id WHERE p.return_id=? ORDER BY p.paid_at,p.id`).all(returnId);
    const maximumRefund = reversal("grossMinor") + Number(shipping.amount_minor);
    return {
      contract: "dsdst.returns.v1", id: request.id, saleId: request.sale_id, currency: request.currency,
      requestedAt: request.requested_at, requestedByActorId: request.requested_by_actor_id, lines,
      financialReversal: { grossBeforeDiscountMinor: reversal("grossBeforeDiscountMinor"), discountMinor: reversal("discountMinor"),
        grossMinor: reversal("grossMinor"), vatMinor: reversal("vatMinor"), netMinor: reversal("netMinor") },
      inspection: { requestedQuantityBaseInt: requestedQuantity, inspectedQuantityBaseInt: inspectedQuantity,
        remainingQuantityBaseInt: requestedQuantity - inspectedQuantity, complete: requestedQuantity === inspectedQuantity },
      customerShippingRefund: { selected: Boolean(shipping.selected), amountMinor: Number(shipping.amount_minor), currency: shipping.currency },
      refundMode: isMarketplace(request.source_channel, request.original_account_type) ? "MARKETPLACE_SETTLEMENT" : "DIRECT_CASH_BANK",
      commissionReversalState: commission?.state ?? null, returnLossTryMinor: returnLoss, refunds,
      refundable: { maximumMinor: maximumRefund, refundedMinor: refunded, remainingMinor: maximumRefund - refunded },
    };
  }
}
