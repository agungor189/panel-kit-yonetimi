import { useState } from 'react';
import { api } from '../../lib/api';
import { Button, Card, Input, Select } from '../ui';

export function ProcurementImport({ csv, supplierId, products, onCreated }: { csv: string; supplierId: string; products: Array<{ id: string; sku: string }>; onCreated: (id: string) => void }) {
  const [preview, setPreview] = useState<any>(null);
  const [choices, setChoices] = useState<Record<string, any>>({});
  const [confirmations, setConfirmations] = useState<string[]>([]);
  const [policy, setPolicy] = useState<any>({ vatMode: '', vatRateBps: '', acquisitionCostVatPolicy: '', includedCost: '', stockCheck: '', stockEvidence: '' });
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState<{ payload: string; operationId: string } | null>(null);
  const editChoice = (ref: string, choice: any) => { setChoices(v => ({ ...v, [ref]: choice })); setReviewed(false); };
  const editPolicy = (next: any) => { setPolicy(next); setReviewed(false); };
  const payload = () => ({ csv, supplierId, choices, confirmations, policy });
  const inspect = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.post('/procurement/v1/imports/preview', payload());
      setPreview(result.data); setReviewed(true);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true); setError('');
    const body = { ...payload(), expectedPreviewHash: preview.previewHash };
    const serialized = JSON.stringify(body);
    const operationId = attempt?.payload === serialized ? attempt.operationId : `purchase-import-${crypto.randomUUID()}`;
    setAttempt({ payload: serialized, operationId });
    try { const result = await api.post('/procurement/v1/imports/apply', body, { operationId }); onCreated(result.data.id); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <Card padding="lg" className="space-y-4">
    <h3 className="font-black">Tek CSV · Önizle → Eşleştirme ve değişiklik onayı → Taslak</h3>
    <p className="text-sm">Önizleme stok veya satın alma oluşturmaz. Vergi, kur ve maliyet kesinleştirmesi ayrıca gereklidir.</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <Button disabled={busy || !supplierId} onClick={inspect}>{preview ? 'Kararlarla Önizlemeyi Yenile' : 'CSV Önizle'}</Button>
    {preview && <>
      <p>{preview.parsed.header.invoice_number} · {preview.parsed.summary.records} kayıt · {preview.parsed.summary.sourceCartons} kaynak koli → {preview.parsed.summary.warehousePackages} depo paketi · Ürün {(preview.parsed.summary.goodsAmountMinor / 100).toFixed(2)} · Kaynak fatura genel toplamı {preview.parsed.summary.sourceInvoiceTotalMinor == null ? '—' : (preview.parsed.summary.sourceInvoiceTotalMinor / 100).toFixed(2)} {preview.parsed.header.currency}</p>
      {preview.existingPurchaseId && <p className="text-amber-700">Bu fatura daha önce kaydedilmiş. Aynı onaylarla tekrar mevcut taslağı döndürür.</p>}
      <details><summary className="cursor-pointer font-bold">Ürün eşleştirmeleri ve katalog farkları ({preview.products.length})</summary>
        <div className="space-y-3">{preview.products.map((p: any) => {
          const choice = choices[p.ref] || {};
          const fields = choice.fields || p.proposed;
          return <div className="rounded border p-3" key={p.ref}>
            <strong>Satır {p.row} · {p.source.sku || p.source.suggested_sku} · {p.source.name_en}</strong>
            <Select value={choice.action || ''} onChange={e => editChoice(p.ref, { ...choice, action: e.target.value, productId: choice.productId || p.current?.id, fields: { ...p.proposed, ...choice.fields } })}>
              <option value="">Karar seçin</option><option value="KEEP">Kayıtlı kartı kullan, alanlarını koru</option><option value="UPDATE">Katalog farklarını onayla ve güncelle</option><option value="CREATE">Yeni pasif ürün oluştur</option>
            </Select>
            {choice.action !== 'CREATE' && <Select value={choice.productId || p.current?.id || ''} onChange={e => editChoice(p.ref, { ...choice, productId: e.target.value })}><option value="">Mevcut SKU seçin</option>{products.map(product => <option key={product.id} value={product.id}>{product.sku}</option>)}</Select>}
            <p className="text-xs">Mevcut: {p.current ? `${p.current.sku} · ${p.current.title} · ${p.current.product_type} · ${p.current.material || '—'} · ${p.current.size || '—'} · ${p.current.mass_grams ?? '—'} g · v${p.current.catalog_version}` : 'Yok'}</p>
            {['UPDATE','CREATE'].includes(choice.action) && <div className="grid gap-2 md:grid-cols-3">{['sku','title','product_type','name_tr','name_en','material','size','profile_type','base_uom_code','mass_grams'].map(field => <label className="text-xs" key={field}>{field}<Input value={fields[field] ?? ''} onChange={e => editChoice(p.ref, { ...choice, fields: { ...fields, [field]: field === 'mass_grams' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value } })}/></label>)}</div>}
          </div>;
        })}</div>
      </details>
      <details><summary className="font-bold">BOM farkları ({preview.bom.length})</summary>{preview.bom.map((b: any) => <div key={b.parentRef}><strong>{b.parentRef}</strong><pre className="overflow-auto text-xs">{JSON.stringify({ mevcut: b.current.lines, önerilen: b.incoming }, null, 2)}</pre></div>)}</details>
      <details><summary className="font-bold">Kaynak koli ve içerik planı</summary>{preview.parsed.groups.map((g: any) => <div className="border-b py-2 text-xs" key={g.record_id}><strong>{g.record_id} · {g.package_count} koli {g.meta.mixed ? '· Karışık: depoda ayır ve tart' : ''}</strong><p>Kaynak net {g.net_weight_kg || '—'} kg · brüt {g.gross_weight_kg || '—'} kg (grup toplamı)</p>{preview.parsed.items.filter((i: any) => i.parent_ref === g.record_id).map((i: any) => <p key={i.record_id}>{i.sku || i.product_ref} · {i.quantity} toplam · {i.units_per_package}/koli · alış {i.purchase_line_ref}</p>)}</div>)}</details>
      <div className="grid gap-3 md:grid-cols-3">
        <Select value={policy.vatMode} onChange={e => editPolicy({ ...policy, vatMode: e.target.value })}><option value="">Vergi tutara dahil mi?</option><option value="EXCLUDED">Hariç</option><option value="INCLUDED">Dahil</option></Select>
        <label className="text-xs">Vergi oranı (baz puan; %1 = 100)<Input type="number" min="0" max="10000" value={policy.vatRateBps} onChange={e => editPolicy({ ...policy, vatRateBps: e.target.value === '' ? '' : Number(e.target.value) })}/></label>
        <Select value={policy.acquisitionCostVatPolicy} onChange={e => editPolicy({ ...policy, acquisitionCostVatPolicy: e.target.value })}><option value="">Stok maliyetinde vergi politikası</option><option value="VAT_EXCLUDED_FROM_INVENTORY_COST">Vergi maliyete dahil değil</option><option value="VAT_INCLUDED_IN_INVENTORY_COST">Vergi maliyete dahil</option></Select>
        <Select value={policy.includedCost} onChange={e => editPolicy({ ...policy, includedCost: e.target.value })}><option value="">Fiyata dahil içerik politikası</option><option value="NO_SEPARATE_CHARGE">Ek bedel yok; LC gider dağıtımı ayrıca onaylanır</option></Select>
        <Select value={policy.stockCheck} onChange={e => editPolicy({ ...policy, stockCheck: e.target.value })}><option value="">Önceki stok kontrolü</option><option value="NO_PRIOR_RECEIPT">Bu parti daha önce kabul/başlangıç stokuna alınmadı</option></Select>
        <Input placeholder="Kontrol kanıtı / açıklaması" value={policy.stockEvidence} onChange={e => editPolicy({ ...policy, stockEvidence: e.target.value })}/>
      </div>
      <p role="status" className="text-amber-700">Giderler aktarılmadı, manuel girilecek. Taslak yalnız ürün bedelini içerir; kaynak fatura genel toplamı değiştirilmez.</p>
      <details><summary>Kaynak gider bilgileri (işlem oluşturulmadı)</summary>{preview.parsed.expenses.map((r: any) => <p key={r.record_id}>{r.name_en} · {r.amount} {r.currency}</p>)}</details>
      <div className="space-y-2">{preview.requirements.map((r: any) => <label className="block text-xs" key={r.key}><input type="checkbox" checked={confirmations.includes(r.key)} onChange={e => setConfirmations(c => e.target.checked ? [...c, r.key] : c.filter(k => k !== r.key))}/> Satır {r.row} · {r.sku} · {r.message}</label>)}</div>
      <Button disabled={busy || !reviewed || preview.products.some((p: any) => !choices[p.ref]?.action) || preview.requirements.some((r: any) => !confirmations.includes(r.key))} onClick={apply}>Onaylanan Satın Alma Taslağını Oluştur</Button>
      {!reviewed && <p className="text-sm">Değişikliklerden sonra önizlemeyi yenileyin.</p>}
    </>}
  </Card>;
}
