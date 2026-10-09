import { useState } from 'react';
import { splitVat } from '../../../server/modules/finance/money';
import { api } from '../../lib/api';
import { Button, Card, Input } from '../ui';

type DraftCost = { id: string; title: string; amountMinor: number; currency: 'USD' | 'TRY'; description: string | null; version: number; paymentStatus?: string; vatMode:'INCLUDED'|'EXCLUDED'; counterparty?:'SUPPLIER'|'THIRD_PARTY'|null; netMinor:number|null; vatRateBps:number|null; vatMinor:number|null; grossMinor:number; estimateUsdMinor: number | null };
type Draft = { id: string; draftCosts: DraftCost[] };
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

export function DraftCostsPanel({ draft, onChanged, onPreview }: { draft: Draft; onChanged: (data: any) => void; onPreview?: () => void }) {
  const [form,setForm] = useState({ title:'', amount:'', currency:'USD' as 'USD' | 'TRY', vatRate:'20', description:'' });
  const [editing,setEditing] = useState<{ id: string; version: number } | null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
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
  return <div className="space-y-4">
    <Card padding="lg" className="space-y-4"><div><h3 className="font-black">Maliyet Ekle</h3><p className="text-sm text-text-muted">Bu kalemler taslakta düzenlenebilir; stok, ödeme veya FINAL maliyet oluşturmaz.</p></div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Input aria-label="Maliyet başlığı" placeholder="Başlık (Nakliye, Gümrük, Paketleme...)" value={form.title} onChange={event => setForm({ ...form,title:event.target.value })}/>
        <div className="space-y-1.5 xl:col-span-2"><span className="text-xs font-bold text-text-muted">KDV dahil toplam tutar</span><div className="flex items-center gap-2 rounded-xl border border-border-color bg-bg-main p-1">
          <div className="flex shrink-0 rounded-lg bg-white p-1 shadow-sm">{(['USD','TRY'] as const).map(currency => <button key={currency} type="button" aria-label={`${currency} olarak gir`} aria-pressed={form.currency === currency} onClick={() => setForm({ ...form,currency })} className={`rounded-md px-3 py-2 text-xs font-black transition-colors ${form.currency === currency ? 'bg-primary text-white' : 'text-text-muted hover:text-text-main'}`}>{currency}</button>)}</div>
          <Input aria-label={`Maliyet tutarı (${form.currency})`} inputMode="decimal" placeholder={form.currency === 'USD' ? '0,00 $' : '0,00 ₺'} value={form.amount} onChange={event => setForm({ ...form,amount:event.target.value })}/>
        </div></div>
        <label className="text-sm">KDV (%)<Input aria-label="Maliyet KDV oranı" type="number" min="0" max="100" step="0.01" value={form.vatRate} onChange={event => setForm({ ...form,vatRate:event.target.value })}/></label>
        <Input className="md:col-span-2 xl:col-span-4" aria-label="Maliyet açıklaması" placeholder="Açıklama (opsiyonel)" value={form.description} onChange={event => setForm({ ...form,description:event.target.value })}/>
      </div>
      {inputAmounts && <p className="text-sm">Ana tutar: {money(inputAmounts.netMinor,form.currency)} · İçindeki KDV: {money(inputAmounts.vatMinor,form.currency)} · Genel toplam / Landed Cost'a eklenecek: <strong>{money(inputAmounts.grossMinor,form.currency)}</strong></p>}
      <div className="flex gap-2"><Button disabled={busy || !form.title.trim() || !form.amount.trim()} onClick={save}>{editing ? 'Değişikliği Kaydet' : 'Maliyet Ekle'}</Button>{editing && <Button variant="secondary" onClick={reset}>Vazgeç</Button>}</div>
      {draft.draftCosts.length ? <div className="space-y-2">{draft.draftCosts.map(cost => <div key={cost.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 text-sm"><div><strong>{cost.title} · Genel toplam {money(cost.grossMinor,cost.currency)}</strong><p className="text-xs text-text-muted">Ana tutar {money(cost.netMinor,cost.currency)} · KDV {cost.vatRateBps == null ? 'oranı bekleniyor' : `%${cost.vatRateBps/100}: ${money(cost.vatMinor,cost.currency)}`}</p><p className="text-xs text-text-muted">{cost.description || 'Açıklama yok'} · {cost.paymentStatus === 'PAID' ? 'Ödendi · Değiştirilemez' : 'Salt okunur maliyet tahmini'} · Tahmini USD {money(cost.estimateUsdMinor)}</p></div><div className="flex gap-2"><Button variant="secondary" disabled={busy || cost.paymentStatus === 'PAID'} onClick={() => startEdit(cost)}>Düzenle</Button><Button variant="secondary" disabled={busy || cost.paymentStatus === 'PAID'} onClick={() => remove(cost)}>Sil</Button></div></div>)}</div> : <p className="text-sm text-text-muted">Henüz ek maliyet yok.</p>}
      <div className="flex flex-wrap items-center gap-3 border-t border-border-color pt-4"><Button variant="secondary" disabled={!draft.draftCosts.length} onClick={onPreview}>Landed Cost Önizle</Button><p className="text-xs text-text-muted">Alış ve tahmini maliyet fiyatları mevcut ürün listesinde yan yana gösterilir.</p></div>
    </Card>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
