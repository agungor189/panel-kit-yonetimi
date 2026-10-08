import { createHash } from 'node:crypto';
import Papa from 'papaparse';

export const IMPORT_VERSION = 'dsdst.procurement.import.v1';
export type ImportRow = Record<string, string> & { row: any; meta: any };
export class ImportValidationError extends Error {
  readonly statusCode = 400;
  readonly code = 'PROCUREMENT_IMPORT_INVALID';
}
export const fail = (r: Partial<ImportRow>, message: string): never => {
  throw new ImportValidationError(`Satır ${r.row ?? '?'} · ${r.record_id || '?'} · SKU ${r.sku || r.suggested_sku || '—'}: ${message}`);
};
// Source decimals remain text. Arithmetic uses fixed precision, never binary money.
export function decimal(value: string, r: Partial<ImportRow>, field: string, scale = 6): bigint {
  if (!/^\d+(\.\d+)?$/.test(value || '') || (value.split('.')[1]?.length || 0) > scale) fail(r, `${field}: geçerli ve açık ondalık değer gerekli.`);
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail(r, `${field}: güvenli hassasiyet aşıldı.`);
  return result;
}
const textDecimal = (value: bigint, scale = 6) => {
  const s = value.toString().padStart(scale + 1, '0');
  return scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}`.replace(/\.?0+$/, '') : s;
};
export function parseProcurementImport(csv: string) {
  if (typeof csv !== 'string' || csv.length > 4_000_000) fail({}, 'CSV eksik veya çok büyük.');
  const result = Papa.parse(csv.replace(/^\ufeff/, ''), { header: true, skipEmptyLines: 'greedy', dynamicTyping: false });
  if (result.errors.length || result.meta.renamedHeaders && Object.keys(result.meta.renamedHeaders).length) fail({}, 'CSV sütunları veya tırnak kaçışları geçersiz.');
  const rows: ImportRow[] = result.data.map((raw: any, index: number) => {
    const r: any = { ...raw, row: index + 2 };
    if (Object.values(raw).some(v => typeof v !== 'string')) fail(r, 'Hücreler metin olmalı.');
    if (r.schema_version !== IMPORT_VERSION) fail(r, 'Desteklenmeyen schema_version.');
    try { r.meta = JSON.parse(r.meta_json || '{}'); } catch { fail(r, 'meta_json geçersiz JSON.'); }
    if (!r.meta || Array.isArray(r.meta) || typeof r.meta !== 'object') fail(r, 'meta_json nesne olmalı.');
    return r;
  });
  if (!rows.length || rows.length > 10000) fail({}, 'Kayıt sayısı geçersiz.');
  const byId = new Map<string, ImportRow>();
  const types = ['PURCHASE', 'PRODUCT', 'LINE', 'EXPENSE', 'PACKAGE_GROUP', 'PACKAGE_ITEM', 'BOM'];
  for (const r of rows) {
    if (!r.record_id || byId.has(r.record_id)) fail(r, 'record_id eksik veya yinelenmiş.');
    if (!types.includes(r.record_type)) fail(r, 'record_type bilinmiyor.');
    byId.set(r.record_id, r);
  }
  const ofType = (type: string) => rows.filter(r => r.record_type === type);
  const headers = ofType('PURCHASE');
  if (headers.length !== 1) fail({}, 'Tam bir PURCHASE gerekli.');
  const header = headers[0];
  if (!header.invoice_number || !header.supplier_name || !/^\d{4}-\d{2}-\d{2}$/.test(header.invoice_date) || !/^[A-Z]{3}$/.test(header.currency)) fail(header, 'Fatura kimliği, tarih, tedarikçi ve para birimi gerekli.');
  const ref = (r: ImportRow, field: string, type: string) => {
    const target = byId.get(r[field]);
    if (!target || target.record_type !== type) fail(r, `${field} geçerli ${type} kaydına bağlanmalı.`);
    return target!;
  };
  const productKey = (r: ImportRow) => r.product_ref || `sku:${r.sku}`;
  for (const r of rows) {
    if (['PRODUCT', 'LINE', 'EXPENSE', 'PACKAGE_GROUP'].includes(r.record_type) && ref(r, 'parent_ref', 'PURCHASE') !== header) fail(r, 'Üst satın alma uyuşmuyor.');
    if (['LINE', 'PACKAGE_ITEM', 'BOM'].includes(r.record_type)) {
      if (r.product_ref) {
        const p = ref(r, 'product_ref', 'PRODUCT');
        if (r.sku && p.sku && r.sku !== p.sku) fail(r, 'product_ref ile SKU çelişiyor.');
        if (r.record_type === 'LINE' && p.product_type === 'assembly') fail(r, 'Assembly fiziksel satın alma satırı olamaz.');
      } else if (!r.sku) fail(r, 'product_ref veya kayıtlı SKU gerekli.');
    }
    if (r.record_type === 'LINE') {
      const quantity = decimal(r.quantity, r, 'quantity');
      if (quantity === 0n) fail(r, 'Miktar pozitif olmalı.');
      const unit = decimal(r.unit_price, r, 'unit_price', 2);
      const amount = decimal(r.amount, r, 'amount', 2);
      if ((unit * quantity + 500000n) / 1000000n !== amount) fail(r, 'Fatura miktar × birim fiyat ve tutarı uyuşmuyor.');
      if (r.currency !== header.currency || !['BILLED', 'INCLUDED_IN_PRICE'].includes(r.pricing_basis)) fail(r, 'Para birimi/fiyat temeli uyuşmuyor.');
      if (unit === 0n && r.pricing_basis === 'BILLED') fail(r, 'Sıfır bedel için açık dahil-maliyet politikası gerekli.');
    }
    if (r.record_type === 'EXPENSE') { decimal(r.amount, r, 'amount', 2); if (r.currency !== header.currency) fail(r, 'Gider para birimi uyuşmuyor.'); }
    if (r.record_type === 'PACKAGE_GROUP') {
      const count = decimal(r.package_count, r, 'package_count', 0);
      if (count < 1n || count > 10000n) fail(r, 'Koli sayısı geçersiz.');
      for (const f of ['net_weight_kg', 'gross_weight_kg']) if (r[f]) decimal(r[f], r, f);
    }
    if (r.record_type === 'PACKAGE_ITEM') {
      const group = ref(r, 'parent_ref', 'PACKAGE_GROUP');
      const line = ref(r, 'purchase_line_ref', 'LINE');
      if (productKey(r) !== productKey(line) || (r.sku && line.sku && r.sku !== line.sku)) fail(r, 'Paket yanlış alış satırına bağlı.');
      if (decimal(r.quantity, r, 'quantity') !== decimal(r.units_per_package, r, 'units_per_package') * BigInt(group.package_count)) fail(r, 'Koli dağılımı içerik toplamına eşit değil.');
    }
    if (r.record_type === 'BOM') {
      const parent = ref(r, 'parent_ref', 'PRODUCT');
      const component = ref(r, 'component_ref', 'PRODUCT');
      if (r.parent_ref !== r.product_ref || parent.product_type !== 'assembly' || component.product_type !== 'component' || parent === component) fail(r, 'BOM assembly → component olmalı.');
      if (r.meta.component_sku && component.sku && r.meta.component_sku !== component.sku) fail(r, 'BOM component SKU çelişkisi.');
      if (decimal(r.quantity_per_unit, r, 'quantity_per_unit', 0) <= 0n) fail(r, 'BOM miktarı pozitif tam sayı olmalı.');
    }
  }
  const lines = ofType('LINE'), groups = ofType('PACKAGE_GROUP'), items = ofType('PACKAGE_ITEM');
  for (const line of lines) {
    const packed = items.filter(i => i.purchase_line_ref === line.record_id).reduce((s, i) => s + decimal(i.quantity, i, 'quantity'), 0n);
    if (packed !== decimal(line.quantity, line, 'quantity')) fail(line, 'Paket içerikleri alış miktarını karşılamıyor.');
  }
  for (const group of groups) {
    const content = items.filter(i => i.parent_ref === group.record_id);
    if (!content.length || Boolean(group.meta.mixed) !== (content.length > 1) || content.length > 1 && group.package_count !== '1') fail(group, 'Karışık koli tek kaynak koli ve açık mixed işareti gerektirir.');
  }
  const sum = (rs: ImportRow[], field: string, scale = 6) => rs.reduce((s, r) => s + decimal(r[field], r, field, scale), 0n);
  const summary = { records: rows.length, sourceCartons: Number(sum(groups, 'package_count', 0)), warehousePackages: groups.reduce((s, g) => s + Number(g.package_count) * items.filter(i => i.parent_ref === g.record_id).length, 0),
    sourceInvoiceTotalMinor: header.meta.invoice_total_usd === undefined ? null : Number(decimal(String(header.meta.invoice_total_usd), header, 'invoice_total_usd', 2)),
    goodsAmountMinor: Number(sum(lines, 'amount', 2)), expenseAmountMinor: Number(sum(ofType('EXPENSE'), 'amount', 2)),
    netWeightKg: groups.every(g => g.net_weight_kg) ? textDecimal(sum(groups, 'net_weight_kg')) : null,
    grossWeightKg: groups.every(g => g.gross_weight_kg) ? textDecimal(sum(groups, 'gross_weight_kg')) : null };
  if (summary.warehousePackages > 20000) fail(header, 'Paket sınırı aşıldı.');
  for (const [key, actual] of Object.entries({ expected_cartons: summary.sourceCartons, goods_amount_usd: summary.goodsAmountMinor, invoice_expenses_usd: summary.expenseAmountMinor, invoice_total_usd: summary.goodsAmountMinor + summary.expenseAmountMinor })) {
    if (header.meta[key] !== undefined && (key.endsWith('_usd') ? Number(decimal(String(header.meta[key]), header, key, 2)) : Number(header.meta[key])) !== actual) fail(header, `${key} kontrol toplamı uyuşmuyor.`);
  }
  return { version: IMPORT_VERSION, sourceHash: createHash('sha256').update(csv).digest('hex'), rows, header, products: ofType('PRODUCT'), lines, expenses: ofType('EXPENSE'), groups, items, bom: ofType('BOM'), summary };
}
export type ParsedImport = ReturnType<typeof parseProcurementImport>;
export function expandSourcePackages(parsed: ParsedImport) {
  return parsed.groups.flatMap(group => Array.from({ length: Number(group.package_count) }, (_, index) => parsed.items.filter(i => i.parent_ref === group.record_id).map(item => ({
    groupRef: group.record_id, cartonIndex: index + 1, itemRef: item.record_id, lineRef: item.purchase_line_ref,
    quantity: item.units_per_package, mixed: Boolean(group.meta.mixed),
    grossWeightKgEstimate: group.meta.mixed || !group.gross_weight_kg ? null : Number(group.gross_weight_kg) / Number(group.package_count),
  })))).flat();
}
