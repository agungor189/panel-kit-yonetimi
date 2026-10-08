import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getUomDefinition, UOM_REGISTRY_VERSION, type UomCode } from "./uom.js";
import { generateNormalizedFields } from "../../utils/normalizeProductFields.js";

export type CatalogType = "product" | "profile" | "connector" | "cap" | "wheel" | "complementary" | "KIT";
export type ProfileForm = "square" | "rectangular" | "round" | "channel" | "angle" | "flat" | "other";
export type MaterialBehavior = "continuous_cut";

export type ProfileAttributesInput = {
  material: string;
  form: ProfileForm;
  width_mm?: string | number | null;
  height_mm?: string | number | null;
  diameter_mm?: string | number | null;
  wall_thickness_mm: string | number;
  width_micrometers?: number | null;
  height_micrometers?: number | null;
  diameter_micrometers?: number | null;
  wall_thickness_micrometers?: number;
  standard_purchase_lengths_mm: number[];
  custom_length_allowed: boolean;
};

export type CatalogProductInput = {
  id?: string;
  sku: string;
  title: string;
  catalog_type: CatalogType;
  base_uom_code?: UomCode;
  base_uom?: { code?: UomCode };
  dimensions?: { length_mm?: number | null; width_mm?: number | null; height_mm?: number | null; diameter_mm?: number | null };
  mass_grams?: number | null;
  material_behavior?: MaterialBehavior | null;
  profile?: ProfileAttributesInput | null;
  status?: string;
  name_tr?: string | null;
  name_en?: string | null;
  supplier_code?: string | null;
  product_type?: "simple" | "component" | "assembly" | "accessory" | null;
  material?: string | null;
  size?: string | null;
  profile_type?: string | null;
  is_sellable?: boolean;
};

export type CatalogProduct = {
  id: string;
  sku: string;
  title: string;
  catalog_type: CatalogType;
  base_uom: { code: UomCode; base_quantum: string; quantity_scale: number };
  catalog_version: number;
  catalog_version_ref: string;
  uom_registry_version: typeof UOM_REGISTRY_VERSION;
  dimensions: { length_mm: number | null; width_mm: number | null; height_mm: number | null; diameter_mm: number | null };
  mass_grams: number | null;
  weight_grams: number | null;
  material_behavior: MaterialBehavior | null;
  profile: ProfileAttributesInput | null;
  status: string;
  image?: string | null;
  name_tr?: string | null;
  name_en?: string | null;
  supplier_code?: string | null;
  material?: string | null;
  form_code?: string | null;
  tube_type_code?: string | null;
  size_code?: string | null;
  size?: string | null;
  pipe_size?: string | null;
  model?: string | null;
  normalized_material?: string | null;
  normalized_size?: string | null;
  normalized_tube_type?: string | null;
  normalized_pipe_size?: string | null;
  product_type?: "simple" | "component" | "assembly" | "accessory" | null;
  is_sellable: boolean;
};

type CatalogMutationOptions = {
  allowPublishedKitMutation?: boolean;
  activationProvenance?: "PROCUREMENT_CSV_FIRST_RECEIPT";
};

export class CatalogValidationError extends Error {
  constructor(message: string, public readonly code = "CATALOG_VALIDATION_FAILED", public readonly statusCode = 400) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

const STANDARD_PROFILE_LENGTHS = new Set([1000, 2000, 3000, 6000]);
const catalogTypes = new Set<CatalogType>(["product", "profile", "connector", "cap", "wheel", "complementary", "KIT"]);
const profileForms = new Set<ProfileForm>(["square", "rectangular", "round", "channel", "angle", "flat", "other"]);

const requiredText = (value: unknown, field: string, max = 250): string => {
  if (typeof value !== "string") throw new CatalogValidationError(`${field} is required.`);
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new CatalogValidationError(`${field} is invalid.`);
  return text;
};

const optionalText = (value: unknown, field: string, max = 250): string | null => {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field, max);
};

const integerOrNull = (value: unknown, field: string, positive = false): number | null => {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < (positive ? 1 : 0)) {
    throw new CatalogValidationError(`${field} must be a ${positive ? "positive" : "non-negative"} integer millimeter/gram value.`);
  }
  return Number(value);
};

const decimalMillimeters = (value: unknown, field: string): { millimeters: string; micrometers: number } | null => {
  if (value === undefined || value === null) return null;
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) throw new CatalogValidationError(`${field} must be a positive decimal millimeter value with at most 3 decimal places.`);
  const micrometers = Number(match[1]) * 1000 + Number((match[2] || "").padEnd(3, "0"));
  if (!Number.isSafeInteger(micrometers) || micrometers <= 0) {
    throw new CatalogValidationError(`${field} must be a positive fixed-precision millimeter value.`);
  }
  const fraction = String(micrometers % 1000).padStart(3, "0").replace(/0+$/, "");
  return { micrometers, millimeters: fraction ? `${Math.floor(micrometers / 1000)}.${fraction}` : String(Math.floor(micrometers / 1000)) };
};

const normalizeProfile = (value: ProfileAttributesInput | null | undefined): ProfileAttributesInput | null => {
  if (!value) return null;
  const material = requiredText(value.material, "profile.material", 100).toUpperCase();
  if (!profileForms.has(value.form)) throw new CatalogValidationError("profile.form is unsupported.");
  const width = decimalMillimeters(value.width_mm, "profile.width_mm");
  const height = decimalMillimeters(value.height_mm, "profile.height_mm");
  const diameter = decimalMillimeters(value.diameter_mm, "profile.diameter_mm");
  const wall = decimalMillimeters(value.wall_thickness_mm, "profile.wall_thickness_mm");
  if (!wall) throw new CatalogValidationError("profile.wall_thickness_mm is required.");
  if (value.form === "round" && (!diameter || width || height)) {
    throw new CatalogValidationError("Round profiles require diameter_mm and forbid width_mm/height_mm.");
  }
  if (["square", "rectangular"].includes(value.form) && (!width || !height || diameter)) {
    throw new CatalogValidationError("Square/rectangular profiles require width_mm and height_mm and forbid diameter_mm.");
  }
  if (!Array.isArray(value.standard_purchase_lengths_mm) || value.standard_purchase_lengths_mm.length === 0) {
    throw new CatalogValidationError("At least one standard purchase length is required.");
  }
  const lengths = [...new Set(value.standard_purchase_lengths_mm.map((length) => integerOrNull(length, "profile.standard_purchase_length", true)!))].sort((a, b) => a - b);
  if (lengths.some((length) => !STANDARD_PROFILE_LENGTHS.has(length))) {
    throw new CatalogValidationError("Standard purchase length must be one of 1000, 2000, 3000 or 6000 mm.");
  }
  return {
    material,
    form: value.form,
    width_mm: width?.millimeters ?? null,
    height_mm: height?.millimeters ?? null,
    diameter_mm: diameter?.millimeters ?? null,
    wall_thickness_mm: wall.millimeters,
    width_micrometers: width?.micrometers ?? null,
    height_micrometers: height?.micrometers ?? null,
    diameter_micrometers: diameter?.micrometers ?? null,
    wall_thickness_micrometers: wall.micrometers,
    standard_purchase_lengths_mm: lengths,
    custom_length_allowed: value.custom_length_allowed === true,
  };
};

const normalizedInput = (input: CatalogProductInput) => {
  const sku = requiredText(input.sku, "sku", 120);
  const title = requiredText(input.title, "title", 300);
  if (!catalogTypes.has(input.catalog_type)) throw new CatalogValidationError("catalog_type is unsupported.");
  const baseUomCode = input.base_uom_code || input.base_uom?.code;
  if (!baseUomCode) throw new CatalogValidationError("base_uom_code is required.");
  getUomDefinition(baseUomCode);
  if (input.catalog_type === "profile" && baseUomCode !== "meter") throw new CatalogValidationError("Profile base UOM must be meter.");
  if (["connector", "cap", "wheel"].includes(input.catalog_type) && baseUomCode !== "piece") {
    throw new CatalogValidationError(`${input.catalog_type} base UOM must be piece.`);
  }
  if (input.catalog_type === "KIT" && baseUomCode !== "piece") throw new CatalogValidationError("KIT base UOM must be piece.");
  const materialBehavior = input.material_behavior ?? null;
  if (materialBehavior !== null && materialBehavior !== "continuous_cut") {
    throw new CatalogValidationError("material_behavior is unsupported.");
  }
  if (materialBehavior === "continuous_cut"
    && (input.catalog_type !== "complementary" || !["meter", "square_meter"].includes(baseUomCode))) {
    throw new CatalogValidationError("Continuous-cut material requires a complementary product with meter or square_meter base UOM.");
  }
  const profile = normalizeProfile(input.profile);
  if (input.catalog_type === "profile" && !profile) throw new CatalogValidationError("Profile attributes are required.");
  if (input.catalog_type !== "profile" && profile) throw new CatalogValidationError("Profile attributes apply only to profile catalog items.");
  const productType = input.product_type ?? null;
  if (productType !== null && !["simple", "component", "assembly", "accessory"].includes(productType)) {
    throw new CatalogValidationError("product_type is unsupported.");
  }
  const master = {
    nameTr: optionalText(input.name_tr, "name_tr", 300),
    nameEn: optionalText(input.name_en, "name_en", 300),
    supplierCode: optionalText(input.supplier_code, "supplier_code", 200),
    productType,
    material: optionalText(input.material, "material", 150) || profile?.material || null,
    size: optionalText(input.size, "size", 150),
    profileType: optionalText(input.profile_type, "profile_type", 100),
  };
  const legacyNormalized = generateNormalizedFields({
    material: master.material,
    size: master.size,
    pipe_size: master.size,
    category: master.profileType,
    name: [master.nameTr, master.nameEn].filter(Boolean).join(" "),
    title,
  });
  return {
    sku,
    title,
    catalogType: input.catalog_type,
    baseUomCode,
    dimensions: {
      length_mm: integerOrNull(input.dimensions?.length_mm, "dimensions.length_mm"),
      width_mm: integerOrNull(input.dimensions?.width_mm, "dimensions.width_mm"),
      height_mm: integerOrNull(input.dimensions?.height_mm, "dimensions.height_mm"),
      diameter_mm: integerOrNull(input.dimensions?.diameter_mm, "dimensions.diameter_mm"),
    },
    massGrams: integerOrNull(input.mass_grams, "mass_grams"),
    materialBehavior,
    profile,
    status: input.status ? requiredText(input.status, "status", 30) : "Active",
    isSellable: input.is_sellable === undefined ? 1 : input.is_sellable ? 1 : 0,
    master,
    legacyNormalized: {
      ...legacyNormalized,
      normalized_tube_type: master.profileType || legacyNormalized.normalized_tube_type,
    },
  };
};

const productSelect = `
  SELECT p.id, p.sku, p.title, p.name_tr, p.name_en, p.supplier_code, p.material, p.product_type,
    p.form_code, p.tube_type_code, p.size_code, p.size, p.pipe_size, p.model,
    p.normalized_material, p.normalized_size, p.normalized_tube_type, p.normalized_pipe_size,
    CASE
      WHEN p.product_type='kit' THEN 'KIT'
      WHEN p.catalog_class='complementary' THEN 'complementary'
      ELSE p.catalog_type
    END AS catalog_type,
    p.catalog_class, p.base_uom_code, p.catalog_version,
    p.catalog_version_ref, p.uom_registry_version, p.length_mm_int, p.width_mm_int,
    p.height_mm_int, p.diameter_mm_int, p.mass_grams_int, p.weight_grams, p.material_behavior, p.status,
    p.is_sellable,
    u.base_quantum, u.quantity_scale,
    a.material AS profile_material, a.form AS profile_form,
    a.width_micrometers AS profile_width_micrometers,
    a.height_micrometers AS profile_height_micrometers,
    a.diameter_micrometers AS profile_diameter_micrometers,
    a.wall_thickness_micrometers, a.standard_purchase_lengths_mm_json, a.custom_length_allowed,
    (SELECT path FROM product_images WHERE product_id=p.id ORDER BY sort_order,id LIMIT 1) AS image
  FROM products p
  JOIN uom_definitions u ON u.code=p.base_uom_code
  LEFT JOIN product_profile_attributes a ON a.product_id=p.id
`;

export class CatalogService {
  constructor(private readonly db: Database.Database) {}

  listProducts(type?: CatalogType): CatalogProduct[] {
    const rows = type
      ? this.db.prepare(`${productSelect} WHERE p.catalog_version > 0 AND p.sku IS NOT NULL AND ${
        type === "complementary"
          ? "p.catalog_class='complementary'"
          : type === "KIT"
            ? "p.product_type='kit'"
            : "p.catalog_type=? AND p.catalog_class IS NULL AND COALESCE(p.product_type,'')<>'kit'"
      } ORDER BY p.sku`).all(...(type === "complementary" || type === "KIT" ? [] : [type]))
      : this.db.prepare(`${productSelect} WHERE p.catalog_version > 0 AND p.sku IS NOT NULL ORDER BY p.sku`).all();
    return (rows as any[]).map((row) => this.mapRow(row));
  }

  getProduct(id: string): CatalogProduct | null {
    const row = this.db.prepare(`${productSelect} WHERE p.id=? AND p.catalog_version > 0`).get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  captureImportedProductVersion(id: string): CatalogProduct {
    return this.db.transaction(() => {
      const current = this.db.prepare("SELECT catalog_version FROM products WHERE id=?").get(id) as { catalog_version: number } | undefined;
      if (!current) throw new CatalogValidationError("Catalog product was not found.");
      return this.captureVersion(id, Number(current.catalog_version || 0) + 1);
    }).immediate();
  }

  createProduct(input: CatalogProductInput, options: CatalogMutationOptions = {}): CatalogProduct {
    const normalized = normalizedInput(input);
    if (normalized.catalogType === "KIT" && !options.allowPublishedKitMutation) {
      throw new CatalogValidationError("KIT products must be created by canonical kit publication.", "KIT_PUBLICATION_REQUIRED", 409);
    }
    const id = input.id ? requiredText(input.id, "id", 200) : randomUUID();
    return this.db.transaction(() => {
      const hasActivationProvenance = Boolean(this.db.prepare(`SELECT 1 FROM pragma_table_info('products')
        WHERE name='procurement_activation_pending'`).get());
      const activationPending = options.activationProvenance === "PROCUREMENT_CSV_FIRST_RECEIPT";
      if (activationPending && !hasActivationProvenance) {
        throw new CatalogValidationError("Procurement activation provenance schema is unavailable.", "CATALOG_SCHEMA_OUTDATED", 409);
      }
      this.db.prepare(`INSERT INTO products (
        id, name, name_tr, name_en, title, sku, supplier_code, status, material, size, pipe_size, tube_type_code,
        normalized_material, normalized_size, normalized_tube_type, normalized_pipe_size,
        weight_grams, product_type, is_sellable, visible_in_catalog, catalog_type, catalog_class, base_uom_code,
        catalog_version, uom_registry_version, length_mm_int, width_mm_int, height_mm_int,
        diameter_mm_int, mass_grams_int, material_behavior${hasActivationProvenance ? ", procurement_activation_pending" : ""}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?${hasActivationProvenance ? ", ?" : ""})`)
        .run(id, normalized.master.nameTr || normalized.master.nameEn || normalized.title,
          normalized.master.nameTr, normalized.master.nameEn, normalized.title, normalized.sku,
          normalized.master.supplierCode, normalized.status, normalized.master.material,
          normalized.master.size, normalized.master.size, normalized.master.profileType,
          normalized.legacyNormalized.normalized_material, normalized.legacyNormalized.normalized_size,
          normalized.legacyNormalized.normalized_tube_type, normalized.legacyNormalized.normalized_pipe_size,
          normalized.massGrams ?? 0,
          normalized.catalogType === "KIT" ? "kit" : normalized.master.productType,
          normalized.isSellable,
          normalized.catalogType === "complementary" || normalized.catalogType === "KIT" ? "product" : normalized.catalogType,
          normalized.catalogType === "complementary" ? "complementary" : null,
          normalized.baseUomCode, UOM_REGISTRY_VERSION, normalized.dimensions.length_mm,
          normalized.dimensions.width_mm, normalized.dimensions.height_mm, normalized.dimensions.diameter_mm,
          normalized.massGrams, normalized.materialBehavior,
          ...(hasActivationProvenance ? [activationPending ? 1 : 0] : []));
      this.writeProfile(id, normalized.profile);
      return this.captureVersion(id, 1);
    }).immediate();
  }

  updateProduct(id: string, expectedVersion: number, input: CatalogProductInput, options: CatalogMutationOptions = {}): CatalogProduct {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new CatalogValidationError("expected catalog version is invalid.");
    return this.db.transaction(() => {
      const current = this.getProduct(id);
      if (!current) throw new CatalogValidationError("Catalog product was not found.");
      const normalized = normalizedInput({
        ...input,
        dimensions: { ...current.dimensions, ...(input.dimensions || {}) },
        mass_grams: input.mass_grams === undefined ? current.mass_grams ?? current.weight_grams : input.mass_grams,
        material_behavior: input.material_behavior === undefined ? current.material_behavior : input.material_behavior,
        profile: input.profile === undefined ? current.profile : input.profile,
        status: input.status === undefined ? current.status : input.status,
        name_tr: input.name_tr === undefined ? current.name_tr : input.name_tr,
        name_en: input.name_en === undefined ? current.name_en : input.name_en,
        supplier_code: input.supplier_code === undefined ? current.supplier_code : input.supplier_code,
        product_type: input.catalog_type === "KIT"
          ? null
          : input.product_type === undefined ? current.product_type : input.product_type,
        material: input.material === undefined ? current.material : input.material,
        size: input.size === undefined ? current.size ?? current.pipe_size : input.size,
        profile_type: input.profile_type === undefined ? current.tube_type_code : input.profile_type,
        is_sellable: input.is_sellable === undefined ? current.is_sellable : input.is_sellable,
      });
      if ((current.catalog_type === "KIT" || normalized.catalogType === "KIT") && !options.allowPublishedKitMutation) {
        throw new CatalogValidationError("KIT products may only change through canonical kit publication.", "KIT_PUBLICATION_REQUIRED", 409);
      }
      if (current.catalog_version !== expectedVersion) throw new CatalogValidationError("Catalog version conflict.");
      if (current.base_uom.code !== normalized.baseUomCode) {
        throw new CatalogValidationError("Base UOM identity is immutable after product creation; create a new SKU/product identity.");
      }
      this.db.prepare(`UPDATE products SET title=?, name=?, name_tr=?, name_en=?, sku=?, supplier_code=?, status=?, material=?, size=?, pipe_size=?, tube_type_code=?,
        normalized_material=?, normalized_size=?, normalized_tube_type=?, normalized_pipe_size=?, weight_grams=?, product_type=?, is_sellable=?, catalog_type=?, catalog_class=?,
        base_uom_code=?, uom_registry_version=?, length_mm_int=?, width_mm_int=?, height_mm_int=?, diameter_mm_int=?,
        mass_grams_int=?, material_behavior=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND catalog_version=?`)
        .run(normalized.title, normalized.master.nameTr || normalized.master.nameEn || normalized.title,
          normalized.master.nameTr, normalized.master.nameEn, normalized.sku, normalized.master.supplierCode,
          normalized.status, normalized.master.material, normalized.master.size, normalized.master.size, normalized.master.profileType,
          normalized.legacyNormalized.normalized_material, normalized.legacyNormalized.normalized_size,
          normalized.legacyNormalized.normalized_tube_type, normalized.legacyNormalized.normalized_pipe_size,
          normalized.massGrams ?? 0, normalized.catalogType === "KIT" ? "kit" : normalized.master.productType,
          normalized.isSellable,
          normalized.catalogType === "complementary" || normalized.catalogType === "KIT" ? "product" : normalized.catalogType,
          normalized.catalogType === "complementary" ? "complementary" : null,
          normalized.baseUomCode, UOM_REGISTRY_VERSION,
          normalized.dimensions.length_mm, normalized.dimensions.width_mm, normalized.dimensions.height_mm,
          normalized.dimensions.diameter_mm, normalized.massGrams, normalized.materialBehavior, id, expectedVersion);
      this.writeProfile(id, normalized.profile);
      return this.captureVersion(id, expectedVersion + 1);
    }).immediate();
  }

  activateProcurementProductIfReady(productId: string): boolean {
    return this.db.transaction(() => {
      const current = this.db.prepare(`SELECT catalog_version,status,is_sellable,central_stock,sale_price,product_type,
        procurement_activation_pending FROM products WHERE id=?`).get(productId) as any;
      if (!current) throw new CatalogValidationError("Catalog product was not found.");
      if (Number(current.procurement_activation_pending) !== 1) return false;
      if (current.status !== "Passive" || Number(current.is_sellable) !== 0) {
        throw new CatalogValidationError("Procurement-created product activation state is invalid.", "PROCUREMENT_ACTIVATION_CONFLICT", 409);
      }
      if (Number(current.central_stock) <= 0 || Number(current.sale_price) <= 0) return false;
      if (current.product_type === "kit") {
        throw new CatalogValidationError("Published KIT products cannot use procurement activation.", "KIT_PUBLICATION_REQUIRED", 409);
      }
      const changed = this.db.prepare(`UPDATE products
        SET status='Active',is_sellable=1,procurement_activation_pending=0,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND procurement_activation_pending=1 AND status='Passive' AND is_sellable=0
          AND central_stock>0 AND sale_price>0`)
        .run(productId);
      if (changed.changes !== 1) {
        throw new CatalogValidationError("Procurement-created product activation conflicted.", "PROCUREMENT_ACTIVATION_CONFLICT", 409);
      }
      this.captureVersion(productId, Number(current.catalog_version) + 1);
      return true;
    }).immediate();
  }

  validateProfilePurchaseLength(productId: string, lengthMm: number) {
    if (!Number.isSafeInteger(lengthMm) || lengthMm <= 0) throw new CatalogValidationError("Profile purchase length must be a positive integer millimeter value.");
    const row = this.db.prepare(`SELECT standard_purchase_lengths_mm_json, custom_length_allowed
      FROM product_profile_attributes WHERE product_id=?`).get(productId) as any;
    if (!row) throw new CatalogValidationError("Profile catalog item was not found.");
    const standard = JSON.parse(row.standard_purchase_lengths_mm_json) as number[];
    if (standard.includes(lengthMm)) return { kind: "standard" as const, length_mm: lengthMm };
    if (Number(row.custom_length_allowed) !== 1) throw new CatalogValidationError("Profile custom length is not allowed.");
    return { kind: "custom" as const, length_mm: lengthMm };
  }

  private writeProfile(productId: string, profile: ProfileAttributesInput | null) {
    if (!profile) {
      this.db.prepare("DELETE FROM product_profile_attributes WHERE product_id=?").run(productId);
      return;
    }
    this.db.prepare(`INSERT INTO product_profile_attributes (
      product_id, material, form, width_mm, height_mm, diameter_mm, wall_thickness_mm,
      width_micrometers, height_micrometers, diameter_micrometers, wall_thickness_micrometers,
      standard_purchase_lengths_mm_json, custom_length_allowed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET material=excluded.material, form=excluded.form,
      width_mm=excluded.width_mm, height_mm=excluded.height_mm, diameter_mm=excluded.diameter_mm,
      wall_thickness_mm=excluded.wall_thickness_mm,
      width_micrometers=excluded.width_micrometers, height_micrometers=excluded.height_micrometers,
      diameter_micrometers=excluded.diameter_micrometers, wall_thickness_micrometers=excluded.wall_thickness_micrometers,
      standard_purchase_lengths_mm_json=excluded.standard_purchase_lengths_mm_json,
      custom_length_allowed=excluded.custom_length_allowed, updated_at=CURRENT_TIMESTAMP`)
      .run(productId, profile.material, profile.form, profile.width_mm == null ? null : Number(profile.width_mm),
        profile.height_mm == null ? null : Number(profile.height_mm), profile.diameter_mm == null ? null : Number(profile.diameter_mm),
        Number(profile.wall_thickness_mm), profile.width_micrometers ?? null, profile.height_micrometers ?? null,
        profile.diameter_micrometers ?? null, profile.wall_thickness_micrometers,
        JSON.stringify(profile.standard_purchase_lengths_mm),
        profile.custom_length_allowed ? 1 : 0);
  }

  private captureVersion(productId: string, version: number): CatalogProduct {
    const row = this.db.prepare(`${productSelect} WHERE p.id=?`).get(productId) as any;
    if (!row) throw new CatalogValidationError("Catalog product was not found.");
    row.catalog_version = version;
    row.catalog_version_ref = `catalog-product:${productId}:v${version}`;
    const product = this.mapRow(row);
    const snapshotJson = JSON.stringify({ schema_version: "dsdst.catalog-product.v1", ...product, image: undefined });
    const contentHash = createHash("sha256").update(snapshotJson).digest("hex");
    this.db.prepare(`INSERT INTO catalog_product_versions (
      id, product_id, catalog_version, version_ref, schema_version, uom_registry_version,
      base_uom_code, snapshot_json, content_hash
    ) VALUES (?, ?, ?, ?, 'dsdst.catalog-product.v1', ?, ?, ?, ?)`)
      .run(randomUUID(), productId, version, product.catalog_version_ref, UOM_REGISTRY_VERSION,
        product.base_uom.code, snapshotJson, contentHash);
    this.db.prepare("UPDATE products SET catalog_version=?, catalog_version_ref=? WHERE id=?")
      .run(version, product.catalog_version_ref, productId);
    return product;
  }

  private mapRow(row: any): CatalogProduct {
    const mm = (micrometers: unknown): string | null => {
      if (micrometers === null || micrometers === undefined) return null;
      const value = Number(micrometers);
      const fraction = String(value % 1000).padStart(3, "0").replace(/0+$/, "");
      return fraction ? `${Math.floor(value / 1000)}.${fraction}` : String(Math.floor(value / 1000));
    };
    const profile = row.profile_form ? {
      material: row.profile_material,
      form: row.profile_form,
      width_mm: mm(row.profile_width_micrometers),
      height_mm: mm(row.profile_height_micrometers),
      diameter_mm: mm(row.profile_diameter_micrometers),
      wall_thickness_mm: mm(row.wall_thickness_micrometers)!,
      width_micrometers: row.profile_width_micrometers ?? null,
      height_micrometers: row.profile_height_micrometers ?? null,
      diameter_micrometers: row.profile_diameter_micrometers ?? null,
      wall_thickness_micrometers: row.wall_thickness_micrometers,
      standard_purchase_lengths_mm: JSON.parse(row.standard_purchase_lengths_mm_json),
      custom_length_allowed: Number(row.custom_length_allowed) === 1,
    } as ProfileAttributesInput : null;
    return {
      id: row.id,
      sku: row.sku,
      title: row.title,
      catalog_type: row.catalog_type,
      base_uom: { code: row.base_uom_code, base_quantum: row.base_quantum, quantity_scale: Number(row.quantity_scale) },
      catalog_version: Number(row.catalog_version),
      catalog_version_ref: row.catalog_version_ref,
      uom_registry_version: UOM_REGISTRY_VERSION,
      dimensions: {
        length_mm: row.length_mm_int ?? null,
        width_mm: row.width_mm_int ?? null,
        height_mm: row.height_mm_int ?? null,
        diameter_mm: row.diameter_mm_int ?? null,
      },
      mass_grams: row.mass_grams_int ?? null,
      weight_grams: row.weight_grams ?? null,
      material_behavior: row.material_behavior ?? null,
      profile,
      status: row.status || "Active",
      image: row.image || null,
      name_tr: row.name_tr || null,
      name_en: row.name_en || null,
      supplier_code: row.supplier_code || null,
      material: row.material || null,
      form_code: row.form_code || null,
      tube_type_code: row.tube_type_code || null,
      size_code: row.size_code || null,
      size: row.size || null,
      pipe_size: row.pipe_size || null,
      model: row.model || null,
      normalized_material: row.normalized_material || null,
      normalized_size: row.normalized_size || null,
      normalized_tube_type: row.normalized_tube_type || null,
      normalized_pipe_size: row.normalized_pipe_size || null,
      product_type: (row.product_type || null) as CatalogProduct["product_type"],
      is_sellable: Number(row.is_sellable) === 1,
    };
  }
}
