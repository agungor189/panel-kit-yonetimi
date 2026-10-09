import { useState } from 'react';
import { splitVat } from '../../../server/modules/finance/money';
import { api } from '../../lib/api';
import { Button, Card, Input, Select } from '../ui';

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

export function DraftCostsPanel({ draft, onChanged }: { draft: Draft; onChanged: (data: any) => void }) {
  const [form,setForm] = useState({ title:'', amount:'', currency:'USD' as 'USD' | 'TRY', counterparty:'' as ''|'SUPPLIER'|'THIRD_PARTY', vatRate:'20', description:'' });
  const [editing,setEditing] = useState<{ id: string; version: number } | null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const reset = () => { setForm({ title:'',amount:'',currency:'USD',counterparty:'',vatRate:'20',description:'' }); setEditing(null); };
  const inputAmounts = (() => {try {return splitVat(parseMinor(form.amount),'INCLUDED',parseVatRate(form.vatRate));} catch {return null;}})();
  const save = async () => {
    try {
      const amountMinor = parseMinor(form.amount);
      const vatRateBps=parseVatRate(form.vatRate);
      setBusy(true); setError('');
      const payload = { title:form.title, amountMinor, currency:form.currency, counterparty:form.counterparty, vatRateBps, description:form.description };
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
    setForm({ title:cost.title,amount:(cost.grossMinor/100).toFixed(2),currency:cost.currency,counterparty:cost.counterparty || '',vatRate:String(cost.vatRateBps == null ? 20 : cost.vatRateBps/100),description:cost.description || '' });
  };
  return <div className="space-y-4">
    <Card padding="lg" className="space-y-4"><div><h3 className="font-black">Maliyet Ekle</h3><p className="text-sm text-text-muted">Bu kalemler taslakta düzenlenebilir; stok, ödeme veya FINAL maliyet oluşturmaz.</p></div>
      <div className="grid gap-3 md:grid-cols-3"><Input aria-label="Maliyet başlığı" placeholder="Başlık (Nakliye, Gümrük, Paketleme...)" value={form.title} onChange={event => setForm({ ...form,title:event.target.value })}/><Input aria-label="Maliyet tutarı" inputMode="decimal" placeholder="KDV dahil toplam tutar" value={form.amount} onChange={event => setForm({ ...form,amount:event.target.value })}/><Select aria-label="Maliyet para birimi" value={form.currency} onChange={event => setForm({ ...form,currency:event.target.value as 'USD' | 'TRY' })}><option value="USD">USD</option><option value="TRY">TL</option></Select><Select aria-label="Maliyet muhatabı" value={form.counterparty} onChange={event => setForm({...form,counterparty:event.target.value as 'SUPPLIER'|'THIRD_PARTY'})}><option value="">Kime ödenecek?</option><option value="SUPPLIER">Tedarikçi</option><option value="THIRD_PARTY">Üçüncü taraf</option></Select><label className="text-sm">KDV (%)<Input aria-label="Maliyet KDV oranı" type="number" min="0" max="100" step="0.01" value={form.vatRate} onChange={event => setForm({ ...form,vatRate:event.target.value })}/></label><Input aria-label="Maliyet açıklaması" placeholder="Açıklama (opsiyonel)" value={form.description} onChange={event => setForm({ ...form,description:event.target.value })}/></div>
      {inputAmounts && <p className="text-sm">Ana tutar: {money(inputAmounts.netMinor,form.currency)} · İçindeki KDV: {money(inputAmounts.vatMinor,form.currency)} · Genel toplam / Landed Cost'a eklenecek: <strong>{money(inputAmounts.grossMinor,form.currency)}</strong></p>}
      <div className="flex gap-2"><Button disabled={busy || !form.title.trim() || !form.amount.trim() || !form.counterparty} onClick={save}>{editing ? 'Değişikliği Kaydet' : 'Maliyet Ekle'}</Button>{editing && <Button variant="secondary" onClick={reset}>Vazgeç</Button>}</div>
      {draft.draftCosts.length ? <div className="space-y-2">{draft.draftCosts.map(cost => <div key={cost.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 text-sm"><div><strong>{cost.title} · Genel toplam {money(cost.grossMinor,cost.currency)}</strong><p className="text-xs text-text-muted">Ana tutar {money(cost.netMinor,cost.currency)} · KDV {cost.vatRateBps == null ? 'oranı bekleniyor' : `%${cost.vatRateBps/100}: ${money(cost.vatMinor,cost.currency)}`}</p><p className="text-xs text-text-muted">{cost.description || 'Açıklama yok'} · {cost.counterparty === 'SUPPLIER' ? 'Tedarikçi' : cost.counterparty === 'THIRD_PARTY' ? 'Üçüncü taraf' : 'Muhatap eksik'} · {cost.paymentStatus === 'PAID' ? 'Ödendi · Değiştirilemez' : 'Giderler: Onay Bekliyor'} · Tahmini USD {money(cost.estimateUsdMinor)}</p></div><div className="flex gap-2"><Button variant="secondary" disabled={busy || cost.paymentStatus === 'PAID'} onClick={() => startEdit(cost)}>Düzenle</Button><Button variant="secondary" disabled={busy || cost.paymentStatus === 'PAID'} onClick={() => remove(cost)}>Sil</Button></div></div>)}</div> : <p className="text-sm text-text-muted">Henüz ek maliyet yok.</p>}
    </Card>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
