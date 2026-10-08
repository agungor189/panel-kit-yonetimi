import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CatalogService, type CatalogProductInput } from '../catalog/catalogService.js';
import { canonicalPayloadHash } from '../commands/commandFoundation.js';
import { normalizeBaseQuantity, type UomCode } from '../catalog/uom.js';
import { ProcurementService, ProcurementValidationError, type PurchaseInput } from './procurementService.js';
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
};

// These five identities were explicitly approved for source rows without a MasterInfo SKU.
const APPROVED_MISSING_SKUS = new Map([
  ['PRODUCT-X001', 'PCI-R200-4W'], ['PRODUCT-X002', 'PCI-R200-5W'],
  ['PRODUCT-X003', 'PCI-R150-SVF'], ['PRODUCT-X004', 'FAST-M8X10'], ['PRODUCT-X005', 'FAST-M8X16'],
]);
const skuKey = (sku: string) => sku.trim().toLocaleUpperCase('en-US');
type ResolvedProduct = {
  ref: string; row: number; source: ImportRow; sku: string; current: ReturnType<CatalogService['getProduct']>;
  proposed: CatalogProductInput; action: 'KEEP' | 'CREATE'; bomVersion: string | null;
};

export class ProcurementImportService {
  private catalog: CatalogService;
  constructor(private db: Database.Database) { this.catalog = new CatalogService(db); }

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
    const existingAliases = new Map((this.db.prepare('SELECT alias,product_id FROM catalog_supplier_aliases WHERE supplier_id=?').all(input.supplierId) as Array<{ alias: string; product_id: string }>).map(a => [skuKey(a.alias), a.product_id]));
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
      const proposed: CatalogProductInput = { sku, title: r.name_tr || r.name_en || sku, catalog_type: 'product', base_uom_code: (r.uom || 'piece') as UomCode,
        product_type: r.product_type as CatalogProductInput['product_type'], name_tr: r.name_tr || undefined, name_en: r.name_en || undefined,
        material: r.material || undefined, size: r.size || undefined, profile_type: r.profile_type || undefined, supplier_code: r.supplier_code || undefined,
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
      offerAlias(product.source.source_supplier_code, product.ref, product.source);
    }
    for (const row of parsed.rows) if (row.record_type !== 'BOM' && row.source_supplier_code) {
      const ref = row.product_ref || skuToRef.get(skuKey(row.sku));
      if (ref) offerAlias(row.source_supplier_code, ref, row);
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
      existingDraftId: identity?.id || null, packagePreview: expandSourcePackages(parsed) };
  }

  apply(input: ImportRequest, actorId: string) {
    return this.db.transaction(() => {
      if ('policy' in input) throw new ProcurementValidationError('IMPORT_COST_DECISION_FORBIDDEN', 'Maliyet kararları CSV importunda alınmaz.', 400);
      const parsed = parseProcurementImport(input.csv);
      const existing = this.db.prepare('SELECT * FROM procurement_import_drafts WHERE source_hash=? OR (supplier_id=? AND invoice_number=?)').get(parsed.sourceHash, input.supplierId, parsed.header.invoice_number.trim()) as any;
      if (existing) {
        if (existing.source_hash !== parsed.sourceHash || existing.supplier_id !== input.supplierId) throw new ProcurementValidationError('IMPORT_IDENTITY_CONFLICT', 'Bu kaynak/fatura farklı içerikle zaten kayıtlı.', 409);
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

  getDraft(id: string): any | null {
    const row = this.db.prepare(`SELECT d.*,s.name AS supplier_name,c.purchase_order_id FROM procurement_import_drafts d
      JOIN procurement_suppliers s ON s.id=d.supplier_id
      LEFT JOIN procurement_import_draft_completions c ON c.draft_id=d.id WHERE d.id=?`).get(id) as any;
    if (!row) return null;
    if (row.purchase_order_id) return new ProcurementService(this.db).getPurchase(row.purchase_order_id);
    const parsed = parseProcurementImport(row.source_csv);
    const resolved = JSON.parse(row.resolved_json) as { productIds: Record<string,string>; lineIds: Record<string,string> };
    const packages = expandSourcePackages(parsed);
    return { id: row.id, purchaseNumber: `CSV-${row.invoice_number}`, orderDate: row.invoice_date,
      workflowState: 'DRAFT', status: 'INCOMPLETE', costDecisionPending: true,
      supplier: { id: row.supplier_id, name: row.supplier_name }, supplierCurrency: row.currency,
      vatPolicy: null, totalNetMinor: null, totalVatMinor: null, totalGrossMinor: null, paidMinor: 0,
      outstandingMinor: null, paymentStatus: 'UNPAID', acquisitionCosts: [], lots: [], documents: [], sourcePacking: [...parsed.groups, ...parsed.items],
      lines: parsed.lines.map(r => {
        const productId = resolved.productIds[r.product_ref || `sku:${r.sku}`];
        const product = this.catalog.getProduct(productId)!;
        const planned = packages.filter(p => p.lineRef === r.record_id);
        const distribution = new Map<number,number>();
        for (const p of planned) {
          const quantity = normalizeBaseQuantity(p.quantity, r.uom as UomCode).baseQuantity;
          distribution.set(quantity, (distribution.get(quantity) || 0) + 1);
        }
        return { id: resolved.lineIds[r.record_id], productId,
          product: { sku: product.sku, title: product.title, supplierCode: product.supplier_code, nameTr: product.name_tr, nameEn: product.name_en,
            size: product.size, material: product.material, profileType: product.tube_type_code, productType: product.product_type },
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
      const purchaseId = randomUUID(), importId = randomUUID(), createdAt = new Date().toISOString();
      const purchase = new ProcurementService(this.db).createPurchase({ id: purchaseId, supplierId: row.supplier_id, invoiceNumber: row.invoice_number, invoiceDate: row.invoice_date,
        acquisitionCostVatPolicy: policy.acquisitionCostVatPolicy,
        lines: parsed.lines.map(r => ({ id: resolved.lineIds[r.record_id], productId: resolved.productIds[r.product_ref || `sku:${r.sku}`],
          quantity: r.quantity, quoteBasis: r.uom as any, supplierUnitPriceMinor: Number(decimal(r.unit_price,r,'unit_price',2)),
          currency: r.currency, vatMode: policy.vatMode, vatRateBps: policy.vatRateBps })), acquisitionCosts: [] });
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
}
