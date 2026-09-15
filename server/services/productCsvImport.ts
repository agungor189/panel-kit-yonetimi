import crypto from "node:crypto";
import type Database from "better-sqlite3";
import {
  canonicalProductType,
  csvValue,
  parseReserveLocations,
  resolveProductCsvHeaders,
  type ProductCsvField,
  type ProductType,
} from "../../shared/productCsvMapping.js";
import { generateNormalizedFields } from "../utils/normalizeProductFields.js";

type CsvRecord = Record<string, unknown>;

type ValidationError = {
  row?: number;
  field?: ProductCsvField | "headers" | "database";
  code: string;
  message: string;
};

type ExistingProduct = {
  id: string;
  sku: string;
  supplier_code?: string | null;
  name?: string | null;
  name_tr?: string | null;
  name_en?: string | null;
  title: string;
  description?: string | null;
  material?: string | null;
  category?: string | null;
  model?: string | null;
  product_series?: string | null;
  tube_type_code?: string | null;
  size?: string | null;
  pipe_size?: string | null;
  form_code?: string | null;
  connection_type?: string | null;
  central_stock?: number | null;
  product_type?: string | null;
  purchase_price_usd?: number | null;
  weight?: number | null;
  weight_grams?: number | null;
  warehouse_location?: string | null;
  barcode?: string | null;
  notes?: string | null;
};

type PreparedProduct = {
  sourceRow: number;
  id: string;
  existingId: string | null;
  sku: string;
  supplier_code: string | null;
  name_tr: string | null;
  name_en: string | null;
  name: string;
  title: string;
  description: string | null;
  material: string | null;
  category: string | null;
  model: string | null;
  product_series: string | null;
  tube_type_code: string | null;
  size: string | null;
  pipe_size: string | null;
  form_code: string | null;
  connection_type: string | null;
  central_stock: number;
  has_stock_value: boolean;
  product_type: ProductType;
  is_sellable: number;
  visible_in_catalog: number;
  exclude_from_analysis: number;
  purchase_price_usd: number;
  weight_grams: number;
  warehouse_location: string | null;
  barcode: string | null;
  notes: string | null;
  normalized_material: string;
  normalized_model: string;
  normalized_size: string;
  normalized_tube_type: string;
  normalized_pipe_size: string;
  logistics: {
    box_count: number | null;
    units_per_box: number | null;
    box_weight_kg: number | null;
    total_weight_kg: number | null;
    has_value: boolean;
  };
  reserve_locations: string[];
  has_reserve_locations_value: boolean;
  receiving: {
    lot_number: string | null;
    package_count: number | null;
    units_per_package: number | null;
    total_units: number | null;
    package_weight_kg: number;
    total_weight_kg: number;
  };
};

type PreparedBomLine = {
  parentSku: string;
  parentId: string;
  componentSku: string;
  componentId: string;
  quantity: number;
};

export type ProductCsvImportReport = {
  mode: "dry-run" | "apply";
  applied: boolean;
  rows: number;
  products_created: number;
  products_updated: number;
  bom_parents: number;
  bom_lines_created: number;
  bom_lines_updated: number;
  bom_lines_removed: number;
  lot_lines_created: number;
  lot_lines_updated: number;
  matched_columns: Array<{ csv_header: string; product_field: ProductCsvField; label: string }>;
  unknown_columns: string[];
  validation_errors: ValidationError[];
  warnings: string[];
};

export type ProductCsvImportOptions = {
  apply?: boolean;
  actorUsername?: string;
  sourceName?: string;
  sourceHash?: string;
};

const clean = (value: unknown): string => String(value ?? "").trim();
const identityKey = (value: unknown): string => clean(value).toLocaleUpperCase("en-US");

function legacyProductType(value: unknown, hasBom = false): ProductType | null {
  if (hasBom) return "assembly";
  const type = clean(value).toLowerCase();
  if (type === "component" || type === "assembly" || type === "accessory" || type === "simple") return type;
  if (["", "finished", "final", "normal"].includes(type)) return "simple";
  return null;
}

function profileTypeCode(value: string | null, fallback: string | null | undefined): string | null {
  const normalized = value?.toLocaleLowerCase("tr-TR") || "";
  if (normalized.includes("yuvarlak") || normalized.includes("round")) return "RD";
  if (normalized.includes("kare") || normalized.includes("square")) return "SQ";
  return clean(fallback) || clean(value) || null;
}

function deriveSeries(sku: string, explicit: string | null, fallback: string | null | undefined): string | null {
  if (explicit) return explicit.toUpperCase();
  const upperSku = sku.toUpperCase();
  for (const code of ["PRM", "OYA", "ALY", "DRL", "STD"]) {
    if (upperSku.includes(`-${code}-`)) return code;
  }
  return clean(fallback) || null;
}

export function parseCsvNumber(value: unknown): number | null {
  let text = clean(value);
  if (!text) return null;

  const negativeByParentheses = /^\(.*\)$/.test(text);
  text = text.replace(/[()]/g, "").replace(/[^0-9,\.\-+]/g, "");
  if (!text || !/[0-9]/.test(text)) return Number.NaN;

  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    text = text.split(thousands).join("");
    if (decimal === ",") text = text.replace(",", ".");
  } else if (comma >= 0) {
    const parts = text.split(",");
    text = parts.length > 2 && parts.at(-1)?.length === 3
      ? parts.join("")
      : `${parts.slice(0, -1).join("")}.${parts.at(-1)}`;
  } else if (dot >= 0) {
    const parts = text.split(".");
    text = parts.length > 2 && parts.at(-1)?.length === 3
      ? parts.join("")
      : `${parts.slice(0, -1).join("")}.${parts.at(-1)}`;
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return negativeByParentheses ? -Math.abs(parsed) : parsed;
}

function readNumber(
  row: CsvRecord,
  rowNumber: number,
  field: ProductCsvField,
  resolution: ReturnType<typeof resolveProductCsvHeaders>,
  errors: ValidationError[],
  integer = false,
): number | null {
  const raw = csvValue(row, resolution, field);
  if (!clean(raw)) return null;
  const parsed = parseCsvNumber(raw);
  if (parsed === null || !Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
    errors.push({
      row: rowNumber,
      field,
      code: integer ? "INVALID_NON_NEGATIVE_INTEGER" : "INVALID_NON_NEGATIVE_NUMBER",
      message: `${clean(raw)} geçerli bir ${integer ? "negatif olmayan tam sayı" : "negatif olmayan sayı"} değil.`,
    });
    return null;
  }
  return parsed;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function importProductsFromCsvRows(
  db: Database.Database,
  rows: CsvRecord[],
  headers: string[],
  options: ProductCsvImportOptions = {},
): ProductCsvImportReport {
  const apply = options.apply === true;
  const resolution = resolveProductCsvHeaders(headers);
  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  for (const field of resolution.missingRequiredFields) {
    errors.push({ field: "headers", code: "MISSING_REQUIRED_COLUMN", message: `${field} için zorunlu CSV kolonu bulunamadı.` });
  }
  for (const duplicate of resolution.duplicateFieldColumns) {
    errors.push({
      field: "headers",
      code: "DUPLICATE_MAPPED_COLUMN",
      message: `${duplicate.csv_headers.join(", ")} kolonları aynı ${duplicate.product_field} alanına eşleşiyor.`,
    });
  }

  const existingProducts = db.prepare("SELECT * FROM products").all() as ExistingProduct[];
  const existingBomRows = tableExists(db, "product_bom")
    ? db.prepare("SELECT parent_product_id, component_product_id FROM product_bom").all() as Array<{ parent_product_id: string; component_product_id: string }>
    : [];
  const existingBomParents = new Set(existingBomRows.map((line) => line.parent_product_id));
  const existingBySku = new Map<string, ExistingProduct[]>();
  const existingBySupplier = new Map<string, ExistingProduct[]>();
  for (const product of existingProducts) {
    const skuGroup = existingBySku.get(identityKey(product.sku)) || [];
    skuGroup.push(product);
    existingBySku.set(identityKey(product.sku), skuGroup);
    if (clean(product.supplier_code)) {
      const supplierGroup = existingBySupplier.get(identityKey(product.supplier_code)) || [];
      supplierGroup.push(product);
      existingBySupplier.set(identityKey(product.supplier_code), supplierGroup);
    }
  }
  for (const [sku, products] of existingBySku) {
    if (sku && products.length > 1) {
      errors.push({ field: "database", code: "DUPLICATE_DATABASE_SKU", message: `Veritabanında ${sku} SKU değeri birden fazla üründe bulunuyor.` });
    }
  }
  for (const [supplierCode, products] of existingBySupplier) {
    if (supplierCode && products.length > 1) {
      errors.push({ field: "database", code: "DUPLICATE_DATABASE_SUPPLIER_CODE", message: `Veritabanında ${supplierCode} tedarikçi kodu birden fazla üründe bulunuyor.` });
    }
  }

  const existingLogistics = new Map<string, any>();
  if (tableExists(db, "product_logistics")) {
    for (const row of db.prepare("SELECT * FROM product_logistics").all() as any[]) existingLogistics.set(row.product_id, row);
  }

  const inputSkuRows = new Map<string, number[]>();
  const inputSupplierRows = new Map<string, Array<{ row: number; sku: string }>>();
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const sku = clean(csvValue(row, resolution, "sku"));
    const skuRows = inputSkuRows.get(identityKey(sku)) || [];
    skuRows.push(rowNumber);
    inputSkuRows.set(identityKey(sku), skuRows);

    const supplierCode = clean(csvValue(row, resolution, "supplier_code"));
    if (supplierCode) {
      const supplierRows = inputSupplierRows.get(identityKey(supplierCode)) || [];
      supplierRows.push({ row: rowNumber, sku });
      inputSupplierRows.set(identityKey(supplierCode), supplierRows);
    }
  }
  for (const rowNumber of inputSkuRows.get("") || []) {
    errors.push({ row: rowNumber, field: "sku", code: "SKU_REQUIRED", message: "SKU boş bırakılamaz." });
  }
  for (const [sku, rowNumbers] of inputSkuRows) {
    if (sku && rowNumbers.length > 1) {
      errors.push({ field: "sku", code: "DUPLICATE_SKU", message: `${sku} SKU değeri CSV satırlarında tekrar ediyor: ${rowNumbers.join(", ")}.` });
    }
  }
  for (const [supplierCode, supplierRows] of inputSupplierRows) {
    if (supplierRows.length > 1) {
      errors.push({ field: "supplier_code", code: "DUPLICATE_SUPPLIER_CODE", message: `${supplierCode} tedarikçi kodu birden fazla üründe kullanılmış: ${supplierRows.map((item) => item.sku || `satır ${item.row}`).join(", ")}.` });
    }
    const existing = existingBySupplier.get(supplierCode) || [];
    const incomingSku = identityKey(supplierRows[0]?.sku);
    if (existing.some((product) => identityKey(product.sku) !== incomingSku)) {
      errors.push({ field: "supplier_code", code: "SUPPLIER_CODE_CONFLICT", message: `${supplierCode} tedarikçi kodu veritabanında başka bir SKU'ya bağlı.` });
    }
  }

  const productIdBySku = new Map<string, string>();
  const preparedProducts: PreparedProduct[] = [];
  for (const [index, row] of rows.entries()) {
    const sourceRow = index + 2;
    const sku = clean(csvValue(row, resolution, "sku"));
    const existing = existingBySku.get(identityKey(sku))?.[0] || null;
    const rawType = csvValue(row, resolution, "product_type");
    const productType = canonicalProductType(rawType);
    if (!productType) {
      errors.push({
        row: sourceRow,
        field: "product_type",
        code: "INVALID_PRODUCT_TYPE",
        message: `'${clean(rawType)}' geçersiz. İzin verilen değerler: simple, component, assembly, accessory.`,
      });
    }

    const lotNumber = clean(csvValue(row, resolution, "party_lot"));
    const stock = readNumber(row, sourceRow, "central_stock", resolution, errors, true);
    const explicitLotQuantity = readNumber(row, sourceRow, "lot_quantity", resolution, errors, true);
    const weightGrams = readNumber(row, sourceRow, "weight_grams", resolution, errors);
    const purchasePriceUsd = readNumber(row, sourceRow, "purchase_price_usd", resolution, errors);
    const boxCount = readNumber(row, sourceRow, "box_count", resolution, errors, true);
    const unitsPerBox = readNumber(row, sourceRow, "units_per_box", resolution, errors, true);
    const boxWeightKg = readNumber(row, sourceRow, "box_weight_kg", resolution, errors);
    const totalWeightKg = readNumber(row, sourceRow, "total_weight_kg", resolution, errors);

    const nameTr = clean(csvValue(row, resolution, "name_tr")) || clean(existing?.name_tr) || null;
    const nameEn = clean(csvValue(row, resolution, "name_en")) || clean(existing?.name_en) || null;
    const explicitTitle = clean(csvValue(row, resolution, "title"));
    const title = explicitTitle || clean(existing?.title) || nameTr || nameEn || sku;
    const name = nameTr || nameEn || title;
    if (!name && !existing) {
      errors.push({ row: sourceRow, field: "name_tr", code: "PRODUCT_NAME_REQUIRED", message: "Yeni ürün için Türkçe isim, İngilizce isim veya başlık gerekli." });
    }

    const supplierCode = clean(csvValue(row, resolution, "supplier_code")) || clean(existing?.supplier_code) || null;
    const material = clean(csvValue(row, resolution, "material")) || clean(existing?.material) || null;
    const size = clean(csvValue(row, resolution, "size")) || clean(existing?.size) || null;
    const profileType = clean(csvValue(row, resolution, "profile_type")) || clean(existing?.tube_type_code) || null;
    const description = clean(csvValue(row, resolution, "description")) || clean(existing?.description) || null;
    const warehouseLocation = clean(csvValue(row, resolution, "warehouse_location")) || clean(existing?.warehouse_location) || null;
    const barcode = clean(csvValue(row, resolution, "barcode")) || clean(existing?.barcode) || null;
    const notes = clean(csvValue(row, resolution, "notes")) || clean(existing?.notes) || null;
    const explicitSeries = clean(csvValue(row, resolution, "product_series")) || null;
    const effectiveType = productType || legacyProductType(existing?.product_type, existing ? existingBomParents.has(existing.id) : false) || "simple";
    const effectiveWeightGrams = weightGrams ?? (Number(existing?.weight_grams ?? existing?.weight ?? 0) || 0);
    const effectivePurchasePrice = purchasePriceUsd ?? (Number(existing?.purchase_price_usd ?? 0) || 0);
    const effectiveStock = effectiveType === "assembly" || lotNumber
      ? Number(existing?.central_stock || 0)
      : stock ?? Number(existing?.central_stock || 0);
    const lotQuantity = explicitLotQuantity ?? (lotNumber ? stock : null) ?? (boxCount && unitsPerBox ? boxCount * unitsPerBox : null);
    if (lotNumber && (!supplierCode || !boxCount || !unitsPerBox || !lotQuantity
      || lotQuantity > boxCount * unitsPerBox || lotQuantity <= (boxCount - 1) * unitsPerBox)) {
      errors.push({
        row: sourceRow,
        field: "party_lot",
        code: "INVALID_LOT_LOGISTICS",
        message: `${lotNumber} için tedarikçi no, pozitif kutu sayısı/kutu içi adet ve kutu kapasitesini aşmayan lot adedi zorunludur.`,
      });
    }
    const normalized = generateNormalizedFields({
      material,
      category: clean(existing?.category) || material,
      model: clean(existing?.model) || null,
      name: `${nameTr || ""} ${nameEn || ""}`.trim() || name,
      title,
      size,
      pipe_size: size,
    });
    const id = existing?.id || crypto.randomUUID();
    productIdBySku.set(identityKey(sku), id);
    const previousLogistics = existing ? existingLogistics.get(existing.id) : null;
    const reserveRaw = csvValue(row, resolution, "reserve_locations");

    preparedProducts.push({
      sourceRow,
      id,
      existingId: existing?.id || null,
      sku,
      supplier_code: supplierCode,
      name_tr: nameTr,
      name_en: nameEn,
      name,
      title,
      description,
      material,
      category: clean(existing?.category) || material,
      model: clean(existing?.model) || null,
      product_series: deriveSeries(sku, explicitSeries, existing?.product_series),
      tube_type_code: profileTypeCode(profileType, existing?.tube_type_code),
      size,
      pipe_size: size || clean(existing?.pipe_size) || null,
      form_code: clean(existing?.form_code) || clean(sku.split("-").at(-1)) || null,
      connection_type: clean(existing?.connection_type) || null,
      central_stock: effectiveStock,
      has_stock_value: effectiveType !== "assembly" && !lotNumber && stock !== null,
      product_type: effectiveType,
      is_sellable: effectiveType === "component" ? 0 : 1,
      visible_in_catalog: effectiveType === "component" ? 0 : 1,
      exclude_from_analysis: effectiveType === "component" ? 1 : 0,
      purchase_price_usd: effectivePurchasePrice,
      weight_grams: effectiveWeightGrams,
      warehouse_location: warehouseLocation,
      barcode,
      notes,
      normalized_material: normalized.normalized_material,
      normalized_model: normalized.normalized_model,
      normalized_size: normalized.normalized_size,
      normalized_tube_type: clean(csvValue(row, resolution, "profile_type")) || normalized.normalized_tube_type,
      normalized_pipe_size: normalized.normalized_pipe_size,
      logistics: {
        box_count: boxCount ?? previousLogistics?.box_count ?? null,
        units_per_box: unitsPerBox ?? previousLogistics?.units_per_box ?? null,
        box_weight_kg: boxWeightKg ?? previousLogistics?.box_weight_kg ?? null,
        total_weight_kg: totalWeightKg ?? previousLogistics?.total_weight_kg ?? null,
        has_value: [boxCount, unitsPerBox, boxWeightKg, totalWeightKg].some((value) => value !== null),
      },
      reserve_locations: parseReserveLocations(reserveRaw),
      has_reserve_locations_value: clean(reserveRaw) !== "",
      receiving: {
        lot_number: lotNumber || null,
        package_count: boxCount,
        units_per_package: unitsPerBox,
        total_units: lotQuantity,
        package_weight_kg: Number(boxWeightKg ?? previousLogistics?.box_weight_kg ?? 0),
        total_weight_kg: Number(totalWeightKg ?? previousLogistics?.total_weight_kg ?? 0),
      },
    });
  }

  const incomingBySupplier = new Map<string, PreparedProduct[]>();
  const incomingBySku = new Map<string, PreparedProduct[]>();
  for (const product of preparedProducts) {
    incomingBySku.set(identityKey(product.sku), [...(incomingBySku.get(identityKey(product.sku)) || []), product]);
    if (product.supplier_code) incomingBySupplier.set(identityKey(product.supplier_code), [...(incomingBySupplier.get(identityKey(product.supplier_code)) || []), product]);
  }

  const preparedBomLines: PreparedBomLine[] = [];
  const validBomParents = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const parentSku = clean(csvValue(row, resolution, "sku"));
    const parent = preparedProducts[index];
    const rawBom = clean(csvValue(row, resolution, "bom"));
    if (!parent) continue;
    if (parent.product_type === "assembly" && !rawBom) {
      errors.push({ row: rowNumber, field: "bom", code: "ASSEMBLY_BOM_REQUIRED", message: `${parentSku} assembly ürünü için BOM boş olamaz.` });
      continue;
    }
    if (parent.product_type !== "assembly" && rawBom) {
      errors.push({ row: rowNumber, field: "bom", code: "NON_ASSEMBLY_HAS_BOM", message: `${parentSku} assembly olmadığı halde BOM içeriyor.` });
      continue;
    }
    if (!rawBom) {
      if (parent.existingId && existingBomParents.has(parent.existingId) && parent.product_type !== "assembly") {
        errors.push({ row: rowNumber, field: "product_type", code: "EXISTING_BOM_TYPE_CONFLICT", message: `${parentSku} mevcut BOM'a sahip olduğu için assembly dışında bir tipe çevrilemez.` });
      }
      continue;
    }

    let bomObject: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBom);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("BOM bir JSON nesnesi olmalı.");
      bomObject = parsed;
    } catch (error: any) {
      errors.push({ row: rowNumber, field: "bom", code: "INVALID_BOM_JSON", message: `${parentSku} BOM JSON geçersiz: ${error.message}` });
      continue;
    }

    const seenComponents = new Set<string>();
    for (const [componentReference, rawQuantity] of Object.entries(bomObject)) {
      const key = identityKey(componentReference);
      const incomingSupplierMatches = incomingBySupplier.get(key) || [];
      const databaseSupplierMatches = existingBySupplier.get(key) || [];
      const incomingSkuMatches = incomingBySku.get(key) || [];
      const databaseSkuMatches = existingBySku.get(key) || [];
      const supplierMatches = incomingSupplierMatches.length ? incomingSupplierMatches : databaseSupplierMatches;
      const skuMatches = incomingSkuMatches.length ? incomingSkuMatches : databaseSkuMatches;
      const matches = supplierMatches.length ? supplierMatches : skuMatches;
      if (matches.length !== 1) {
        errors.push({
          row: rowNumber,
          field: "bom",
          code: matches.length ? "AMBIGUOUS_BOM_COMPONENT" : "BOM_COMPONENT_NOT_FOUND",
          message: `${parentSku} BOM bileşeni '${componentReference}' ${matches.length ? "birden fazla ürünle eşleşiyor" : "bulunamadı"}.`,
        });
        continue;
      }
      const component: any = matches[0];
      const componentId = component.id;
      const componentSku = clean(component.sku);
      const componentType = "sourceRow" in component
        ? component.product_type
        : legacyProductType(component.product_type, existingBomParents.has(component.id));
      const quantity = parseCsvNumber(rawQuantity);
      if (componentType !== "component") {
        errors.push({ row: rowNumber, field: "bom", code: "BOM_TARGET_NOT_COMPONENT", message: `${componentSku} BOM hedefi component tipinde değil.` });
        continue;
      }
      if (componentId === parent.id) {
        errors.push({ row: rowNumber, field: "bom", code: "BOM_SELF_REFERENCE", message: `${parentSku} kendi BOM bileşeni olamaz.` });
        continue;
      }
      if (quantity === null || !Number.isFinite(quantity) || quantity <= 0) {
        errors.push({ row: rowNumber, field: "bom", code: "INVALID_BOM_QUANTITY", message: `${parentSku} / ${componentReference} miktarı pozitif sayı olmalı.` });
        continue;
      }
      if (seenComponents.has(componentId)) {
        errors.push({ row: rowNumber, field: "bom", code: "DUPLICATE_BOM_COMPONENT", message: `${parentSku} BOM içinde ${componentSku} bileşenini birden fazla kez referanslıyor.` });
        continue;
      }
      seenComponents.add(componentId);
      preparedBomLines.push({ parentSku, parentId: parent.id, componentSku, componentId, quantity });
    }
    if (seenComponents.size > 0) validBomParents.add(parent.id);
  }

  const existingBomPairs = new Set(existingBomRows.map((line) => `${line.parent_product_id}\u0000${line.component_product_id}`));
  const incomingBomPairs = new Set(preparedBomLines.map((line) => `${line.parentId}\u0000${line.componentId}`));
  const importedAssemblyIds = new Set(preparedProducts.filter((product) => product.product_type === "assembly").map((product) => product.id));
  const bomLinesRemoved = existingBomRows.filter((line) => importedAssemblyIds.has(line.parent_product_id) && !incomingBomPairs.has(`${line.parent_product_id}\u0000${line.component_product_id}`)).length;

  const report: ProductCsvImportReport = {
    mode: apply ? "apply" : "dry-run",
    applied: false,
    rows: rows.length,
    products_created: preparedProducts.filter((product) => !product.existingId).length,
    products_updated: preparedProducts.filter((product) => product.existingId).length,
    bom_parents: validBomParents.size,
    bom_lines_created: preparedBomLines.filter((line) => !existingBomPairs.has(`${line.parentId}\u0000${line.componentId}`)).length,
    bom_lines_updated: preparedBomLines.filter((line) => existingBomPairs.has(`${line.parentId}\u0000${line.componentId}`)).length,
    bom_lines_removed: bomLinesRemoved,
    lot_lines_created: preparedProducts.filter((product) => product.receiving.lot_number).length,
    lot_lines_updated: 0,
    matched_columns: resolution.matchedColumns,
    unknown_columns: resolution.unknownColumns,
    validation_errors: errors,
    warnings,
  };

  if (!apply || errors.length > 0) return report;

  const insertProduct = db.prepare(`
    INSERT INTO products (
      id, sku, supplier_code, name_tr, name_en, name, title, description, material, category, model,
      product_series, tube_type_code, size, pipe_size, form_code, connection_type,
      central_stock, product_type, is_sellable, visible_in_catalog, exclude_from_analysis,
      purchase_price_usd, weight_grams, warehouse_location, barcode, notes, status,
      normalized_material, normalized_model, normalized_size, normalized_tube_type, normalized_pipe_size
    ) VALUES (
      @id, @sku, @supplier_code, @name_tr, @name_en, @name, @title, @description, @material, @category, @model,
      @product_series, @tube_type_code, @size, @pipe_size, @form_code, @connection_type,
      @central_stock, @product_type, @is_sellable, @visible_in_catalog, @exclude_from_analysis,
      @purchase_price_usd, @weight_grams, @warehouse_location, @barcode, @notes, 'Active',
      @normalized_material, @normalized_model, @normalized_size, @normalized_tube_type, @normalized_pipe_size
    )
  `);
  const updateProduct = db.prepare(`
    UPDATE products SET
      sku=@sku, supplier_code=@supplier_code, name_tr=@name_tr, name_en=@name_en, name=@name, title=@title,
      description=@description, material=@material, category=@category, model=@model, product_series=@product_series,
      tube_type_code=@tube_type_code, size=@size, pipe_size=@pipe_size, form_code=@form_code,
      connection_type=@connection_type,
      central_stock=CASE WHEN @has_stock_value=1 THEN @central_stock ELSE central_stock END,
      product_type=@product_type, is_sellable=@is_sellable, visible_in_catalog=@visible_in_catalog,
      exclude_from_analysis=@exclude_from_analysis, purchase_price_usd=@purchase_price_usd,
      weight_grams=@weight_grams, warehouse_location=@warehouse_location, barcode=@barcode, notes=@notes,
      normalized_material=@normalized_material, normalized_model=@normalized_model, normalized_size=@normalized_size,
      normalized_tube_type=@normalized_tube_type, normalized_pipe_size=@normalized_pipe_size,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=@existingId
  `);
  const upsertLogistics = db.prepare(`
    INSERT INTO product_logistics (product_id, box_count, units_per_box, box_weight_kg, total_weight_kg)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET
      box_count=excluded.box_count,
      units_per_box=excluded.units_per_box,
      box_weight_kg=excluded.box_weight_kg,
      total_weight_kg=excluded.total_weight_kg,
      updated_at=CURRENT_TIMESTAMP
  `);
  const deleteReserveLocations = db.prepare("DELETE FROM product_reserve_locations WHERE product_id = ?");
  const insertReserveLocation = db.prepare(`
    INSERT INTO product_reserve_locations (id, product_id, location, sort_order) VALUES (?, ?, ?, ?)
  `);
  const deleteBomForParent = db.prepare("DELETE FROM product_bom WHERE parent_product_id = ?");
  const insertBom = db.prepare(`
    INSERT INTO product_bom (id, parent_product_id, component_product_id, quantity_per_unit, component_role)
    VALUES (?, ?, ?, ?, NULL)
  `);
  const insertStockMovement = db.prepare(`
    INSERT INTO stock_movements (id, product_id, platform_name, change_amount, reason, type)
    VALUES (?, ?, 'Merkez Depo', ?, 'Product CSV import', 'ADJUST')
  `);
  const existingLotLine = tableExists(db, "inbound_lot_lines")
    ? db.prepare("SELECT id FROM inbound_lot_lines WHERE lot_number = ? COLLATE NOCASE AND product_id = ?")
    : null;
  const upsertLotLine = tableExists(db, "inbound_lot_lines")
    ? db.prepare(`
      INSERT INTO inbound_lot_lines (
        id, lot_number, product_id, supplier_code, package_count, units_per_package, total_units,
        package_weight_kg, total_weight_kg, source_name, source_hash, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lot_number, product_id) DO UPDATE SET
        supplier_code=excluded.supplier_code, package_count=excluded.package_count,
        units_per_package=excluded.units_per_package, total_units=excluded.total_units,
        package_weight_kg=excluded.package_weight_kg, total_weight_kg=excluded.total_weight_kg,
        source_name=excluded.source_name, source_hash=excluded.source_hash,
        created_by=excluded.created_by, updated_at=CURRENT_TIMESTAMP
    `)
    : null;

  db.transaction(() => {
    for (const product of preparedProducts) {
      const before = product.existingId ? existingBySku.get(identityKey(product.sku))?.[0] : null;
      if (product.existingId) updateProduct.run({ ...product, has_stock_value: product.has_stock_value ? 1 : 0 });
      else insertProduct.run(product);

      if (product.has_stock_value) {
        const difference = product.central_stock - Number(before?.central_stock || 0);
        if (difference !== 0) insertStockMovement.run(crypto.randomUUID(), product.id, difference);
      }
      if (product.logistics.has_value) {
        upsertLogistics.run(product.id, product.logistics.box_count, product.logistics.units_per_box, product.logistics.box_weight_kg, product.logistics.total_weight_kg);
      }
      if (product.has_reserve_locations_value) {
        deleteReserveLocations.run(product.id);
        product.reserve_locations.forEach((location, index) => insertReserveLocation.run(crypto.randomUUID(), product.id, location, index));
      }
      if (product.receiving.lot_number && product.receiving.package_count && product.receiving.units_per_package && product.receiving.total_units && upsertLotLine) {
        if (existingLotLine?.get(product.receiving.lot_number, product.id)) {
          report.lot_lines_created -= 1;
          report.lot_lines_updated += 1;
        }
        upsertLotLine.run(
          crypto.randomUUID(), product.receiving.lot_number, product.id, product.supplier_code,
          product.receiving.package_count, product.receiving.units_per_package, product.receiving.total_units,
          product.receiving.package_weight_kg, product.receiving.total_weight_kg,
          options.sourceName || null, options.sourceHash || null, options.actorUsername || null,
        );
      }
    }

    for (const parentId of importedAssemblyIds) deleteBomForParent.run(parentId);
    for (const line of preparedBomLines) insertBom.run(crypto.randomUUID(), line.parentId, line.componentId, line.quantity);

    if (tableExists(db, "activity_logs")) {
      db.prepare(`
        INSERT INTO activity_logs (id, action, entity_type, entity_id, details, actor_username)
        VALUES (?, 'PRODUCTS_IMPORTED', 'product_import', ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        options.sourceName || "csv-import",
        JSON.stringify({
          source_hash: options.sourceHash || null,
          products_created: report.products_created,
          products_updated: report.products_updated,
          bom_lines_created: report.bom_lines_created,
          bom_lines_updated: report.bom_lines_updated,
          bom_lines_removed: report.bom_lines_removed,
          lot_lines_created: report.lot_lines_created,
          lot_lines_updated: report.lot_lines_updated,
        }),
        options.actorUsername || "product-csv-import",
      );
    }
  })();

  report.applied = true;
  return report;
}
