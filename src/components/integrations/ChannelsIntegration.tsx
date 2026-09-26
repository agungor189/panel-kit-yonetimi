import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleOff, RefreshCw, ShoppingCart } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Card, EmptyState, LoadingState, PageHeader } from '../ui';

type Dashboard = {
  adapters: Record<string, { enabledTransport: boolean; verifiedTransportScope: string }>;
  accounts: Array<any>;
  mappings: Array<any>;
  commissionTerms: Array<any>;
  exceptions: Array<any>;
  jobs: Array<any>;
  cursors: Array<any>;
};

const money = (minor: number | null) => minor === null
  ? 'Yayın kapalı'
  : new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(minor / 100);

export default function ChannelsIntegration() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = async () => {
    try { setLoading(true); setError(''); setData(await api.get('/integrations/channels/dashboard')); }
    catch (err: any) { setError(err.message || 'Kanal durumu yüklenemedi.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  if (loading) return <Card className="rounded-2xl"><LoadingState label="Kanal durumu yükleniyor..." /></Card>;
  if (!data) return <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-700">{error}</div>;
  return <div className="space-y-6">
    <Card padding="md" className="rounded-3xl shadow-sm">
      <PageHeader title="Kanal Geçidi" description="Panel stok, fiyat, satış ve finans otoritesi; kanal kayıtları güvenli gelen kutusu ve yayın projeksiyonudur." actions={<Button variant="secondary" onClick={load} className="rounded-xl font-bold"><RefreshCw className="h-4 w-4" />Yenile</Button>} />
    </Card>
    <div className="grid gap-4 md:grid-cols-4">{Object.entries(data.adapters).map(([name, adapter]) => <div key={name} className="rounded-2xl border bg-white p-4">
      <div className="flex items-center justify-between"><b>{name}</b>{adapter.enabledTransport ? <CheckCircle2 className="text-emerald-600" /> : <CircleOff className="text-amber-600" />}</div>
      <p className="mt-2 text-xs text-slate-500">{adapter.verifiedTransportScope}</p>
    </div>)}</div>
    <section className="rounded-2xl border bg-white p-5"><h3 className="mb-4 text-lg font-black">Bağlantılar ve son durum</h3>
      <div className="grid gap-3 md:grid-cols-2">{data.accounts.map(a => <div key={a.id} className="rounded-xl bg-slate-50 p-4 text-sm">
        <div className="font-black">{a.channel} · {a.merchantAccountId}</div><div>{a.environment} · {a.state}</div>
        <div className="mt-2 text-xs text-slate-500">Webhook: {a.lastWebhookAt || '-'} · Poll: {a.lastPollAt || '-'} · Sync: {a.lastSyncAt || '-'}</div>
        {a.lastErrorCode && <div className="mt-1 text-red-600">{a.lastErrorCode}</div>}
      </div>)}</div>
    </section>
    <section className="overflow-hidden rounded-2xl border bg-white"><div className="p-5"><h3 className="text-lg font-black">Ürün eşlemeleri, fiyat ve stok</h3></div>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50"><tr>{['Kanal kaydı','Panel ürünü','Komisyon','Panel hedef','Kanal fiyatı','Mevcut','Tampon','Yayınlanabilir'].map(h => <th key={h} className="p-3">{h}</th>)}</tr></thead>
      <tbody>{data.mappings.map(m => <tr key={m.id} className="border-t"><td className="p-3">{m.externalListingId}</td><td className="p-3 font-bold">{m.sku} · {m.title}</td>
        <td className="p-3">{m.commissionState}</td><td className="p-3">{money(m.targetPriceMinor)}</td><td className="p-3 font-black">{money(m.calculatedChannelPriceMinor)}</td>
        <td className="p-3">{m.canonicalAvailableBaseInt}</td><td className="p-3">{m.stockBufferBaseInt}</td><td className="p-3">{m.publishableStockBaseInt}</td></tr>)}</tbody></table></div>
    </section>
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-2xl border bg-white p-5"><h3 className="mb-3 text-lg font-black"><AlertTriangle className="mr-2 inline text-amber-600" />Açık istisnalar</h3>
        <div className="space-y-2">{data.exceptions.length ? data.exceptions.map(e => <div key={e.id} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm"><b>{e.type}</b><div className="break-all text-xs">{e.detail}</div></div>) : <EmptyState title="Açık istisna yok." className="py-6" />}</div>
      </section>
      <section className="rounded-2xl border bg-white p-5"><h3 className="mb-3 text-lg font-black">Senkron işleri ve poll checkpoint</h3>
        <div className="space-y-2 text-sm">{data.jobs.map(j => <div key={j.id} className="rounded-xl bg-slate-50 p-3"><b>{j.kind}</b> · {j.state} · deneme {j.attemptCount}{j.lastErrorCode ? ` · ${j.lastErrorCode}` : ''}</div>)}
        {data.cursors.map(c => <div key={`${c.accountId}-${c.cursorName}`} className="rounded-xl bg-blue-50 p-3"><b>{c.cursorName}</b> · v{c.version} · {c.checkpointValue}</div>)}</div>
      </section>
    </div>
  </div>;
}
