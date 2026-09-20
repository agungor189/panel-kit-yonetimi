import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ExchangeRateService, type FxSnapshot } from "../finance/exchangeRates.js";
import { integerMoney, multiplyAndRound, reduceRational, roundRatio, splitVat, type Rational } from "../finance/money.js";

export type SaleExpenseCategory = "shipping" | "packaging" | "advertising" | "other";
export type ExpenseFactInput = {
  state: "KNOWN" | "UNKNOWN";
  amountMinor?: number;
  currency?: string;
  provenance?: unknown;
};

type Actor = { id: string; name?: string | null };
type CommissionBasis = "GROSS_BEFORE_DISCOUNT" | "GROSS_AFTER_DISCOUNT";

export class SalesFinancialValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "SalesFinancialValidationError";
  }
}

const FORMULA_VERSION = "dsdst.sale-financial.v1";
const COGS_FORMULA_VERSION = "dsdst.sale-fifo-cogs.v1";
const categories = ["SHIPPING", "PACKAGING", "ADVERTISING", "OTHER"] as const;
const inputCategory = {
  shipping: "SHIPPING",
  packaging: "PACKAGING",
  advertising: "ADVERTISING",
  other: "OTHER",
} as const;

const text = (value: unknown, field: string, max = 300) => {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", `${field} is invalid.`);
  }
  return result;
};

const currencyCode = (value: unknown) => {
  const valueText = text(value, "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(valueText)) throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", "currency must be an ISO three-letter code.");
  return valueText;
};

const timestamp = (value: unknown, field: string) => {
  const result = text(value, field, 50);
  if (!Number.isFinite(Date.parse(result))) throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", `${field} must be an ISO timestamp.`);
  return result;
};

const safeAdd = (values: number[], field: string) => {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new SalesFinancialValidationError("MONEY_OVERFLOW", `${field} exceeds safe integer precision.`);
  return total;
};

const safeMultiply = (left: number, right: number, field: string) => {
  const product = BigInt(left) * BigInt(right);
  const result = Number(product);
  if (!Number.isSafeInteger(result)) throw new SalesFinancialValidationError("MONEY_OVERFLOW", `${field} exceeds safe integer precision.`);
  return result;
};

const positiveInteger = (value: unknown, field: string) => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", `${field} must be a positive integer.`);
  return Number(value);
};

const nonNegativeDecimalRatio = (value: unknown, field: string): Rational => {
  const source = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,8}))?$/.exec(source);
  if (!match) throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", `${field} must be a non-negative decimal with at most 8 fraction digits.`);
  const fraction = match[2] || "";
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(match[1]) * denominator + BigInt(fraction || "0");
  return reduceRational(numerator, denominator, field);
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", "provenance must be JSON-compatible.");
};

const allocate = <T extends { key: string; weight: number }>(amount: number, weights: T[]) => {
  const totalWeight = safeAdd(weights.map(({ weight }) => weight), "allocation weight");
  if (amount === 0) return weights.map((entry) => ({ ...entry, allocated: 0 }));
  if (totalWeight === 0 || amount > totalWeight) throw new SalesFinancialValidationError("INVALID_DISCOUNT", "Discount cannot exceed gross sale amount.");
  const base = weights.map((entry) => {
    const product = BigInt(amount) * BigInt(entry.weight);
    return { ...entry, allocated: Number(product / BigInt(totalWeight)), remainder: product % BigInt(totalWeight) };
  });
  let residual = amount - safeAdd(base.map(({ allocated }) => allocated), "allocation floor");
  const priority = [...base].sort((left, right) => left.remainder === right.remainder
    ? left.key.localeCompare(right.key)
    : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; index < residual; index += 1) priority[index].allocated += 1;
  return base.map(({ remainder: _remainder, ...entry }) => entry);
};

const actorInput = (actor: Actor) => ({ id: text(actor.id, "actor.id"), name: actor.name ? text(actor.name, "actor.name") : null });

export class SalesFinancialService {
  private readonly fx: ExchangeRateService;

  constructor(private readonly db: Database.Database) {
    this.fx = new ExchangeRateService(db);
  }

  createOrderSnapshot(input: {
    saleId: string;
    currency: string;
    sourceChannel: string;
    discountMinor: number;
    commissionRatePercent: string | number;
    commissionCalculationBasis: CommissionBasis;
    commissionTerms: unknown;
    expenses?: Partial<Record<SaleExpenseCategory, ExpenseFactInput>>;
    lines: Array<{ saleLineId: string; productId: string; quantity: number; unitGrossMinor: number; vatRateBps: number }>;
    operationId: string;
    actor: Actor;
    createdAt?: string;
  }) {
    const saleId = text(input.saleId, "saleId");
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    const createdAt = input.createdAt ? timestamp(input.createdAt, "createdAt") : new Date().toISOString();
    const currency = currencyCode(input.currency);
    const sourceChannel = text(input.sourceChannel, "sourceChannel");
    const discountMinor = integerMoney(input.discountMinor, "discountMinor");
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", "At least one financial sale line is required.");
    if (!(["GROSS_BEFORE_DISCOUNT", "GROSS_AFTER_DISCOUNT"] as const).includes(input.commissionCalculationBasis)) {
      throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", "commissionCalculationBasis is unsupported.");
    }
    const percent = nonNegativeDecimalRatio(input.commissionRatePercent, "commissionRatePercent");
    const commissionRate = reduceRational(BigInt(percent.numerator), BigInt(percent.denominator) * 100n, "commissionRate");
    if (commissionRate.numerator > commissionRate.denominator) throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", "commissionRatePercent cannot exceed 100.");
    const commissionTermsJson = stableJson(input.commissionTerms);
    const fx = this.fx.snapshotFor(currency, createdAt);

    return this.db.transaction(() => {
      const sale = this.db.prepare("SELECT id FROM sales WHERE id=?").get(saleId);
      if (!sale) throw new SalesFinancialValidationError("SALE_NOT_FOUND", "Sale was not found.", 404);
      const existing = this.db.prepare("SELECT created_operation_id FROM sale_financial_snapshots WHERE sale_id=?").get(saleId) as { created_operation_id: string } | undefined;
      if (existing) {
        if (existing.created_operation_id !== operationId) throw new SalesFinancialValidationError("SALE_FINANCIAL_SNAPSHOT_EXISTS", "The sale already has an immutable financial snapshot.", 409);
        return this.getSaleFinancial(saleId)!;
      }

      const normalizedLines = input.lines.map((line, lineSequence) => {
        const saleLineId = text(line.saleLineId, `lines[${lineSequence}].saleLineId`);
        const productId = text(line.productId, `lines[${lineSequence}].productId`);
        const quantity = positiveInteger(line.quantity, `lines[${lineSequence}].quantity`);
        const unitGrossMinor = integerMoney(line.unitGrossMinor, `lines[${lineSequence}].unitGrossMinor`);
        if (!Number.isSafeInteger(line.vatRateBps) || line.vatRateBps < 0 || line.vatRateBps > 10_000) {
          throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", `lines[${lineSequence}].vatRateBps must be an integer between 0 and 10000.`);
        }
        const saleLine = this.db.prepare("SELECT sale_id,product_id,quantity FROM sale_items WHERE id=?").get(saleLineId) as any;
        if (!saleLine || saleLine.sale_id !== saleId || saleLine.product_id !== productId || Number(saleLine.quantity) !== quantity) {
          throw new SalesFinancialValidationError("SALE_LINE_MISMATCH", "Financial line identity must match the canonical sale line.", 409);
        }
        const product = this.db.prepare(`SELECT id,sku,title,name,catalog_version,catalog_version_ref,base_uom_code
          FROM products WHERE id=? AND catalog_version>0`).get(productId) as any;
        if (!product?.sku || !product.catalog_version_ref) throw new SalesFinancialValidationError("CATALOG_SNAPSHOT_REQUIRED", `Product ${productId} has no versioned catalog identity.`, 409);
        const grossBeforeDiscountMinor = safeMultiply(unitGrossMinor, quantity, "line gross");
        return { lineSequence, saleLineId, product, quantity, unitGrossMinor, vatRateBps: Number(line.vatRateBps), grossBeforeDiscountMinor };
      });
      if (new Set(normalizedLines.map(({ saleLineId }) => saleLineId)).size !== normalizedLines.length) throw new SalesFinancialValidationError("SALE_LINE_MISMATCH", "Sale lines must be unique.");

      const grossBeforeDiscountMinor = safeAdd(normalizedLines.map((line) => line.grossBeforeDiscountMinor), "sale gross");
      if (discountMinor > grossBeforeDiscountMinor) throw new SalesFinancialValidationError("INVALID_DISCOUNT", "Discount cannot exceed gross sale amount.");
      const discountShares = new Map<string, number>(allocate(discountMinor, normalizedLines.map((line) => ({ key: line.saleLineId, weight: line.grossBeforeDiscountMinor })))
        .map((entry): [string, number] => [entry.key, entry.allocated]));
      const lines = normalizedLines.map((line) => {
        const allocatedDiscount = discountShares.get(line.saleLineId)!;
        const amounts = splitVat(line.grossBeforeDiscountMinor - allocatedDiscount, "INCLUDED", line.vatRateBps);
        return {
          ...line,
          allocatedDiscount,
          ...amounts,
          baseTry: {
            grossMinor: multiplyAndRound(amounts.grossMinor, fx, "sale line gross TRY"),
            netMinor: multiplyAndRound(amounts.netMinor, fx, "sale line net TRY"),
          },
        };
      }).map((line) => ({ ...line, baseTry: { ...line.baseTry, vatMinor: line.baseTry.grossMinor - line.baseTry.netMinor } }));
      const grossMinor = safeAdd(lines.map((line) => line.grossMinor), "gross amount");
      const vatMinor = safeAdd(lines.map((line) => line.vatMinor), "VAT amount");
      const netRevenueMinor = safeAdd(lines.map((line) => line.netMinor), "net revenue");
      const grossTryMinor = safeAdd(lines.map((line) => line.baseTry.grossMinor), "gross TRY");
      const vatTryMinor = safeAdd(lines.map((line) => line.baseTry.vatMinor), "VAT TRY");
      const netTryMinor = safeAdd(lines.map((line) => line.baseTry.netMinor), "net TRY");
      const commissionBasisMinor = input.commissionCalculationBasis === "GROSS_BEFORE_DISCOUNT" ? grossBeforeDiscountMinor : grossMinor;
      const commissionMinor = multiplyAndRound(commissionBasisMinor, commissionRate, "commission");
      const commissionTryMinor = multiplyAndRound(commissionMinor, fx, "commission TRY");
      const snapshotId = randomUUID();
      this.db.prepare(`INSERT INTO sale_financial_snapshots (
        id,sale_id,snapshot_version,formula_version,currency,source_channel,gross_before_discount_minor,discount_minor,
        gross_amount_minor,vat_amount_minor,net_revenue_minor,gross_amount_base_try_minor,vat_amount_base_try_minor,
        net_revenue_base_try_minor,commission_rate_numerator,commission_rate_denominator,commission_calculation_basis,
        commission_terms_json,commission_amount_minor,commission_base_try_minor,fx_observation_id,fx_rate_numerator,
        fx_rate_denominator,fx_source,fx_observed_at,fx_direction,created_operation_id,created_actor_id,created_actor_name,created_at
      ) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        snapshotId, saleId, FORMULA_VERSION, currency, sourceChannel, grossBeforeDiscountMinor, discountMinor,
        grossMinor, vatMinor, netRevenueMinor, grossTryMinor, vatTryMinor, netTryMinor,
        commissionRate.numerator, commissionRate.denominator, input.commissionCalculationBasis, commissionTermsJson,
        commissionMinor, commissionTryMinor, fx.observationId, fx.numerator, fx.denominator, fx.source, fx.observedAt,
        fx.direction, operationId, actor.id, actor.name, createdAt,
      );

      const insertLine = this.db.prepare(`INSERT INTO sale_financial_lines (
        id,financial_snapshot_id,sale_line_id,line_sequence,product_id,product_sku_snapshot,product_title_snapshot,
        catalog_version_snapshot,catalog_version_ref_snapshot,base_uom_code_snapshot,quantity_base_int,unit_gross_minor,
        gross_before_discount_minor,discount_allocation_minor,gross_amount_minor,vat_rate_bps,vat_amount_minor,
        net_revenue_minor,gross_amount_base_try_minor,vat_amount_base_try_minor,net_revenue_base_try_minor,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertComponent = this.db.prepare(`INSERT INTO sale_financial_line_components (
        id,financial_line_id,component_sequence,component_product_id,component_sku_snapshot,component_title_snapshot,
        component_catalog_version,component_catalog_version_ref,component_role_snapshot,quantity_base_int,base_uom_code_snapshot,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const line of lines) {
        const financialLineId = randomUUID();
        insertLine.run(financialLineId, snapshotId, line.saleLineId, line.lineSequence, line.product.id, line.product.sku,
          line.product.title || line.product.name || line.product.sku, line.product.catalog_version, line.product.catalog_version_ref,
          line.product.base_uom_code, line.quantity, line.unitGrossMinor, line.grossBeforeDiscountMinor, line.allocatedDiscount,
          line.grossMinor, line.vatRateBps, line.vatMinor, line.netMinor, line.baseTry.grossMinor, line.baseTry.vatMinor,
          line.baseTry.netMinor, createdAt);
        const bom = this.db.prepare(`SELECT b.component_product_id,b.quantity_per_unit,b.component_role,
          p.sku,p.title,p.name,p.catalog_version,p.catalog_version_ref,p.base_uom_code
          FROM product_bom b JOIN products p ON p.id=b.component_product_id
          WHERE b.parent_product_id=? ORDER BY b.component_product_id`).all(line.product.id) as any[];
        const components = bom.length > 0 ? bom : [{
          component_product_id: line.product.id, quantity_per_unit: 1, component_role: null,
          sku: line.product.sku, title: line.product.title, name: line.product.name,
          catalog_version: line.product.catalog_version, catalog_version_ref: line.product.catalog_version_ref,
          base_uom_code: line.product.base_uom_code,
        }];
        components.forEach((component, componentSequence) => {
          if (!Number.isSafeInteger(component.quantity_per_unit) || Number(component.quantity_per_unit) <= 0) {
            throw new SalesFinancialValidationError("INVALID_BOM_QUANTITY", "Sale-time BOM requires positive base-unit integer component quantities.", 409);
          }
          const componentQuantity = positiveInteger(Number(component.quantity_per_unit) * line.quantity, "component.quantityBaseInt");
          if (!component.sku || !component.catalog_version_ref || Number(component.catalog_version) <= 0) {
            throw new SalesFinancialValidationError("CATALOG_SNAPSHOT_REQUIRED", "BOM component has no versioned catalog identity.", 409);
          }
          insertComponent.run(randomUUID(), financialLineId, componentSequence, component.component_product_id, component.sku,
            component.title || component.name || component.sku, component.catalog_version, component.catalog_version_ref,
            component.component_role || null, componentQuantity, component.base_uom_code, createdAt);
        });
      }

      for (const category of categories) {
        const key = category.toLowerCase() as SaleExpenseCategory;
        const fact = input.expenses?.[key] || { state: "UNKNOWN" as const };
        this.insertExpense(snapshotId, category, 1, fact, operationId, actor, createdAt, currency, fx);
      }
      return this.getSaleFinancial(saleId)!;
    }).immediate();
  }

  recordExpenseFact(input: {
    saleId: string;
    category: SaleExpenseCategory;
    state: "KNOWN" | "UNKNOWN";
    amountMinor?: number;
    currency?: string;
    provenance?: unknown;
    operationId: string;
    actor: Actor;
    recordedAt?: string;
  }) {
    const saleId = text(input.saleId, "saleId");
    const category = inputCategory[input.category];
    if (!category) throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", "Expense category is unsupported.");
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    const recordedAt = input.recordedAt ? timestamp(input.recordedAt, "recordedAt") : new Date().toISOString();
    return this.db.transaction(() => {
      const snapshot = this.db.prepare("SELECT id,currency FROM sale_financial_snapshots WHERE sale_id=?").get(saleId) as any;
      if (!snapshot) throw new SalesFinancialValidationError("SALE_FINANCIAL_SNAPSHOT_NOT_FOUND", "The sale has no V2-09 financial snapshot.", 409);
      const existingOperation = this.db.prepare(`SELECT id FROM sale_financial_expense_facts
        WHERE financial_snapshot_id=? AND category=? AND operation_id=?`).get(snapshot.id, category, operationId);
      if (existingOperation) return this.getSaleFinancial(saleId)!;
      const nextVersion = Number(this.db.prepare(`SELECT COALESCE(MAX(fact_version),0)+1 FROM sale_financial_expense_facts
        WHERE financial_snapshot_id=? AND category=?`).pluck().get(snapshot.id, category));
      this.insertExpense(snapshot.id, category, nextVersion, input, operationId, actor, recordedAt, snapshot.currency);
      return this.getSaleFinancial(saleId)!;
    }).immediate();
  }

  finalizeDispatch(input: { reservationId: string; operationId: string; actor: Actor; finalizedAt?: string }) {
    const reservationId = text(input.reservationId, "reservationId");
    const operationId = text(input.operationId, "operationId");
    const actor = actorInput(input.actor);
    const finalizedAt = input.finalizedAt ? timestamp(input.finalizedAt, "finalizedAt") : new Date().toISOString();
    return this.db.transaction(() => {
      const reservation = this.db.prepare("SELECT id,order_id,status,shipment_id,dispatch_operation_id FROM inventory_reservations WHERE id=?").get(reservationId) as any;
      if (!reservation) return null;
      const snapshot = this.db.prepare("SELECT id FROM sale_financial_snapshots WHERE sale_id=?").get(reservation.order_id) as any;
      if (!snapshot) return this.getSaleFinancial(reservation.order_id);
      const existing = this.db.prepare("SELECT dispatch_operation_id FROM sale_financial_cogs_finalizations WHERE financial_snapshot_id=?").get(snapshot.id) as any;
      if (existing) {
        if (existing.dispatch_operation_id !== operationId) throw new SalesFinancialValidationError("COGS_ALREADY_FINALIZED", "Sale COGS was already finalized by another dispatch operation.", 409);
        return this.getSaleFinancial(reservation.order_id);
      }
      if (reservation.status !== "DISPATCHED" || !reservation.shipment_id || reservation.dispatch_operation_id !== operationId) {
        throw new SalesFinancialValidationError("DISPATCH_NOT_FINAL", "COGS can only be finalized for the exact approved dispatch operation.", 409);
      }
      const dispatchedLots = this.db.prepare(`SELECT a.product_id,a.lot_id,a.quantity_base_int,a.fifo_sequence,
        l.acquisition_cost_snapshot_id,l.base_uom_code_snapshot,c.normalized_cost_numerator,c.normalized_cost_denominator
        FROM inventory_reservation_allocations a
        JOIN inventory_lots l ON l.id=a.lot_id
        JOIN acquisition_lot_cost_snapshots c ON c.id=l.acquisition_cost_snapshot_id
        JOIN inventory_ledger_events e ON e.reservation_id=a.reservation_id AND e.lot_id=a.lot_id
          AND e.event_type='DISPATCH' AND e.operation_id=?
        WHERE a.reservation_id=? ORDER BY a.product_id,a.fifo_sequence,a.lot_id`).all(operationId, reservationId) as any[];
      const demands = (this.db.prepare(`SELECT c.financial_line_id,l.sale_line_id,c.component_product_id,c.quantity_base_int
        FROM sale_financial_line_components c JOIN sale_financial_lines l ON l.id=c.financial_line_id
        WHERE l.financial_snapshot_id=? ORDER BY c.component_product_id,l.line_sequence,c.component_sequence`).all(snapshot.id) as any[])
        .map((row) => ({ ...row, remaining: Number(row.quantity_base_int) }));
      const insert = this.db.prepare(`INSERT INTO sale_financial_cogs_allocations (
        id,financial_snapshot_id,financial_line_id,sale_line_id,component_product_id,inventory_lot_id,
        acquisition_cost_snapshot_id,quantity_base_int,base_uom_code_snapshot,unit_cost_numerator,
        unit_cost_denominator,cost_base_try_minor,cost_formula_version,dispatch_operation_id,actor_id,actor_name,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      let totalCogs = 0;
      for (const lot of dispatchedLots) {
        let remaining = Number(lot.quantity_base_int);
        let consumedFromLot = 0;
        const matching = demands.filter((demand) => demand.component_product_id === lot.product_id && demand.remaining > 0);
        for (const demand of matching) {
          if (remaining === 0) break;
          const quantity = Math.min(remaining, demand.remaining);
          const priorCost = roundRatio(BigInt(consumedFromLot) * BigInt(lot.normalized_cost_numerator), BigInt(lot.normalized_cost_denominator), "prior lot COGS");
          consumedFromLot += quantity;
          const cumulativeCost = roundRatio(BigInt(consumedFromLot) * BigInt(lot.normalized_cost_numerator), BigInt(lot.normalized_cost_denominator), "lot COGS");
          const cost = cumulativeCost - priorCost;
          insert.run(randomUUID(), snapshot.id, demand.financial_line_id, demand.sale_line_id, lot.product_id, lot.lot_id,
            lot.acquisition_cost_snapshot_id, quantity, lot.base_uom_code_snapshot, lot.normalized_cost_numerator,
            lot.normalized_cost_denominator, cost, COGS_FORMULA_VERSION, operationId, actor.id, actor.name, finalizedAt);
          demand.remaining -= quantity;
          remaining -= quantity;
          totalCogs = safeAdd([totalCogs, cost], "total COGS");
        }
        if (remaining !== 0) throw new SalesFinancialValidationError("COGS_ALLOCATION_MISMATCH", "Dispatched FIFO lot quantity cannot be mapped to the immutable sale-time BOM.", 409);
      }
      if (demands.some((demand) => demand.remaining !== 0)) throw new SalesFinancialValidationError("COGS_ALLOCATION_MISMATCH", "Sale-time BOM demand is not fully represented by dispatched FIFO allocations.", 409);
      this.db.prepare(`INSERT INTO sale_financial_cogs_finalizations (
        id,financial_snapshot_id,reservation_id,shipment_id,dispatch_operation_id,total_cogs_base_try_minor,
        formula_version,actor_id,actor_name,finalized_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), snapshot.id, reservationId, reservation.shipment_id,
        operationId, totalCogs, COGS_FORMULA_VERSION, actor.id, actor.name, finalizedAt);
      return this.getSaleFinancial(reservation.order_id);
    }).immediate();
  }

  getSaleFinancial(saleIdValue: string): any | null {
    const saleId = text(saleIdValue, "saleId");
    const sale = this.db.prepare("SELECT id FROM sales WHERE id=?").get(saleId);
    if (!sale) return null;
    const snapshot = this.db.prepare("SELECT * FROM sale_financial_snapshots WHERE sale_id=?").get(saleId) as any;
    if (!snapshot) return { contract: FORMULA_VERSION, saleId, state: "LEGACY_UNSNAPSHOTTED", snapshot: null, lines: [], expenses: {} };
    const expenseRows = this.db.prepare(`SELECT e.* FROM sale_financial_expense_facts e
      JOIN (SELECT category,MAX(fact_version) AS version FROM sale_financial_expense_facts WHERE financial_snapshot_id=? GROUP BY category) latest
        ON latest.category=e.category AND latest.version=e.fact_version
      WHERE e.financial_snapshot_id=? ORDER BY e.category`).all(snapshot.id, snapshot.id) as any[];
    const expenses: Record<string, any> = {};
    for (const row of expenseRows) expenses[row.category.toLowerCase()] = {
      state: row.state,
      version: row.fact_version,
      amountMinor: row.amount_minor,
      currency: row.currency,
      amountTryMinor: row.amount_base_try_minor,
      provenance: JSON.parse(row.provenance_json),
      operationId: row.operation_id,
      recordedAt: row.recorded_at,
    };
    const finalization = this.db.prepare("SELECT * FROM sale_financial_cogs_finalizations WHERE financial_snapshot_id=?").get(snapshot.id) as any;
    const lines = (this.db.prepare("SELECT * FROM sale_financial_lines WHERE financial_snapshot_id=? ORDER BY line_sequence").all(snapshot.id) as any[]).map((line) => ({
      id: line.id,
      saleLineId: line.sale_line_id,
      productId: line.product_id,
      productSku: line.product_sku_snapshot,
      productTitle: line.product_title_snapshot,
      catalogVersion: line.catalog_version_snapshot,
      catalogVersionRef: line.catalog_version_ref_snapshot,
      quantityBaseInt: line.quantity_base_int,
      baseUomCode: line.base_uom_code_snapshot,
      unitGrossMinor: line.unit_gross_minor,
      grossBeforeDiscountMinor: line.gross_before_discount_minor,
      discountMinor: line.discount_allocation_minor,
      grossMinor: line.gross_amount_minor,
      vatRateBps: line.vat_rate_bps,
      vatMinor: line.vat_amount_minor,
      netRevenueMinor: line.net_revenue_minor,
      components: (this.db.prepare("SELECT * FROM sale_financial_line_components WHERE financial_line_id=? ORDER BY component_sequence").all(line.id) as any[]).map((component) => ({
        productId: component.component_product_id,
        sku: component.component_sku_snapshot,
        title: component.component_title_snapshot,
        catalogVersion: component.component_catalog_version,
        catalogVersionRef: component.component_catalog_version_ref,
        role: component.component_role_snapshot,
        quantityBaseInt: component.quantity_base_int,
        baseUomCode: component.base_uom_code_snapshot,
      })),
      cogsAllocations: (this.db.prepare("SELECT * FROM sale_financial_cogs_allocations WHERE financial_line_id=? ORDER BY inventory_lot_id").all(line.id) as any[]).map((allocation) => ({
        inventoryLotId: allocation.inventory_lot_id,
        acquisitionCostSnapshotId: allocation.acquisition_cost_snapshot_id,
        componentProductId: allocation.component_product_id,
        quantityBaseInt: allocation.quantity_base_int,
        baseUomCode: allocation.base_uom_code_snapshot,
        unitCost: { numerator: allocation.unit_cost_numerator, denominator: allocation.unit_cost_denominator },
        costTryMinor: allocation.cost_base_try_minor,
        operationId: allocation.dispatch_operation_id,
      })),
    }));
    const knownExpenseTryMinor = safeAdd(expenseRows.filter((row) => row.state === "KNOWN").map((row) => Number(row.amount_base_try_minor)), "known expenses");
    const unknownExpense = expenseRows.some((row) => row.state === "UNKNOWN");
    const actualCogsTryMinor = finalization ? Number(finalization.total_cogs_base_try_minor) : null;
    const grossProfitTryMinor = actualCogsTryMinor === null ? null : Number(snapshot.net_revenue_base_try_minor) - actualCogsTryMinor;
    const provisionalNetContributionTryMinor = grossProfitTryMinor === null ? null
      : grossProfitTryMinor - Number(snapshot.commission_base_try_minor) - knownExpenseTryMinor;
    const state = !finalization ? "COGS_PENDING" : unknownExpense ? "PROVISIONAL" : "FINAL";
    return {
      contract: FORMULA_VERSION,
      saleId,
      snapshot: { id: snapshot.id, version: snapshot.snapshot_version, formulaVersion: snapshot.formula_version, operationId: snapshot.created_operation_id, actorId: snapshot.created_actor_id, createdAt: snapshot.created_at },
      state,
      currency: snapshot.currency,
      sourceChannel: snapshot.source_channel,
      fx: { observationId: snapshot.fx_observation_id, numerator: snapshot.fx_rate_numerator, denominator: snapshot.fx_rate_denominator, source: snapshot.fx_source, observedAt: snapshot.fx_observed_at, direction: snapshot.fx_direction },
      commission: { rate: { numerator: snapshot.commission_rate_numerator, denominator: snapshot.commission_rate_denominator }, calculationBasis: snapshot.commission_calculation_basis, terms: JSON.parse(snapshot.commission_terms_json) },
      totals: {
        grossBeforeDiscountMinor: snapshot.gross_before_discount_minor,
        discountMinor: snapshot.discount_minor,
        grossMinor: snapshot.gross_amount_minor,
        vatMinor: snapshot.vat_amount_minor,
        netRevenueMinor: snapshot.net_revenue_minor,
        commissionMinor: snapshot.commission_amount_minor,
        grossTryMinor: snapshot.gross_amount_base_try_minor,
        vatTryMinor: snapshot.vat_amount_base_try_minor,
        netRevenueTryMinor: snapshot.net_revenue_base_try_minor,
        commissionTryMinor: snapshot.commission_base_try_minor,
        actualCogsTryMinor,
        grossProfitTryMinor,
        knownExpenseTryMinor,
        provisionalNetContributionTryMinor,
        netContributionTryMinor: !unknownExpense ? provisionalNetContributionTryMinor : null,
      },
      expenses,
      cogsFinalization: finalization ? { reservationId: finalization.reservation_id, shipmentId: finalization.shipment_id, operationId: finalization.dispatch_operation_id, finalizedAt: finalization.finalized_at } : null,
      lines,
    };
  }

  private insertExpense(
    snapshotId: string,
    category: typeof categories[number],
    version: number,
    input: ExpenseFactInput,
    operationId: string,
    actor: { id: string; name: string | null },
    recordedAt: string,
    saleCurrency: string,
    saleFx?: FxSnapshot,
  ) {
    if (input.state !== "KNOWN" && input.state !== "UNKNOWN") throw new SalesFinancialValidationError("SALE_FINANCIAL_VALIDATION_FAILED", "Expense state must be KNOWN or UNKNOWN.");
    if (input.state === "UNKNOWN") {
      this.db.prepare(`INSERT INTO sale_financial_expense_facts (
        id,financial_snapshot_id,category,fact_version,state,provenance_json,operation_id,actor_id,actor_name,recorded_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), snapshotId, category, version, "UNKNOWN",
        stableJson(input.provenance ?? { state: "NOT_KNOWN" }), operationId, actor.id, actor.name, recordedAt);
      return;
    }
    const amountMinor = integerMoney(input.amountMinor, `${category}.amountMinor`);
    const currency = currencyCode(input.currency || saleCurrency);
    if (input.provenance === undefined || input.provenance === null) throw new SalesFinancialValidationError("EXPENSE_PROVENANCE_REQUIRED", `Known ${category.toLowerCase()} expense requires provenance.`);
    const fx = saleFx && currency === saleCurrency ? saleFx : this.fx.snapshotFor(currency, recordedAt);
    const amountTryMinor = multiplyAndRound(amountMinor, fx, `${category} expense TRY`);
    this.db.prepare(`INSERT INTO sale_financial_expense_facts (
      id,financial_snapshot_id,category,fact_version,state,amount_minor,currency,amount_base_try_minor,
      fx_observation_id,fx_rate_numerator,fx_rate_denominator,fx_source,fx_observed_at,fx_direction,
      provenance_json,operation_id,actor_id,actor_name,recorded_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), snapshotId, category, version, "KNOWN",
      amountMinor, currency, amountTryMinor, fx.observationId, fx.numerator, fx.denominator, fx.source, fx.observedAt,
      fx.direction, stableJson(input.provenance), operationId, actor.id, actor.name, recordedAt);
  }
}
