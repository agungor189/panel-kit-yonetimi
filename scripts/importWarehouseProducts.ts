/**
 * Safe Warehouse product/BOM importer.
 *
 * Dry-run is the default and opens the database read-only:
 *   npm run warehouse-import:dry-run -- --csv /path/to/products.csv
 *
 * Applying requires BOTH --apply and ALLOW_WAREHOUSE_IMPORT=true. Products are
 * updated by SKU without deleting existing records. The whole product/type/BOM
 * operation runs in one transaction and never clears a non-empty stock value
 * merely because the CSV cell is blank.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import Papa from "papaparse";
import { generateNormalizedFields } from "../server/utils/normalizeProductFields.js";

type CanonicalProductType = "simple" | "component" | "assembly";

type CsvRecord = Record<string, string>;

type PreparedProduct = {
  sourceRow: number;
  id: string;
  existingId: string | null;
  sku: string;
  supplier_code: string | null;
  name: string;
  title: string;
  description: string | null;
  material: string | null;
  category: string | null;
  model: string | null;
  tube_type_code: string | null;
  size: string | null;
  pipe_size: string | null;
  form_code: string | null;
  connection_type: string | null;
  central_stock: number;
  has_stock_value: boolean;
  product_type: CanonicalProductType;
  is_sellable: number;
  visible_in_catalog: number;
  exclude_from_analysis: number;
  purchase_price_usd: number;
  weight: number;
  weight_grams: number;
  warehouse_location: string | null;
  barcode: string | null;
  normalized_material: string;
  normalized_model: string;
  normalized_size: string;
  normalized_tube_type: string;
  normalized_pipe_size: string;
};

type PreparedBomLine = {
  parentSku: string;
  parentId: string;
  componentSku: string;
  componentId: string;
  quantity: number;
};

type ExistingProduct = {
  id: string;
  sku: string;
  product_type: string | null;
  is_sellable: number | null;
  visible_in_catalog: number | null;
  central_stock: number | null;
  warehouse_location: string | null;
  barcode: string | null;
};

const clean = (value: unknown): string => String(value ?? "").trim();
const skuKey = (value: unknown): string => clean(value).toLocaleUpperCase("en-US");
const positiveNumber = (value: unknown): number | null => {
  const text = clean(value).replaceAll("$", "").replaceAll("€", "");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const optionValue = (name: string): string | null => {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
};

const apply = process.argv.includes("--apply");
const csvArgument = optionValue("--csv");
const dbArgument = optionValue("--db");

if (!csvArgument) {
  console.error("Usage: npm run warehouse-import:dry-run -- --csv /path/to/products.csv [--db /path/to/dsdst_panel.db]");
  process.exit(1);
}

if (apply && process.env.ALLOW_WAREHOUSE_IMPORT !== "true") {
  console.error("Apply blocked: --apply also requires ALLOW_WAREHOUSE_IMPORT=true.");
  process.exit(1);
}

const csvPath = path.resolve(csvArgument);
const dbPath = path.resolve(dbArgument || process.env.DB_PATH || path.join(process.cwd(), "dsdst_panel.db"));
if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);

const csvText = fs.readFileSync(csvPath, "utf8");
const parsed = Papa.parse<CsvRecord>(csvText, { header: true, skipEmptyLines: "greedy" });
if (parsed.errors.length > 0) {
  throw new Error(`CSV parse failed: ${parsed.errors.map((error) => error.message).join("; ")}`);
}

const headers = new Set(parsed.meta.fields || []);
const sizeHeader = ["Ölçü", "ölçü", "Ǒlçü"].find((header) => headers.has(header));
const requiredHeaders = [
  "SKU", "Tedarik NO", "Malzeme", "Profil Tipi", "İsim - EN", "Isim - TR",
  "Toplam Adet", "Parça Ağırlığı", "Alış Fiyatı", "TÜR", "BOM", "Açıklama",
];
const missingHeaders = requiredHeaders.filter((header) => !headers.has(header));
if (!sizeHeader) missingHeaders.push("Ölçü/ölçü/Ǒlçü");
if (missingHeaders.length > 0) throw new Error(`Missing CSV columns: ${missingHeaders.join(", ")}`);

const inputSkuGroups = new Map<string, number[]>();
for (const [index, row] of parsed.data.entries()) {
  const key = skuKey(row.SKU);
  const rows = inputSkuGroups.get(key) || [];
  rows.push(index + 2);
  inputSkuGroups.set(key, rows);
}
const blankSkuRows = inputSkuGroups.get("") || [];
const duplicateSkus = [...inputSkuGroups.entries()]
  .filter(([key, rows]) => key && rows.length > 1)
  .map(([sku, rows]) => ({ sku, rows }));
if (blankSkuRows.length > 0 || duplicateSkus.length > 0) {
  console.error(JSON.stringify({ blocked: true, blank_sku_rows: blankSkuRows, duplicate_skus: duplicateSkus }, null, 2));
  process.exit(2);
}

const canonicalType = (value: unknown, rowNumber: number): CanonicalProductType => {
  const type = clean(value).toLowerCase();
  if (type === "simple" || type === "component" || type === "assembly") return type;
  throw new Error(`Invalid TÜR '${clean(value)}' at CSV row ${rowNumber}. Allowed: simple, component, assembly.`);
};

const db = new Database(dbPath, { readonly: !apply });
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

const existingProducts = db.prepare(`
  SELECT id, sku, product_type, is_sellable, visible_in_catalog,
         central_stock, warehouse_location, barcode
  FROM products
`).all() as ExistingProduct[];

const existingSkuGroups = new Map<string, ExistingProduct[]>();
for (const product of existingProducts) {
  const key = skuKey(product.sku);
  const rows = existingSkuGroups.get(key) || [];
  rows.push(product);
  existingSkuGroups.set(key, rows);
}
const existingDuplicateSkus = [...existingSkuGroups.entries()]
  .filter(([key, rows]) => key && rows.length > 1)
  .map(([sku, rows]) => ({ sku, product_ids: rows.map((row) => row.id) }));
if (existingDuplicateSkus.length > 0) {
  console.error(JSON.stringify({ blocked: true, existing_duplicate_skus: existingDuplicateSkus }, null, 2));
  db.close();
  process.exit(2);
}

const sourceRowsBySku = new Map<string, CsvRecord>();
const supplierCodeGroups = new Map<string, CsvRecord[]>();
for (const row of parsed.data) {
  sourceRowsBySku.set(skuKey(row.SKU), row);
  const supplierKey = skuKey(row["Tedarik NO"]);
  if (!supplierKey) continue;
  const rows = supplierCodeGroups.get(supplierKey) || [];
  rows.push(row);
  supplierCodeGroups.set(supplierKey, rows);
}
const duplicateSupplierCodes = [...supplierCodeGroups.entries()]
  .filter(([, rows]) => rows.length > 1)
  .map(([supplier_code, rows]) => ({ supplier_code, skus: rows.map((row) => clean(row.SKU)) }));
if (duplicateSupplierCodes.length > 0) {
  console.error(JSON.stringify({ blocked: true, duplicate_supplier_codes: duplicateSupplierCodes }, null, 2));
  db.close();
  process.exit(2);
}

const productIdBySku = new Map<string, string>();
const preparedProducts: PreparedProduct[] = parsed.data.map((row, index) => {
  const sourceRow = index + 2;
  const sku = clean(row.SKU);
  const existing = existingSkuGroups.get(skuKey(sku))?.[0] || null;
  const productType = canonicalType(row["TÜR"], sourceRow);
  const stockText = clean(row["Toplam Adet"]);
  const stockValue = positiveNumber(stockText);
  if (stockText && stockValue === null) throw new Error(`Invalid Toplam Adet at row ${sourceRow}: ${stockText}`);
  if (stockValue !== null && !Number.isInteger(stockValue)) throw new Error(`Toplam Adet must be an integer at row ${sourceRow}: ${stockText}`);
  const weight = positiveNumber(row["Parça Ağırlığı"]);
  if (weight === null) throw new Error(`Invalid Parça Ağırlığı at row ${sourceRow}: ${row["Parça Ağırlığı"]}`);
  const purchasePrice = positiveNumber(row["Alış Fiyatı"]);
  if (purchasePrice === null) throw new Error(`Invalid Alış Fiyatı at row ${sourceRow}: ${row["Alış Fiyatı"]}`);

  const material = clean(row.Malzeme) || null;
  const profileType = clean(row["Profil Tipi"]) || null;
  const size = clean(row[sizeHeader!]) || null;
  const englishName = clean(row["İsim - EN"]);
  const turkishName = clean(row["Isim - TR"]);
  const description = clean(row.Açıklama) || null;
  const title = description || turkishName || englishName || sku;
  const name = turkishName || englishName || title;
  const model = englishName || turkishName || null;
  const category = [material, profileType].filter(Boolean).join(" ") || null;
  const normalized = generateNormalizedFields({
    material,
    category,
    model,
    name: `${englishName} ${turkishName}`.trim(),
    title,
    size,
    pipe_size: size,
  });
  const id = existing?.id || crypto.randomUUID();
  productIdBySku.set(skuKey(sku), id);

  return {
    sourceRow,
    id,
    existingId: existing?.id || null,
    sku,
    supplier_code: clean(row["Tedarik NO"]) || null,
    name,
    title,
    description,
    material,
    category,
    model,
    tube_type_code: profileType === "Yuvarlak" ? "RD" : profileType === "Kare" ? "SQ" : null,
    size,
    pipe_size: size,
    form_code: clean(sku.split("-").at(-1)) || null,
    connection_type: model,
    central_stock: stockValue || 0,
    has_stock_value: productType !== "assembly" && stockValue !== null,
    product_type: productType,
    is_sellable: productType === "component" ? 0 : 1,
    visible_in_catalog: productType === "component" ? 0 : 1,
    exclude_from_analysis: productType === "component" ? 1 : 0,
    purchase_price_usd: purchasePrice,
    weight,
    weight_grams: weight,
    warehouse_location: clean(row.warehouse_location || row.WarehouseLocation || row.Lokasyon) || existing?.warehouse_location || null,
    barcode: clean(row.barcode || row.Barcode || row.Barkod) || existing?.barcode || null,
    normalized_material: normalized.normalized_material,
    normalized_model: normalized.normalized_model,
    normalized_size: normalized.normalized_size,
    normalized_tube_type: profileType || normalized.normalized_tube_type,
    normalized_pipe_size: normalized.normalized_pipe_size,
  };
});

const bomErrors: Array<Record<string, unknown>> = [];
const preparedBomLines: PreparedBomLine[] = [];
const assemblyRows = parsed.data.filter((row) => clean(row["TÜR"]).toLowerCase() === "assembly");

for (const [index, row] of parsed.data.entries()) {
  const rowNumber = index + 2;
  const productType = canonicalType(row["TÜR"], rowNumber);
  const rawBom = clean(row.BOM);
  if (productType === "assembly" && !rawBom) {
    bomErrors.push({ parent_sku: clean(row.SKU), row: rowNumber, reason: "ASSEMBLY_BOM_EMPTY" });
    continue;
  }
  if (productType !== "assembly" && rawBom) {
    bomErrors.push({ parent_sku: clean(row.SKU), row: rowNumber, reason: "NON_ASSEMBLY_HAS_BOM" });
    continue;
  }
  if (!rawBom) continue;

  let bomObject: Record<string, unknown>;
  try {
    const value = JSON.parse(rawBom);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BOM must be a JSON object");
    bomObject = value;
  } catch (error: any) {
    bomErrors.push({ parent_sku: clean(row.SKU), row: rowNumber, reason: "INVALID_BOM_JSON", message: error.message });
    continue;
  }

  const parentSku = clean(row.SKU);
  const parentId = productIdBySku.get(skuKey(parentSku));
  for (const [supplierCode, rawQuantity] of Object.entries(bomObject)) {
    const matches = supplierCodeGroups.get(skuKey(supplierCode)) || [];
    const quantity = Number(rawQuantity);
    if (matches.length !== 1) {
      bomErrors.push({
        parent_sku: parentSku,
        supplier_code: supplierCode,
        reason: matches.length === 0 ? "COMPONENT_NOT_FOUND" : "AMBIGUOUS_COMPONENT",
      });
      continue;
    }

    const componentRow = matches[0];
    const componentSku = clean(componentRow.SKU);
    const componentType = clean(componentRow["TÜR"]).toLowerCase();
    const componentId = productIdBySku.get(skuKey(componentSku));
    if (componentType !== "component") {
      bomErrors.push({ parent_sku: parentSku, supplier_code: supplierCode, component_sku: componentSku, reason: "TARGET_NOT_COMPONENT" });
      continue;
    }
    if (!parentId || !componentId) {
      bomErrors.push({ parent_sku: parentSku, supplier_code: supplierCode, component_sku: componentSku, reason: "PRODUCT_ID_UNRESOLVED" });
      continue;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      bomErrors.push({ parent_sku: parentSku, supplier_code: supplierCode, component_sku: componentSku, quantity: rawQuantity, reason: "INVALID_QUANTITY" });
      continue;
    }

    preparedBomLines.push({ parentSku, parentId, componentSku, componentId, quantity });
  }
}

const existingBomRows = db.prepare(`
  SELECT parent_product_id, component_product_id
  FROM product_bom
`).all() as Array<{ parent_product_id: string; component_product_id: string }>;
const existingBomParents = new Set(existingBomRows.map((row) => row.parent_product_id));
const currentAssembliesWithoutBom = existingProducts
  .filter((product) => clean(product.product_type).toLowerCase() === "assembly" && !existingBomParents.has(product.id))
  .map((product) => product.sku);
const currentNonAssembliesWithBom = existingProducts
  .filter((product) => clean(product.product_type).toLowerCase() !== "assembly" && existingBomParents.has(product.id))
  .map((product) => product.sku);

const migrationChanges: Array<{ id: string; sku: string; from: string; to: CanonicalProductType; is_sellable: number; visible_in_catalog: number }> = [];
const ambiguousLegacyTypes: Array<{ id: string; sku: string; product_type: string }> = [];
const plannedTypeByExistingId = new Map<string, CanonicalProductType>();
for (const product of existingProducts) {
  const currentType = clean(product.product_type).toLowerCase();
  const hasBom = existingBomParents.has(product.id);
  let targetType: CanonicalProductType | null = null;
  if (hasBom) targetType = "assembly";
  else if (currentType === "component" || currentType === "accessory") targetType = "component";
  else if (["", "simple", "finished", "final"].includes(currentType)) targetType = "simple";
  else if (currentType === "assembly" || currentType === "kit") {
    ambiguousLegacyTypes.push({ id: product.id, sku: product.sku, product_type: currentType });
  } else {
    ambiguousLegacyTypes.push({ id: product.id, sku: product.sku, product_type: currentType });
  }
  if (!targetType) continue;
  plannedTypeByExistingId.set(product.id, targetType);
  const sellable = targetType === "component" ? 0 : 1;
  const visible = targetType === "component" ? 0 : 1;
  if (currentType !== targetType || Number(product.is_sellable) !== sellable || Number(product.visible_in_catalog) !== visible) {
    migrationChanges.push({ id: product.id, sku: product.sku, from: currentType || "(blank)", to: targetType, is_sellable: sellable, visible_in_catalog: visible });
  }
}

const incomingParentIds = new Set(preparedBomLines.map((line) => line.parentId));
const incomingBomPairs = new Set(preparedBomLines.map((line) => `${line.parentId}\u0000${line.componentId}`));
const staleBomLines = existingBomRows.filter((line) =>
  incomingParentIds.has(line.parent_product_id) && !incomingBomPairs.has(`${line.parent_product_id}\u0000${line.component_product_id}`)
);

const blockers = [
  ...bomErrors,
  ...ambiguousLegacyTypes.map((item) => ({ ...item, reason: "AMBIGUOUS_LEGACY_PRODUCT_TYPE" })),
  ...currentAssembliesWithoutBom.map((sku) => ({ sku, reason: "CURRENT_ASSEMBLY_WITHOUT_BOM" })),
  ...staleBomLines.map((line) => ({ ...line, reason: "STALE_BOM_LINE_REQUIRES_EXPLICIT_CLEANUP" })),
];

const typeCounts = (products: Array<{ product_type: string }>) => {
  const counts: Record<string, number> = {};
  for (const product of products) counts[product.product_type] = (counts[product.product_type] || 0) + 1;
  return counts;
};

const effectiveLocationMissing: Record<CanonicalProductType, number> = { simple: 0, component: 0, assembly: 0 };
let barcodeMissing = 0;
for (const product of preparedProducts) {
  if (!product.warehouse_location) effectiveLocationMissing[product.product_type]++;
  if (!product.barcode) barcodeMissing++;
}

const projectedLocationMissing: Record<CanonicalProductType, number> = { ...effectiveLocationMissing };
let projectedBarcodeMissing = barcodeMissing;
for (const product of existingProducts) {
  if (sourceRowsBySku.has(skuKey(product.sku))) continue;
  const plannedType = plannedTypeByExistingId.get(product.id);
  if (!plannedType) continue;
  if (!clean(product.warehouse_location)) projectedLocationMissing[plannedType]++;
  if (!clean(product.barcode)) projectedBarcodeMissing++;
}

const existingTypeCounts: Record<string, number> = {};
for (const product of existingProducts) {
  const type = clean(product.product_type) || "(blank/null)";
  existingTypeCounts[type] = (existingTypeCounts[type] || 0) + 1;
}

const report = {
  mode: apply ? "apply" : "dry-run",
  applied: false,
  source: {
    file: csvPath,
    sha256: crypto.createHash("sha256").update(csvText).digest("hex"),
    rows: preparedProducts.length,
    product_types: typeCounts(preparedProducts),
    duplicate_skus: duplicateSkus.length,
    blank_skus: blankSkuRows.length,
  },
  current_database: {
    file: dbPath,
    products: existingProducts.length,
    product_types: existingTypeCounts,
    assemblies_without_bom: currentAssembliesWithoutBom.length,
    non_assemblies_with_bom: currentNonAssembliesWithBom.length,
  },
  migration: {
    product_rows_to_standardize: migrationChanges.length,
    by_target_type: typeCounts(migrationChanges.map((item) => ({ product_type: item.to }))),
    ambiguous_legacy_types: ambiguousLegacyTypes,
  },
  import_plan: {
    products_to_create: preparedProducts.filter((product) => !product.existingId).length,
    products_to_update: preparedProducts.filter((product) => product.existingId).length,
    existing_products_preserved_outside_csv: existingProducts.filter((product) => !sourceRowsBySku.has(skuKey(product.sku))).length,
    physical_stock_rows_from_csv: preparedProducts.filter((product) => product.has_stock_value).length,
    physical_stock_total_from_csv: preparedProducts.filter((product) => product.has_stock_value).reduce((sum, product) => sum + product.central_stock, 0),
    assembly_stock_cells_ignored: preparedProducts.filter((product) => product.product_type === "assembly").length,
  },
  bom: {
    assemblies: assemblyRows.length,
    assemblies_with_bom: new Set(preparedBomLines.map((line) => line.parentId)).size,
    lines: preparedBomLines.length,
    unresolved_components: bomErrors.length,
    stale_existing_lines: staleBomLines.length,
  },
  warehouse_data: {
    incoming_missing_location: effectiveLocationMissing,
    incoming_missing_barcode: barcodeMissing,
    projected_missing_location: projectedLocationMissing,
    projected_missing_barcode: projectedBarcodeMissing,
  },
  blockers,
};

if (!apply) {
  console.log(JSON.stringify(report, null, 2));
  db.close();
  process.exit(blockers.length > 0 ? 2 : 0);
}

if (blockers.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  db.close();
  process.exit(2);
}

const updateLegacyType = db.prepare(`
  UPDATE products
  SET product_type = ?, is_sellable = ?, visible_in_catalog = ?,
      exclude_from_analysis = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);
const insertProduct = db.prepare(`
  INSERT INTO products (
    id, sku, supplier_code, name, title, description, material, category, model,
    tube_type_code, size, pipe_size, form_code, connection_type,
    central_stock, product_type, is_sellable, visible_in_catalog, exclude_from_analysis,
    purchase_price_usd, weight, weight_grams, warehouse_location, barcode, status,
    normalized_material, normalized_model, normalized_size, normalized_tube_type, normalized_pipe_size
  ) VALUES (
    @id, @sku, @supplier_code, @name, @title, @description, @material, @category, @model,
    @tube_type_code, @size, @pipe_size, @form_code, @connection_type,
    @central_stock, @product_type, @is_sellable, @visible_in_catalog, @exclude_from_analysis,
    @purchase_price_usd, @weight, @weight_grams, @warehouse_location, @barcode, 'Active',
    @normalized_material, @normalized_model, @normalized_size, @normalized_tube_type, @normalized_pipe_size
  )
`);
const updateProduct = db.prepare(`
  UPDATE products
  SET sku = @sku,
      supplier_code = COALESCE(@supplier_code, supplier_code),
      name = @name,
      title = @title,
      description = @description,
      material = @material,
      category = @category,
      model = @model,
      tube_type_code = @tube_type_code,
      size = @size,
      pipe_size = @pipe_size,
      form_code = @form_code,
      connection_type = @connection_type,
      central_stock = CASE WHEN @has_stock_value = 1 THEN @central_stock ELSE central_stock END,
      product_type = @product_type,
      is_sellable = @is_sellable,
      visible_in_catalog = @visible_in_catalog,
      exclude_from_analysis = @exclude_from_analysis,
      purchase_price_usd = @purchase_price_usd,
      weight = @weight,
      weight_grams = @weight_grams,
      warehouse_location = COALESCE(@warehouse_location, warehouse_location),
      barcode = COALESCE(@barcode, barcode),
      normalized_material = @normalized_material,
      normalized_model = @normalized_model,
      normalized_size = @normalized_size,
      normalized_tube_type = @normalized_tube_type,
      normalized_pipe_size = @normalized_pipe_size,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = @existingId
`);
const upsertBom = db.prepare(`
  INSERT INTO product_bom (id, parent_product_id, component_product_id, quantity_per_unit, component_role)
  VALUES (?, ?, ?, ?, NULL)
  ON CONFLICT(parent_product_id, component_product_id)
  DO UPDATE SET quantity_per_unit = excluded.quantity_per_unit,
                component_role = NULL,
                updated_at = CURRENT_TIMESTAMP
`);
const insertStockMovement = db.prepare(`
  INSERT INTO stock_movements (id, product_id, platform_name, change_amount, reason, type)
  VALUES (?, ?, 'Merkez Depo', ?, 'Warehouse CSV import', 'ADJUST')
`);

db.transaction(() => {
  for (const change of migrationChanges) {
    updateLegacyType.run(change.to, change.is_sellable, change.visible_in_catalog, change.to === "component" ? 1 : 0, change.id);
  }

  for (const product of preparedProducts) {
    if (!product.existingId) {
      insertProduct.run(product);
      if (product.has_stock_value && product.central_stock !== 0) {
        insertStockMovement.run(crypto.randomUUID(), product.id, product.central_stock);
      }
      continue;
    }

    const before = existingSkuGroups.get(skuKey(product.sku))![0];
    updateProduct.run({ ...product, has_stock_value: product.has_stock_value ? 1 : 0 });
    if (product.has_stock_value) {
      const difference = product.central_stock - Number(before.central_stock || 0);
      if (difference !== 0) insertStockMovement.run(crypto.randomUUID(), product.id, difference);
    }
  }

  for (const line of preparedBomLines) {
    upsertBom.run(crypto.randomUUID(), line.parentId, line.componentId, line.quantity);
  }

  db.prepare(`
    INSERT INTO activity_logs (id, action, entity_type, entity_id, details, actor_username)
    VALUES (?, 'WAREHOUSE_PRODUCTS_IMPORTED', 'product_import', ?, ?, 'warehouse-import-script')
  `).run(
    crypto.randomUUID(),
    path.basename(csvPath),
    JSON.stringify({
      sha256: report.source.sha256,
      products_created: report.import_plan.products_to_create,
      products_updated: report.import_plan.products_to_update,
      bom_lines: report.bom.lines,
    }),
  );
})();

report.applied = true;
console.log(JSON.stringify(report, null, 2));
db.close();
