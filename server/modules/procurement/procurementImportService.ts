import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CatalogService, type CatalogProductInput } from '../catalog/catalogService.js';
import { canonicalPayloadHash } from '../commands/commandFoundation.js';
import { normalizeBaseQuantity, type UomCode } from '../catalog/uom.js';
import { ProcurementService, ProcurementValidationError, type PurchaseInput } from './procurementService.js';
import { parseProcurementImport, expandSourcePackages, decimal, fail, type ImportRow } from './procurementImport.js';

type Choice = { action: 'KEEP' | 'UPDATE' | 'CREATE'; productId?: string; fields?: CatalogProductInput };
export type ImportRequest = {
  csv: string; supplierId: string; choices?: Record<string, Choice>; confirmations?: string[];
  expectedPreviewHash?: string;
  policy?: { vatMode: 'INCLUDED' | 'EXCLUDED'; vatRateBps: number; acquisitionCostVatPolicy: PurchaseInput['acquisitionCostVatPolicy']; includedCost: 'NO_SEPARATE_CHARGE'; stockCheck: 'NO_PRIOR_RECEIPT'; stockEvidence: string; expenseTypes: Record<string, any> };
};

export class ProcurementImportService {
  private catalog: CatalogService;
  constructor(private db: Database.Database) { this.catalog = new CatalogService(db); }

  preview(input: ImportRequest) {
    const parsed = parseProcurementImport(input.csv);
    const supplier = this.db.prepare('SELECT id,name FROM procurement_suppliers WHERE id=? AND active=1').get(input.supplierId) as any;
    if (!supplier) fail(parsed.header, 'Önce kayıtlı tedarikçiyi seçin.');
    const definitions = [...parsed.products];
    for (const line of parsed.lines.filter(r => !r.product_ref)) if (!definitions.some(r => r.record_id === `sku:${line.sku}`)) definitions.push({ ...line, record_id: `sku:${line.sku}` } as ImportRow);
    const required = new Map<string, { key: string; row: number; sku: string; message: string }>();
    const review = (r: ImportRow, code: string, message: string) => required.set(`${r.record_id}:${code}`, { key: `${r.record_id}:${code}`, row: r.row, sku: r.sku || r.suggested_sku || '', message });
    if (supplier.name.trim().toLocaleUpperCase('en-US') !== parsed.header.supplier_name.trim().toLocaleUpperCase('en-US')) review(parsed.header, 'SUPPLIER_CONFIRM', `Kaynak tedarikçi ${parsed.header.supplier_name} → kayıtlı ${supplier.name} eşleştirmesini onaylayın.`);
    for (const r of parsed.rows) {
      for (const code of (r.review_codes || '').split(';').filter(Boolean)) review(r, code, `${code} · ${r.notes || r.name_en || r.record_id}`);
      if (r.record_type === 'LINE' && r.pricing_basis === 'INCLUDED_IN_PRICE') review(r, 'INCLUDED_COST_POLICY_CONFIRM', 'Fiyata dahil içerik: ayrı bedel eklenmeyecek; LC dağıtımı ayrıca onaylanır.');
      if (r.meta.quantity_derived_from || r.meta.quantity_derived || Object.hasOwn(r.meta, 'original_total_qty_cell_value') && String(r.meta.original_total_qty_cell_value ?? '').trim() === '') review(r, 'DERIVED_QUANTITY_CONFIRM', 'Kaynakta boş toplam miktarın koli içeriğinden türetilmesini onaylayın.');
    }
    review(parsed.header, 'EXISTING_STOCK_CHECK', 'Bu fatura/parti daha önce fiziksel kabul veya başlangıç stokuna alınmadı; kanıt açıklaması gerekli.');
    for (const r of parsed.expenses) review(r, 'EXPENSE_POLICY_CONFIRM', `${r.name_en}: ${r.amount} ${r.currency}; gider türünü ve vergi politikasını seçin.`);
    const products = definitions.map(r => {
      const choice = input.choices?.[r.record_id];
      const exact = r.sku ? this.db.prepare('SELECT id FROM products WHERE upper(sku)=upper(?)').get(r.sku) as any : null;
      const current = this.catalog.getProduct(choice?.productId || exact?.id || '') || null;
      if (choice?.action === 'CREATE' && choice.fields?.sku && this.db.prepare('SELECT 1 FROM products WHERE upper(sku)=upper(?)').get(choice.fields.sku.trim())) fail(r, 'Önerilen yeni SKU katalogda zaten kullanılıyor.');
      if (r.sku && current && current.sku !== r.sku) fail(r, 'SKU farklı ürüne eşleştirilemez.');
      if (choice?.action === 'CREATE' && current) fail(r, 'Yeni SKU mevcut katalogla çakışıyor.');
      if (!current || !r.sku) review(r, 'NEW_PRODUCT_CONFIRM', 'Mevcut ürüne eşleştirin veya yeni ürün alanlarını açıkça onaylayın.');
      const proposed: any = JSON.parse(JSON.stringify({ sku: r.sku || r.suggested_sku || '', title: r.name_tr || r.name_en || r.sku || '', catalog_type: 'product', base_uom_code: r.uom || 'piece',
        product_type: r.product_type, name_tr: r.name_tr || undefined, name_en: r.name_en || undefined, material: r.material || undefined, size: r.size || undefined, profile_type: r.profile_type || undefined, supplier_code: r.supplier_code || undefined,
        mass_grams: r.unit_weight_g && Number.isInteger(Number(r.unit_weight_g)) ? Number(r.unit_weight_g) : undefined }));
      // Fractional source measurements remain in source records, never silently rounded into integer catalog mass.
      if (r.unit_weight_g && !Number.isInteger(Number(r.unit_weight_g))) review(r, 'CATALOG_WEIGHT_CONFIRM', `Kaynak ağırlığı ${r.unit_weight_g} g; tamsayı katalog ağırlığını ayrıca seçebilir veya katalog alanını boş tutabilirsiniz.`);
      for (const item of parsed.rows.filter(x => x.record_type !== 'BOM' && (x.product_ref === r.record_id || (!x.product_ref && x.sku === r.sku)))) {
        const alias = item.source_supplier_code;
        if (!alias) continue;
        const bound = this.catalog.supplierAlias(input.supplierId, alias);
        if (bound && current && bound !== current.id) fail(item, 'Tedarikçi alias başka ürüne bağlı.');
        if (!bound && alias !== (current?.supplier_code || r.supplier_code)) review(item, 'ALIAS_CONFIRM', `${alias} → ${current?.sku || proposed.sku} tedarikçi eşleşmesini onaylayın.`);
      }
      return { ref: r.record_id, row: r.row, source: r, current, proposed, choice: choice || null, bomVersion: current ? this.catalog.readBom(current.id).version : null };
    });
    const bom = [...new Set(parsed.bom.map(r => r.parent_ref))].map(parentRef => {
      const p = products.find(p => p.ref === parentRef)!;
      const current = p.current ? this.catalog.readBom(p.current.id) : { lines: [], version: this.catalog.readBom('').version };
      const incoming = parsed.bom.filter(r => r.parent_ref === parentRef).map(r => ({ componentRef: r.component_ref, quantity: Number(r.quantity_per_unit) }));
      review(parsed.bom.find(r => r.parent_ref === parentRef)!, 'BOM_DIFF_CONFIRM', 'Bu assembly reçetesinin mevcut/önerilen farkını onaylayın. Diğer reçeteler korunur.');
      return { parentRef, current, incoming };
    });
    const requirements = [...required.values()];
    const identity = this.db.prepare('SELECT purchase_order_id,source_hash FROM procurement_imports WHERE source_hash=? OR (supplier_id=? AND invoice_number=?)').get(parsed.sourceHash, input.supplierId, parsed.header.invoice_number.trim()) as any;
    const previewHash = canonicalPayloadHash(JSON.parse(JSON.stringify({ source: parsed.sourceHash, supplierId: supplier.id, products, bom, policy: input.policy || null, requirements })));
    return { parsed, supplier, products, bom, requirements, previewHash, existingPurchaseId: identity?.purchase_order_id || null,
      unresolved: requirements.filter(r => !input.confirmations?.includes(r.key)), packagePreview: expandSourcePackages(parsed) };
  }

  apply(input: ImportRequest, actorId: string) {
    return this.db.transaction(() => {
      const parsed = parseProcurementImport(input.csv);
      const approvalHash = canonicalPayloadHash({ sourceHash: parsed.sourceHash, supplierId: input.supplierId, choices: input.choices || {}, confirmations: [...(input.confirmations || [])].sort(), policy: input.policy || null });
      const existing = this.db.prepare('SELECT * FROM procurement_imports WHERE source_hash=? OR (supplier_id=? AND invoice_number=?)').get(parsed.sourceHash, input.supplierId, parsed.header.invoice_number.trim()) as any;
      if (existing) {
        if (existing.approval_hash !== approvalHash) throw new ProcurementValidationError('IMPORT_IDENTITY_CONFLICT', 'Bu kaynak/fatura farklı onaylarla zaten kayıtlı.', 409);
        return new ProcurementService(this.db).getPurchase(existing.purchase_order_id)!;
      }
      // All purchases, including older/manual ones, participate in invoice duplication protection.
      if (this.db.prepare('SELECT 1 FROM purchase_orders WHERE supplier_id=? AND upper(trim(invoice_number))=upper(?)').get(input.supplierId, parsed.header.invoice_number.trim())) throw new ProcurementValidationError('INVOICE_ALREADY_EXISTS', 'Fatura daha önce kaydedilmiş; ikinci taslak veya stok girişi engellendi.', 409);
      const preview = this.preview(input);
      if (preview.previewHash !== input.expectedPreviewHash) throw new ProcurementValidationError('IMPORT_PREVIEW_STALE', 'Katalog, BOM veya kararlar değişti. Önizlemeyi yenileyin.', 409);
      if (preview.unresolved.length) fail(parsed.header, 'Çözülmemiş kaynak onayları var.');
      const policy = input.policy;
      if (!policy || !['INCLUDED','EXCLUDED'].includes(policy.vatMode) || !Number.isInteger(policy.vatRateBps) || policy.vatRateBps < 0 || policy.vatRateBps > 10000 || !['VAT_EXCLUDED_FROM_INVENTORY_COST','VAT_INCLUDED_IN_INVENTORY_COST'].includes(policy.acquisitionCostVatPolicy) || policy.stockCheck !== 'NO_PRIOR_RECEIPT' || !policy.stockEvidence?.trim() || parsed.lines.some(r => r.pricing_basis === 'INCLUDED_IN_PRICE') && policy.includedCost !== 'NO_SEPARATE_CHARGE') fail(parsed.header, 'DECISION REQUIRED: vergi, dahil maliyet ve önceki stok kontrolü açıkça tamamlanmalı.');
      const importId = randomUUID(), purchaseId = randomUUID(), createdAt = new Date().toISOString();
      const ids = new Map<string, string>();
      for (const p of preview.products) {
        const choice = input.choices?.[p.ref];
        if (!choice || !['KEEP','UPDATE','CREATE'].includes(choice.action)) fail(p.source, 'Ürün eşleştirme/değişiklik kararı gerekli.');
        let product = p.current;
        if (choice.action === 'CREATE') {
          if (p.source.record_type !== 'PRODUCT') fail(p.source, 'PRODUCT olmadan yeni kart oluşturulamaz.');
          if (!choice.fields) fail(p.source, 'Yeni ürün alanlarının onayı gerekli.');
          const { id: _id, ...fields } = choice.fields!;
          if (p.source.sku && fields.sku !== p.source.sku) fail(p.source, 'Kaynak SKU değiştirilemez.');
          product = this.catalog.createProduct({ ...fields, status: 'Passive', is_sellable: false }, fields.product_type === 'assembly' ? {} : { activationProvenance: 'PROCUREMENT_CSV_FIRST_RECEIPT' });
        } else if (!product) fail(p.source, 'Kayıtlı SKU bulunamadı. PRODUCT olmadan yeni kart yaratılamaz.');
        else if (choice.action === 'UPDATE') {
          if (!choice.fields || choice.fields.sku !== product.sku) fail(p.source, 'Onaylı güncelleme alanları/SKU geçersiz.');
          product = this.catalog.updateProduct(product.id, product.catalog_version, { ...choice.fields!, status: product.status, is_sellable: product.is_sellable });
        }
        ids.set(p.ref, product!.id);
        for (const r of parsed.rows.filter(r => r.record_type !== 'BOM' && (r.product_ref === p.ref || (!r.product_ref && r.sku === product!.sku)))) if (r.source_supplier_code) this.catalog.confirmSupplierAlias(input.supplierId, r.source_supplier_code, product!.id, `${importId}:${r.record_id}`);
      }
      for (const b of preview.bom) this.catalog.replaceBom(ids.get(b.parentRef)!, b.current.version, b.incoming.map(c => ({ componentId: ids.get(c.componentRef)!, quantity: c.quantity })));
      const lineIds = new Map(parsed.lines.map(r => [r.record_id, randomUUID()]));
      const expenseIds = new Map(parsed.expenses.map(r => [r.record_id, randomUUID()]));
      const purchase = new ProcurementService(this.db).createPurchase({ id: purchaseId, supplierId: input.supplierId, invoiceNumber: parsed.header.invoice_number.trim(), invoiceDate: parsed.header.invoice_date,
        acquisitionCostVatPolicy: policy!.acquisitionCostVatPolicy,
        lines: parsed.lines.map(r => {
          const productId = ids.get(r.product_ref || `sku:${r.sku}`)!;
          const product = this.catalog.getProduct(productId)!;
          if (product.product_type === 'assembly' || product.catalog_type === 'KIT') fail(r, 'Assembly/KIT fiziksel kabul edilemez.');
          if (!r.uom || r.uom !== product.base_uom.code) fail(r, 'Kaynak ve katalog UOM uyuşmuyor.');
          return { id: lineIds.get(r.record_id), productId, quantity: r.quantity, quoteBasis: r.uom as any, supplierUnitPriceMinor: Number(decimal(r.unit_price, r, 'unit_price', 2)), currency: r.currency, vatMode: policy!.vatMode, vatRateBps: policy!.vatRateBps };
        }),
        acquisitionCosts: parsed.expenses.map(r => {
          const expenseType = policy!.expenseTypes?.[r.record_id];
          if (!['FREIGHT','CUSTOMS_DUTY','ADDITIONAL_TAX','CUSTOMS_BROKER','WAREHOUSE_PORT','DOMESTIC_FREIGHT','INSURANCE','BANK_TRANSFER','OTHER'].includes(expenseType)) fail(r, 'DECISION REQUIRED: gider türü seçilmeli.');
          return { id: expenseIds.get(r.record_id), category: ['FREIGHT','DOMESTIC_FREIGHT'].includes(expenseType) ? 'FREIGHT' : ['CUSTOMS_DUTY','ADDITIONAL_TAX'].includes(expenseType) ? 'CUSTOMS' : 'OTHER', expenseType, description: r.name_en, amountMinor: Number(decimal(r.amount, r, 'amount', 2)), currency: r.currency, vatMode: policy!.vatMode, vatRateBps: policy!.vatRateBps };
        }) });
      this.db.prepare('INSERT INTO procurement_imports VALUES (?,?,?,?,?,?,?,?,?,?)').run(importId, parsed.sourceHash, parsed.version, input.supplierId, parsed.header.invoice_number.trim(), purchaseId, approvalHash, JSON.stringify({ choices: input.choices, confirmations: input.confirmations, policy, previewHash: preview.previewHash }), actorId, createdAt);
      for (const r of parsed.rows) this.db.prepare('INSERT INTO procurement_import_records VALUES (?,?,?,?,?)').run(importId, r.record_id, r.record_type, JSON.stringify(r), ids.get(r.record_id) || lineIds.get(r.record_id) || expenseIds.get(r.record_id) || (r.record_type === 'PURCHASE' ? purchaseId : null));
      const cartons = new Map<string, string>();
      for (const p of preview.packagePreview) {
        const key = `${p.groupRef}:${p.cartonIndex}`;
        if (!cartons.has(key)) cartons.set(key, randomUUID());
        const line = parsed.lines.find(l => l.record_id === p.lineRef)!;
        const id = randomUUID();
        const productId = ids.get(line.product_ref || `sku:${line.sku}`)!;
        this.db.prepare('INSERT INTO procurement_package_plan VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, `PKG-${id.toUpperCase()}`, importId, purchaseId, lineIds.get(p.lineRef), productId, p.groupRef, p.itemRef, cartons.get(key), p.cartonIndex, `import-plan:${importId}:1`, normalizeBaseQuantity(p.quantity, line.uom as UomCode).baseQuantity, p.mixed ? 1 : 0, p.grossWeightKgEstimate, JSON.stringify(this.catalog.getProduct(productId)));
      }
      return new ProcurementService(this.db).getPurchase(purchase.id)!;
    }).immediate();
  }
}
