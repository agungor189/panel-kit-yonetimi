import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { CatalogService } from "../catalog/catalogService.js";
import { normalizeBaseQuantity, type UomCode } from "../catalog/uom.js";
import { ExchangeRateService, type FxSnapshot } from "../finance/exchangeRates.js";
import {
  amountForQuantity,
  convertMoney,
  integerMoney,
  parseDecimalRational,
  reduceRational,
  splitVat,
  type Rational,
} from "../finance/money.js";

type VatMode = "EXCLUDED" | "INCLUDED";
export type AcquisitionCostVatPolicy = "VAT_EXCLUDED_FROM_INVENTORY_COST" | "VAT_INCLUDED_IN_INVENTORY_COST";
type QuoteBasis = "piece" | "meter" | "square_meter" | "kg" | "roll" | "package" | "box" | "profile_bar";
type CostCategory = "FREIGHT" | "CUSTOMS" | "CUTTING_LABOR" | "OTHER";

export class ProcurementValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "ProcurementValidationError";
  }
}

const requiredText = (value: unknown, field: string, max = 300): string => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", `${field} is invalid.`);
  return text;
};

const optionalText = (value: unknown, field: string, max = 1000): string | null => {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field, max);
};

const currencyCode = (value: unknown): string => {
  const currency = requiredText(value, "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "currency must be an ISO three-letter code.");
  return currency;
};

const vatMode = (value: unknown): VatMode => {
  if (value !== "EXCLUDED" && value !== "INCLUDED") throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "vatMode must be EXCLUDED or INCLUDED.");
  return value;
};

const vatRate = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 10_000) {
    throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "vatRateBps must be an integer between 0 and 10000.");
  }
  return Number(value);
};

const safeAdd = (values: number[], field: string) => {
  const value = values.reduce((sum, item) => sum + item, 0);
  if (!Number.isSafeInteger(value)) throw new ProcurementValidationError("MONEY_OVERFLOW", `${field} exceeds safe integer precision.`);
  return value;
};

const quoteBases = new Set<QuoteBasis>(["piece", "meter", "square_meter", "kg", "roll", "package", "box", "profile_bar"]);
const costCategories = new Set<CostCategory>(["FREIGHT", "CUSTOMS", "CUTTING_LABOR", "OTHER"]);
const acquisitionCostVatPolicies = new Set<AcquisitionCostVatPolicy>(["VAT_EXCLUDED_FROM_INVENTORY_COST", "VAT_INCLUDED_IN_INVENTORY_COST"]);

const acquisitionCostVatPolicy = (value: unknown): AcquisitionCostVatPolicy => {
  if (!acquisitionCostVatPolicies.has(value as AcquisitionCostVatPolicy)) {
    throw new ProcurementValidationError("ACQUISITION_COST_VAT_POLICY_REQUIRED", "acquisitionCostVatPolicy must explicitly include or exclude VAT from inventory cost.");
  }
  return value as AcquisitionCostVatPolicy;
};

export type PurchaseLineInput = {
  id?: string;
  productId: string;
  quantity: string;
  quoteBasis: QuoteBasis;
  profileLengthMm?: number;
  supplierUnitPriceMinor: number;
  currency: string;
  vatMode: VatMode;
  vatRateBps: number;
  notes?: string;
};

export type PurchaseCostInput = {
  id?: string;
  category: CostCategory;
  amountMinor: number;
  currency: string;
  vatMode: VatMode;
  vatRateBps: number;
  notes?: string;
};

export type PurchaseInput = {
  id?: string;
  supplierId: string;
  acquisitionCostVatPolicy: AcquisitionCostVatPolicy;
  invoiceNumber?: string;
  invoiceDate?: string;
  notes?: string;
  lines: PurchaseLineInput[];
  acquisitionCosts?: PurchaseCostInput[];
  attachments?: Array<{ id?: string; kind: "INVOICE" | "QUOTE" | "DELIVERY"; fileName: string; mediaType: string; sizeBytes: number; sha256: string; storageReference?: string }>;
};

type NormalizedLine = {
  id: string;
  lineIndex: number;
  productId: string;
  productSku: string;
  productTitle: string;
  catalogVersionRef: string;
  baseUomCode: string;
  baseUomScale: number;
  originalQuantity: string;
  quoteBasis: QuoteBasis;
  profileLengthMm: number | null;
  profileLengthKind: "standard" | "custom" | null;
  quantityBaseInt: number;
  unitPriceMinor: number;
  currency: string;
  vatMode: VatMode;
  vatRateBps: number;
  supplier: { netMinor: number; vatMinor: number; grossMinor: number };
  baseTry: { netMinor: number; vatMinor: number; grossMinor: number };
  fx: FxSnapshot;
  normalizedCost: Rational;
  notes: string | null;
};

type NormalizedCost = {
  id: string;
  category: CostCategory;
  sourceAmountMinor: number;
  currency: string;
  vatMode: VatMode;
  vatRateBps: number;
  source: { netMinor: number; vatMinor: number; grossMinor: number };
  baseTry: { netMinor: number; vatMinor: number; grossMinor: number };
  fx: FxSnapshot;
  suggestions: Array<{ lineId: string; amountTryMinor: number; roundingAdjustmentMinor: number }>;
  roundingResidualMinor: number;
  notes: string | null;
};

const deterministicValueAllocation = (amount: number, lines: NormalizedLine[]) => {
  const weights = lines.map((line) => ({ lineId: line.id, weight: line.baseTry.netMinor }));
  const totalWeight = safeAdd(weights.map(({ weight }) => weight), "allocation weight");
  if (amount === 0 || totalWeight === 0) return { entries: [], residual: amount };
  const base = weights.map(({ lineId, weight }) => {
    const product = BigInt(amount) * BigInt(weight);
    return {
      lineId,
      amountTryMinor: Number(product / BigInt(totalWeight)),
      remainder: product % BigInt(totalWeight),
      roundingAdjustmentMinor: 0,
    };
  });
  const floorTotal = safeAdd(base.map(({ amountTryMinor }) => amountTryMinor), "allocation floor");
  const residual = amount - floorTotal;
  const order = [...base].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return left.lineId.localeCompare(right.lineId);
  });
  for (let index = 0; index < residual; index += 1) {
    order[index].amountTryMinor += 1;
    order[index].roundingAdjustmentMinor = 1;
  }
  return {
    entries: base.sort((left, right) => left.lineId.localeCompare(right.lineId)).map(({ remainder: _remainder, ...entry }) => entry),
    residual,
  };
};

const deterministicWeightedAllocation = <T extends { key: string; weight: number }>(amount: number, weights: T[]) => {
  const totalWeight = safeAdd(weights.map(({ weight }) => weight), "proportional allocation weight");
  if (amount === 0 || totalWeight === 0) return weights.map((entry) => ({ ...entry, allocated: 0 }));
  const base = weights.map((entry) => {
    const product = BigInt(amount) * BigInt(entry.weight);
    return { ...entry, allocated: Number(product / BigInt(totalWeight)), remainder: product % BigInt(totalWeight) };
  });
  const residual = amount - safeAdd(base.map(({ allocated }) => allocated), "proportional allocation floor");
  const order = [...base].sort((left, right) => left.remainder === right.remainder
    ? left.key.localeCompare(right.key)
    : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; index < residual; index += 1) order[index].allocated += 1;
  return base.map(({ remainder: _remainder, ...entry }) => entry);
};

export class ProcurementService {
  private readonly fx: ExchangeRateService;
  private readonly catalog: CatalogService;

  constructor(private readonly db: Database.Database) {
    this.fx = new ExchangeRateService(db);
    this.catalog = new CatalogService(db);
  }

  registerSupplier(input: { id?: string; name: string; defaultCurrency: string; taxIdentifier?: string; contact?: unknown; notes?: string }) {
    const supplier = {
      id: input.id ? requiredText(input.id, "supplier.id", 200) : randomUUID(),
      name: requiredText(input.name, "supplier.name"),
      defaultCurrency: currencyCode(input.defaultCurrency),
      taxIdentifier: optionalText(input.taxIdentifier, "supplier.taxIdentifier", 100),
      contactJson: input.contact === undefined ? null : JSON.stringify(input.contact),
      notes: optionalText(input.notes, "supplier.notes", 2000),
    };
    this.db.prepare(`INSERT INTO procurement_suppliers
      (id,name,default_currency,tax_identifier,contact_json,notes) VALUES (?,?,?,?,?,?)`)
      .run(supplier.id, supplier.name, supplier.defaultCurrency, supplier.taxIdentifier, supplier.contactJson, supplier.notes);
    return { id: supplier.id, name: supplier.name, defaultCurrency: supplier.defaultCurrency, taxIdentifier: supplier.taxIdentifier, contact: supplier.contactJson ? JSON.parse(supplier.contactJson) : null, notes: supplier.notes };
  }

  createPurchase(input: PurchaseInput) {
    if (!input || !Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "A purchase requires at least one line.");
    }
    const supplierId = requiredText(input.supplierId, "supplierId", 200);
    const supplier = this.db.prepare("SELECT id,name,default_currency FROM procurement_suppliers WHERE id=? AND active=1").get(supplierId) as any;
    if (!supplier) throw new ProcurementValidationError("SUPPLIER_NOT_FOUND", "Registered supplier was not found.", 404);
    const purchaseId = input.id ? requiredText(input.id, "purchase.id", 200) : randomUUID();
    const createdAt = new Date().toISOString();
    const vatPolicy = acquisitionCostVatPolicy(input.acquisitionCostVatPolicy);
    const lines = input.lines.map((item, index) => this.normalizeLine(item, index, createdAt));
    const supplierCurrency = lines[0].currency;
    if (lines.some((item) => item.currency !== supplierCurrency)) {
      throw new ProcurementValidationError("MIXED_PURCHASE_CURRENCY", "One purchase cannot mix supplier currencies.");
    }
    const costs = (input.acquisitionCosts || []).map((item) => this.normalizeCost(item, lines, createdAt, vatPolicy));
    const merchandise = {
      netMinor: safeAdd(lines.map((item) => item.supplier.netMinor), "merchandise net"),
      vatMinor: safeAdd(lines.map((item) => item.supplier.vatMinor), "merchandise VAT"),
      grossMinor: safeAdd(lines.map((item) => item.supplier.grossMinor), "merchandise gross"),
    };
    const direct = {
      netMinor: safeAdd(costs.map((item) => item.baseTry.netMinor), "direct cost base TRY net"),
      vatMinor: safeAdd(costs.map((item) => item.baseTry.vatMinor), "direct cost base TRY VAT"),
      grossMinor: safeAdd(costs.map((item) => item.baseTry.grossMinor), "direct cost base TRY gross"),
    };
    const baseTry = {
      netMinor: safeAdd([...lines.map((item) => item.baseTry.netMinor), ...costs.map((item) => item.baseTry.netMinor)], "base TRY net"),
      vatMinor: safeAdd([...lines.map((item) => item.baseTry.vatMinor), ...costs.map((item) => item.baseTry.vatMinor)], "base TRY VAT"),
      grossMinor: safeAdd([...lines.map((item) => item.baseTry.grossMinor), ...costs.map((item) => item.baseTry.grossMinor)], "base TRY gross"),
    };
    // The goods supplier payable excludes third-party acquisition costs, which
    // can have different counterparties and currencies.
    const total = merchandise;
    const attachments = input.attachments || [];

    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO purchase_orders (
        id,supplier_id,supplier_name_snapshot,supplier_currency,acquisition_cost_vat_policy,invoice_number,invoice_date,notes,
        merchandise_net_minor,merchandise_vat_minor,merchandise_gross_minor,
        direct_cost_base_try_net_minor,direct_cost_base_try_vat_minor,direct_cost_base_try_gross_minor,
        total_net_minor,total_vat_minor,total_gross_minor,
        total_base_try_net_minor,total_base_try_vat_minor,total_base_try_gross_minor,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        purchaseId, supplier.id, supplier.name, supplierCurrency, vatPolicy,
        optionalText(input.invoiceNumber, "invoiceNumber", 200), optionalText(input.invoiceDate, "invoiceDate", 30), optionalText(input.notes, "notes", 4000),
        merchandise.netMinor, merchandise.vatMinor, merchandise.grossMinor,
        direct.netMinor, direct.vatMinor, direct.grossMinor,
        total.netMinor, total.vatMinor, total.grossMinor,
        baseTry.netMinor, baseTry.vatMinor, baseTry.grossMinor, createdAt,
      );
      const insertLine = this.db.prepare(`INSERT INTO purchase_order_lines (
        id,purchase_order_id,line_index,product_id,product_sku_snapshot,product_title_snapshot,catalog_version_ref_snapshot,
        base_uom_code_snapshot,base_uom_scale_snapshot,original_quantity,quote_basis,profile_length_mm,profile_length_kind,
        quantity_base_int,supplier_unit_price_minor,supplier_currency,vat_mode,vat_rate_bps,
        supplier_net_minor,supplier_vat_minor,supplier_gross_minor,base_try_net_minor,base_try_vat_minor,base_try_gross_minor,
        fx_observation_id,fx_rate_numerator,fx_rate_denominator,fx_source,fx_observed_at,fx_direction,
        normalized_cost_numerator,normalized_cost_denominator,notes,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of lines) insertLine.run(
        item.id, purchaseId, item.lineIndex, item.productId, item.productSku, item.productTitle, item.catalogVersionRef,
        item.baseUomCode, item.baseUomScale, item.originalQuantity, item.quoteBasis, item.profileLengthMm, item.profileLengthKind,
        item.quantityBaseInt, item.unitPriceMinor, item.currency, item.vatMode, item.vatRateBps,
        item.supplier.netMinor, item.supplier.vatMinor, item.supplier.grossMinor, item.baseTry.netMinor, item.baseTry.vatMinor, item.baseTry.grossMinor,
        item.fx.observationId, item.fx.numerator, item.fx.denominator, item.fx.source, item.fx.observedAt, item.fx.direction,
        item.normalizedCost.numerator, item.normalizedCost.denominator, item.notes, createdAt,
      );
      const insertCost = this.db.prepare(`INSERT INTO purchase_cost_components (
        id,purchase_order_id,category,source_currency,source_amount_minor,vat_mode,vat_rate_bps,
        source_net_minor,source_vat_minor,source_gross_minor,base_try_net_minor,base_try_vat_minor,base_try_gross_minor,
        fx_observation_id,fx_rate_numerator,fx_rate_denominator,fx_source,fx_observed_at,suggestion_json,rounding_residual_minor,notes,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of costs) insertCost.run(
        item.id, purchaseId, item.category, item.currency, item.sourceAmountMinor, item.vatMode, item.vatRateBps,
        item.source.netMinor, item.source.vatMinor, item.source.grossMinor, item.baseTry.netMinor, item.baseTry.vatMinor, item.baseTry.grossMinor,
        item.fx.observationId, item.fx.numerator, item.fx.denominator, item.fx.source, item.fx.observedAt,
        JSON.stringify(item.suggestions), item.roundingResidualMinor, item.notes, createdAt,
      );
      const insertAttachment = this.db.prepare(`INSERT INTO purchase_attachments
        (id,purchase_order_id,kind,file_name,media_type,size_bytes,sha256,storage_reference,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const attachment of attachments) {
        if (!["INVOICE", "QUOTE", "DELIVERY"].includes(attachment.kind)) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "attachment.kind is unsupported.");
        const sha256 = requiredText(attachment.sha256, "attachment.sha256", 64).toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "attachment.sha256 is invalid.");
        insertAttachment.run(
          attachment.id ? requiredText(attachment.id, "attachment.id", 200) : randomUUID(), purchaseId, attachment.kind,
          requiredText(attachment.fileName, "attachment.fileName"), requiredText(attachment.mediaType, "attachment.mediaType", 150),
          integerMoney(attachment.sizeBytes, "attachment.sizeBytes"), sha256,
          optionalText(attachment.storageReference, "attachment.storageReference", 500), createdAt,
        );
      }
    }).immediate();
    return this.getPurchase(purchaseId)!;
  }

  finalizeAcquisitionCosts(purchaseIdValue: string, input: { allocations: Array<{ componentId: string; mode: "ACCEPT_SUGGESTION" | "MANUAL" | "UNALLOCATED"; lineAllocations?: Array<{ lineId: string; amountTryMinor: number }> }> }) {
    const purchaseId = requiredText(purchaseIdValue, "purchaseId", 200);
    const header = this.db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(purchaseId) as any;
    if (!header) throw new ProcurementValidationError("PURCHASE_NOT_FOUND", "Purchase was not found.", 404);
    if (header.status !== "DRAFT") throw new ProcurementValidationError("PURCHASE_ALREADY_FINALIZED", "Purchase acquisition cost is already finalized.", 409);
    const lines = this.db.prepare("SELECT * FROM purchase_order_lines WHERE purchase_order_id=? ORDER BY line_index").all(purchaseId) as any[];
    const components = this.db.prepare("SELECT * FROM purchase_cost_components WHERE purchase_order_id=? ORDER BY id").all(purchaseId) as any[];
    if (!input || !Array.isArray(input.allocations)) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "allocations is required.");
    const decisions = new Map(input.allocations.map((decision) => [requiredText(decision.componentId, "componentId", 200), decision]));
    if (decisions.size !== input.allocations.length || decisions.size !== components.length || components.some((component) => !decisions.has(component.id))) {
      throw new ProcurementValidationError("ALLOCATION_DECISION_REQUIRED", "Every shared acquisition cost requires exactly one allocation decision.");
    }
    const lineIds = new Set(lines.map((line) => line.id));
    const allocations: Array<{ componentId: string; lineId: string | null; amountTryMinor: number; provenance: "ACCEPTED_SUGGESTION" | "MANUAL" | "UNALLOCATED" }> = [];
    for (const component of components) {
      const decision = decisions.get(component.id)!;
      const componentInventoryBasis = header.acquisition_cost_vat_policy === "VAT_INCLUDED_IN_INVENTORY_COST"
        ? component.base_try_gross_minor
        : component.base_try_net_minor;
      if (decision.mode === "ACCEPT_SUGGESTION") {
        const suggestions = JSON.parse(component.suggestion_json) as Array<{ lineId: string; amountTryMinor: number }>;
        for (const suggestion of suggestions) allocations.push({ componentId: component.id, lineId: suggestion.lineId, amountTryMinor: suggestion.amountTryMinor, provenance: "ACCEPTED_SUGGESTION" });
        const allocated = safeAdd(suggestions.map((item) => item.amountTryMinor), "accepted allocation");
        if (allocated < componentInventoryBasis) allocations.push({ componentId: component.id, lineId: null, amountTryMinor: componentInventoryBasis - allocated, provenance: "UNALLOCATED" });
      } else if (decision.mode === "UNALLOCATED") {
        allocations.push({ componentId: component.id, lineId: null, amountTryMinor: componentInventoryBasis, provenance: "UNALLOCATED" });
      } else if (decision.mode === "MANUAL") {
        const entries = decision.lineAllocations || [];
        const unique = new Set<string>();
        for (const entry of entries) {
          const lineId = requiredText(entry.lineId, "lineId", 200);
          if (!lineIds.has(lineId) || unique.has(lineId)) throw new ProcurementValidationError("INVALID_MANUAL_ALLOCATION", "Manual allocation line is invalid or duplicated.");
          unique.add(lineId);
          const amountTryMinor = integerMoney(entry.amountTryMinor, "amountTryMinor");
          if (amountTryMinor > 0) allocations.push({ componentId: component.id, lineId, amountTryMinor, provenance: "MANUAL" });
        }
        const allocated = safeAdd(allocations.filter((entry) => entry.componentId === component.id && entry.lineId).map((entry) => entry.amountTryMinor), "manual allocation");
        if (allocated > componentInventoryBasis) throw new ProcurementValidationError("INVALID_MANUAL_ALLOCATION", "Manual allocation exceeds the acquisition cost component.");
        if (allocated < componentInventoryBasis) allocations.push({ componentId: component.id, lineId: null, amountTryMinor: componentInventoryBasis - allocated, provenance: "UNALLOCATED" });
      } else {
        throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "Allocation mode is unsupported.");
      }
    }

    const allocatedVatByComponentAndLine = new Map<string, number>();
    for (const component of components) {
      const componentAllocations = allocations.filter((entry) => entry.componentId === component.id);
      const vatShares = deterministicWeightedAllocation(component.base_try_vat_minor, componentAllocations.map((entry) => ({
        key: `${component.id}:${entry.lineId || "__UNALLOCATED__"}`,
        weight: entry.amountTryMinor,
      })));
      for (const share of vatShares) allocatedVatByComponentAndLine.set(share.key, share.allocated);
    }

    const finalizedAt = new Date().toISOString();
    this.db.transaction(() => {
      const insertAllocation = this.db.prepare(`INSERT INTO purchase_cost_allocations
        (id,purchase_order_id,component_id,line_id,amount_try_minor,provenance,created_at) VALUES (?,?,?,?,?,?,?)`);
      for (const allocation of allocations) insertAllocation.run(randomUUID(), purchaseId, allocation.componentId, allocation.lineId, allocation.amountTryMinor, allocation.provenance, finalizedAt);
      const insertLot = this.db.prepare(`INSERT INTO acquisition_lot_cost_snapshots (
        id,purchase_order_id,purchase_line_id,product_id,quantity_base_int,base_uom_code_snapshot,
        merchandise_cost_try_minor,freight_cost_try_minor,customs_cost_try_minor,cutting_labor_cost_try_minor,other_direct_cost_try_minor,
        vat_try_minor,landed_cost_try_minor,normalized_cost_numerator,normalized_cost_denominator,
        allocation_snapshot_json,source_snapshot_json,formula_version,vat_policy_snapshot,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const line of lines) {
        const allocated = allocations.filter((entry) => entry.lineId === line.id);
        const amountFor = (category: CostCategory) => safeAdd(allocated.filter((entry) => components.find((component) => component.id === entry.componentId)?.category === category).map((entry) => entry.amountTryMinor), category);
        const freight = amountFor("FREIGHT");
        const customs = amountFor("CUSTOMS");
        const cutting = amountFor("CUTTING_LABOR");
        const other = amountFor("OTHER");
        const merchandiseCost = header.acquisition_cost_vat_policy === "VAT_INCLUDED_IN_INVENTORY_COST" ? line.base_try_gross_minor : line.base_try_net_minor;
        const allocatedComponentVat = safeAdd(allocated.map((entry) => allocatedVatByComponentAndLine.get(`${entry.componentId}:${line.id}`) || 0), "allocated acquisition VAT");
        const vatSnapshot = safeAdd([line.base_try_vat_minor, allocatedComponentVat], "lot VAT snapshot");
        const landed = safeAdd([merchandiseCost, freight, customs, cutting, other], "landed cost");
        const normalized = reduceRational(BigInt(landed) * BigInt(line.base_uom_scale_snapshot), BigInt(line.quantity_base_int), "landed unit cost");
        insertLot.run(
          randomUUID(), purchaseId, line.id, line.product_id, line.quantity_base_int, line.base_uom_code_snapshot,
          merchandiseCost, freight, customs, cutting, other, vatSnapshot, landed,
          normalized.numerator, normalized.denominator,
          JSON.stringify(allocated), JSON.stringify({
            supplier: { id: header.supplier_id, name: header.supplier_name_snapshot }, invoice: { number: header.invoice_number, date: header.invoice_date },
            quote: { basis: line.quote_basis, originalQuantity: line.original_quantity, unitPriceMinor: line.supplier_unit_price_minor, currency: line.supplier_currency, profileLengthMm: line.profile_length_mm },
            fx: { observationId: line.fx_observation_id, numerator: line.fx_rate_numerator, denominator: line.fx_rate_denominator, source: line.fx_source, observedAt: line.fx_observed_at, direction: line.fx_direction },
            vat: { mode: line.vat_mode, rateBps: line.vat_rate_bps, supplierMinor: line.supplier_vat_minor, baseTryMinor: line.base_try_vat_minor },
            acquisitionCostVatPolicy: header.acquisition_cost_vat_policy,
            allocatedCostComponents: allocated.map((entry) => {
              const component = components.find((candidate) => candidate.id === entry.componentId)!;
              return {
                id: component.id, category: component.category, inventoryCostAllocationTryMinor: entry.amountTryMinor,
                source: { currency: component.source_currency, amountMinor: component.source_amount_minor, netMinor: component.source_net_minor, vatMinor: component.source_vat_minor, grossMinor: component.source_gross_minor },
                baseTry: { netMinor: component.base_try_net_minor, vatMinor: component.base_try_vat_minor, grossMinor: component.base_try_gross_minor },
                fx: { observationId: component.fx_observation_id, numerator: component.fx_rate_numerator, denominator: component.fx_rate_denominator, source: component.fx_source, observedAt: component.fx_observed_at },
              };
            }),
          }), "dsdst.acquisition-cost.v2", header.acquisition_cost_vat_policy, finalizedAt,
        );
      }
      this.db.prepare("UPDATE purchase_orders SET status='APPROVED', finalized_at=? WHERE id=? AND status='DRAFT'").run(finalizedAt, purchaseId);
    }).immediate();
    return this.getPurchase(purchaseId)!;
  }

  recordPayment(purchaseIdValue: string, input: { id?: string; cashAccountId: string; amountMinor: number; currency: string; paidAt: string; reference?: string; notes?: string }) {
    const purchaseId = requiredText(purchaseIdValue, "purchaseId", 200);
    const header = this.db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(purchaseId) as any;
    if (!header) throw new ProcurementValidationError("PURCHASE_NOT_FOUND", "Purchase was not found.", 404);
    const amountMinor = integerMoney(input.amountMinor, "amountMinor", false);
    const currency = currencyCode(input.currency);
    if (currency !== header.supplier_currency) throw new ProcurementValidationError("PAYMENT_CURRENCY_MISMATCH", "Payment currency must match purchase supplier currency.");
    const cashAccountId = requiredText(input.cashAccountId, "cashAccountId", 200);
    const account = this.db.prepare("SELECT id,currency FROM cash_accounts WHERE id=? AND is_active=1").get(cashAccountId) as any;
    if (!account) throw new ProcurementValidationError("CASH_ACCOUNT_NOT_FOUND", "Active cash account was not found.", 404);
    if (account.currency !== currency) throw new ProcurementValidationError("PAYMENT_ACCOUNT_CURRENCY_MISMATCH", "Cash account currency must match payment currency.");
    const outstanding = header.total_gross_minor - header.paid_minor;
    if (amountMinor > outstanding) throw new ProcurementValidationError("PAYMENT_EXCEEDS_OUTSTANDING", "Payment exceeds purchase outstanding balance.", 409);
    const paidAt = requiredText(input.paidAt, "paidAt", 50);
    if (Number.isNaN(Date.parse(paidAt))) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "paidAt is invalid.");
    const paymentId = input.id ? requiredText(input.id, "payment.id", 200) : randomUUID();
    const postingId = randomUUID();
    const cashTransactionId = `procurement-payment:${paymentId}`;
    const nextPaid = header.paid_minor + amountMinor;
    const paymentStatus = nextPaid === header.total_gross_minor ? "PAID" : "PARTIAL";
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO purchase_payments
        (id,purchase_order_id,cash_account_id,amount_minor,currency,paid_at,reference,notes)
        VALUES (?,?,?,?,?,?,?,?)`).run(paymentId, purchaseId, cashAccountId, amountMinor, currency, paidAt, optionalText(input.reference, "reference", 200), optionalText(input.notes, "notes", 1000));
      this.db.prepare(`INSERT INTO procurement_cash_postings
        (id,purchase_id,payment_id,cash_account_id,direction,amount_minor,currency,occurred_at,source_type)
        VALUES (?,?,?,?,'OUT',?,?,?,'PURCHASE_PAYMENT')`).run(postingId, purchaseId, paymentId, cashAccountId, amountMinor, currency, paidAt);
      // Existing cash reporting uses cash_transactions in major currency units.
      // This immutable row is a compatibility projection; purchase_payments and
      // procurement_cash_postings remain the exact minor-unit provenance.
      this.db.prepare(`INSERT INTO cash_transactions
        (id,account_id,type,amount,currency,exchange_rate_at_transaction,source_type,source_id,description,transaction_date,is_deleted)
        VALUES (?,?,'OUT',?,?,NULL,'procurement_purchase_payment',?,?,?,0)`)
        .run(cashTransactionId, cashAccountId, amountMinor / 100, currency, paymentId, `Purchase payment: ${header.invoice_number || purchaseId}`, paidAt);
      this.db.prepare("UPDATE purchase_orders SET paid_minor=?,payment_status=? WHERE id=?").run(nextPaid, paymentStatus, purchaseId);
    }).immediate();
    return { ...this.getPurchase(purchaseId)!, recordedPaymentId: paymentId };
  }

  getPurchase(purchaseIdValue: string): any | null {
    const purchaseId = requiredText(purchaseIdValue, "purchaseId", 200);
    const header = this.db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(purchaseId) as any;
    if (!header) return null;
    const lineRows = this.db.prepare("SELECT * FROM purchase_order_lines WHERE purchase_order_id=? ORDER BY line_index").all(purchaseId) as any[];
    const componentRows = this.db.prepare("SELECT * FROM purchase_cost_components WHERE purchase_order_id=? ORDER BY id").all(purchaseId) as any[];
    const allocationRows = this.db.prepare("SELECT * FROM purchase_cost_allocations WHERE purchase_order_id=? ORDER BY component_id,line_id").all(purchaseId) as any[];
    const lots = (this.db.prepare("SELECT * FROM acquisition_lot_cost_snapshots WHERE purchase_order_id=? ORDER BY purchase_line_id").all(purchaseId) as any[]).map((row) => ({
      id: row.id, lineId: row.purchase_line_id, productId: row.product_id, state: row.state,
      quantityBaseInt: row.quantity_base_int, baseUomCode: row.base_uom_code_snapshot,
      merchandiseCostTryMinor: row.merchandise_cost_try_minor, freightCostTryMinor: row.freight_cost_try_minor,
      customsCostTryMinor: row.customs_cost_try_minor, cuttingLaborCostTryMinor: row.cutting_labor_cost_try_minor,
      otherDirectCostTryMinor: row.other_direct_cost_try_minor, vatTryMinor: row.vat_try_minor,
      landedCostTryMinor: row.landed_cost_try_minor,
      vatPolicy: row.vat_policy_snapshot,
      normalizedAcquisitionUnitCostTry: { numerator: row.normalized_cost_numerator, denominator: row.normalized_cost_denominator, currency: "TRY", perBaseUom: row.base_uom_code_snapshot },
      formulaVersion: row.formula_version,
    }));
    const allocationSuggestions = componentRows.flatMap((component) => (JSON.parse(component.suggestion_json) as any[]).map((entry) => ({ componentId: component.id, ...entry })));
    return {
      id: header.id,
      supplier: { id: header.supplier_id, name: header.supplier_name_snapshot },
      supplierCurrency: header.supplier_currency,
      vatPolicy: header.acquisition_cost_vat_policy,
      status: header.status,
      paymentStatus: header.payment_status,
      totalNetMinor: header.total_net_minor,
      totalVatMinor: header.total_vat_minor,
      totalGrossMinor: header.total_gross_minor,
      paidMinor: header.paid_minor,
      outstandingMinor: header.total_gross_minor - header.paid_minor,
      lines: lineRows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        product: { sku: row.product_sku_snapshot, title: row.product_title_snapshot, catalogVersionRef: row.catalog_version_ref_snapshot },
        quote: { basis: row.quote_basis, originalQuantity: row.original_quantity, supplierUnitPriceMinor: row.supplier_unit_price_minor, currency: row.supplier_currency, profileLengthMm: row.profile_length_mm, profileLengthKind: row.profile_length_kind },
        normalizedQuantity: { baseQuantity: row.quantity_base_int, baseUomCode: row.base_uom_code_snapshot, quantityScale: row.base_uom_scale_snapshot },
        vat: { mode: row.vat_mode, rateBps: row.vat_rate_bps },
        amounts: { supplier: { netMinor: row.supplier_net_minor, vatMinor: row.supplier_vat_minor, grossMinor: row.supplier_gross_minor }, baseTry: { netMinor: row.base_try_net_minor, vatMinor: row.base_try_vat_minor, grossMinor: row.base_try_gross_minor } },
        fx: { observationId: row.fx_observation_id, numerator: row.fx_rate_numerator, denominator: row.fx_rate_denominator, source: row.fx_source, observedAt: row.fx_observed_at, direction: row.fx_direction },
        normalizedMerchandiseUnitCostTry: { numerator: row.normalized_cost_numerator, denominator: row.normalized_cost_denominator, currency: "TRY", perBaseUom: row.base_uom_code_snapshot },
      })),
      acquisitionCosts: componentRows.map((row) => ({
        id: row.id, category: row.category, sourceAmountMinor: row.source_amount_minor, currency: row.source_currency,
        vat: { mode: row.vat_mode, rateBps: row.vat_rate_bps },
        amounts: { source: { netMinor: row.source_net_minor, vatMinor: row.source_vat_minor, grossMinor: row.source_gross_minor }, baseTry: { netMinor: row.base_try_net_minor, vatMinor: row.base_try_vat_minor, grossMinor: row.base_try_gross_minor } },
        fx: { observationId: row.fx_observation_id, numerator: row.fx_rate_numerator, denominator: row.fx_rate_denominator, source: row.fx_source, observedAt: row.fx_observed_at, direction: row.source_currency === "TRY" ? "TRY_TO_TRY" : "USD_TO_TRY" },
      })),
      allocationSuggestions,
      allocationRuns: componentRows.map((row) => ({ componentId: row.id, method: row.allocation_method, roundingResidualMinor: row.rounding_residual_minor })),
      allocations: allocationRows.filter((row) => row.provenance !== "UNALLOCATED").map((row) => ({ componentId: row.component_id, lineId: row.line_id, amountTryMinor: row.amount_try_minor, provenance: row.provenance })),
      unallocatedCosts: allocationRows.filter((row) => row.provenance === "UNALLOCATED").map((row) => ({ componentId: row.component_id, amountTryMinor: row.amount_try_minor, provenance: row.provenance })),
      lots,
      payments: (this.db.prepare("SELECT * FROM purchase_payments WHERE purchase_order_id=? ORDER BY paid_at,id").all(purchaseId) as any[]).map((row) => ({ id: row.id, amountMinor: row.amount_minor, currency: row.currency, paidAt: row.paid_at, cashAccountId: row.cash_account_id, reference: row.reference })),
      attachments: (this.db.prepare("SELECT * FROM purchase_attachments WHERE purchase_order_id=? ORDER BY id").all(purchaseId) as any[]).map((row) => ({ id: row.id, kind: row.kind, fileName: row.file_name, mediaType: row.media_type, sizeBytes: row.size_bytes, sha256: row.sha256, storageReference: row.storage_reference })),
    };
  }

  private normalizeLine(input: PurchaseLineInput, lineIndex: number, createdAt: string): NormalizedLine {
    const productId = requiredText(input.productId, "productId", 200);
    const product = this.db.prepare(`SELECT p.id,p.sku,p.title,p.catalog_type,p.catalog_class,p.catalog_version_ref,p.base_uom_code,u.quantity_scale
      FROM products p JOIN uom_definitions u ON u.code=p.base_uom_code WHERE p.id=? AND p.catalog_version>0`).get(productId) as any;
    if (!product) throw new ProcurementValidationError("CATALOG_PRODUCT_NOT_FOUND", "Canonical catalog item was not found.", 404);
    if (!quoteBases.has(input.quoteBasis)) throw new ProcurementValidationError("INVALID_QUOTE_BASIS", "quoteBasis is unsupported.");
    const quoteBasis = input.quoteBasis;
    const originalQuantity = requiredText(input.quantity, "quantity", 50);
    let quantityBaseInt: number;
    let profileLengthMm: number | null = null;
    let profileLengthKind: "standard" | "custom" | null = null;
    if (product.catalog_type === "profile") {
      if (quoteBasis === "profile_bar") {
        const count = parseDecimalRational(originalQuantity, "quantity");
        if (count.denominator !== 1) throw new ProcurementValidationError("INVALID_PROFILE_BAR_QUANTITY", "Profile bar quantity must be an integer.");
        if (!Number.isSafeInteger(input.profileLengthMm) || Number(input.profileLengthMm) <= 0) throw new ProcurementValidationError("PROFILE_LENGTH_REQUIRED", "profileLengthMm is required for per-bar quotes.");
        profileLengthMm = Number(input.profileLengthMm);
        profileLengthKind = this.catalog.validateProfilePurchaseLength(productId, profileLengthMm).kind;
        quantityBaseInt = count.numerator * profileLengthMm;
      } else if (quoteBasis === "meter") {
        quantityBaseInt = normalizeBaseQuantity(originalQuantity, "meter").baseQuantity;
      } else {
        throw new ProcurementValidationError("INVALID_QUOTE_BASIS", "Profiles support per-meter or per-physical-bar quotes only.");
      }
    } else {
      if (quoteBasis === "profile_bar" || quoteBasis !== product.base_uom_code) {
        throw new ProcurementValidationError("INVALID_QUOTE_BASIS", `Quote basis must match catalog base UOM ${product.base_uom_code}.`);
      }
      quantityBaseInt = normalizeBaseQuantity(originalQuantity, product.base_uom_code as UomCode).baseQuantity;
    }
    if (!Number.isSafeInteger(quantityBaseInt) || quantityBaseInt <= 0) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "Quantity must normalize to a positive base-unit integer.");
    const quantityForPrice = parseDecimalRational(originalQuantity, "quantity");
    const unitPriceMinor = integerMoney(input.supplierUnitPriceMinor, "supplierUnitPriceMinor");
    const currency = currencyCode(input.currency);
    const mode = vatMode(input.vatMode);
    const rateBps = vatRate(input.vatRateBps);
    const supplierAmounts = splitVat(amountForQuantity(unitPriceMinor, quantityForPrice), mode, rateBps);
    const fx = this.fx.snapshotFor(currency, createdAt);
    const baseTry = convertMoney(supplierAmounts, fx);
    const normalizedCost = reduceRational(BigInt(baseTry.netMinor) * BigInt(product.quantity_scale), BigInt(quantityBaseInt), "normalized merchandise unit cost");
    return {
      id: input.id ? requiredText(input.id, "line.id", 200) : randomUUID(), lineIndex, productId,
      productSku: requiredText(product.sku, "product.sku", 200), productTitle: requiredText(product.title, "product.title"),
      catalogVersionRef: requiredText(product.catalog_version_ref, "product.catalogVersionRef", 250),
      baseUomCode: product.base_uom_code, baseUomScale: Number(product.quantity_scale), originalQuantity, quoteBasis,
      profileLengthMm, profileLengthKind, quantityBaseInt, unitPriceMinor, currency, vatMode: mode, vatRateBps: rateBps,
      supplier: supplierAmounts, baseTry, fx, normalizedCost, notes: optionalText(input.notes, "line.notes", 1000),
    };
  }

  private normalizeCost(input: PurchaseCostInput, lines: NormalizedLine[], createdAt: string, vatPolicy: AcquisitionCostVatPolicy): NormalizedCost {
    if (!costCategories.has(input.category)) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "Acquisition cost category is unsupported.");
    const currency = currencyCode(input.currency);
    const sourceAmountMinor = integerMoney(input.amountMinor, "amountMinor");
    const mode = vatMode(input.vatMode);
    const rateBps = vatRate(input.vatRateBps);
    const source = splitVat(sourceAmountMinor, mode, rateBps);
    const fx = this.fx.snapshotFor(currency, createdAt);
    const baseTry = convertMoney(source, fx);
    const allocationBasis = vatPolicy === "VAT_INCLUDED_IN_INVENTORY_COST" ? baseTry.grossMinor : baseTry.netMinor;
    const suggestion = deterministicValueAllocation(allocationBasis, lines);
    return {
      id: input.id ? requiredText(input.id, "cost.id", 200) : randomUUID(), category: input.category,
      sourceAmountMinor, currency, vatMode: mode, vatRateBps: rateBps, source, baseTry, fx,
      suggestions: suggestion.entries, roundingResidualMinor: suggestion.residual, notes: optionalText(input.notes, "cost.notes", 1000),
    };
  }
}
