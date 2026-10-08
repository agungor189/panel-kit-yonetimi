import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { CatalogService, CatalogValidationError } from "../catalog/catalogService.js";
import { normalizeBaseQuantity, type UomCode } from "../catalog/uom.js";
import { ExchangeRateService, type FxSnapshot } from "../finance/exchangeRates.js";
import { canonicalProductType, normalizeCsvHeader, type ProductType } from "../../../shared/productCsvMapping.js";
import { generateNormalizedFields } from "../../utils/normalizeProductFields.js";
import { decimal } from "./procurementImport.js";
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
export type PurchaseWorkflowState = "DRAFT" | "ORDERED" | "IN_TRANSIT" | "COST_PENDING" | "RECEIPT_PENDING" | "COMPLETED";
export type PurchaseExpenseType = "FREIGHT" | "CUSTOMS_DUTY" | "ADDITIONAL_TAX" | "CUSTOMS_BROKER" | "WAREHOUSE_PORT" | "DOMESTIC_FREIGHT" | "INSURANCE" | "BANK_TRANSFER" | "OTHER";

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
  productId?: string;
  quantity: string;
  quoteBasis: QuoteBasis;
  profileLengthMm?: number;
  supplierUnitPriceMinor: number;
  currency: string;
  vatMode: VatMode;
  vatRateBps: number;
  notes?: string;
  packing?: PurchaseLinePackingInput;
  catalogProposal?: PurchaseCatalogProposal;
};

export type PurchaseCatalogProposal = {
  sku: string;
  supplierNo: string;
  productType: ProductType;
  size?: string | null;
  material?: string | null;
  profileType?: string | null;
  nameEn?: string | null;
  nameTr?: string | null;
  partWeightG: number;
};

export type PurchaseLinePackingInput = PurchaseCatalogProposal & {
  totalQuantity: number;
  boxCount: number;
  unitsPerBox: number;
  boxWeightKg: number;
  totalWeightKg: number;
};

export type PurchaseCostInput = {
  counterparty?: "SUPPLIER" | "THIRD_PARTY";
  id?: string;
  category: CostCategory;
  amountMinor: number;
  currency: string;
  vatMode: VatMode;
  vatRateBps: number;
  notes?: string;
  expenseType?: PurchaseExpenseType;
  description?: string;
  occurredOn?: string;
  targetLineIds?: string[];
};

export type PurchaseInput = {
  id?: string;
  supplierId: string;
  acquisitionCostVatPolicy: AcquisitionCostVatPolicy;
  invoiceNumber?: string;
  invoiceDate?: string;
  notes?: string;
  purchaseNumber?: string;
  orderDate?: string;
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
  packing: NormalizedPacking | null;
};

type NormalizedPacking = {
  supplierNo: string;
  productType: ProductType;
  size: string | null;
  material: string | null;
  profileType: string | null;
  nameEn: string | null;
  nameTr: string | null;
  totalQuantity: number;
  boxCount: number;
  unitsPerBox: number;
  boxWeightGrams: number;
  totalWeightGrams: number;
  partWeightMilligrams: number;
};

const csvAliases = {
  sku: ["sku"],
  supplierNo: ["supplier_no", "tedarik no", "tedarikci no", "tedarikçi no"],
  productType: ["type", "tur", "tür", "product type"],
  size: ["size", "olcu", "ölçü"],
  material: ["material", "malzeme"],
  profileType: ["profile_type", "profile type", "profil tipi", "profil turu", "profil türü"],
  nameEn: ["name_en", "name en", "isim en", "isim - en", "i̇sim - en"],
  nameTr: ["name_tr", "name tr", "isim tr", "isim - tr", "i̇sim - tr"],
  totalQuantity: ["total_quantity", "total quantity", "toplam adet"],
  boxCount: ["box_count", "box count", "kutu sayisi", "kutu sayısı"],
  unitsPerBox: ["units_per_box", "units per box", "kutu ici adet", "kutu içi adet"],
  boxWeightKg: ["box_weight_kg", "box weight kg", "kutu agirligi", "kutu ağırlığı"],
  totalWeightKg: ["total_weight_kg", "total weight kg", "toplam agirlik", "toplam ağırlık"],
  partWeightG: ["part_weight_g", "part weight g", "parca agirligi", "parça ağırlığı"],
  purchasePriceUsd: ["purchase_price_usd", "purchase price usd", "alis fiyati", "alış fiyatı"],
} as const;

const csvRowValue = (row: Record<string, unknown>, aliases: readonly string[]) => {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeCsvHeader(key), value]));
  for (const alias of aliases) {
    const value = normalized.get(normalizeCsvHeader(alias));
    if (value !== undefined) return value;
  }
  return undefined;
};

const csvText = (value: unknown) => String(value ?? "").trim();
const csvNumber = (value: unknown) => {
  const text = csvText(value).replace(/[$₺\s]/g, "").replace(",", ".");
  return text === "" ? Number.NaN : Number(text);
};
const positiveInteger = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const comparable = (value: unknown) => normalizeCsvHeader(value);

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

  private hasTable(name: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
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
    return this.db.transaction(() => this.createPurchaseAtomic(input)).immediate();
  }

  private createPurchaseAtomic(input: PurchaseInput) {
    if (!input || !Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "A purchase requires at least one line.");
    }
    const supplierId = requiredText(input.supplierId, "supplierId", 200);
    const supplier = this.db.prepare("SELECT id,name,default_currency FROM procurement_suppliers WHERE id=? AND active=1").get(supplierId) as any;
    if (!supplier) throw new ProcurementValidationError("SUPPLIER_NOT_FOUND", "Registered supplier was not found.", 404);
    const purchaseId = input.id ? requiredText(input.id, "purchase.id", 200) : randomUUID();
    const createdAt = new Date().toISOString();
    const purchaseNumber = input.purchaseNumber ? requiredText(input.purchaseNumber, "purchaseNumber", 100) : `PO-${purchaseId}`;
    const orderDate = input.orderDate ? requiredText(input.orderDate, "orderDate", 30) : (input.invoiceDate || createdAt.slice(0, 10));
    if (Number.isNaN(Date.parse(orderDate))) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "orderDate is invalid.");
    const vatPolicy = acquisitionCostVatPolicy(input.acquisitionCostVatPolicy);
    const materializedLines = input.lines.map((item, index) => this.materializePurchaseLine(item, index));
    const lines = materializedLines.map((item, index) => this.normalizeLine(item, index, createdAt));
    const supplierCurrency = lines[0].currency;
    if (lines.some((item) => item.currency !== supplierCurrency)) {
      throw new ProcurementValidationError("MIXED_PURCHASE_CURRENCY", "One purchase cannot mix supplier currencies.");
    }
    for (const cost of input.acquisitionCosts || []) this.validateCounterparty(cost, supplierCurrency);
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
      if (this.hasTable("procurement_workflows")) {
        this.db.prepare(`INSERT INTO procurement_workflows
          (purchase_order_id,purchase_number,order_date,state,updated_at) VALUES (?,?,?,'DRAFT',?)`)
          .run(purchaseId, purchaseNumber, orderDate, createdAt);
      }
      const insertLine = this.db.prepare(`INSERT INTO purchase_order_lines (
        id,purchase_order_id,line_index,product_id,product_sku_snapshot,product_title_snapshot,catalog_version_ref_snapshot,
        base_uom_code_snapshot,base_uom_scale_snapshot,original_quantity,quote_basis,profile_length_mm,profile_length_kind,
        quantity_base_int,supplier_unit_price_minor,supplier_currency,vat_mode,vat_rate_bps,
        supplier_net_minor,supplier_vat_minor,supplier_gross_minor,base_try_net_minor,base_try_vat_minor,base_try_gross_minor,
        fx_observation_id,fx_rate_numerator,fx_rate_denominator,fx_source,fx_observed_at,fx_direction,
        normalized_cost_numerator,normalized_cost_denominator,notes,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of lines) {
        insertLine.run(
          item.id, purchaseId, item.lineIndex, item.productId, item.productSku, item.productTitle, item.catalogVersionRef,
          item.baseUomCode, item.baseUomScale, item.originalQuantity, item.quoteBasis, item.profileLengthMm, item.profileLengthKind,
          item.quantityBaseInt, item.unitPriceMinor, item.currency, item.vatMode, item.vatRateBps,
          item.supplier.netMinor, item.supplier.vatMinor, item.supplier.grossMinor, item.baseTry.netMinor, item.baseTry.vatMinor, item.baseTry.grossMinor,
          item.fx.observationId, item.fx.numerator, item.fx.denominator, item.fx.source, item.fx.observedAt, item.fx.direction,
          item.normalizedCost.numerator, item.normalizedCost.denominator, item.notes, createdAt,
        );
        if (item.packing && this.hasTable("purchase_line_packing_snapshots")) {
          const packing = item.packing;
          this.db.prepare(`INSERT INTO purchase_line_packing_snapshots (
            purchase_line_id,purchase_order_id,supplier_no,product_type_snapshot,size_snapshot,material_snapshot,
            profile_type_snapshot,name_en_snapshot,name_tr_snapshot,total_quantity,box_count,units_per_box,
            box_weight_grams,total_weight_grams,part_weight_milligrams,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            item.id, purchaseId, packing.supplierNo, packing.productType, packing.size, packing.material,
            packing.profileType, packing.nameEn, packing.nameTr, packing.totalQuantity, packing.boxCount,
            packing.unitsPerBox, packing.boxWeightGrams, packing.totalWeightGrams,
            packing.partWeightMilligrams, createdAt,
          );
        }
      }
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
      for (const [index, item] of (input.acquisitionCosts || []).entries()) {
        if (!this.hasTable("purchase_cost_component_details")) break;
        const normalized = costs[index];
        const targets = Array.isArray(item.targetLineIds) ? item.targetLineIds : [];
        this.db.prepare(`INSERT INTO purchase_cost_component_details
          (component_id,expense_type,description,occurred_on,target_scope,target_line_ids_json,created_at,counterparty)
          VALUES (?,?,?,?,?,?,?,?)`).run(
          normalized.id, item.expenseType || (item.category === "FREIGHT" ? "FREIGHT" : item.category === "CUSTOMS" ? "CUSTOMS_DUTY" : "OTHER"),
          optionalText(item.description || item.notes, "cost.description", 1000), item.occurredOn || createdAt.slice(0, 10),
          targets.length ? "SELECTED_LINES" : "COMMON", JSON.stringify(targets), createdAt, item.counterparty,
        );
      }
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

  private calculateAcquisitionCosts(purchaseIdValue: string, input: { allocations: Array<{ componentId: string; mode: "ACCEPT_SUGGESTION" | "MANUAL" | "UNALLOCATED"; lineAllocations?: Array<{ lineId: string; amountTryMinor: number }> }> }) {
    const purchaseId = requiredText(purchaseIdValue, "purchaseId", 200);
    const header = this.db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(purchaseId) as any;
    if (!header) throw new ProcurementValidationError("PURCHASE_NOT_FOUND", "Purchase was not found.", 404);
    if (header.status !== "DRAFT") throw new ProcurementValidationError("PURCHASE_ALREADY_FINALIZED", "Purchase acquisition cost is already finalized.", 409);
    const lines = this.db.prepare("SELECT * FROM purchase_order_lines WHERE purchase_order_id=? ORDER BY line_index").all(purchaseId) as any[];
    const components = this.db.prepare("SELECT * FROM purchase_cost_components WHERE purchase_order_id=? ORDER BY id").all(purchaseId) as any[];
    for (const line of lines) {
      if (!Number.isSafeInteger(Number(line.quantity_base_int)) || Number(line.quantity_base_int) <= 0
        || !Number.isSafeInteger(Number(line.base_uom_scale_snapshot)) || Number(line.base_uom_scale_snapshot) <= 0
        || !Number.isSafeInteger(Number(line.fx_rate_numerator)) || Number(line.fx_rate_numerator) <= 0
        || !Number.isSafeInteger(Number(line.fx_rate_denominator)) || Number(line.fx_rate_denominator) <= 0
        || !String(line.fx_source || "").trim()) {
        throw new ProcurementValidationError("COST_PREVIEW_INPUT_INVALID", `Quantity or FX snapshot is invalid for SKU ${line.product_sku_snapshot}.`);
      }
    }
    for (const component of components) {
      if (!Number.isSafeInteger(Number(component.fx_rate_numerator)) || Number(component.fx_rate_numerator) <= 0
        || !Number.isSafeInteger(Number(component.fx_rate_denominator)) || Number(component.fx_rate_denominator) <= 0
        || !String(component.fx_source || "").trim()) {
        throw new ProcurementValidationError("COST_PREVIEW_INPUT_INVALID", `FX snapshot is invalid for cost component ${component.id}.`);
      }
    }
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

    const lineCosts = lines.map((line) => {
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
      return { line, allocated, freight, customs, cutting, other, merchandiseCost, vatSnapshot, landed, normalized };
    });
    return { purchaseId, header, components, allocations, lineCosts };
  }

  previewAcquisitionCosts(purchaseIdValue: string, input: { allocations: Array<{ componentId: string; mode: "ACCEPT_SUGGESTION" | "MANUAL" | "UNALLOCATED"; lineAllocations?: Array<{ lineId: string; amountTryMinor: number }> }> }) {
    const calculation = this.calculateAcquisitionCosts(purchaseIdValue, input);
    const unallocatedCosts = calculation.allocations.filter((entry) => entry.lineId === null).map((entry) => ({
      componentId: entry.componentId,
      amountTryMinor: entry.amountTryMinor,
      category: calculation.components.find((component) => component.id === entry.componentId)?.category,
    }));
    return {
      purchaseId: calculation.purchaseId,
      formulaVersion: "dsdst.acquisition-cost.v2",
      readOnly: true,
      lines: calculation.lineCosts.map((cost) => ({
        lineId: cost.line.id,
        sku: cost.line.product_sku_snapshot,
        quantityBaseInt: cost.line.quantity_base_int,
        baseUomCode: cost.line.base_uom_code_snapshot,
        unitPurchaseCostTry: reduceRational(BigInt(cost.merchandiseCost) * BigInt(cost.line.base_uom_scale_snapshot), BigInt(cost.line.quantity_base_int), "purchase unit cost"),
        merchandiseCostTryMinor: cost.merchandiseCost,
        allocatedExpenseTryMinor: safeAdd([cost.freight, cost.customs, cost.cutting, cost.other], "allocated expenses"),
        estimatedUnitLandedCostTry: cost.normalized,
        totalCostTryMinor: cost.landed,
      })),
      unallocatedCosts,
      warnings: unallocatedCosts.map((cost) => ({ code: "UNALLOCATED_COST", message: `${cost.componentId} giderinin ${cost.amountTryMinor} kuruşu dağıtılmadı.` })),
      totals: {
        merchandiseTryMinor: safeAdd(calculation.lineCosts.map((cost) => cost.merchandiseCost), "preview merchandise total"),
        allocatedExpensesTryMinor: safeAdd(calculation.lineCosts.map((cost) => safeAdd([cost.freight, cost.customs, cost.cutting, cost.other], "preview allocated expense")), "preview expense total"),
        landedCostTryMinor: safeAdd(calculation.lineCosts.map((cost) => cost.landed), "preview landed total"),
      },
    };
  }

  finalizeAcquisitionCosts(purchaseIdValue: string, input: { allocations: Array<{ componentId: string; mode: "ACCEPT_SUGGESTION" | "MANUAL" | "UNALLOCATED"; lineAllocations?: Array<{ lineId: string; amountTryMinor: number }> }> }) {
    const calculation = this.calculateAcquisitionCosts(purchaseIdValue, input);
    const { purchaseId, header, components, allocations, lineCosts } = calculation;

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
      for (const cost of lineCosts) {
        const { line, allocated, freight, customs, cutting, other, merchandiseCost, vatSnapshot, landed, normalized } = cost;
        const lotSnapshotId = randomUUID();
        insertLot.run(
          lotSnapshotId, purchaseId, line.id, line.product_id, line.quantity_base_int, line.base_uom_code_snapshot,
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
        if (this.hasTable("current_product_landed_costs")) this.db.prepare(`INSERT INTO current_product_landed_costs
          (product_id,acquisition_cost_snapshot_id,purchase_order_id,purchase_line_id,cost_try_numerator,cost_try_denominator,base_uom_code,finalized_at)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(product_id) DO UPDATE SET
            acquisition_cost_snapshot_id=excluded.acquisition_cost_snapshot_id,
            purchase_order_id=excluded.purchase_order_id,purchase_line_id=excluded.purchase_line_id,
            cost_try_numerator=excluded.cost_try_numerator,cost_try_denominator=excluded.cost_try_denominator,
            base_uom_code=excluded.base_uom_code,finalized_at=excluded.finalized_at`)
          .run(line.product_id, lotSnapshotId, purchaseId, line.id, normalized.numerator, normalized.denominator, line.base_uom_code_snapshot, finalizedAt);
      }
      this.db.prepare("UPDATE purchase_orders SET status='APPROVED', finalized_at=? WHERE id=? AND status='DRAFT'").run(finalizedAt, purchaseId);
      if (this.hasTable("procurement_workflows")) this.db.prepare("UPDATE procurement_workflows SET state='COST_PENDING',updated_at=? WHERE purchase_order_id=?").run(finalizedAt, purchaseId);
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
    const payable = this.supplierPayable(header);
    const outstanding = payable.grossMinor - header.paid_minor;
    if (amountMinor > outstanding) throw new ProcurementValidationError("PAYMENT_EXCEEDS_OUTSTANDING", "Payment exceeds purchase outstanding balance.", 409);
    const paidAt = requiredText(input.paidAt, "paidAt", 50);
    if (Number.isNaN(Date.parse(paidAt))) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "paidAt is invalid.");
    const paymentId = input.id ? requiredText(input.id, "payment.id", 200) : randomUUID();
    const postingId = randomUUID();
    const cashTransactionId = `procurement-payment:${paymentId}`;
    const nextPaid = header.paid_minor + amountMinor;
    const paymentStatus = nextPaid === payable.grossMinor ? "PAID" : "PARTIAL";
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
    const payable = this.supplierPayable(header);
    const lineRows = this.db.prepare("SELECT * FROM purchase_order_lines WHERE purchase_order_id=? ORDER BY line_index").all(purchaseId) as any[];
    const componentRows = this.db.prepare("SELECT * FROM purchase_cost_components WHERE purchase_order_id=? ORDER BY id").all(purchaseId) as any[];
    const importedCostDetails = new Map((this.hasTable('procurement_import_draft_costs')
      ? this.db.prepare(`SELECT id,title,description FROM procurement_import_draft_costs
        WHERE id IN (SELECT id FROM purchase_cost_components WHERE purchase_order_id=?)`).all(purchaseId) as Array<{ id: string; title: string; description: string | null }>
      : []).map(row => [row.id,row]));
    const allocationRows = this.db.prepare("SELECT * FROM purchase_cost_allocations WHERE purchase_order_id=? ORDER BY component_id,line_id").all(purchaseId) as any[];
    const packingByLine = new Map((this.hasTable("purchase_line_packing_snapshots")
      ? this.db.prepare("SELECT * FROM purchase_line_packing_snapshots WHERE purchase_order_id=?").all(purchaseId) as any[]
      : []).map((row) => [row.purchase_line_id, row]));
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
    const workflow = this.hasTable("procurement_workflows") ? this.db.prepare("SELECT * FROM procurement_workflows WHERE purchase_order_id=?").get(purchaseId) as any : null;
    const costDetails = new Map((this.hasTable("purchase_cost_component_details")
      ? this.db.prepare("SELECT * FROM purchase_cost_component_details WHERE component_id IN (SELECT id FROM purchase_cost_components WHERE purchase_order_id=?)").all(purchaseId) as any[]
      : []).map((row) => [row.component_id, row]));
    const sourceRows = this.hasTable('procurement_import_records') ? (this.db.prepare(`SELECT r.record_id,r.record_type,r.canonical_id,r.source_json
      FROM procurement_import_records r JOIN procurement_imports i ON i.id=r.import_id
      WHERE i.purchase_order_id=? AND r.record_type IN ('PRODUCT','LINE')`).all(purchaseId) as any[]) : [];
    const productsBySourceRef = new Map<string, any>();
    const linesByCanonicalId = new Map<string, any>();
    for (const record of sourceRows) {
      const source = JSON.parse(record.source_json);
      if (record.record_type === 'PRODUCT') productsBySourceRef.set(record.record_id, source);
      else linesByCanonicalId.set(record.canonical_id, source);
    }
    const catalogSnapshots = new Map((this.hasTable('catalog_product_versions') ? this.db.prepare(`SELECT version_ref,snapshot_json FROM catalog_product_versions
      WHERE version_ref IN (SELECT catalog_version_ref_snapshot FROM purchase_order_lines WHERE purchase_order_id=?)`).all(purchaseId) as Array<{ version_ref: string; snapshot_json: string }> : [])
      .map(row => [row.version_ref, JSON.parse(row.snapshot_json)]));
    const packagePlans = this.hasTable('procurement_package_plan') ? (this.db.prepare('SELECT purchase_line_id,quantity_base_int,mixed FROM procurement_package_plan WHERE purchase_order_id=?').all(purchaseId) as any[]) : [];
    const plansByLine = new Map<string, { count: number; mixedCount: number; distribution: Map<number, number> }>();
    for (const plan of packagePlans) {
      const summary = plansByLine.get(plan.purchase_line_id) || { count: 0, mixedCount: 0, distribution: new Map<number, number>() };
      summary.count++;
      summary.mixedCount += Number(plan.mixed);
      summary.distribution.set(plan.quantity_base_int, (summary.distribution.get(plan.quantity_base_int) || 0) + 1);
      plansByLine.set(plan.purchase_line_id, summary);
    }
    return {
      id: header.id,
      sourcePacking: this.hasTable('procurement_import_records') ? (this.db.prepare(`SELECT r.source_json FROM procurement_import_records r JOIN procurement_imports i ON i.id=r.import_id WHERE i.purchase_order_id=? AND r.record_type IN ('PACKAGE_GROUP','PACKAGE_ITEM') ORDER BY r.record_id`).all(purchaseId) as any[]).map(r => JSON.parse(r.source_json)) : [],
      purchaseNumber: workflow?.purchase_number || header.id,
      orderDate: workflow?.order_date || header.created_at,
      workflowState: workflow?.state || (header.status === "APPROVED" ? "COST_PENDING" : "DRAFT"),
      supplier: { id: header.supplier_id, name: header.supplier_name_snapshot },
      supplierCurrency: header.supplier_currency,
      vatPolicy: header.acquisition_cost_vat_policy,
      status: header.status,
      paymentStatus: this.paymentStatus(header, payable.grossMinor),
      totalNetMinor: payable.netMinor,
      totalVatMinor: payable.vatMinor,
      totalGrossMinor: payable.grossMinor,
      paidMinor: header.paid_minor,
      outstandingMinor: payable.grossMinor - header.paid_minor,
      lines: lineRows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        product: (() => {
          const sourceLine = linesByCanonicalId.get(row.id);
          const sourceProduct = productsBySourceRef.get(sourceLine?.product_ref) || catalogSnapshots.get(row.catalog_version_ref_snapshot) || sourceLine || {};
          return { sku: row.product_sku_snapshot, title: row.product_title_snapshot, catalogVersionRef: row.catalog_version_ref_snapshot,
            supplierCode: sourceProduct.supplier_code || null,
            nameTr: sourceProduct.name_tr || null, nameEn: sourceProduct.name_en || null,
            size: sourceProduct.size || null, material: sourceProduct.material || null,
            profileType: sourceProduct.profile_type || null, productType: sourceProduct.product_type || null };
        })(),
        sourceLineAmountMinor: linesByCanonicalId.has(row.id) ? Number(decimal(linesByCanonicalId.get(row.id).amount, linesByCanonicalId.get(row.id), 'amount', 2)) : null,
        plannedPackages: (() => {
          const plan = plansByLine.get(row.id);
          return plan ? { count: plan.count, mixedCount: plan.mixedCount,
            distribution: [...plan.distribution].map(([quantity, count]) => ({ quantity, count })).sort((a,b) => b.quantity - a.quantity) } : null;
        })(),
        quote: { basis: row.quote_basis, originalQuantity: row.original_quantity, supplierUnitPriceMinor: row.supplier_unit_price_minor, currency: row.supplier_currency, profileLengthMm: row.profile_length_mm, profileLengthKind: row.profile_length_kind },
        normalizedQuantity: { baseQuantity: row.quantity_base_int, baseUomCode: row.base_uom_code_snapshot, quantityScale: row.base_uom_scale_snapshot },
        vat: { mode: row.vat_mode, rateBps: row.vat_rate_bps },
        amounts: { supplier: { netMinor: row.supplier_net_minor, vatMinor: row.supplier_vat_minor, grossMinor: row.supplier_gross_minor }, baseTry: { netMinor: row.base_try_net_minor, vatMinor: row.base_try_vat_minor, grossMinor: row.base_try_gross_minor } },
        fx: { observationId: row.fx_observation_id, numerator: row.fx_rate_numerator, denominator: row.fx_rate_denominator, source: row.fx_source, observedAt: row.fx_observed_at, direction: row.fx_direction },
        normalizedMerchandiseUnitCostTry: { numerator: row.normalized_cost_numerator, denominator: row.normalized_cost_denominator, currency: "TRY", perBaseUom: row.base_uom_code_snapshot },
        packing: packingByLine.has(row.id) ? this.mapPackingRow(packingByLine.get(row.id)) : null,
      })),
      acquisitionCosts: componentRows.map((row) => ({
        id: row.id, category: row.category, sourceAmountMinor: row.source_amount_minor, currency: row.source_currency,
        title: importedCostDetails.get(row.id)?.title || costDetails.get(row.id)?.description || row.category,
        counterparty: costDetails.get(row.id)?.counterparty || null,
        expenseType: costDetails.get(row.id)?.expense_type || row.category,
        description: importedCostDetails.get(row.id)?.description || costDetails.get(row.id)?.description || row.notes,
        occurredOn: costDetails.get(row.id)?.occurred_on || row.created_at,
        targetLineIds: JSON.parse(costDetails.get(row.id)?.target_line_ids_json || "[]"),
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
      documents: (this.hasTable("procurement_documents") ? this.db.prepare("SELECT * FROM procurement_documents WHERE purchase_order_id=? ORDER BY created_at DESC").all(purchaseId) as any[] : []).map((row) => ({
        id: row.id, costComponentId: row.cost_component_id, documentType: row.document_type, fileName: row.original_file_name,
        storageReference: row.storage_reference, mediaType: row.media_type, sizeBytes: row.size_bytes, createdAt: row.created_at,
      })),
    };
  }

  listSuppliers() {
    return this.db.prepare(`SELECT id,name,default_currency AS defaultCurrency,tax_identifier AS taxIdentifier,
      contact_json AS contactJson,notes,active,created_at AS createdAt FROM procurement_suppliers ORDER BY name`).all()
      .map((row: any) => ({ ...row, contact: row.contactJson ? JSON.parse(row.contactJson) : null, contactJson: undefined }));
  }

  listPurchases() {
    return (this.db.prepare(`SELECT p.id,p.supplier_name_snapshot,p.supplier_currency,p.total_gross_minor,p.created_at,p.finalized_at,
      w.purchase_number,w.order_date,w.state,
      (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.purchase_order_id=p.id) AS line_count,
      (SELECT COUNT(*) FROM warehouse_goods_receipts r WHERE r.purchase_order_id=p.id) AS received_line_count
      FROM purchase_orders p JOIN procurement_workflows w ON w.purchase_order_id=p.id
      ORDER BY datetime(p.created_at) DESC`).all() as any[]).map((row) => ({
        id: row.id, purchaseNumber: row.purchase_number, orderDate: row.order_date, workflowState: row.state,
        supplierName: row.supplier_name_snapshot, supplierCurrency: row.supplier_currency, totalGrossMinor: safeAdd([row.total_gross_minor, this.supplierSurcharges(row.id).grossMinor], "supplier payable"),
        lineCount: Number(row.line_count), receivedLineCount: Number(row.received_line_count), finalizedAt: row.finalized_at,
      }));
  }

  transitionWorkflow(purchaseIdValue: string, nextState: PurchaseWorkflowState) {
    const purchaseId = requiredText(purchaseIdValue, "purchaseId", 200);
    const current = this.db.prepare("SELECT state FROM procurement_workflows WHERE purchase_order_id=?").pluck().get(purchaseId) as PurchaseWorkflowState | undefined;
    if (!current) throw new ProcurementValidationError("PURCHASE_NOT_FOUND", "Purchase was not found.", 404);
    const allowed: Record<PurchaseWorkflowState, PurchaseWorkflowState[]> = {
      DRAFT: ["ORDERED", "COST_PENDING"], ORDERED: ["IN_TRANSIT", "COST_PENDING"], IN_TRANSIT: ["COST_PENDING"],
      COST_PENDING: [], RECEIPT_PENDING: [], COMPLETED: [],
    };
    if (!allowed[current].includes(nextState)) throw new ProcurementValidationError("INVALID_PURCHASE_TRANSITION", `${current} cannot transition to ${nextState}.`, 409);
    const updatedAt = new Date().toISOString();
    this.db.prepare("UPDATE procurement_workflows SET state=?,updated_at=? WHERE purchase_order_id=?").run(nextState, updatedAt, purchaseId);
    return this.getPurchase(purchaseId);
  }

  addAcquisitionCost(purchaseIdValue: string, input: PurchaseCostInput) {
    const purchaseId = requiredText(purchaseIdValue, "purchaseId", 200);
    const header = this.db.prepare("SELECT status,supplier_currency,acquisition_cost_vat_policy FROM purchase_orders WHERE id=?").get(purchaseId) as any;
    if (!header) throw new ProcurementValidationError("PURCHASE_NOT_FOUND", "Purchase was not found.", 404);
    if (header.status !== "DRAFT") throw new ProcurementValidationError("PURCHASE_ALREADY_FINALIZED", "Finalized purchase costs cannot be changed.", 409);
    this.validateCounterparty(input, header.supplier_currency);
    const rows = this.db.prepare("SELECT * FROM purchase_order_lines WHERE purchase_order_id=? ORDER BY line_index").all(purchaseId) as any[];
    const targetIds = Array.isArray(input.targetLineIds) ? [...new Set(input.targetLineIds.map((id) => requiredText(id, "targetLineId", 200)))] : [];
    const selectedRows = targetIds.length ? rows.filter((row) => targetIds.includes(row.id)) : rows;
    if (!selectedRows.length || selectedRows.length !== (targetIds.length || rows.length)) throw new ProcurementValidationError("INVALID_COST_TARGET", "Every selected cost target must belong to the purchase.");
    const createdAt = new Date().toISOString();
    const normalizedLines = selectedRows.map((row) => ({
      id: row.id, baseTry: { netMinor: row.base_try_net_minor },
    })) as NormalizedLine[];
    const normalized = this.normalizeCost(input, normalizedLines, createdAt, header.acquisition_cost_vat_policy);
    const expenseType = input.expenseType || (input.category === "FREIGHT" ? "FREIGHT" : input.category === "CUSTOMS" ? "CUSTOMS_DUTY" : "OTHER");
    const allowedExpenseTypes = new Set<PurchaseExpenseType>(["FREIGHT","CUSTOMS_DUTY","ADDITIONAL_TAX","CUSTOMS_BROKER","WAREHOUSE_PORT","DOMESTIC_FREIGHT","INSURANCE","BANK_TRANSFER","OTHER"]);
    if (!allowedExpenseTypes.has(expenseType)) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "expenseType is unsupported.");
    const occurredOn = requiredText(input.occurredOn || createdAt.slice(0, 10), "occurredOn", 30);
    if (Number.isNaN(Date.parse(occurredOn))) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "occurredOn is invalid.");
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO purchase_cost_components (
        id,purchase_order_id,category,source_currency,source_amount_minor,vat_mode,vat_rate_bps,
        source_net_minor,source_vat_minor,source_gross_minor,base_try_net_minor,base_try_vat_minor,base_try_gross_minor,
        fx_observation_id,fx_rate_numerator,fx_rate_denominator,fx_source,fx_observed_at,suggestion_json,rounding_residual_minor,notes,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        normalized.id,purchaseId,normalized.category,normalized.currency,normalized.sourceAmountMinor,normalized.vatMode,normalized.vatRateBps,
        normalized.source.netMinor,normalized.source.vatMinor,normalized.source.grossMinor,normalized.baseTry.netMinor,normalized.baseTry.vatMinor,normalized.baseTry.grossMinor,
        normalized.fx.observationId,normalized.fx.numerator,normalized.fx.denominator,normalized.fx.source,normalized.fx.observedAt,
        JSON.stringify(normalized.suggestions),normalized.roundingResidualMinor,normalized.notes,createdAt,
      );
      this.db.prepare(`INSERT INTO purchase_cost_component_details
        (component_id,expense_type,description,occurred_on,target_scope,target_line_ids_json,created_at,counterparty) VALUES (?,?,?,?,?,?,?,?)`)
        .run(normalized.id, expenseType, optionalText(input.description || input.notes, "description", 1000), occurredOn,
          targetIds.length ? "SELECTED_LINES" : "COMMON", JSON.stringify(targetIds), createdAt, input.counterparty);
      const currentHeader = this.db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(purchaseId);
      this.db.prepare('UPDATE purchase_orders SET payment_status=? WHERE id=?').run(this.paymentStatus(currentHeader), purchaseId);
      this.db.prepare("UPDATE procurement_workflows SET state='COST_PENDING',updated_at=? WHERE purchase_order_id=? AND state IN ('DRAFT','ORDERED','IN_TRANSIT')")
        .run(createdAt, purchaseId);
    }).immediate();
    return this.getPurchase(purchaseId);
  }

  approveForReceipt(purchaseIdValue: string, actorId: string) {
    const purchaseId = requiredText(purchaseIdValue, "purchaseId", 200);
    const row = this.db.prepare(`SELECT p.status,w.state,
      (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.purchase_order_id=p.id) AS line_count,
      (SELECT COUNT(*) FROM acquisition_lot_cost_snapshots s WHERE s.purchase_order_id=p.id) AS snapshot_count
      FROM purchase_orders p JOIN procurement_workflows w ON w.purchase_order_id=p.id WHERE p.id=?`).get(purchaseId) as any;
    if (!row) throw new ProcurementValidationError("PURCHASE_NOT_FOUND", "Purchase was not found.", 404);
    if (row.status !== "APPROVED" || Number(row.line_count) === 0 || Number(row.line_count) !== Number(row.snapshot_count)) {
      throw new ProcurementValidationError("FINAL_LANDED_COST_REQUIRED", "Every purchase line requires a final landed-cost snapshot before receipt approval.", 409);
    }
    if (row.state !== "COST_PENDING") throw new ProcurementValidationError("INVALID_PURCHASE_TRANSITION", "Only a cost-finalized purchase can be approved for receipt.", 409);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE procurement_workflows SET state='RECEIPT_PENDING',receipt_approved_at=?,receipt_approved_by=?,updated_at=? WHERE purchase_order_id=?`)
      .run(now, requiredText(actorId, "actorId", 200), now, purchaseId);
    return this.getPurchase(purchaseId);
  }

  recordDocument(input: { id?: string; purchaseId: string; costComponentId?: string | null; documentType: string; fileName: string; storageReference: string; mediaType: string; sizeBytes: number; sha256: string; uploadedBy: string }) {
    const purchaseId = requiredText(input.purchaseId, "purchaseId", 200);
    if (!this.db.prepare("SELECT 1 FROM purchase_orders WHERE id=?").get(purchaseId)) throw new ProcurementValidationError("PURCHASE_NOT_FOUND", "Purchase was not found.", 404);
    const documentTypes = new Set(["PROFORMA_INVOICE","COMMERCIAL_INVOICE","PACKING_LIST","CUSTOMS_DOCUMENT","FREIGHT_DOCUMENT","EXPENSE_INVOICE","OTHER"]);
    const documentType = requiredText(input.documentType, "documentType", 50);
    if (!documentTypes.has(documentType)) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "documentType is unsupported.");
    const costComponentId = input.costComponentId ? requiredText(input.costComponentId, "costComponentId", 200) : null;
    if (costComponentId && !this.db.prepare("SELECT 1 FROM purchase_cost_components WHERE id=? AND purchase_order_id=?").get(costComponentId, purchaseId)) {
      throw new ProcurementValidationError("INVALID_COST_DOCUMENT", "Cost component does not belong to the purchase.");
    }
    const id = input.id || randomUUID();
    const sha256 = requiredText(input.sha256,"sha256",64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "sha256 is invalid.");
    this.db.prepare(`INSERT INTO procurement_documents
      (id,purchase_order_id,cost_component_id,document_type,original_file_name,storage_reference,media_type,size_bytes,sha256,uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,purchaseId,costComponentId,documentType,requiredText(input.fileName,"fileName",300),requiredText(input.storageReference,"storageReference",500),
        requiredText(input.mediaType,"mediaType",150),integerMoney(input.sizeBytes,"sizeBytes",false),sha256,requiredText(input.uploadedBy,"uploadedBy",200));
    return this.getPurchase(purchaseId);
  }

  previewCsv(rows: Array<Record<string, unknown>>) {
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000) throw new ProcurementValidationError("PROCUREMENT_VALIDATION_FAILED", "CSV rows must contain between 1 and 1000 records.");
    return rows.map((row, index) => {
      const rowNumber = index + 2;
      const sku = csvText(csvRowValue(row, csvAliases.sku));
      const supplierNo = csvText(csvRowValue(row, csvAliases.supplierNo));
      const productTypeRaw = csvText(csvRowValue(row, csvAliases.productType));
      const productType = canonicalProductType(productTypeRaw);
      const size = csvText(csvRowValue(row, csvAliases.size)) || null;
      const material = csvText(csvRowValue(row, csvAliases.material)) || null;
      const profileType = csvText(csvRowValue(row, csvAliases.profileType)) || null;
      const nameEn = csvText(csvRowValue(row, csvAliases.nameEn)) || null;
      const nameTr = csvText(csvRowValue(row, csvAliases.nameTr)) || null;
      const totalQuantity = csvNumber(csvRowValue(row, csvAliases.totalQuantity));
      const boxCount = csvNumber(csvRowValue(row, csvAliases.boxCount));
      const unitsPerBox = csvNumber(csvRowValue(row, csvAliases.unitsPerBox));
      const boxWeightKg = csvNumber(csvRowValue(row, csvAliases.boxWeightKg));
      const totalWeightKg = csvNumber(csvRowValue(row, csvAliases.totalWeightKg));
      const partWeightG = csvNumber(csvRowValue(row, csvAliases.partWeightG));
      const purchasePriceUsd = csvNumber(csvRowValue(row, csvAliases.purchasePriceUsd));
      const product = sku ? this.findProductBySku(sku) : null;
      const errors: string[] = [];
      const addError = (message: string) => errors.push(`Satır ${rowNumber} · SKU ${sku || "—"}: ${message}`);
      if (!sku) addError("SKU boş olamaz.");
      if (!supplierNo) addError("Tedarik NO boş olamaz.");
      if (!productType) addError("TÜR geçersiz. Beklenen değerler: simple, component, assembly veya accessory.");
      if (!positiveInteger(totalQuantity)) addError("Toplam adet pozitif tam sayı olmalıdır.");
      if (!positiveInteger(boxCount)) addError("Kutu sayısı pozitif tam sayı olmalıdır.");
      if (!positiveInteger(unitsPerBox)) addError("Kutu içi adet pozitif tam sayı olmalıdır.");
      if (!Number.isFinite(boxWeightKg) || boxWeightKg <= 0) addError("Kutu ağırlığı 0'dan büyük olmalıdır.");
      if (!Number.isFinite(totalWeightKg) || totalWeightKg <= 0) addError("Toplam ağırlık 0'dan büyük olmalıdır.");
      if (!Number.isFinite(partWeightG) || partWeightG <= 0) addError("Parça ağırlığı 0'dan büyük olmalıdır.");
      if (!Number.isFinite(purchasePriceUsd) || purchasePriceUsd < 0) addError("Alış fiyatı USD 0 veya daha büyük olmalıdır.");
      if (positiveInteger(boxCount) && positiveInteger(unitsPerBox) && positiveInteger(totalQuantity)
        && boxCount * unitsPerBox !== totalQuantity) {
        addError(`Toplam adet uyuşmuyor. ${boxCount} kutu × ${unitsPerBox} adet = ${boxCount * unitsPerBox} olmalı; CSV'de ${totalQuantity} girilmiş.`);
      }
      if (Number.isFinite(boxCount) && Number.isFinite(boxWeightKg) && Number.isFinite(totalWeightKg)
        && Math.abs(boxCount * boxWeightKg - totalWeightKg) > 0.05 + Number.EPSILON) {
        addError(`Toplam ağırlık uyuşmuyor. Hesaplanan ${(boxCount * boxWeightKg).toFixed(2)} kg; CSV'de ${totalWeightKg.toFixed(2)} kg.`);
      }
      const packing = productType ? {
        sku, supplierNo, productType, size, material, profileType, nameEn, nameTr,
        totalQuantity, boxCount, unitsPerBox, boxWeightKg, totalWeightKg, partWeightG,
      } : null;
      if (product && packing) {
        for (const mismatch of this.masterMismatches(packing, product)) addError(mismatch);
      }
      if (!product && sku && !nameTr && !nameEn) addError("Yeni SKU için İsim - TR veya İsim - EN zorunludur.");
      const catalogProposal = !product && sku && productType ? {
        sku, supplierNo, productType, size, material, profileType, nameEn, nameTr, partWeightG,
      } : null;
      return {
        row: rowNumber, sku,
        quantity: positiveInteger(totalQuantity) ? String(totalQuantity) : "",
        unitPriceUsd: Number.isFinite(purchasePriceUsd) && purchasePriceUsd >= 0 ? String(purchasePriceUsd) : "",
        product: product ? { id: product.id, sku: product.sku, title: product.title, base_uom_code: product.base_uom_code, catalog_type: product.catalog_type, isNew: false } : null,
        packing, catalogProposal, isNewProduct: !product && errors.length === 0, errors,
      };
    });
  }

  getPackagePlan(lineId: string) {
    if (!this.hasTable('procurement_package_plan')) return null;
    const rows = this.db.prepare(`SELECT pp.*,p.sku,p.title,p.product_type,p.size
      FROM procurement_package_plan pp JOIN products p ON p.id=pp.product_id
      WHERE pp.purchase_line_id=? ORDER BY pp.source_group_ref,pp.carton_index,pp.id`).all(lineId) as any[];
    if (!rows.length) return null;
    return { version: rows[0].plan_version, packages: rows.map(r => ({ id: r.id, code: r.package_code, quantityBaseInt: r.quantity_base_int,
      sourceCartonId: r.source_carton_id, sourceGroupRef: r.source_group_ref, sourceItemRef: r.source_item_ref,
      mixed: Boolean(r.mixed), grossWeightKgEstimate: r.gross_weight_kg_estimate,
      sku: JSON.parse(r.product_snapshot_json).sku, title: JSON.parse(r.product_snapshot_json).title,
      productType: JSON.parse(r.product_snapshot_json).product_type, size: JSON.parse(r.product_snapshot_json).size })) };
  }

  listReceiptReady() {
    const packingColumns = this.hasTable("purchase_line_packing_snapshots")
      ? `,pk.supplier_no,pk.total_quantity,pk.box_count,pk.units_per_box,pk.box_weight_grams,pk.total_weight_grams,pk.part_weight_milligrams`
      : `,NULL AS supplier_no,NULL AS total_quantity,NULL AS box_count,NULL AS units_per_box,NULL AS box_weight_grams,NULL AS total_weight_grams,NULL AS part_weight_milligrams`;
    const packingJoin = this.hasTable("purchase_line_packing_snapshots") ? "LEFT JOIN purchase_line_packing_snapshots pk ON pk.purchase_line_id=l.id" : "";
    return (this.db.prepare(`SELECT s.id AS cost_snapshot_id,s.purchase_order_id,s.purchase_line_id,s.product_id,
      s.quantity_base_int,s.base_uom_code_snapshot,w.purchase_number,w.order_date,
      p.supplier_name_snapshot,l.product_sku_snapshot,l.product_title_snapshot ${packingColumns}
      FROM acquisition_lot_cost_snapshots s
      JOIN purchase_orders p ON p.id=s.purchase_order_id
      JOIN procurement_workflows w ON w.purchase_order_id=p.id
      JOIN purchase_order_lines l ON l.id=s.purchase_line_id
      ${packingJoin}
      LEFT JOIN warehouse_goods_receipts r ON r.acquisition_cost_snapshot_id=s.id
      LEFT JOIN inventory_lots il ON il.acquisition_cost_snapshot_id=s.id
      WHERE w.state='RECEIPT_PENDING' AND s.state='COSTED_PENDING_RECEIPT' AND p.status='APPROVED' AND r.id IS NULL AND il.id IS NULL
      ORDER BY w.order_date,w.purchase_number,l.line_index`).all() as any[]).map((row) => ({
        packagePlan: this.getPackagePlan(row.purchase_line_id),
        costSnapshotId: row.cost_snapshot_id, purchaseOrderId: row.purchase_order_id, purchaseLineId: row.purchase_line_id,
        productId: row.product_id, purchaseNumber: row.purchase_number, orderDate: row.order_date,
        supplierName: row.supplier_name_snapshot, sku: row.product_sku_snapshot, productTitle: row.product_title_snapshot,
        quantityBaseInt: Number(row.quantity_base_int), baseUomCode: row.base_uom_code_snapshot,
        supplierNo: row.supplier_no,
        totalQuantity: row.total_quantity == null ? null : Number(row.total_quantity),
        boxCount: row.box_count == null ? null : Number(row.box_count),
        unitsPerBox: row.units_per_box == null ? null : Number(row.units_per_box),
        boxWeightKg: row.box_weight_grams == null ? null : Number(row.box_weight_grams) / 1000,
        totalWeightKg: row.total_weight_grams == null ? null : Number(row.total_weight_grams) / 1000,
        partWeightG: row.part_weight_milligrams == null ? null : Number(row.part_weight_milligrams) / 1000,
      }));
  }

  getProductPurchaseHistory(productIdValue: string) {
    const productId = requiredText(productIdValue, "productId", 200);
    if (!this.db.prepare("SELECT 1 FROM products WHERE id=?").get(productId)) {
      throw new ProcurementValidationError("CATALOG_PRODUCT_NOT_FOUND", "Canonical catalog item was not found.", 404);
    }
    const packingColumns = this.hasTable("purchase_line_packing_snapshots")
      ? `pk.supplier_no,pk.total_quantity,pk.box_count,pk.units_per_box,pk.box_weight_grams,pk.total_weight_grams,pk.part_weight_milligrams,`
      : `NULL AS supplier_no,NULL AS total_quantity,NULL AS box_count,NULL AS units_per_box,NULL AS box_weight_grams,NULL AS total_weight_grams,NULL AS part_weight_milligrams,`;
    const packingJoin = this.hasTable("purchase_line_packing_snapshots") ? "LEFT JOIN purchase_line_packing_snapshots pk ON pk.purchase_line_id=l.id" : "";
    const rows = this.db.prepare(`SELECT l.id AS purchase_line_id,l.purchase_order_id,l.quantity_base_int,
      l.supplier_unit_price_minor,l.supplier_currency,l.supplier_net_minor,
      p.supplier_name_snapshot,p.created_at,w.purchase_number,w.order_date,w.state,
      ${packingColumns}
      s.id AS cost_snapshot_id,s.normalized_cost_numerator,s.normalized_cost_denominator,
      r.supplier_lot_code,r.accepted_quantity_base_int,r.received_at,
      il.received_at AS inventory_received_at
      FROM purchase_order_lines l
      JOIN purchase_orders p ON p.id=l.purchase_order_id
      JOIN procurement_workflows w ON w.purchase_order_id=p.id
      ${packingJoin}
      LEFT JOIN acquisition_lot_cost_snapshots s ON s.purchase_line_id=l.id
      LEFT JOIN warehouse_goods_receipts r ON r.acquisition_cost_snapshot_id=s.id
      LEFT JOIN inventory_lots il ON il.acquisition_cost_snapshot_id=s.id
      WHERE l.product_id=?
      ORDER BY date(w.order_date) DESC,datetime(p.created_at) DESC,l.line_index DESC`).all(productId) as any[];
    return rows.map((row) => ({
      purchaseOrderId: row.purchase_order_id,
      purchaseLineId: row.purchase_line_id,
      acquisitionCostSnapshotId: row.cost_snapshot_id,
      purchaseNumber: row.purchase_number,
      orderDate: row.order_date,
      supplierName: row.supplier_name_snapshot,
      supplierNo: row.supplier_no,
      workflowState: row.state,
      lotCode: row.supplier_lot_code,
      orderedTotalQuantity: row.total_quantity == null ? Number(row.quantity_base_int) : Number(row.total_quantity),
      boxCount: row.box_count == null ? null : Number(row.box_count),
      unitsPerBox: row.units_per_box == null ? null : Number(row.units_per_box),
      boxWeightKg: row.box_weight_grams == null ? null : Number(row.box_weight_grams) / 1000,
      totalWeightKg: row.total_weight_grams == null ? null : Number(row.total_weight_grams) / 1000,
      partWeightG: row.part_weight_milligrams == null ? null : Number(row.part_weight_milligrams) / 1000,
      supplierUnitPriceUsd: row.supplier_currency === "USD" ? Number(row.supplier_unit_price_minor) / 100 : null,
      lineTotalPurchaseUsd: row.supplier_currency === "USD" ? Number(row.supplier_net_minor) / 100 : null,
      finalLandedCostTry: row.normalized_cost_numerator == null ? null : Number(row.normalized_cost_numerator) / Number(row.normalized_cost_denominator) / 100,
      receivedAt: row.received_at || row.inventory_received_at || null,
      acceptedQuantity: row.accepted_quantity_base_int == null ? null : Number(row.accepted_quantity_base_int),
    }));
  }

  markReceiptRecorded(purchaseIdValue: string, completedAt: string) {
    const purchaseId = requiredText(purchaseIdValue, "purchaseId", 200);
    const counts = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM acquisition_lot_cost_snapshots WHERE purchase_order_id=?) AS expected,
      (SELECT COUNT(DISTINCT s.id) FROM acquisition_lot_cost_snapshots s
        LEFT JOIN warehouse_goods_receipts r ON r.acquisition_cost_snapshot_id=s.id
        LEFT JOIN inventory_lots il ON il.acquisition_cost_snapshot_id=s.id
        WHERE s.purchase_order_id=? AND (r.id IS NOT NULL OR il.id IS NOT NULL)) AS received`).get(purchaseId, purchaseId) as any;
    if (Number(counts.expected) > 0 && Number(counts.expected) === Number(counts.received)) {
      this.db.prepare(`UPDATE procurement_workflows SET state='COMPLETED',completed_at=?,updated_at=?
        WHERE purchase_order_id=? AND state='RECEIPT_PENDING'`).run(completedAt, completedAt, purchaseId);
      return true;
    }
    return false;
  }

  private findProductBySku(sku: string) {
    return this.db.prepare(`SELECT p.id,p.sku,p.title,p.base_uom_code,p.catalog_type,p.catalog_version_ref,
      p.supplier_code,p.product_type,p.size,p.pipe_size,p.material,p.tube_type_code,
      p.normalized_size,p.normalized_pipe_size,p.normalized_material,p.normalized_tube_type,
      p.name_en,p.name_tr,p.weight_grams,p.mass_grams_int
      FROM products p WHERE upper(p.sku)=upper(?) AND p.catalog_version>0`).get(sku) as any;
  }

  private masterMismatches(input: PurchaseLinePackingInput | PurchaseCatalogProposal, product: any) {
    const mismatches: string[] = [];
    const compare = (label: string, systemValue: unknown, csvValue: unknown) => {
      if (!csvValue || systemValue == null || String(systemValue).trim() === "" || comparable(systemValue) === "bilinmiyor") return;
      if (comparable(systemValue) !== comparable(csvValue)) {
        mismatches.push(`${label} uyuşmuyor. Sistemde ${systemValue}, CSV'de ${csvValue}.`);
      }
    };
    compare("SKU", product.sku, input.sku);
    compare("Tedarik NO", product.supplier_code, input.supplierNo);
    compare("TÜR", product.product_type, input.productType);
    compare("İsim - EN", product.name_en, input.nameEn);
    compare("İsim - TR", product.name_tr, input.nameTr);
    const csvNormalized = generateNormalizedFields({
      material: input.material, size: input.size, pipe_size: input.size, category: input.profileType,
      name: [input.nameTr, input.nameEn].filter(Boolean).join(" "), title: product.title,
    });
    if (input.material) compare("Malzeme", product.normalized_material || product.material, csvNormalized.normalized_material);
    if (input.size) compare("Ölçü", product.normalized_pipe_size || product.normalized_size || product.pipe_size || product.size, csvNormalized.normalized_pipe_size || csvNormalized.normalized_size);
    if (input.profileType) compare("Profil tipi", product.normalized_tube_type || product.tube_type_code, input.profileType);
    const systemWeight = Number(product.mass_grams_int ?? product.weight_grams);
    if (Number.isFinite(systemWeight) && systemWeight > 0 && Number.isFinite(input.partWeightG)
      && Math.abs(systemWeight - input.partWeightG) > 0.51) {
      mismatches.push(`Parça ağırlığı uyuşmuyor. Sistemde ${systemWeight} g, CSV'de ${input.partWeightG} g.`);
    }
    return mismatches;
  }

  private materializePurchaseLine(input: PurchaseLineInput, lineIndex: number): PurchaseLineInput {
    if (input.productId) return input;
    if (!input.catalogProposal) {
      throw new ProcurementValidationError("CATALOG_PRODUCT_NOT_FOUND", `Satın alma satırı ${lineIndex + 1} için canonical ürün veya güvenli katalog önerisi gereklidir.`);
    }
    const proposal = input.catalogProposal;
    const existing = this.findProductBySku(requiredText(proposal.sku, "catalogProposal.sku", 120));
    if (existing) return { ...input, productId: existing.id };
    try {
      const created = this.catalog.createProduct({
        sku: proposal.sku,
        title: proposal.nameTr || proposal.nameEn || proposal.sku,
        catalog_type: "product",
        base_uom_code: "piece",
        mass_grams: Math.round(Number(proposal.partWeightG)),
        status: "Passive",
        name_tr: proposal.nameTr,
        name_en: proposal.nameEn,
        supplier_code: proposal.supplierNo,
        product_type: proposal.productType,
        material: proposal.material,
        size: proposal.size,
        profile_type: proposal.profileType,
        is_sellable: false,
      }, { activationProvenance: "PROCUREMENT_CSV_FIRST_RECEIPT" });
      return { ...input, productId: created.id };
    } catch (error) {
      if (error instanceof CatalogValidationError) {
        throw new ProcurementValidationError("CATALOG_PROPOSAL_INVALID", error.message, error.statusCode);
      }
      throw error;
    }
  }

  private normalizePacking(input: PurchaseLinePackingInput, product: any, originalQuantity: string): NormalizedPacking {
    const supplierNo = requiredText(input.supplierNo, "packing.supplierNo", 200);
    if (!canonicalProductType(input.productType)) throw new ProcurementValidationError("INVALID_PRODUCT_TYPE", "packing.productType is not canonical.");
    if (!positiveInteger(input.totalQuantity) || !positiveInteger(input.boxCount) || !positiveInteger(input.unitsPerBox)) {
      throw new ProcurementValidationError("INVALID_PACKING_QUANTITY", "Packing quantities must be positive integers.");
    }
    if (input.boxCount * input.unitsPerBox !== input.totalQuantity) {
      throw new ProcurementValidationError("PACKING_QUANTITY_MISMATCH", `${input.boxCount} boxes × ${input.unitsPerBox} units does not equal ${input.totalQuantity}.`);
    }
    if (Number(originalQuantity) !== input.totalQuantity) {
      throw new ProcurementValidationError("PACKING_LINE_QUANTITY_MISMATCH", "Purchase line quantity must equal packing total quantity.");
    }
    const boxWeightGrams = Math.round(Number(input.boxWeightKg) * 1000);
    const totalWeightGrams = Math.round(Number(input.totalWeightKg) * 1000);
    const partWeightMilligrams = Math.round(Number(input.partWeightG) * 1000);
    if (![boxWeightGrams, totalWeightGrams, partWeightMilligrams].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new ProcurementValidationError("INVALID_PACKING_WEIGHT", "Packing weights must be positive fixed-precision values.");
    }
    if (Math.abs(input.boxCount * boxWeightGrams - totalWeightGrams) > 50) {
      throw new ProcurementValidationError("PACKING_WEIGHT_MISMATCH", "Calculated box weight total differs from total weight by more than 0.05 kg.");
    }
    const mismatches = this.masterMismatches(input, product);
    if (mismatches.length) throw new ProcurementValidationError("PRODUCT_MASTER_MISMATCH", mismatches.join(" "), 409);
    return {
      supplierNo,
      productType: input.productType,
      size: optionalText(input.size, "packing.size", 150),
      material: optionalText(input.material, "packing.material", 150),
      profileType: optionalText(input.profileType, "packing.profileType", 100),
      nameEn: optionalText(input.nameEn, "packing.nameEn", 300),
      nameTr: optionalText(input.nameTr, "packing.nameTr", 300),
      totalQuantity: input.totalQuantity,
      boxCount: input.boxCount,
      unitsPerBox: input.unitsPerBox,
      boxWeightGrams,
      totalWeightGrams,
      partWeightMilligrams,
    };
  }

  private mapPackingRow(row: any) {
    return {
      supplierNo: row.supplier_no,
      productType: row.product_type_snapshot,
      size: row.size_snapshot,
      material: row.material_snapshot,
      profileType: row.profile_type_snapshot,
      nameEn: row.name_en_snapshot,
      nameTr: row.name_tr_snapshot,
      totalQuantity: Number(row.total_quantity),
      boxCount: Number(row.box_count),
      unitsPerBox: Number(row.units_per_box),
      boxWeightKg: Number(row.box_weight_grams) / 1000,
      totalWeightKg: Number(row.total_weight_grams) / 1000,
      partWeightG: Number(row.part_weight_milligrams) / 1000,
    };
  }

  private normalizeLine(input: PurchaseLineInput, lineIndex: number, createdAt: string): NormalizedLine {
    const productId = requiredText(input.productId, "productId", 200);
    const product = this.db.prepare(`SELECT p.id,p.sku,p.title,p.catalog_type,p.catalog_class,p.catalog_version_ref,p.base_uom_code,u.quantity_scale,
      p.supplier_code,p.product_type,p.size,p.pipe_size,p.material,p.tube_type_code,p.normalized_size,p.normalized_pipe_size,
      p.normalized_material,p.normalized_tube_type,p.name_en,p.name_tr,p.weight_grams,p.mass_grams_int
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
    const packing = input.packing ? this.normalizePacking(input.packing, product, originalQuantity) : null;
    return {
      id: input.id ? requiredText(input.id, "line.id", 200) : randomUUID(), lineIndex, productId,
      productSku: requiredText(product.sku, "product.sku", 200), productTitle: requiredText(product.title, "product.title"),
      catalogVersionRef: requiredText(product.catalog_version_ref, "product.catalogVersionRef", 250),
      baseUomCode: product.base_uom_code, baseUomScale: Number(product.quantity_scale), originalQuantity, quoteBasis,
      profileLengthMm, profileLengthKind, quantityBaseInt, unitPriceMinor, currency, vatMode: mode, vatRateBps: rateBps,
      supplier: supplierAmounts, baseTry, fx, normalizedCost, notes: optionalText(input.notes, "line.notes", 1000), packing,
    };
  }

  private validateCounterparty(input: PurchaseCostInput, supplierCurrency: string) {
    if (!['SUPPLIER','THIRD_PARTY'].includes(input.counterparty || '')) throw new ProcurementValidationError('COST_COUNTERPARTY_REQUIRED', 'DECISION REQUIRED: cost counterparty / gider muhatabı seçilmeli.');
    if (input.counterparty === 'SUPPLIER' && input.currency !== supplierCurrency) throw new ProcurementValidationError('SUPPLIER_COST_CURRENCY_MISMATCH', 'Tedarikçi ek bedeli fatura para biriminde olmalı.');
  }

  // Original invoice snapshots never change. Explicit manual supplier surcharges extend payable once.
  private supplierSurcharges(purchaseId: string) {
    const rows = this.db.prepare(`SELECT c.source_net_minor,c.source_vat_minor,c.source_gross_minor
      FROM purchase_cost_components c JOIN purchase_cost_component_details d ON d.component_id=c.id
      WHERE c.purchase_order_id=? AND d.counterparty='SUPPLIER'`).all(purchaseId) as any[];
    return { netMinor: safeAdd(rows.map(r => r.source_net_minor), 'supplier surcharge net'),
      vatMinor: safeAdd(rows.map(r => r.source_vat_minor), 'supplier surcharge VAT'),
      grossMinor: safeAdd(rows.map(r => r.source_gross_minor), 'supplier surcharge gross') };
  }
  private supplierPayable(header: any) {
    const surcharge = this.supplierSurcharges(header.id);
    return { netMinor: safeAdd([header.total_net_minor, surcharge.netMinor], 'supplier net'),
      vatMinor: safeAdd([header.total_vat_minor, surcharge.vatMinor], 'supplier VAT'),
      grossMinor: safeAdd([header.total_gross_minor, surcharge.grossMinor], 'supplier gross') };
  }
  private paymentStatus(header: any, grossMinor = this.supplierPayable(header).grossMinor) {
    return header.paid_minor === 0 ? 'UNPAID' : header.paid_minor === grossMinor ? 'PAID' : 'PARTIAL';
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
