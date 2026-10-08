import { useState } from 'react';
import { api } from '../../lib/api';
import { Button, Card } from '../ui';

export function ProcurementImport({ csv, supplierId, onCreated }: { csv: string; supplierId: string; onCreated: (id: string) => void }) {
  const [preview, setPreview] = useState<any>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState<{ payload: string; operationId: string } | null>(null);
  const payload = () => ({ csv, supplierId });
  const inspect = async () => {
    setBusy(true); setError(''); setReviewed(false); setAttempt(null);
    try { const result = await api.post('/procurement/v1/imports/preview', payload()); setPreview(result.data); setReviewed(true); }
    catch (e: any) { setPreview(null); setError(e.message); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview || preview.blockingErrors.length) return;
    setBusy(true); setError('');
    const body = { ...payload(), expectedPreviewHash: preview.previewHash };
    const serialized = JSON.stringify(body);
    const operationId = attempt?.payload === serialized ? attempt.operationId : `purchase-import-${crypto.randomUUID()}`;
    setAttempt({ payload: serialized, operationId });
    try { const result = await api.post('/procurement/v1/imports/apply', body, { operationId }); onCreated(result.data.id); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <Card padding="lg" className="space-y-4">
    <h3 className="font-black">Tek CSV · Otomatik eşleştirme ve satın alma taslağı</h3>
    <p className="text-sm">Önizleme ürün, alış, BOM ve paketleri doğrular. Import yalnız ürün kartlarını ve eksik maliyetli satın alma taslağını oluşturur; stok, gider ve maliyet kaydı oluşturmaz.</p>
    {error && <p role="alert" className="whitespace-pre-line text-danger">{error}</p>}
    <Button disabled={busy || !supplierId} onClick={inspect}>{preview ? 'Önizlemeyi Yenile' : 'CSV Önizle'}</Button>
    {preview && <>
      <div className="grid gap-2 text-sm md:grid-cols-3">
        <p>Mevcut SKU: <strong>{preview.summary.existingSkuCount}</strong> · Yeni SKU: <strong>{preview.summary.newSkuCount}</strong></p>
        <p>Alış: <strong>{preview.summary.purchaseLineCount}</strong> satır ({preview.summary.billedLineCount} faturalanmış + {preview.summary.includedLineCount} fiyata dahil)</p>
        <p>Ürün bedeli: <strong>{(preview.parsed.summary.goodsAmountMinor / 100).toFixed(2)} {preview.parsed.header.currency}</strong></p>
        <p>Kaynak koli: <strong>{preview.parsed.summary.sourceCartons}</strong> · Planlı depo paketi: <strong>{preview.parsed.summary.warehousePackages}</strong></p>
        <p>BOM: <strong>{preview.summary.bomCount}</strong> reçete · {preview.summary.bomRelationCount} bileşen bağı</p>
        <p>Otomatik tedarik eşleşmesi: <strong>{preview.summary.aliasCount}</strong></p>
      </div>
      <p className="text-sm">Kaynak fatura genel toplamı: {preview.parsed.summary.sourceInvoiceTotalMinor == null ? '—' : (preview.parsed.summary.sourceInvoiceTotalMinor / 100).toFixed(2)} {preview.parsed.header.currency}. Giderler aktarılmadı, Satın Alma'dan manuel girilecek.</p>
      {preview.existingDraftId && <p className="text-amber-700">Bu fatura daha önce aktarılmış; mevcut taslak döner.</p>}
      {preview.cancelledDraftId && <p className="text-amber-700">Önceki taslak iptal edildi; aynı CSV yeniden açılabilir.</p>}
      {!preview.existingDraftId && preview.existingPurchaseId && <p className="text-amber-700">Bu fatura zaten satın alma kaydında; yeniden import edilemez.</p>}
      {preview.blockingErrors.length > 0 && <div role="alert" className="space-y-1 rounded border border-red-300 p-3 text-sm text-danger"><strong>CSV'de düzeltilmesi gereken hatalar ({preview.blockingErrors.length})</strong>{preview.blockingErrors.map((message: string, index: number) => <p key={index}>{message}</p>)}</div>}
      {preview.skippedAliases.length > 0 && <p className="text-xs text-amber-700">Birden fazla SKU için kullanılan genel kaynak açıklamaları alias olarak kaydedilmedi: {preview.skippedAliases.join(', ')}.</p>}
      <details><summary className="cursor-pointer font-bold">Otomatik SKU eşleşmeleri ({preview.products.length})</summary><div className="max-h-80 space-y-1 overflow-auto text-xs">{preview.products.map((product: any) => <p key={product.ref}>Satır {product.row} · {product.sku} · {product.action === 'KEEP' ? 'Mevcut kart korunur' : 'Yeni pasif kart'} · {product.proposed.title}</p>)}</div></details>
      {preview.summary.bomChangeCount > 0 && <details><summary className="cursor-pointer font-bold">Tek onayla uygulanacak BOM farkları ({preview.summary.bomChangeCount})</summary>{preview.bom.filter((item: any) => item.action === 'REPLACE').map((item: any) => <p key={item.parentRef} className="text-xs">{item.parentRef} · mevcut {item.current.lines.length}, önerilen {item.incoming.length} bileşen</p>)}</details>}
      <details><summary className="cursor-pointer font-bold">Kaynak koliler ve planlanan paketler</summary>{preview.parsed.groups.map((group: any) => <div className="border-b py-2 text-xs" key={group.record_id}><strong>{group.record_id} · {group.package_count} koli {group.meta.mixed ? '· Karışık: depoda ayrılıp tartılacak' : ''}</strong><p>Net {group.net_weight_kg || '—'} kg · brüt {group.gross_weight_kg || '—'} kg</p>{preview.parsed.items.filter((item: any) => item.parent_ref === group.record_id).map((item: any) => <p key={item.record_id}>{item.sku || item.product_ref} · {item.quantity} toplam · {item.units_per_package}/koli · alış {item.purchase_line_ref}</p>)}</div>)}</details>
      <details><summary>Kaynak gider kanıtı (işlem oluşturulmaz)</summary>{preview.parsed.expenses.map((row: any) => <p key={row.record_id}>{row.name_en} · {row.amount} {row.currency}</p>)}</details>
      <p className="text-xs">Vergi, kur, stok kanıtı ve maliyet politikası taslaktan sonra Satın Alma'da tamamlanır. Fiziksel mal kabul ayrıca onaylanır.</p>
      <Button disabled={busy || !reviewed || preview.blockingErrors.length > 0 || (preview.existingPurchaseId && !preview.existingDraftId)} onClick={apply}>{preview.cancelledDraftId ? 'Taslağı Yeniden Aç' : 'Taslağı Oluştur'}</Button>
    </>}
  </Card>;
}
