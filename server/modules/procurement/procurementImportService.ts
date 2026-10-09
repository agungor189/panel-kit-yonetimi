import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CatalogService, type CatalogProductInput } from '../catalog/catalogService.js';
import { splitVat, integerMoney } from '../finance/money.js';
import { ExchangeRateService } from '../finance/exchangeRates.js';
import { ExpenseService, draftCostAmounts } from '../finance/expenseService.js';
import { canonicalPayloadHash } from '../commands/commandFoundation.js';
import { normalizeBaseQuantity, type UomCode } from '../catalog/uom.js';
import { ProcurementService, ProcurementValidationError, type PurchaseInput, type PurchaseCostInput } from './procurementService.js';
import { parseProcurementImport, expandSourcePackages, decimal, fail, ImportValidationError, type ImportRow } from './procurementImport.js';

type Choice = { action: 'KEEP' | 'UPDATE' | 'CREATE'; productId?: string; fields?: CatalogProductInput };
export type ImportRequest = {
  csv: string; supplierId: string; choices?: Record<string, Choice>; confirmations?: string[];
  expectedPreviewHash?: string;
};
export type ImportCostDecision = {
  vatMode: 'INCLUDED' | 'EXCLUDED'; vatRateBps: number;
  acquisitionCostVatPolicy: PurchaseInput['acquisitionCostVatPolicy'];
  includedCost: 'NO_SEPARATE_CHARGE'; stockCheck: 'NO_PRIOR_RECEIPT'; stockEvidence: string;
  costDecisions?: Array<{ costId: string; category: PurchaseCostInput['category']; counterparty: 'SUPPLIER' | 'THIRD_PARTY'; vatMode: 'INCLUDED' | 'EXCLUDED'; vatRateBps: number }>;
  approveProportionalAllocation?: boolean;
  expectedPreviewHash?: string; approvePreview?: boolean;
};
class PreviewRollback extends Error { constructor(readonly result: any) { super('Read-only preview rollback'); } }
export type DraftCostInput = { title: string; amountMinor: number; currency: 'USD' | 'TRY'; description?: string; vatRateBps?: number };

const draftText = (value: unknown, field: string, max: number) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw new ProcurementValidationError('DRAFT_COST_INVALID', `${field} geçersiz.`);
  return result;
};
const draftCostFields = (input: DraftCostInput) => {
  const title = draftText(input?.title, 'Başlık', 120);
  if (!Number.isSafeInteger(input?.amountMinor) || input.amountMinor <= 0) throw new ProcurementValidationError('DRAFT_COST_INVALID', 'Tutar pozitif kuruş değeri olmalı.');
  if (input.currency !== 'USD' && input.currency !== 'TRY') throw new ProcurementValidationError('DRAFT_COST_INVALID', 'Para birimi USD veya TRY olmalı.');
  const description = input.description?.trim() ? draftText(input.description, 'Açıklama', 1000) : null;
  const vatRateBps = input.vatRateBps === undefined ? 2000 : input.vatRateBps;
  if (!Number.isInteger(vatRateBps) || vatRateBps < 0 || vatRateBps > 10000) throw new ProcurementValidationError('DRAFT_COST_INVALID','KDV oranı %0–100 arasında, en çok iki ondalık basamakla girilmeli.');
  integerMoney(splitVat(input.amountMinor,'EXCLUDED',vatRateBps).grossMinor,'gross cost');
  return { title, amountMinor: input.amountMinor, currency: input.currency, description, vatRateBps };
};
const roundRatio = (amount: number, numerator: number, denominator: number) => {
  const n = BigInt(amount) * BigInt(numerator), d = BigInt(denominator);
  const value = (n + d / 2n) / d;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProcurementValidationError('DRAFT_COST_INVALID', 'Tahmini döviz tutarı çok büyük.');
  return Number(value);
};

// These five identities were explicitly approved for source rows without a MasterInfo SKU.
const APPROVED_MISSING_SKUS = new Map([
  ['PRODUCT-X001', 'PCI-R200-4W'], ['PRODUCT-X002', 'PCI-R200-5W'],
  ['PRODUCT-X003', 'PCI-R150-SVF'], ['PRODUCT-X004', 'FAST-M8X10'], ['PRODUCT-X005', 'FAST-M8X16'],
]);
const skuKey = (sku: string) => sku.trim().toLocaleUpperCase('en-US');
const verifiedSourceFields = (row: ImportRow, products: ImportRow[]) => {
  if (!['PRODUCT-X001','PRODUCT-X002','PRODUCT-X003'].includes(row.record_id) ||
    APPROVED_MISSING_SKUS.get(row.record_id) !== row.suggested_sku || !row.supplier_code || !row.name_en || row.profile_type !== 'Yuvarlak') return {};
  const suffix = row.supplier_code.match(/-(E60|D48)$/)?.[1];
  const proposed = row.meta?.proposed_fields;
  if (!suffix || !proposed || typeof proposed !== 'object') return {};
  const peers = products.filter(other => other !== row && other.supplier_code?.endsWith(`-${suffix}`) &&
    other.material === proposed.material && other.size === proposed.size && other.profile_type === row.profile_type);
  // A proposal is not a catalog fact by itself. Require corroboration by at least
  // two MasterInfo products with the same supplier-code size family.
  if (peers.length < 2 || proposed.material !== 'Premium Cast Iron' ||
    proposed.size !== (suffix === 'E60' ? '2 inç - 60.3mm' : '1.5 inç - 48.3mm')) return {};
  return { material: proposed.material as string, size: proposed.size as string };
};
type ResolvedProduct = {
  ref: string; row: number; source: ImportRow; sku: string; current: ReturnType<CatalogService['getProduct']>;
  proposed: CatalogProductInput; action: 'KEEP' | 'CREATE'; bomVersion: string | null;
};

export class ProcurementImportService {
  private catalog: CatalogService;
  constructor(private db: Database.Database) { this.catalog = new CatalogService(db); }

  private draftLifecycle(draftId: string): 'CANCELLED' | 'REOPENED' | null {
    return (this.db.prepare(`SELECT event_type FROM procurement_import_draft_lifecycle_events
      WHERE draft_id=? ORDER BY sequence DESC LIMIT 1`).pluck().get(draftId) as 'CANCELLED' | 'REOPENED' | undefined) || null;
  }

  preview(input: ImportRequest) {
    const parsed = parseProcurementImport(input.csv);
    const supplier = this.db.prepare('SELECT id,name FROM procurement_suppliers WHERE id=? AND active=1').get(input.supplierId) as any;
    if (!supplier) fail(parsed.header, 'Önce kayıtlı tedarikçiyi seçin.');
    const blockingErrors: string[] = [];
    const problem = (r: ImportRow, message: string) => blockingErrors.push(`Satır ${r.row} · ${r.record_id} · ${r.source_file || 'CSV'}:${r.source_row || r.row} · ${message}`);
    if (skuKey(supplier.name) !== skuKey(parsed.header.supplier_name)) problem(parsed.header, `Kaynak tedarikçi ${parsed.header.supplier_name} kayıtlı ${supplier.name} ile uyuşmuyor.`);
    const catalogBySku = new Map<string, NonNullable<ReturnType<CatalogService['getProduct']>>>();
    const ambiguousCatalogSkus = new Set<string>();
    for (const product of this.catalog.listProducts()) {
      const key = skuKey(product.sku);
      if (catalogBySku.has(key) && catalogBySku.get(key)!.id !== product.id) ambiguousCatalogSkus.add(key);
      else catalogBySku.set(key, product);
    }
    for (const product of this.db.prepare('SELECT id,sku FROM products WHERE sku IS NOT NULL').all() as Array<{ id: string; sku: string }>) {
      if (catalogBySku.get(skuKey(product.sku))?.id !== product.id) ambiguousCatalogSkus.add(skuKey(product.sku));
    }
    const catalogBySupplierCode = new Map<string, string>();
    for (const product of catalogBySku.values()) if (product.supplier_code) {
      const key = skuKey(product.supplier_code);
      if (!catalogBySupplierCode.has(key)) catalogBySupplierCode.set(key, product.id);
      else if (catalogBySupplierCode.get(key) !== product.id) catalogBySupplierCode.set(key, 'AMBIGUOUS');
    }
    const existingAliases = new Map((this.db.prepare(`SELECT a.alias,a.product_id FROM catalog_supplier_aliases a WHERE a.supplier_id=?
      AND NOT EXISTS(SELECT 1 FROM catalog_supplier_alias_retractions r WHERE r.supplier_id=a.supplier_id AND r.alias=a.alias
        AND NOT EXISTS(SELECT 1 FROM catalog_supplier_alias_retraction_reversals v WHERE v.supplier_id=r.supplier_id AND v.alias=r.alias))`).all(input.supplierId) as Array<{ alias: string; product_id: string }>).map(a => [skuKey(a.alias), a.product_id]));
    const definitions = [...parsed.products];
    const skuToRef = new Map<string, string>();
    for (const r of definitions) {
      const approved = APPROVED_MISSING_SKUS.get(r.record_id);
      const sku = r.sku?.trim() || (approved && r.suggested_sku === approved ? approved : '');
      if (!sku) { problem(r, 'MasterInfo SKU yok; yalnız açıkça kabul edilmiş beş önerilen SKU otomatik atanabilir.'); continue; }
      const key = skuKey(sku);
      if (skuToRef.has(key)) problem(r, `SKU ${sku} birden fazla PRODUCT kaydında bulunuyor.`);
      else skuToRef.set(key, r.record_id);
    }
    for (const line of parsed.lines.filter(r => !r.product_ref)) {
      if (!skuToRef.has(skuKey(line.sku))) {
        if (!catalogBySku.has(skuKey(line.sku))) problem(line, `PRODUCT içermeyen SKU ${line.sku} katalogda yok.`);
        else { definitions.push({ ...line, record_id: `sku:${line.sku}` } as ImportRow); skuToRef.set(skuKey(line.sku), `sku:${line.sku}`); }
      }
    }
    const products: ResolvedProduct[] = definitions.map(r => {
      const sku = r.sku?.trim() || (APPROVED_MISSING_SKUS.get(r.record_id) === r.suggested_sku ? r.suggested_sku : '');
      const current = catalogBySku.get(skuKey(sku)) || null;
      if (ambiguousCatalogSkus.has(skuKey(sku))) problem(r, `SKU ${sku} katalogda tek ve sürümlü ürün olarak çözülemedi (çift veya versiyonsuz kayıt).`);
      if (!current && r.record_type === 'PRODUCT' && (!r.uom || !r.product_type || !(r.name_tr || r.name_en))) problem(r, 'Yeni ürün için MasterInfo tür, birim ve ürün adı zorunlu.');
      if (current && r.record_type === 'PRODUCT') {
        if (r.product_type && current.product_type !== r.product_type) problem(r, `SKU ${sku} katalog türüyle çelişiyor (${current.product_type || 'boş'} / ${r.product_type}).`);
        if (r.uom && current.base_uom.code !== r.uom) problem(r, `SKU ${sku} katalog birimiyle çelişiyor.`);
      }
      const verified = verifiedSourceFields(r,parsed.products);
      const proposed: CatalogProductInput = { sku, title: r.name_tr || r.name_en || sku, catalog_type: 'product', base_uom_code: (r.uom || 'piece') as UomCode,
        product_type: r.product_type as CatalogProductInput['product_type'], name_tr: r.name_tr || undefined, name_en: r.name_en || undefined,
        material: r.material || verified.material, size: r.size || verified.size, profile_type: r.profile_type || undefined, supplier_code: r.supplier_code || undefined,
        // Source fractions are preserved verbatim in source rows, not rounded into catalog grams.
        mass_grams: r.unit_weight_g && Number.isInteger(Number(r.unit_weight_g)) ? Number(r.unit_weight_g) : undefined };
      return { ref: r.record_id, row: r.row, source: r, sku, current, proposed, action: current ? 'KEEP' : 'CREATE', bomVersion: current ? this.catalog.readBom(current.id).version : null };
    });
    const byRef = new Map(products.map(product => [product.ref, product]));
    const aliasesByKey = new Map<string, { alias: string; refs: Set<string>; rows: ImportRow[]; canonical: boolean }>();
    const offerAlias = (alias: string, ref: string, row: ImportRow, canonical = false) => {
      if (!alias?.trim() || !byRef.has(ref)) return;
      const key = skuKey(alias);
      const entry = aliasesByKey.get(key) || { alias: alias.trim(), refs: new Set<string>(), rows: [], canonical: false };
      entry.refs.add(ref); entry.rows.push(row); entry.canonical ||= canonical;
      aliasesByKey.set(key, entry);
    };
    for (const product of products) if (product.source.record_type === 'PRODUCT') {
      offerAlias(product.source.supplier_code, product.ref, product.source, true);
    }
    const aliases: Array<{ alias: string; ref: string }> = [];
    const skippedAliases: string[] = [];
    for (const [key, entry] of aliasesByKey) {
      if (entry.refs.size > 1) {
        if (entry.canonical || existingAliases.has(key)) for (const row of entry.rows) problem(row, `Tedarik no ${entry.alias} birden fazla SKU'ya bağlı.`);
        else skippedAliases.push(entry.alias); // Generic packing descriptions are not verified supplier numbers.
        continue;
      }
      const ref = [...entry.refs][0], product = byRef.get(ref)!;
      const owner = existingAliases.get(key) || catalogBySupplierCode.get(key);
      if (owner && owner !== product.current?.id) problem(entry.rows[0], `Tedarik no ${entry.alias} başka katalog ürününe bağlı.`);
      else aliases.push({ alias: entry.alias, ref });
    }
    const bom = [...new Set(parsed.bom.map(r => r.parent_ref))].map(parentRef => {
      const p = byRef.get(parentRef);
      if (!p) { problem(parsed.bom.find(r => r.parent_ref === parentRef)!, 'BOM parent ürünü çözülemedi.'); return null; }
      const current = p.current ? this.catalog.readBom(p.current.id) : { lines: [], version: this.catalog.readBom('').version };
      const incoming = parsed.bom.filter(r => r.parent_ref === parentRef).map(r => ({ componentRef: r.component_ref, quantity: Number(r.quantity_per_unit) }));
      for (const item of incoming) {
        const component = byRef.get(item.componentRef);
        if (!component || component.current?.product_type && component.current.product_type !== 'component') problem(parsed.bom.find(r => r.component_ref === item.componentRef)!, 'BOM bileşeni katalogda component olarak çözülemedi.');
      }
      const incomingExisting = incoming.map(item => ({ componentId: byRef.get(item.componentRef)?.current?.id, quantity: item.quantity }));
      const unchanged = p.current && incomingExisting.every(item => item.componentId) &&
        JSON.stringify([...incomingExisting].sort((a,b) => String(a.componentId).localeCompare(String(b.componentId)))) === JSON.stringify(current.lines);
      return { parentRef, current, incoming, action: unchanged ? 'KEEP' as const : 'REPLACE' as const };
    }).filter((item): item is NonNullable<typeof item> => item !== null);
    const summary = { existingSkuCount: products.filter(p => p.action === 'KEEP').length, newSkuCount: products.filter(p => p.action === 'CREATE').length,
      purchaseLineCount: parsed.lines.length, billedLineCount: parsed.lines.filter(l => l.pricing_basis === 'BILLED').length,
      includedLineCount: parsed.lines.filter(l => l.pricing_basis === 'INCLUDED_IN_PRICE').length, bomCount: bom.length,
      bomRelationCount: parsed.bom.length, bomChangeCount: bom.filter(b => b.action === 'REPLACE').length, aliasCount: aliases.length };
    const identity = this.db.prepare(`SELECT d.id, c.purchase_order_id FROM procurement_import_drafts d
      LEFT JOIN procurement_import_draft_completions c ON c.draft_id=d.id
      WHERE d.source_hash=? OR (d.supplier_id=? AND d.invoice_number=?)`).get(parsed.sourceHash, input.supplierId, parsed.header.invoice_number.trim()) as any;
    const previousPurchase = !identity && this.db.prepare(`SELECT purchase_order_id FROM procurement_imports
      WHERE source_hash=? OR (supplier_id=? AND invoice_number=?)`).get(parsed.sourceHash, input.supplierId, parsed.header.invoice_number.trim()) as any;
    const previewHash = canonicalPayloadHash({ source: parsed.sourceHash, supplierId: supplier.id,
      products: products.map(p => ({ ref: p.ref, sku: p.sku, action: p.action, id: p.current?.id ?? null, version: p.current?.catalog_version_ref ?? null })),
      bom: bom.map(b => ({ ref: b.parentRef, action: b.action, version: b.current.version, incoming: b.incoming })),
      aliases, blockingErrors });
    return { parsed, supplier, products, bom, aliases, skippedAliases, summary, blockingErrors, previewHash,
      existingPurchaseId: identity?.purchase_order_id || previousPurchase?.purchase_order_id || null,
      existingDraftId: identity?.id && this.draftLifecycle(identity.id) !== 'CANCELLED' ? identity.id : null,
      cancelledDraftId: identity?.id && this.draftLifecycle(identity.id) === 'CANCELLED' ? identity.id : null,
      packagePreview: expandSourcePackages(parsed) };
  }

  apply(input: ImportRequest, actorId: string, operationId?: string) {
    return this.db.transaction(() => {
      if ('policy' in input) throw new ProcurementValidationError('IMPORT_COST_DECISION_FORBIDDEN', 'Maliyet kararları CSV importunda alınmaz.', 400);
      const parsed = parseProcurementImport(input.csv);
      const existing = this.db.prepare('SELECT * FROM procurement_import_drafts WHERE source_hash=? OR (supplier_id=? AND invoice_number=?)').get(parsed.sourceHash, input.supplierId, parsed.header.invoice_number.trim()) as any;
      if (existing) {
        if (existing.source_hash !== parsed.sourceHash || existing.supplier_id !== input.supplierId) throw new ProcurementValidationError('IMPORT_IDENTITY_CONFLICT', 'Bu kaynak/fatura farklı içerikle zaten kayıtlı.', 409);
        if (this.draftLifecycle(existing.id) === 'CANCELLED') {
          if (this.db.prepare('SELECT 1 FROM procurement_import_draft_completions WHERE draft_id=?').get(existing.id))
            throw new ProcurementValidationError('DRAFT_ALREADY_COMPLETED','Kesinleştirilmiş taslak yeniden açılamaz.',409);
          const review = this.preview(input);
          if (review.previewHash !== input.expectedPreviewHash || review.blockingErrors.length)
            throw new ProcurementValidationError('IMPORT_PREVIEW_STALE','Kaynak veya katalog değişti; önizlemeyi yenileyin.',409);
          this.db.prepare(`INSERT INTO procurement_import_draft_lifecycle_events
            (draft_id,event_type,operation_id,actor_id,created_at) VALUES (?,'REOPENED',?,?,?)`)
            .run(existing.id,draftText(operationId,'operationId',200),draftText(actorId,'actorId',200),new Date().toISOString());
        }
        return this.getDraft(existing.id)!;
      }
      // All purchases, including older/manual ones, participate in invoice duplication protection.
      if (this.db.prepare('SELECT 1 FROM purchase_orders WHERE supplier_id=? AND upper(trim(invoice_number))=upper(?)').get(input.supplierId, parsed.header.invoice_number.trim())) throw new ProcurementValidationError('INVOICE_ALREADY_EXISTS', 'Fatura daha önce kaydedilmiş; ikinci taslak veya stok girişi engellendi.', 409);
      const preview = this.preview(input);
      if (preview.previewHash !== input.expectedPreviewHash) throw new ProcurementValidationError('IMPORT_PREVIEW_STALE', 'Katalog veya BOM değişti. Önizlemeyi yenileyin.', 409);
      if (preview.blockingErrors.length) throw new ImportValidationError(preview.blockingErrors.join('\n'));
      const draftId = randomUUID(), createdAt = new Date().toISOString();
      const ids = new Map<string, string>();
      for (const p of preview.products) {
        let product = p.current;
        if (p.action === 'CREATE') {
          if (p.source.record_type !== 'PRODUCT') fail(p.source, 'PRODUCT olmadan yeni kart oluşturulamaz.');
          product = this.catalog.createProduct({ ...p.proposed, status: 'Passive', is_sellable: false }, p.proposed.product_type === 'assembly' ? {} : { activationProvenance: 'PROCUREMENT_CSV_FIRST_RECEIPT' });
        } else if (!product) fail(p.source, 'Kayıtlı SKU bulunamadı.');
        else if (['PRODUCT-X001','PRODUCT-X002','PRODUCT-X003'].includes(p.ref) && p.proposed.material && p.proposed.size) {
          const missing = { material:!product.material ? p.proposed.material : undefined,
            size:!product.size ? p.proposed.size : undefined,
            profile_type:!product.tube_type_code ? p.proposed.profile_type : undefined,
            name_en:!product.name_en ? p.proposed.name_en : undefined,
            supplier_code:!product.supplier_code ? p.proposed.supplier_code : undefined };
          if (Object.values(missing).some(Boolean)) product = this.catalog.updateProduct(product.id,product.catalog_version,
            { sku:product.sku,title:product.title,catalog_type:product.catalog_type,base_uom_code:product.base_uom.code,...missing });
        }
        ids.set(p.ref, product!.id);
      }
      for (const alias of preview.aliases) this.catalog.confirmSupplierAlias(input.supplierId, alias.alias, ids.get(alias.ref)!, `${draftId}:${alias.ref}`);
      for (const b of preview.bom) if (b.action === 'REPLACE') this.catalog.replaceBom(ids.get(b.parentRef)!, b.current.version, b.incoming.map(c => ({ componentId: ids.get(c.componentRef)!, quantity: c.quantity })));
      const lineIds = new Map(parsed.lines.map(r => [r.record_id, randomUUID()]));
      for (const r of parsed.lines) {
        const productId = ids.get(r.product_ref || `sku:${r.sku}`)!;
        const product = this.catalog.getProduct(productId)!;
        if (product.product_type === 'assembly' || product.catalog_type === 'KIT') fail(r, 'Assembly/KIT fiziksel kabul edilemez.');
        if (!r.uom || r.uom !== product.base_uom.code) fail(r, 'Kaynak ve katalog UOM uyuşmuyor.');
        decimal(r.unit_price, r, 'unit_price', 2);
      }
      this.db.prepare(`INSERT INTO procurement_import_drafts
        (id,source_hash,supplier_id,invoice_number,invoice_date,currency,source_csv,resolved_json,preview_hash,actor_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(draftId, parsed.sourceHash, input.supplierId, parsed.header.invoice_number.trim(), parsed.header.invoice_date,
          parsed.header.currency, input.csv, JSON.stringify({ productIds: Object.fromEntries(ids), lineIds: Object.fromEntries(lineIds), aliases: preview.aliases }), preview.previewHash, actorId, createdAt);
      return this.getDraft(draftId)!;
    }).immediate();
  }

  private openDraft(draftId: string) {
    const row = this.db.prepare(`SELECT d.id FROM procurement_import_drafts d
      LEFT JOIN procurement_import_draft_completions c ON c.draft_id=d.id WHERE d.id=? AND c.draft_id IS NULL`).get(draftId) as any;
    if (!row || this.draftLifecycle(draftId) === 'CANCELLED')
      throw new ProcurementValidationError('DRAFT_NOT_EDITABLE', 'Taslak bulunamadı, iptal edilmiş veya maliyetleri kesinleştirilmiş.', 409);
  }

  cancelDraft(draftId: string, actorId: string, operationId: string) {
    return this.db.transaction(() => {
      this.openDraft(draftId);
      const now = new Date().toISOString();
      for (const cost of this.activeDraftCosts(draftId)) {
        new ExpenseService(this.db).assertCostUnpaid(cost.id);
        const changed = this.db.prepare(`UPDATE procurement_import_draft_costs SET status='DELETED',version=version+1,updated_by=?,updated_at=?
          WHERE id=? AND draft_id=? AND status='ACTIVE' AND version=?`).run(actorId,now,cost.id,draftId,cost.version);
        if (changed.changes !== 1) throw new ProcurementValidationError('DRAFT_COST_STALE','Maliyet kalemi değişti; iptal işlemini yenileyin.',409);
        this.recordCostRevision(this.db.prepare('SELECT * FROM procurement_import_draft_costs WHERE id=?').get(cost.id),
          'DELETE',actorId,operationId,now);
        new ExpenseService(this.db).syncPendingCost(cost.id);
      }
      this.db.prepare(`INSERT INTO procurement_import_draft_lifecycle_events
        (draft_id,event_type,operation_id,actor_id,created_at) VALUES (?,'CANCELLED',?,?,?)`)
        .run(draftId,draftText(operationId,'operationId',200),draftText(actorId,'actorId',200),now);
      return { id:draftId,status:'CANCELLED' as const,cancelledAt:now };
    }).immediate();
  }

  private activeDraftCosts(draftId: string) {
    return this.db.prepare(`SELECT *
      FROM procurement_import_draft_costs WHERE draft_id=? AND status='ACTIVE' ORDER BY created_at,id`).all(draftId) as Array<{
        id: string; title: string; amount_minor: number; currency: 'USD' | 'TRY'; description: string | null; vat_rate_bps: number | null; version: number; created_at: string;
      }>;
  }

  private recordCostRevision(row: any, action: 'CREATE' | 'UPDATE' | 'DELETE', actorId: string, operationId: string, now: string) {
    this.db.prepare(`INSERT INTO procurement_import_draft_cost_revisions
      (cost_id,version,action,snapshot_json,operation_id,actor_id,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(row.id, row.version, action, JSON.stringify(row), draftText(operationId,'operationId',200), draftText(actorId,'actorId',200), now);
  }

  addDraftCost(draftId: string, input: DraftCostInput, actorId: string, operationId: string) {
    return this.db.transaction(() => {
      this.openDraft(draftId);
      const cost = draftCostFields(input), id = randomUUID(), now = new Date().toISOString();
      this.db.prepare(`INSERT INTO procurement_import_draft_costs
        (id,draft_id,title,amount_minor,currency,description,vat_rate_bps,status,version,created_by,created_at,updated_by,updated_at)
        VALUES (?,?,?,?,?,?,?,'ACTIVE',1,?,?,?,?)`).run(id,draftId,cost.title,cost.amountMinor,cost.currency,cost.description,cost.vatRateBps,actorId,now,actorId,now);
      const row = this.db.prepare('SELECT * FROM procurement_import_draft_costs WHERE id=?').get(id);
      this.recordCostRevision(row,'CREATE',actorId,operationId,now);
      new ExpenseService(this.db).syncPendingCost(id);
      return this.getDraft(draftId)!;
    }).immediate();
  }

  updateDraftCost(draftId: string, costId: string, input: DraftCostInput & { expectedVersion: number }, actorId: string, operationId: string) {
    return this.db.transaction(() => {
      this.openDraft(draftId);
      const cost = draftCostFields(input), now = new Date().toISOString();
      new ExpenseService(this.db).assertCostUnpaid(costId);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new ProcurementValidationError('DRAFT_COST_VERSION_REQUIRED', 'Güncel maliyet sürümü gerekli.', 409);
      const changed = this.db.prepare(`UPDATE procurement_import_draft_costs SET title=?,amount_minor=?,currency=?,description=?,vat_rate_bps=?,
        version=version+1,updated_by=?,updated_at=? WHERE id=? AND draft_id=? AND status='ACTIVE' AND version=?`)
        .run(cost.title,cost.amountMinor,cost.currency,cost.description,cost.vatRateBps,actorId,now,costId,draftId,input.expectedVersion);
      if (changed.changes !== 1) throw new ProcurementValidationError('DRAFT_COST_STALE', 'Maliyet kalemi değişmiş veya silinmiş; listeyi yenileyin.', 409);
      this.recordCostRevision(this.db.prepare('SELECT * FROM procurement_import_draft_costs WHERE id=?').get(costId),'UPDATE',actorId,operationId,now);
      new ExpenseService(this.db).syncPendingCost(costId);
      return this.getDraft(draftId)!;
    }).immediate();
  }

  deleteDraftCost(draftId: string, costId: string, expectedVersion: number, actorId: string, operationId: string) {
    return this.db.transaction(() => {
      this.openDraft(draftId);
      new ExpenseService(this.db).assertCostUnpaid(costId);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new ProcurementValidationError('DRAFT_COST_VERSION_REQUIRED', 'Güncel maliyet sürümü gerekli.', 409);
      const now = new Date().toISOString();
      const changed = this.db.prepare(`UPDATE procurement_import_draft_costs SET status='DELETED',version=version+1,updated_by=?,updated_at=?
        WHERE id=? AND draft_id=? AND status='ACTIVE' AND version=?`).run(actorId,now,costId,draftId,expectedVersion);
      if (changed.changes !== 1) throw new ProcurementValidationError('DRAFT_COST_STALE', 'Maliyet kalemi değişmiş veya silinmiş; listeyi yenileyin.', 409);
      this.recordCostRevision(this.db.prepare('SELECT * FROM procurement_import_draft_costs WHERE id=?').get(costId),'DELETE',actorId,operationId,now);
      new ExpenseService(this.db).syncPendingCost(costId);
      return this.getDraft(draftId)!;
    }).immediate();
  }

  getDraft(id: string): any | null {
    const row = this.db.prepare(`SELECT d.*,s.name AS supplier_name,c.purchase_order_id FROM procurement_import_drafts d
      JOIN procurement_suppliers s ON s.id=d.supplier_id
      LEFT JOIN procurement_import_draft_completions c ON c.draft_id=d.id WHERE d.id=?`).get(id) as any;
    if (!row) return null;
    if (this.draftLifecycle(id) === 'CANCELLED') return null;
    if (row.purchase_order_id) return new ProcurementService(this.db).getPurchase(row.purchase_order_id);
    const parsed = parseProcurementImport(row.source_csv);
    const resolved = JSON.parse(row.resolved_json) as { productIds: Record<string,string>; lineIds: Record<string,string> };
    const sourceProducts = new Map(parsed.products.map(product => [product.record_id,product]));
    const packages = expandSourcePackages(parsed);
    const currentFx = new ExchangeRateService(this.db).getCurrentUsdTry();
    const draftCosts = this.activeDraftCosts(row.id).map(cost => ({
      id: cost.id, title: cost.title, amountMinor: cost.amount_minor, ...draftCostAmounts(cost), currency: cost.currency, description: cost.description, version: cost.version,
      expenseId: cost.id, paymentStatus: new ExpenseService(this.db).detail(cost.id)?.paymentStatus ?? null,
      estimateUsdMinor: cost.currency === 'USD' ? draftCostAmounts(cost).grossMinor : currentFx ? roundRatio(draftCostAmounts(cost).grossMinor,currentFx.denominator,currentFx.numerator) : null,
    }));
    const goodsAmountUsdMinor = parsed.header.currency === 'USD' ? parsed.summary.goodsAmountMinor : null;
    const additionalCostsUsdMinor = draftCosts.every(cost => cost.estimateUsdMinor !== null)
      ? draftCosts.reduce((sum,cost) => sum + cost.estimateUsdMinor!,0) : null;
    const estimatedTotalUsdMinor = goodsAmountUsdMinor === null || additionalCostsUsdMinor === null ? null : goodsAmountUsdMinor + additionalCostsUsdMinor;
    return { id: row.id, purchaseNumber: `CSV-${row.invoice_number}`, orderDate: row.invoice_date,
      workflowState: 'DRAFT', status: 'INCOMPLETE', costDecisionPending: true,
      goodsAmountUsdMinor, additionalCostsUsdMinor, estimatedTotalUsdMinor,
      estimateFx: currentFx ? { observationId: currentFx.observationId, numerator: currentFx.numerator, denominator: currentFx.denominator, observedAt: currentFx.observedAt } : null,
      draftCosts,
      supplier: { id: row.supplier_id, name: row.supplier_name }, supplierCurrency: row.currency,
      vatPolicy: null, totalNetMinor: null, totalVatMinor: null, totalGrossMinor: null, paidMinor: 0,
      outstandingMinor: null, paymentStatus: 'UNPAID', acquisitionCosts: [], lots: [], documents: [], sourcePacking: [...parsed.groups, ...parsed.items],
      lines: parsed.lines.map(r => {
        const productId = resolved.productIds[r.product_ref || `sku:${r.sku}`];
        const product = this.catalog.getProduct(productId)!;
        const sourceProduct = sourceProducts.get(r.product_ref);
        const planned = packages.filter(p => p.lineRef === r.record_id);
        const distribution = new Map<number,number>();
        for (const p of planned) {
          const quantity = normalizeBaseQuantity(p.quantity, r.uom as UomCode).baseQuantity;
          distribution.set(quantity, (distribution.get(quantity) || 0) + 1);
        }
        return { id: resolved.lineIds[r.record_id], productId,
          product: { sku: product.sku, title: product.title, supplierCode: sourceProduct?.supplier_code || product.supplier_code,
            nameTr: sourceProduct?.name_tr || product.name_tr, nameEn: sourceProduct?.name_en || product.name_en,
            size: sourceProduct?.size || product.size, material: sourceProduct?.material || product.material,
            profileType: sourceProduct?.profile_type || product.tube_type_code, productType: product.product_type },
          sourceLineAmountMinor: Number(decimal(r.amount, r, 'amount', 2)),
          plannedPackages: { count: planned.length, mixedCount: planned.filter(p => p.mixed).length,
            distribution: [...distribution].map(([quantity,count]) => ({ quantity,count })).sort((a,b) => b.quantity-a.quantity) },
          quote: { basis: r.uom, originalQuantity: r.quantity, supplierUnitPriceMinor: Number(decimal(r.unit_price,r,'unit_price',2)), currency: r.currency },
          normalizedQuantity: { baseQuantity: normalizeBaseQuantity(r.quantity,r.uom as UomCode).baseQuantity, baseUomCode: r.uom },
          vat: null, amounts: null, fx: null, normalizedMerchandiseUnitCostTry: null, packing: null };
      }),
    };
  }

  listDrafts() {
    return (this.db.prepare(`SELECT d.id,d.invoice_number,d.invoice_date,d.currency,d.created_at,s.name AS supplier_name,
      d.source_csv FROM procurement_import_drafts d JOIN procurement_suppliers s ON s.id=d.supplier_id
      LEFT JOIN procurement_import_draft_completions c ON c.draft_id=d.id WHERE c.draft_id IS NULL
        AND COALESCE((SELECT event_type FROM procurement_import_draft_lifecycle_events e
          WHERE e.draft_id=d.id ORDER BY e.sequence DESC LIMIT 1),'ACTIVE')!='CANCELLED'
      ORDER BY d.created_at DESC`).all() as any[]).map(row => ({
        id: row.id, purchaseNumber: `CSV-${row.invoice_number}`, orderDate: row.invoice_date, workflowState: 'DRAFT',
        supplierName: row.supplier_name, supplierCurrency: row.currency, totalGrossMinor: null,
        lineCount: parseProcurementImport(row.source_csv).lines.length, receivedLineCount: 0, finalizedAt: null, costDecisionPending: true,
      }));
  }

  completeDraft(draftId: string, policy: ImportCostDecision, actorId: string) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM procurement_import_drafts WHERE id=?').get(draftId) as any;
      if (!row) throw new ProcurementValidationError('PURCHASE_NOT_FOUND', 'Satın alma taslağı bulunamadı.', 404);
      if (this.draftLifecycle(draftId) === 'CANCELLED')
        throw new ProcurementValidationError('DRAFT_NOT_EDITABLE','İptal edilmiş taslak kesinleştirilemez.',409);
      const completed = this.db.prepare('SELECT purchase_order_id,decision_json FROM procurement_import_draft_completions WHERE draft_id=?').get(draftId) as any;
      if (completed) {
        if (completed.decision_json !== JSON.stringify(policy)) throw new ProcurementValidationError('IMPORT_DECISION_CONFLICT', 'Taslak farklı maliyet kararlarıyla tamamlandı.', 409);
        return new ProcurementService(this.db).getPurchase(completed.purchase_order_id)!;
      }
      const parsed = parseProcurementImport(row.source_csv);
      if (this.db.prepare('SELECT 1 FROM purchase_orders WHERE supplier_id=? AND upper(trim(invoice_number))=upper(?)').get(row.supplier_id, row.invoice_number))
        throw new ProcurementValidationError('INVOICE_ALREADY_EXISTS', 'Fatura başka bir satın almada kayıtlı; taslak maliyetlendirilemez.', 409);
      if (!policy || !['INCLUDED','EXCLUDED'].includes(policy.vatMode) || !Number.isInteger(policy.vatRateBps) || policy.vatRateBps < 0 || policy.vatRateBps > 10000 ||
        !['VAT_EXCLUDED_FROM_INVENTORY_COST','VAT_INCLUDED_IN_INVENTORY_COST'].includes(policy.acquisitionCostVatPolicy) ||
        policy.includedCost !== 'NO_SEPARATE_CHARGE' || policy.stockCheck !== 'NO_PRIOR_RECEIPT' || !policy.stockEvidence?.trim())
        fail(parsed.header, 'DECISION REQUIRED: vergi, dahil maliyet ve önceki stok kontrolü açıkça tamamlanmalı.');
      const resolved = JSON.parse(row.resolved_json) as { productIds: Record<string,string>; lineIds: Record<string,string>; aliases: unknown[] };
      for (const source of parsed.lines) {
        const product = this.catalog.getProduct(resolved.productIds[source.product_ref || `sku:${source.sku}`]);
        if (!product || (source.sku && skuKey(product.sku) !== skuKey(source.sku)) || product.base_uom.code !== source.uom || product.product_type === 'assembly' || product.catalog_type === 'KIT')
          fail(source, 'Taslak ürün kimliği/türü/birimi değişmiş; maliyetlendirme güvenle tamamlanamaz.');
      }
      const stagedCosts = this.activeDraftCosts(draftId);
      const decisions = policy.costDecisions || [];
      if (decisions.length !== stagedCosts.length || new Set(decisions.map(item => item.costId)).size !== stagedCosts.length)
        throw new ProcurementValidationError('DRAFT_COST_DECISION_REQUIRED', 'Her ek maliyet için ayrı kesinleştirme kararı gerekli.', 409);
      const acquisitionCosts: PurchaseCostInput[] = stagedCosts.map(cost => {
        const decision = decisions.find(item => item.costId === cost.id);
        if (!decision || !['FREIGHT','CUSTOMS','CUTTING_LABOR','OTHER'].includes(decision.category) ||
          !['SUPPLIER','THIRD_PARTY'].includes(decision.counterparty) || !['INCLUDED','EXCLUDED'].includes(decision.vatMode) ||
          !Number.isInteger(decision.vatRateBps) || decision.vatRateBps < 0 || decision.vatRateBps > 10000)
          throw new ProcurementValidationError('DRAFT_COST_DECISION_REQUIRED', 'Ek maliyetin türü, muhatabı ve vergi kararı gerekli.', 409);
        if (cost.vat_rate_bps != null && (decision.vatMode !== 'EXCLUDED' || decision.vatRateBps !== cost.vat_rate_bps))
          throw new ProcurementValidationError('DRAFT_COST_VAT_CONFLICT','Maliyet ana tutarı KDV hariçtir; kesinleştirmede kayıtlı KDV oranı kullanılmalı.',409);
        return { id: cost.id, category: decision.category, counterparty: decision.counterparty,
          amountMinor: cost.amount_minor, currency: cost.currency, vatMode: decision.vatMode, vatRateBps: decision.vatRateBps,
          expenseType: decision.category === 'FREIGHT' ? 'FREIGHT' : decision.category === 'CUSTOMS' ? 'CUSTOMS_DUTY' : 'OTHER',
          description: cost.title, notes: cost.description || undefined };
      });
      const purchaseId = randomUUID(), importId = randomUUID(), createdAt = new Date().toISOString();
      const purchase = new ProcurementService(this.db).createPurchase({ id: purchaseId, supplierId: row.supplier_id, invoiceNumber: row.invoice_number, invoiceDate: row.invoice_date,
        acquisitionCostVatPolicy: policy.acquisitionCostVatPolicy,
        lines: parsed.lines.map(r => ({ id: resolved.lineIds[r.record_id], productId: resolved.productIds[r.product_ref || `sku:${r.sku}`],
          quantity: r.quantity, quoteBasis: r.uom as any, supplierUnitPriceMinor: Number(decimal(r.unit_price,r,'unit_price',2)),
          currency: r.currency, vatMode: policy.vatMode, vatRateBps: policy.vatRateBps })), acquisitionCosts });
      const approvalHash = canonicalPayloadHash({ sourceHash: parsed.sourceHash, supplierId: row.supplier_id, policy });
      this.db.prepare('INSERT INTO procurement_imports VALUES (?,?,?,?,?,?,?,?,?,?)').run(importId, parsed.sourceHash, parsed.version, row.supplier_id,
        row.invoice_number, purchaseId, approvalHash, JSON.stringify({ aliases: resolved.aliases, policy, previewHash: row.preview_hash, draftId }), actorId, createdAt);
      for (const r of parsed.rows) this.db.prepare('INSERT INTO procurement_import_records VALUES (?,?,?,?,?)').run(importId, r.record_id, r.record_type,
        JSON.stringify(r), resolved.productIds[r.record_id] || resolved.lineIds[r.record_id] || (r.record_type === 'PURCHASE' ? purchaseId : null));
      const cartons = new Map<string, string>();
      for (const p of expandSourcePackages(parsed)) {
        const key = `${p.groupRef}:${p.cartonIndex}`;
        if (!cartons.has(key)) cartons.set(key, randomUUID());
        const line = parsed.lines.find(l => l.record_id === p.lineRef)!;
        const id = randomUUID();
        const productId = resolved.productIds[line.product_ref || `sku:${line.sku}`];
        this.db.prepare('INSERT INTO procurement_package_plan VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, `PKG-${id.toUpperCase()}`, importId, purchaseId, resolved.lineIds[p.lineRef], productId, p.groupRef, p.itemRef, cartons.get(key), p.cartonIndex, `import-plan:${importId}:1`, normalizeBaseQuantity(p.quantity, line.uom as UomCode).baseQuantity, p.mixed ? 1 : 0, p.grossWeightKgEstimate, JSON.stringify(this.catalog.getProduct(productId)));
      }
      this.db.prepare('INSERT INTO procurement_import_draft_completions VALUES (?,?,?,?,?)').run(draftId, purchaseId, JSON.stringify(policy), actorId, createdAt);
      return new ProcurementService(this.db).getPurchase(purchase.id)!;
    }).immediate();
  }

  previewDraftCost(draftId: string, decision: ImportCostDecision, actorId: string) {
    const { expectedPreviewHash: _expected, approvePreview: _approved, ...policy } = decision || {} as ImportCostDecision;
    const draft = this.db.prepare('SELECT source_hash FROM procurement_import_drafts WHERE id=?').get(draftId) as { source_hash: string } | undefined;
    if (!draft) throw new ProcurementValidationError('PURCHASE_NOT_FOUND','Satın alma taslağı bulunamadı.',404);
    try {
      this.db.transaction(() => {
        const costs = this.activeDraftCosts(draftId);
        if (costs.length && policy.approveProportionalAllocation !== true)
          throw new ProcurementValidationError('ALLOCATION_APPROVAL_REQUIRED','Ek maliyet dağıtım onayı gerekli.',409);
        const purchase = this.completeDraft(draftId,policy,actorId);
        const engine = new ProcurementService(this.db).previewAcquisitionCosts(purchase.id,{
          allocations: costs.map(cost => ({ componentId:cost.id,mode:'ACCEPT_SUGGESTION' as const })),
        });
        const snapshots = {
          lines: purchase.lines.map((line: any) => ({ lineId:line.id,observationId:line.fx.observationId,numerator:line.fx.numerator,denominator:line.fx.denominator })),
          costs: purchase.acquisitionCosts.map((cost: any) => ({ costId:cost.id,observationId:cost.fx.observationId,numerator:cost.fx.numerator,denominator:cost.fx.denominator })),
        };
        const rate = snapshots.lines[0];
        const usdEquivalent = (tryMinor: number) => rate && rate.numerator > 0 && rate.denominator > 0
          ? roundRatio(tryMinor,rate.denominator,rate.numerator) : null;
        const result = { readOnly:true,formulaVersion:engine.formulaVersion,lines:engine.lines,totals:engine.totals,
          usdTotals: { merchandiseUsdMinor:usdEquivalent(engine.totals.merchandiseTryMinor),
            additionalUsdMinor:usdEquivalent(engine.totals.allocatedExpensesTryMinor),
            estimatedTotalUsdMinor:usdEquivalent(engine.totals.landedCostTryMinor),fxObservationId:rate?.observationId ?? null },
          warnings:engine.warnings,fxSnapshots:snapshots };
        throw new PreviewRollback({ ...result,previewHash:canonicalPayloadHash({ draftId,sourceHash:draft.source_hash,
          costs:costs.map(cost => ({ id:cost.id,version:cost.version })),policy,result }) });
      }).immediate();
    } catch (error) { if (error instanceof PreviewRollback) return error.result; throw error; }
  }

  finalizeDraft(draftId: string, decision: ImportCostDecision, actorId: string) {
    return this.db.transaction(() => {
      if (decision?.approvePreview !== true || !decision.expectedPreviewHash)
        throw new ProcurementValidationError('COST_PREVIEW_APPROVAL_REQUIRED','FINAL maliyet önizlemesi açıkça onaylanmalı.',409);
      const preview = this.previewDraftCost(draftId,decision,actorId);
      if (preview.previewHash !== decision.expectedPreviewHash)
        throw new ProcurementValidationError('COST_PREVIEW_STALE','Maliyet veya kur değişti; önizlemeyi yenileyin.',409);
      if (preview.warnings.length)
        throw new ProcurementValidationError('COST_PREVIEW_UNALLOCATED','Dağıtılmamış gider varken FINAL maliyet kesinleştirilemez.',409);
      const { expectedPreviewHash: _expected, approvePreview: _approved, ...policy } = decision;
      const costs = this.activeDraftCosts(draftId);
      if (costs.length && policy.approveProportionalAllocation !== true)
        throw new ProcurementValidationError('ALLOCATION_APPROVAL_REQUIRED', 'Ek maliyetleri alış bedeli oranında dağıtma onayı gerekli.', 409);
      const purchase = this.completeDraft(draftId,policy,actorId);
      if (purchase.status === 'APPROVED') return purchase;
      return new ProcurementService(this.db).finalizeAcquisitionCosts(purchase.id, {
        allocations: costs.map(cost => ({ componentId: cost.id, mode: 'ACCEPT_SUGGESTION' as const })),
      });
    }).immediate();
  }
}
