import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Card } from '../ui';

export function ProductPackages({ productId }: { productId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(''); setData(null);
    api.get(`/inventory/v1/products/${encodeURIComponent(productId)}/packages`).then(result => { if (!cancelled) setData(result.data); })
      .catch(e => { if (!cancelled) setError(e.message || 'Paketler yüklenemedi.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, productId, retry]);
  const table = (rows: any[]) => <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr>{['Paket kodu / barkodu','İlk adet','Kalan adet','Ağırlık (kg)','Lot','Satın alma no','Lokasyon','Durum'].map(h => <th className="p-2 text-left" key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(p => <tr className="border-t" key={p.id}><td className="p-2 font-bold">{p.code}{p.sourceCartonId && <small className="block font-normal text-text-muted">Kaynak koli: {p.sourceGroupRef} · {p.sourceCartonId}</small>}</td><td>{p.initial}</td><td>{p.remaining}</td><td>{p.weightKg == null ? '—' : `${Number(p.weightKg).toLocaleString('tr-TR', { maximumFractionDigits: 3 })}${p.weightEstimated ? ' · Tahmini' : ''}`}</td><td>{p.lot || '—'}</td><td>{p.purchaseNumber || '—'}</td><td>{p.location || '—'}</td><td>{p.status}</td></tr>)}</tbody></table></div>;
  return <Card><details open={open} onToggle={e => setOpen(e.currentTarget.open)}><summary className="cursor-pointer p-6 text-sm font-bold">Kutular / Paketler</summary><div className="space-y-3 px-6 pb-6">
    {loading && <p role="status">Paketler yükleniyor…</p>}
    {error && <div role="alert"><p>{error}</p><button className="text-primary" onClick={() => setRetry(r => r+1)}>Tekrar dene</button></div>}
    {data && <><p className="font-bold">{data.bomTracked ? 'BOM üzerinden takip edilir' : `${data.physicalCount} kutu · ${data.remainingQuantity} ${data.baseUom === 'piece' ? 'adet' : data.baseUom}${data.distribution.length ? ` — ${data.distribution.map((d: any) => `${d.count}×${d.quantity}`).join(' + ')}` : ''}`}</p>
      {data.physical.length ? <details><summary className="cursor-pointer text-sm">Fiziksel paket detayları / geçmiş</summary>{table(data.physical)}</details> : <p className="text-sm text-text-muted">Fiziksel paket kaydı yok.</p>}
      <details><summary className="cursor-pointer text-sm">Henüz kabul edilmemiş planlanan paketler ({data.planned.length})</summary><p className="text-xs text-text-muted">Mevcut stok ve kutu toplamına dahil değildir.</p>{data.planned.length ? table(data.planned) : <p className="text-sm">Bekleyen paket planı yok.</p>}</details>
    </>}
  </div></details></Card>;
}
