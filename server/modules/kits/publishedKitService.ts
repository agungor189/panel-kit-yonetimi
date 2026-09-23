import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { CatalogService } from "../catalog/catalogService.js";

export type KitPublicationComponent = {
  productId: string;
  catalogVersionRef: string;
  quantityBaseInt: number;
  role: string;
};

export type KitPublicationProposal = {
  workspaceKitId: string;
  workspaceVersionId: string;
  publishedKitId: string | null;
  sku: string;
  title: string;
  description?: string | null;
  components: KitPublicationComponent[];
  profileCutPlan?: null | {
    profileProductId: string;
    catalogVersionRef: string;
    cuts: Array<{ quantity: number; lengthMm: number; label?: string | null }>;
  };
  packagingPlan: {
    packageCount: number;
    instructionVersion: string;
    installationGuideVersion: string;
    packages: Array<{
      packageNumber: number;
      dimensionsMm?: { length?: number | null; width?: number | null; height?: number | null } | null;
      targetWeightGrams?: number | null;
      items: Array<{ productId: string; quantityBaseInt: number }>;
    }>;
  };
  finalSalePriceMinor: number;
  currency: string;
  authoredContentHash: string;
};

type ResolvedComponent = {
  productId: string;
  sku: string;
  title: string;
  catalogVersion: number;
  catalogVersionRef: string;
  role: string;
  quantityBaseInt: number;
  baseUomCode: string;
  acquisitionCostSnapshotId: string;
  unitCostNumerator: number;
  unitCostDenominator: number;
  extendedCostMinor: number;
};

export class PublishedKitValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "PublishedKitValidationError";
  }
}

const stableJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PublishedKitValidationError("INVALID_KIT", "Kit content must contain finite JSON numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new PublishedKitValidationError("INVALID_KIT", "Kit content must be JSON-compatible.");
};

const hash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");

export const authoredKitContentHash = (value: Omit<KitPublicationProposal, "authoredContentHash"> | KitPublicationProposal): string => {
  const { authoredContentHash: _ignored, publishedKitId: _relationship, ...content } = value as KitPublicationProposal;
  return hash(content);
};

const text = (value: unknown, field: string, max = 300) => {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new PublishedKitValidationError("INCOMPLETE_KIT", `${field} is required and must be valid.`);
  }
  return result;
};

const optionalText = (value: unknown, field: string, max = 2000) => {
  if (value === undefined || value === null || value === "") return null;
  return text(value, field, max);
};

const positiveInteger = (value: unknown, field: string) => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new PublishedKitValidationError("INCOMPLETE_KIT", `${field} must be a positive integer.`);
  return Number(value);
};

const nonNegativeInteger = (value: unknown, field: string) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new PublishedKitValidationError("INCOMPLETE_KIT", `${field} must be a non-negative integer.`);
  return Number(value);
};

const forbiddenSubstituteKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(forbiddenSubstituteKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => /substitut|alternative/i.test(key) || forbiddenSubstituteKey(child));
};

const roundRatio = (numerator: bigint, denominator: bigint) => {
  if (denominator <= 0n) throw new PublishedKitValidationError("COST_UNKNOWN", "Canonical cost denominator is invalid.", 409);
  return Number((numerator + denominator / 2n) / denominator);
};

export type KitPublicationPreview = {
  authoredContentHash: string;
  contentHash: string;
  corePolicyHash: string;
  cost: {
    currency: string;
    canonicalCostMinor: number;
    suggestedSalePriceMinor: number;
    formulaVersion: string;
    components: ResolvedComponent[];
  };
  cutPlan: null | {
    profileProductId: string;
    profileCatalogVersionRef: string;
    effectiveKerfMm: number;
    cutLengthMm: number;
    kerfLengthMm: number;
    consumedLengthMm: number;
    cuts: Array<{ quantity: number; lengthMm: number; kerfMm: number; consumedLengthMm: number; label: string | null }>;
  };
  resolvedSnapshot: Record<string, unknown>;
};

export class PublishedKitService {
  constructor(private readonly db: Database.Database) {}

  preview(raw: KitPublicationProposal): KitPublicationPreview {
    if (forbiddenSubstituteKey(raw)) throw new PublishedKitValidationError("SUBSTITUTES_FORBIDDEN", "Published kit BOM cannot contain substitutes or alternatives.");
    const workspaceKitId = text(raw?.workspaceKitId, "workspaceKitId", 200);
    const workspaceVersionId = text(raw?.workspaceVersionId, "workspaceVersionId", 200);
    const sku = text(raw?.sku, "sku", 120);
    const title = text(raw?.title, "title");
    const description = optionalText(raw?.description, "description");
    const currency = text(raw?.currency, "currency", 3).toUpperCase();
    if (currency !== "TRY") throw new PublishedKitValidationError("UNSUPPORTED_CURRENCY", "V2-11 kit publication cost is canonical TRY.", 409);
    const finalSalePriceMinor = nonNegativeInteger(raw?.finalSalePriceMinor, "finalSalePriceMinor");
    const expectedAuthoredHash = authoredKitContentHash(raw);
    if (!/^[a-f0-9]{64}$/.test(String(raw?.authoredContentHash || "")) || raw.authoredContentHash !== expectedAuthoredHash) {
      throw new PublishedKitValidationError("AUTHORED_CONTENT_HASH_MISMATCH", "Authored kit content hash does not match the proposal.", 409);
    }

    const existingKit = raw.publishedKitId
      ? this.db.prepare("SELECT * FROM published_kits WHERE id=?").get(raw.publishedKitId) as any
      : null;
    if (raw.publishedKitId && !existingKit) throw new PublishedKitValidationError("PUBLISHED_KIT_NOT_FOUND", "Published kit identity was not found.", 404);
    if (existingKit && (existingKit.workspace_kit_id !== workspaceKitId || String(existingKit.sku).toUpperCase() !== sku.toUpperCase())) {
      throw new PublishedKitValidationError("KIT_IDENTITY_CONFLICT", "Published kit workspace/SKU identity cannot change.", 409);
    }
    const duplicate = this.db.prepare("SELECT id FROM products WHERE sku=? COLLATE NOCASE AND id<>COALESCE(?, '') LIMIT 1")
      .get(sku, existingKit?.product_id ?? null);
    if (duplicate) throw new PublishedKitValidationError("DUPLICATE_SKU", "SKU is already owned by another canonical product.", 409);

    if (!Array.isArray(raw.components)) throw new PublishedKitValidationError("INCOMPLETE_KIT", "components are required.");
    const componentInputs = raw.components.map((component, index) => ({
      productId: text(component?.productId, `components[${index}].productId`, 200),
      catalogVersionRef: text(component?.catalogVersionRef, `components[${index}].catalogVersionRef`, 250),
      quantityBaseInt: positiveInteger(component?.quantityBaseInt, `components[${index}].quantityBaseInt`),
      role: text(component?.role, `components[${index}].role`, 100),
    }));

    const setting = this.db.prepare("SELECT kerf_mm,formula_version FROM kit_publication_settings WHERE id='default'").get() as any;
    if (!setting) throw new PublishedKitValidationError("KIT_POLICY_UNKNOWN", "Kit publication policy is not configured.", 409);
    const kerfMm = nonNegativeInteger(setting.kerf_mm, "kerfMm");
    const formulaVersion = text(setting.formula_version, "formulaVersion", 200);
    let cutPlan: KitPublicationPreview["cutPlan"] = null;
    if (raw.profileCutPlan) {
      const profileProductId = text(raw.profileCutPlan.profileProductId, "profileCutPlan.profileProductId", 200);
      const profileCatalogVersionRef = text(raw.profileCutPlan.catalogVersionRef, "profileCutPlan.catalogVersionRef", 250);
      if (!Array.isArray(raw.profileCutPlan.cuts) || raw.profileCutPlan.cuts.length === 0) {
        throw new PublishedKitValidationError("INCOMPLETE_KIT", "Profile cut plan requires at least one cut.");
      }
      const cuts = raw.profileCutPlan.cuts.map((cut, index) => {
        const quantity = positiveInteger(cut?.quantity, `profileCutPlan.cuts[${index}].quantity`);
        const lengthMm = positiveInteger(cut?.lengthMm, `profileCutPlan.cuts[${index}].lengthMm`);
        const consumedLengthMm = quantity * (lengthMm + kerfMm);
        if (!Number.isSafeInteger(consumedLengthMm)) throw new PublishedKitValidationError("INCOMPLETE_KIT", "Profile cut length exceeds safe integer precision.");
        return { quantity, lengthMm, kerfMm, consumedLengthMm, label: optionalText(cut?.label, `profileCutPlan.cuts[${index}].label`, 200) };
      });
      const cutLengthMm = cuts.reduce((sum, cut) => sum + cut.quantity * cut.lengthMm, 0);
      const kerfLengthMm = cuts.reduce((sum, cut) => sum + cut.quantity * kerfMm, 0);
      const consumedLengthMm = cutLengthMm + kerfLengthMm;
      componentInputs.push({ productId: profileProductId, catalogVersionRef: profileCatalogVersionRef, quantityBaseInt: consumedLengthMm, role: "PROFILE" });
      cutPlan = { profileProductId, profileCatalogVersionRef, effectiveKerfMm: kerfMm, cutLengthMm, kerfLengthMm, consumedLengthMm, cuts };
    }
    if (componentInputs.length === 0) throw new PublishedKitValidationError("INCOMPLETE_KIT", "Published kit BOM cannot be empty.");
    const productIds = componentInputs.map(({ productId }) => productId);
    if (new Set(productIds).size !== productIds.length) throw new PublishedKitValidationError("NON_DETERMINISTIC_BOM", "Each BOM product must appear exactly once.", 409);

    const resolved = componentInputs.map((component) => {
      const product = this.db.prepare(`SELECT p.id,p.sku,p.title,p.name,p.catalog_type,p.catalog_version,p.catalog_version_ref,
        p.base_uom_code,u.quantity_scale FROM products p JOIN uom_definitions u ON u.code=p.base_uom_code
        WHERE p.id=? AND p.catalog_version>0`).get(component.productId) as any;
      if (!product) throw new PublishedKitValidationError("CATALOG_REFERENCE_MISSING", `Catalog product ${component.productId} was not found.`, 409);
      if (product.catalog_version_ref !== component.catalogVersionRef) {
        throw new PublishedKitValidationError("CATALOG_VERSION_STALE", `Catalog product ${component.productId} changed after authoring.`, 409);
      }
      if (component.role === "PROFILE" && (product.catalog_type !== "profile" || product.base_uom_code !== "meter")) {
        throw new PublishedKitValidationError("PROFILE_UOM_INVALID", "Profile cuts require a canonical meter-base profile.", 409);
      }
      const cost = this.db.prepare(`SELECT id,normalized_cost_numerator,normalized_cost_denominator
        FROM acquisition_lot_cost_snapshots WHERE product_id=?
        ORDER BY datetime(created_at) DESC,created_at DESC,id DESC LIMIT 1`).get(component.productId) as any;
      if (!cost) throw new PublishedKitValidationError("COST_UNKNOWN", `Canonical acquisition cost is UNKNOWN for ${product.sku}.`, 409);
      const baseQuantumCostDenominator = BigInt(cost.normalized_cost_denominator) * BigInt(product.quantity_scale);
      const extendedCostMinor = roundRatio(BigInt(component.quantityBaseInt) * BigInt(cost.normalized_cost_numerator), baseQuantumCostDenominator);
      return {
        productId: product.id, sku: product.sku, title: product.title || product.name || product.sku,
        catalogVersion: Number(product.catalog_version), catalogVersionRef: product.catalog_version_ref,
        role: component.role, quantityBaseInt: component.quantityBaseInt, baseUomCode: product.base_uom_code,
        acquisitionCostSnapshotId: cost.id, unitCostNumerator: Number(cost.normalized_cost_numerator),
        unitCostDenominator: Number(baseQuantumCostDenominator), extendedCostMinor,
      } satisfies ResolvedComponent;
    }).sort((left, right) => left.productId.localeCompare(right.productId));
    const canonicalCostMinor = resolved.reduce((sum, component) => sum + component.extendedCostMinor, 0);
    if (!Number.isSafeInteger(canonicalCostMinor)) throw new PublishedKitValidationError("COST_OVERFLOW", "Canonical kit cost exceeds safe integer precision.", 409);
    if (finalSalePriceMinor < canonicalCostMinor) throw new PublishedKitValidationError("SALE_PRICE_BELOW_COST", "Final sale price cannot be below canonical calculated kit cost.", 409);
    const suggestedSalePriceMinor = canonicalCostMinor;

    const packaging = this.normalizePackaging(raw.packagingPlan, resolved);
    const policy = { formulaVersion, effectiveKerfMm: kerfMm, currency, suggestedPricePolicy: "CANONICAL_COST_FLOOR" };
    const corePolicyHash = hash(policy);
    const resolvedSnapshot = {
      contract: "dsdst.kit-publication.v1", workspaceKitId, workspaceVersionId, sku, title, description,
      authoredContentHash: expectedAuthoredHash, currency, components: resolved, cutPlan, packaging,
      canonicalCostMinor, suggestedSalePriceMinor, finalSalePriceMinor, policy,
    };
    return {
      authoredContentHash: expectedAuthoredHash,
      contentHash: hash(resolvedSnapshot),
      corePolicyHash,
      cost: { currency, canonicalCostMinor, suggestedSalePriceMinor, formulaVersion, components: resolved },
      cutPlan,
      resolvedSnapshot,
    };
  }

  publish(input: {
    proposal: KitPublicationProposal;
    approvedContentHash: string;
    approvedPolicyHash: string;
    operationId: string;
    actor: { id: string; name?: string | null };
    service?: { id: string; name?: string | null };
    publishedAt?: string;
  }) {
    const operationId = text(input.operationId, "operationId", 200);
    const actorId = text(input.actor?.id, "actor.id", 200);
    const actorName = optionalText(input.actor?.name, "actor.name", 200);
    const serviceId = input.service ? text(input.service.id, "service.id", 200) : null;
    const publishedAt = input.publishedAt ? text(input.publishedAt, "publishedAt", 50) : new Date().toISOString();
    if (!Number.isFinite(Date.parse(publishedAt))) throw new PublishedKitValidationError("INVALID_KIT", "publishedAt must be an ISO timestamp.");

    return this.db.transaction(() => {
      const preview = this.preview(input.proposal);
      if (preview.contentHash !== input.approvedContentHash || preview.corePolicyHash !== input.approvedPolicyHash) {
        throw new PublishedKitValidationError("APPROVED_PREVIEW_MISMATCH", "Approved content/policy hash no longer matches the canonical preview.", 409);
      }
      const replay = this.db.prepare(`SELECT v.id AS version_id,v.version_number,k.id AS published_kit_id,k.product_id
        FROM published_kit_versions v JOIN published_kits k ON k.id=v.published_kit_id
        WHERE v.published_operation_id=?`).get(operationId) as any;
      if (replay) return { publishedKitId: replay.published_kit_id, productId: replay.product_id, versionId: replay.version_id, versionNumber: Number(replay.version_number), contentHash: preview.contentHash, corePolicyHash: preview.corePolicyHash };

      const catalog = new CatalogService(this.db);
      let kit = input.proposal.publishedKitId
        ? this.db.prepare("SELECT * FROM published_kits WHERE id=?").get(input.proposal.publishedKitId) as any
        : null;
      let product;
      if (!kit) {
        product = catalog.createProduct({ sku: input.proposal.sku, title: input.proposal.title, catalog_type: "KIT", base_uom_code: "piece" });
        const publishedKitId = randomUUID();
        this.db.prepare(`INSERT INTO published_kits (id,workspace_kit_id,product_id,sku) VALUES (?,?,?,?)`)
          .run(publishedKitId, input.proposal.workspaceKitId, product.id, input.proposal.sku);
        kit = this.db.prepare("SELECT * FROM published_kits WHERE id=?").get(publishedKitId) as any;
      } else {
        const current = catalog.getProduct(kit.product_id);
        if (!current) throw new PublishedKitValidationError("PUBLISHED_KIT_NOT_FOUND", "Published kit product was not found.", 409);
        product = catalog.updateProduct(kit.product_id, current.catalog_version, { sku: kit.sku, title: input.proposal.title, catalog_type: "KIT", base_uom_code: "piece" });
      }
      this.db.prepare(`UPDATE products SET product_type='kit',is_sellable=1,visible_in_catalog=1,status='Active' WHERE id=?`).run(product.id);

      const versionNumber = Number(this.db.prepare("SELECT COALESCE(MAX(version_number),0)+1 FROM published_kit_versions WHERE published_kit_id=?").pluck().get(kit.id));
      const versionId = randomUUID();
      this.db.prepare(`INSERT INTO published_kit_versions (
        id,published_kit_id,version_number,workspace_version_id,authored_content_hash,content_hash,core_policy_hash,
        product_catalog_version,product_catalog_version_ref,title_snapshot,description_snapshot,currency,
        canonical_cost_minor,suggested_sale_price_minor,final_sale_price_minor,cost_formula_version,cost_provenance_json,
        packaging_snapshot_json,installation_guide_version,effective_kerf_mm,published_operation_id,
        published_by_actor_id,published_by_actor_name,published_by_service_id,published_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        versionId, kit.id, versionNumber, input.proposal.workspaceVersionId, preview.authoredContentHash,
        preview.contentHash, preview.corePolicyHash, product.catalog_version, product.catalog_version_ref,
        input.proposal.title, input.proposal.description || null, preview.cost.currency,
        preview.cost.canonicalCostMinor, preview.cost.suggestedSalePriceMinor, input.proposal.finalSalePriceMinor,
        preview.cost.formulaVersion, stableJson(preview.cost.components), stableJson((preview.resolvedSnapshot as any).packaging),
        input.proposal.packagingPlan.installationGuideVersion, preview.cutPlan?.effectiveKerfMm ?? Number(this.db.prepare("SELECT kerf_mm FROM kit_publication_settings WHERE id='default'").pluck().get()),
        operationId, actorId, actorName, serviceId, publishedAt,
      );

      const insertComponent = this.db.prepare(`INSERT INTO published_kit_version_components (
        id,published_kit_version_id,component_sequence,component_product_id,component_sku_snapshot,
        component_title_snapshot,component_catalog_version,component_catalog_version_ref,component_role_snapshot,
        quantity_base_int,base_uom_code_snapshot,acquisition_cost_snapshot_id,unit_cost_numerator,
        unit_cost_denominator,extended_cost_minor
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      preview.cost.components.forEach((component, sequence) => insertComponent.run(
        randomUUID(), versionId, sequence, component.productId, component.sku, component.title,
        component.catalogVersion, component.catalogVersionRef, component.role, component.quantityBaseInt,
        component.baseUomCode, component.acquisitionCostSnapshotId, component.unitCostNumerator,
        component.unitCostDenominator, component.extendedCostMinor,
      ));
      if (preview.cutPlan) {
        const insertCut = this.db.prepare(`INSERT INTO published_kit_version_cuts (
          id,published_kit_version_id,cut_sequence,profile_product_id,profile_catalog_version_ref,
          quantity,length_mm,kerf_mm,consumed_length_mm,label_snapshot
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`);
        preview.cutPlan.cuts.forEach((cut, sequence) => insertCut.run(randomUUID(), versionId, sequence,
          preview.cutPlan!.profileProductId, preview.cutPlan!.profileCatalogVersionRef, cut.quantity,
          cut.lengthMm, cut.kerfMm, cut.consumedLengthMm, cut.label));
      }

      const packaging = (preview.resolvedSnapshot as any).packaging as ReturnType<PublishedKitService["normalizePackaging"]>;
      const insertPackage = this.db.prepare(`INSERT INTO published_kit_version_packages (
        id,published_kit_version_id,package_number,length_mm,width_mm,height_mm,target_weight_grams,instruction_version
      ) VALUES (?,?,?,?,?,?,?,?)`);
      const insertPackageItem = this.db.prepare(`INSERT INTO published_kit_version_package_items (
        id,package_id,component_product_id,quantity_base_int,base_uom_code_snapshot
      ) VALUES (?,?,?,?,?)`);
      const componentById = new Map(preview.cost.components.map((component) => [component.productId, component]));
      for (const pack of packaging.packages) {
        const packageId = randomUUID();
        insertPackage.run(packageId, versionId, pack.packageNumber, pack.dimensionsMm?.length ?? null,
          pack.dimensionsMm?.width ?? null, pack.dimensionsMm?.height ?? null, pack.targetWeightGrams ?? null,
          packaging.instructionVersion);
        for (const item of pack.items) insertPackageItem.run(randomUUID(), packageId, item.productId,
          item.quantityBaseInt, componentById.get(item.productId)!.baseUomCode);
      }

      this.db.prepare("DELETE FROM product_bom WHERE parent_product_id=?").run(product.id);
      const insertBom = this.db.prepare(`INSERT INTO product_bom (id,parent_product_id,component_product_id,quantity_per_unit,component_role)
        VALUES (?,?,?,?,?)`);
      for (const component of preview.cost.components) insertBom.run(randomUUID(), product.id, component.productId, component.quantityBaseInt, component.role);
      this.db.prepare("UPDATE published_kits SET current_version_id=?,updated_at=? WHERE id=?").run(versionId, publishedAt, kit.id);
      return { publishedKitId: kit.id as string, productId: product.id, versionId, versionNumber, contentHash: preview.contentHash, corePolicyHash: preview.corePolicyHash };
    }).immediate();
  }

  getPublishedKit(idOrProductId: string) {
    const kit = this.db.prepare("SELECT * FROM published_kits WHERE id=? OR product_id=?").get(idOrProductId, idOrProductId) as any;
    if (!kit) return null;
    const versions = (this.db.prepare(`SELECT * FROM published_kit_versions WHERE published_kit_id=? ORDER BY version_number DESC`).all(kit.id) as any[])
      .map((version) => ({
        ...version,
        current: version.id === kit.current_version_id,
        components: this.db.prepare("SELECT * FROM published_kit_version_components WHERE published_kit_version_id=? ORDER BY component_sequence").all(version.id),
        cuts: this.db.prepare("SELECT * FROM published_kit_version_cuts WHERE published_kit_version_id=? ORDER BY cut_sequence").all(version.id),
        packages: this.db.prepare("SELECT * FROM published_kit_version_packages WHERE published_kit_version_id=? ORDER BY package_number").all(version.id),
      }));
    return { ...kit, versions };
  }

  private normalizePackaging(value: KitPublicationProposal["packagingPlan"], components: ResolvedComponent[]) {
    if (!value || !Array.isArray(value.packages)) throw new PublishedKitValidationError("INCOMPLETE_KIT", "Packaging plan is required.");
    const packageCount = positiveInteger(value.packageCount, "packagingPlan.packageCount");
    const instructionVersion = text(value.instructionVersion, "packagingPlan.instructionVersion", 200);
    const installationGuideVersion = text(value.installationGuideVersion, "packagingPlan.installationGuideVersion", 200);
    if (value.packages.length !== packageCount) throw new PublishedKitValidationError("INCOMPLETE_KIT", "Packaging plan must define every package.");
    const packages = value.packages.map((pack, index) => {
      const packageNumber = positiveInteger(pack.packageNumber, `packagingPlan.packages[${index}].packageNumber`);
      const dimension = (field: "length" | "width" | "height") => {
        const raw = pack.dimensionsMm?.[field];
        return raw === undefined || raw === null ? null : positiveInteger(raw, `packagingPlan.packages[${index}].dimensionsMm.${field}`);
      };
      const targetWeightGrams = pack.targetWeightGrams === undefined || pack.targetWeightGrams === null
        ? null : positiveInteger(pack.targetWeightGrams, `packagingPlan.packages[${index}].targetWeightGrams`);
      if (!Array.isArray(pack.items) || pack.items.length === 0) throw new PublishedKitValidationError("INCOMPLETE_KIT", "Every package requires component allocations.");
      const items = pack.items.map((item, itemIndex) => ({
        productId: text(item.productId, `packagingPlan.packages[${index}].items[${itemIndex}].productId`, 200),
        quantityBaseInt: positiveInteger(item.quantityBaseInt, `packagingPlan.packages[${index}].items[${itemIndex}].quantityBaseInt`),
      }));
      if (new Set(items.map(({ productId }) => productId)).size !== items.length) throw new PublishedKitValidationError("INCOMPLETE_KIT", "One package cannot repeat a component allocation.");
      return { packageNumber, dimensionsMm: { length: dimension("length"), width: dimension("width"), height: dimension("height") }, targetWeightGrams, items };
    });
    const numbers = packages.map(({ packageNumber }) => packageNumber).sort((a, b) => a - b);
    if (numbers.some((number, index) => number !== index + 1)) throw new PublishedKitValidationError("INCOMPLETE_KIT", "Package numbers must be consecutive from 1.");
    const allocated = new Map<string, number>();
    for (const pack of packages) for (const item of pack.items) allocated.set(item.productId, (allocated.get(item.productId) || 0) + item.quantityBaseInt);
    for (const component of components) {
      if (allocated.get(component.productId) !== component.quantityBaseInt) throw new PublishedKitValidationError("INCOMPLETE_KIT", `Packaging allocation for ${component.sku} must equal the published BOM quantity.`);
    }
    if ([...allocated].some(([productId]) => !components.some((component) => component.productId === productId))) {
      throw new PublishedKitValidationError("INCOMPLETE_KIT", "Packaging cannot allocate a product outside the published BOM.");
    }
    return { packageCount, instructionVersion, installationGuideVersion, packages };
  }
}
