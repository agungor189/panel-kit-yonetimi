import { useState } from 'react';
import { splitVat } from '../../../server/modules/finance/money';
import { api } from '../../lib/api';
import { Button, Card, Input, Select } from '../ui';

type DraftCost = { id: string; title: string; amountMinor: number; currency: 'USD' | 'TRY'; description: string | null; version: number; paymentStatus?: string; vatMode:'INCLUDED'|'EXCLUDED'; netMinor:number|null; vatRateBps:number|null; vatMinor:number|null; grossMinor:number; estimateUsdMinor: number | null };
type Draft = { id: string; goodsAmountUsdMinor: number | null; additionalCostsUsdMinor: number | null; estimatedTotalUsdMinor: number | null;
  estimateFx: { numerator: number; denominator: number; observedAt: string } | null; draftCosts: DraftCost[] };
type CostDecision = { costId: string; category: string; counterparty: string; vatMode: string; vatRateBps: string };
type FinalPreview = { previewHash: string; lines: Array<{ lineId:string;sku:string;merchandiseCostTryMinor:number;allocatedExpenseTryMinor:number;
  estimatedUnitLandedCostTry:{numerator:number;denominator:number};totalCostTryMinor:number }>;
  totals:{merchandiseTryMinor:number;allocatedExpensesTryMinor:number;landedCostTryMinor:number};
  usdTotals:{merchandiseUsdMinor:number|null;additionalUsdMinor:number|null;estimatedTotalUsdMinor:number|null};warnings:Array<{message:string}> };
const operation = (name: string) => ({ operationId: `${name}-${crypto.randomUUID()}` });
const money = (minor: number | null, currency: 'USD' | 'TRY' = 'USD') => minor === null ? '—' : new Intl.NumberFormat('tr-TR',{ style:'currency',currency }).format(minor/100);
const parseMinor = (text: string) => {
  const match = text.trim().replace(',','.').match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('Tutarı en çok iki ondalık basamakla girin.');
  const value = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2,'0'));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Tutar pozitif ve geçerli olmalı.');
  return value;
};

export const parseVatRate = (value:string) => {
  const text=value.trim().replace(',','.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('KDV oranını en çok iki ondalık basamakla girin.');
  const [whole,fraction='']=text.split('.');
  const rate=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if (!Number.isSafeInteger(rate) || rate>10000) throw new Error('KDV oranı %0–100 arasında olmalı.');
  return rate;
};

export function DraftCostsPanel({ draft, onChanged, onFinalized }: { draft: Draft; onChanged: (data: any) => void; onFinalized: (data: any) => void }) {
  const [form,setForm] = useState({ title:'', amount:'', currency:'USD' as 'USD' | 'TRY', vatRate:'20', description:'' });
  const [editing,setEditing] = useState<{ id: string; version: number } | null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [showFinalize,setShowFinalize] = useState(false);
  const [final,setFinal] = useState({ vatMode:'',vatRateBps:'',acquisitionCostVatPolicy:'',includedCost:'',stockEvidence:'',approveProportionalAllocation:false });
  const [decisions,setDecisions] = useState<Record<string,CostDecision>>({});
  const [preview,setPreview] = useState<{ data:FinalPreview; input:string } | null>(null);
  const [approvePreview,setApprovePreview] = useState(false);
  const reset = () => { setForm({ title:'',amount:'',currency:'USD',vatRate:'20',description:'' }); setEditing(null); };
  const inputAmounts = (() => {try {return splitVat(parseMinor(form.amount),'INCLUDED',parseVatRate(form.vatRate));} catch {return null;}})();
  const save = async () => {
    try {
      const amountMinor = parseMinor(form.amount);
      const vatRateBps=parseVatRate(form.vatRate);
      setBusy(true); setError('');
      const payload = { title:form.title, amountMinor, currency:form.currency, vatRateBps, description:form.description };
      const path = `/procurement/v1/imports/drafts/${draft.id}/costs`;
      const result = editing
        ? await api.post(`${path}/${editing.id}/update`,{ ...payload, expectedVersion:editing.version },operation('draft-cost-update'))
        : await api.post(path,payload,operation('draft-cost-add'));
      onChanged(result.data); reset();
    } catch (cause: any) { setError(cause.message || 'Maliyet kaydedilemedi.'); }
    finally { setBusy(false); }
  };
  const remove = async (cost: DraftCost) => {
    try {
      setBusy(true); setError('');
      const result = await api.post(`/procurement/v1/imports/drafts/${draft.id}/costs/${cost.id}/remove`,{ expectedVersion:cost.version },operation('draft-cost-remove'));
      onChanged(result.data); if (editing?.id === cost.id) reset();
    } catch (cause: any) { setError(cause.message || 'Maliyet silinemedi.'); }
    finally { setBusy(false); }
  };
  const startEdit = (cost: DraftCost) => {
    setEditing({ id:cost.id,version:cost.version });
    setForm({ title:cost.title,amount:(cost.grossMinor/100).toFixed(2),currency:cost.currency,vatRate:String(cost.vatRateBps == null ? 20 : cost.vatRateBps/100),description:cost.description || '' });
  };
  const decisionFor = (id: string):CostDecision => {
    const cost=draft.draftCosts.find(item => item.id===id)!;
    const decision=decisions[id] || { costId:id,category:'',counterparty:'',vatMode:'',vatRateBps:'' };
    return cost.vatRateBps == null ? decision : {...decision,vatMode:cost.vatMode,vatRateBps:String(cost.vatRateBps)};
  };
  const updateDecision = (id: string, field: keyof CostDecision, value: string) => setDecisions(current => ({ ...current, [id]:{ ...decisionFor(id),[field]:value } }));
  const ready = Boolean(final.vatMode && final.vatRateBps !== '' && final.acquisitionCostVatPolicy && final.includedCost && final.stockEvidence.trim()
    && (!draft.draftCosts.length || final.approveProportionalAllocation)
    && draft.draftCosts.every(cost => { const d = decisionFor(cost.id); return d.category && d.counterparty && d.vatMode && d.vatRateBps !== ''; }));
  const finalPayload = () => ({
    vatMode:final.vatMode, vatRateBps:Number(final.vatRateBps), acquisitionCostVatPolicy:final.acquisitionCostVatPolicy,
    includedCost:final.includedCost, stockCheck:'NO_PRIOR_RECEIPT', stockEvidence:final.stockEvidence.trim(),
    approveProportionalAllocation:final.approveProportionalAllocation,
    costDecisions:draft.draftCosts.map(cost => ({ ...decisionFor(cost.id), vatRateBps:Number(decisionFor(cost.id).vatRateBps) })),
  });
  const previewInput = () => JSON.stringify({ decision:finalPayload(),costs:draft.draftCosts.map(cost => [cost.id,cost.version,cost.amountMinor,cost.currency]) });
  const loadPreview = async () => {
    if (!ready) return;
    try {
      setBusy(true); setError(''); setPreview(null); setApprovePreview(false);
      const input = previewInput();
      const result = await api.post(`/procurement/v1/imports/drafts/${draft.id}/cost-preview`,finalPayload());
      setPreview({ data:result.data,input });
    } catch (cause:any) { setError(cause.message || 'FINAL önizlemesi hesaplanamadı.'); }
    finally { setBusy(false); }
  };
  const currentPreview = ready && preview?.input === previewInput() ? preview.data : null;
  const finalize = async () => {
    if (!currentPreview || !approvePreview) return;
    try {
      setBusy(true); setError('');
      const result = await api.post(`/procurement/v1/imports/drafts/${draft.id}/finalize`,
        { ...finalPayload(), expectedPreviewHash:currentPreview.previewHash,approvePreview:true },operation('draft-finalize'));
      onFinalized(result.data);
    } catch (cause: any) { setError(cause.message || 'Maliyet kesinleştirilemedi.'); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <Card padding="lg" className="space-y-4"><div><h3 className="font-black">Maliyet Ekle</h3><p className="text-sm text-text-muted">Bu kalemler taslakta düzenlenebilir; stok, ödeme veya FINAL maliyet oluşturmaz.</p></div>
      <div className="grid gap-3 md:grid-cols-5"><Input aria-label="Maliyet başlığı" placeholder="Başlık (Nakliye, Gümrük, Paketleme...)" value={form.title} onChange={event => setForm({ ...form,title:event.target.value })}/><Input aria-label="Maliyet tutarı" inputMode="decimal" placeholder="KDV dahil toplam tutar" value={form.amount} onChange={event => setForm({ ...form,amount:event.target.value })}/><Select aria-label="Maliyet para birimi" value={form.currency} onChange={event => setForm({ ...form,currency:event.target.value as 'USD' | 'TRY' })}><option value="USD">USD</option><option value="TRY">TL</option></Select><label className="text-sm">KDV (%)<Input aria-label="Maliyet KDV oranı" type="number" min="0" max="100" step="0.01" value={form.vatRate} onChange={event => setForm({ ...form,vatRate:event.target.value })}/></label><Input aria-label="Maliyet açıklaması" placeholder="Açıklama (opsiyonel)" value={form.description} onChange={event => setForm({ ...form,description:event.target.value })}/></div>
      {inputAmounts && <p className="text-sm">Ana tutar: {money(inputAmounts.netMinor,form.currency)} · İçindeki KDV: {money(inputAmounts.vatMinor,form.currency)} · Genel toplam / Landed Cost'a eklenecek: <strong>{money(inputAmounts.grossMinor,form.currency)}</strong></p>}
      <div className="flex gap-2"><Button disabled={busy || !form.title.trim() || !form.amount.trim()} onClick={save}>{editing ? 'Değişikliği Kaydet' : 'Maliyet Ekle'}</Button>{editing && <Button variant="secondary" onClick={reset}>Vazgeç</Button>}</div>
      {draft.draftCosts.length ? <div className="space-y-2">{draft.draftCosts.map(cost => <div key={cost.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 text-sm"><div><strong>{cost.title} · Genel toplam {money(cost.grossMinor,cost.currency)}</strong><p className="text-xs text-text-muted">Ana tutar {money(cost.netMinor,cost.currency)} · KDV {cost.vatRateBps == null ? 'oranı bekleniyor' : `%${cost.vatRateBps/100}: ${money(cost.vatMinor,cost.currency)}`}</p><p className="text-xs text-text-muted">{cost.description || 'Açıklama yok'} · {cost.paymentStatus === 'PAID' ? 'Ödendi · Değiştirilemez' : 'Giderler: Onay Bekliyor'} · Tahmini USD {money(cost.estimateUsdMinor)}</p></div><div className="flex gap-2"><Button variant="secondary" disabled={busy || cost.paymentStatus === 'PAID'} onClick={() => startEdit(cost)}>Düzenle</Button><Button variant="secondary" disabled={busy || cost.paymentStatus === 'PAID'} onClick={() => remove(cost)}>Sil</Button></div></div>)}</div> : <p className="text-sm text-text-muted">Henüz ek maliyet yok.</p>}
      <div className="grid gap-3 rounded-xl bg-bg-main p-4 text-sm md:grid-cols-3"><p>Toplam alış bedeli<strong className="block text-lg">{money(draft.goodsAmountUsdMinor)}</strong></p><p>Ek maliyetler<strong className="block text-lg">{money(draft.additionalCostsUsdMinor)}</strong></p><p>Tahmini toplam maliyet<strong className="block text-lg">{money(draft.estimatedTotalUsdMinor)}</strong></p></div>
      <p className="text-xs text-text-muted">Tahmini USD dönüşümü {draft.estimateFx ? `${(draft.estimateFx.numerator/draft.estimateFx.denominator).toLocaleString('tr-TR')} TRY/USD · ${draft.estimateFx.observedAt} kur gözlemine dayanır.` : 'için onaylı USD/TRY kuru bekleniyor.'} FINAL Landed Cost mevcut hesap motorunda ayrıca kesinleşir.</p>
    </Card>
    <Card padding="lg" className="space-y-3"><h3 className="font-black">Kesinleştirme</h3><p className="text-sm text-text-muted">Vergi, kur, gider muhatabı ve dağıtım kararları yalnız FINAL maliyet onayında gerekir.</p><Button variant="secondary" onClick={() => setShowFinalize(value => !value)}>{showFinalize ? 'Kontrolleri Kapat' : 'FINAL Kontrollerini Aç'}</Button>
      {showFinalize && <div className="space-y-4 border-t pt-4"><div className="grid gap-3 md:grid-cols-2"><label className="text-sm">Fatura vergisi<Select value={final.vatMode} onChange={event => setFinal({ ...final,vatMode:event.target.value })}><option value="">Seçin</option><option value="EXCLUDED">Hariç</option><option value="INCLUDED">Dahil</option></Select></label><label className="text-sm">Vergi oranı (baz puan)<Input type="number" min="0" max="10000" value={final.vatRateBps} onChange={event => setFinal({ ...final,vatRateBps:event.target.value })}/></label><label className="text-sm">Stok maliyeti vergi politikası<Select value={final.acquisitionCostVatPolicy} onChange={event => setFinal({ ...final,acquisitionCostVatPolicy:event.target.value })}><option value="">Seçin</option><option value="VAT_EXCLUDED_FROM_INVENTORY_COST">Vergi maliyete dahil değil</option><option value="VAT_INCLUDED_IN_INVENTORY_COST">Vergi maliyete dahil</option></Select></label><label className="text-sm">Fiyata dahil içerik<Select value={final.includedCost} onChange={event => setFinal({ ...final,includedCost:event.target.value })}><option value="">Seçin</option><option value="NO_SEPARATE_CHARGE">Ayrı ek bedel yok</option></Select></label><label className="text-sm md:col-span-2">Önceki stok kontrolü kanıtı<Input value={final.stockEvidence} onChange={event => setFinal({ ...final,stockEvidence:event.target.value })}/></label></div>
        {draft.draftCosts.map(cost => { const item = decisionFor(cost.id); return <div key={cost.id} className="space-y-2 rounded-xl border p-3 text-sm"><strong>{cost.title} · {money(cost.grossMinor,cost.currency)}</strong><div className="grid gap-2 md:grid-cols-4"><Select aria-label={`${cost.title} türü`} value={item.category} onChange={event => updateDecision(cost.id,'category',event.target.value)}><option value="">Gider türü</option><option value="FREIGHT">Nakliye</option><option value="CUSTOMS">Gümrük</option><option value="CUTTING_LABOR">İşçilik</option><option value="OTHER">Diğer / Paketleme</option></Select><Select aria-label={`${cost.title} muhatabı`} value={item.counterparty} onChange={event => updateDecision(cost.id,'counterparty',event.target.value)}><option value="">Muhatap</option><option value="SUPPLIER">Tedarikçi</option><option value="THIRD_PARTY">Üçüncü taraf</option></Select>{cost.vatRateBps == null ? <><Select aria-label={`${cost.title} vergisi`} value={item.vatMode} onChange={event => updateDecision(cost.id,'vatMode',event.target.value)}><option value="">Vergi</option><option value="EXCLUDED">Hariç</option><option value="INCLUDED">Dahil</option></Select><Input aria-label={`${cost.title} vergi oranı`} type="number" min="0" max="10000" placeholder="Vergi baz puan" value={item.vatRateBps} onChange={event => updateDecision(cost.id,'vatRateBps',event.target.value)}/></> : <p className="md:col-span-2">KDV dahil toplam {money(cost.grossMinor,cost.currency)} · Ana tutar {money(cost.netMinor,cost.currency)} · İçindeki %{cost.vatRateBps/100} KDV {money(cost.vatMinor,cost.currency)}. Brüt toplam Landed Cost'a bir kez dahil edilir.</p>}</div></div>; })}
        {draft.draftCosts.length > 0 && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={final.approveProportionalAllocation} onChange={event => setFinal({ ...final,approveProportionalAllocation:event.target.checked })}/>Ek maliyetlerin alış bedeli oranında dağıtımını onaylıyorum.</label>}
        <Button disabled={busy || !ready} onClick={loadPreview}>FINAL LC Önizlemesini Hesapla</Button>
        {currentPreview && <div className="space-y-3 rounded-xl border p-3"><h4 className="font-bold">Salt Okunur FINAL LC Önizlemesi</h4>
          <div className="max-h-80 overflow-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-text-muted"><th>SKU</th><th>Alış bedeli (TL)</th><th>Ek gider (TL)</th><th>Birim FINAL LC (TL)</th><th>Toplam (TL)</th></tr></thead><tbody>{currentPreview.lines.map(line => <tr key={line.lineId} className="border-t"><td>{line.sku}</td><td>{money(line.merchandiseCostTryMinor,'TRY')}</td><td>{money(line.allocatedExpenseTryMinor,'TRY')}</td><td>{money(line.estimatedUnitLandedCostTry.numerator/line.estimatedUnitLandedCostTry.denominator,'TRY')}</td><td>{money(line.totalCostTryMinor,'TRY')}</td></tr>)}</tbody></table></div>
          <p className="text-xs text-text-muted">USD karşılıkları maliyet önizlemesinin güvenilir kur snapshotıyla hesaplanır.</p>
          <div className="grid gap-2 text-sm md:grid-cols-3"><p>Alış: {money(currentPreview.usdTotals.merchandiseUsdMinor)} / {money(currentPreview.totals.merchandiseTryMinor,'TRY')}</p><p>Ek gider: {money(currentPreview.usdTotals.additionalUsdMinor)} / {money(currentPreview.totals.allocatedExpensesTryMinor,'TRY')}</p><p>Toplam: {money(currentPreview.usdTotals.estimatedTotalUsdMinor)} / {money(currentPreview.totals.landedCostTryMinor,'TRY')}</p></div>
          {currentPreview.warnings.map((warning,index) => <p key={index} className="text-sm text-amber-700">{warning.message}</p>)}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={approvePreview} onChange={event => setApprovePreview(event.target.checked)}/>Bu FINAL maliyet önizlemesini onaylıyorum.</label>
          <Button disabled={busy || !approvePreview || currentPreview.warnings.length > 0} onClick={finalize}>FINAL Landed Cost'u Kesinleştir</Button>
        </div>}
      </div>}
    </Card>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
