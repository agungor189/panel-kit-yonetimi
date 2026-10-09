import { useMemo, useState } from 'react';
import { Input } from '../ui';

export type PurchaseTreeLine = {
  id: string; productId: string;
  product: { sku: string; title: string; supplierCode?: string | null; nameTr?: string | null; nameEn?: string | null;
    material?: string | null; profileType?: string | null; size?: string | null; productType?: string | null };
  quote: { originalQuantity: string; supplierUnitPriceMinor: number; currency: string };
  normalizedQuantity: { baseUomCode: string };
  sourceLineAmountMinor?: number | null;
  plannedPackages?: { count: number; mixedCount: number; distribution: Array<{ quantity: number; count: number }> } | null;
  packing?: { boxCount: number; unitsPerBox: number; totalWeightKg: number } | null;
};
type Lot = { lineId: string; landedCostTryMinor: number; merchandiseCostTryMinor: number;
  normalizedAcquisitionUnitCostTry: { numerator: number; denominator: number } };
export type DraftPricing = {
  readOnly: true; landedUsdMinor:number|null; currency: string | null; fxPending: boolean;
  lines: Array<{ lineId:string; merchandiseMinor:number|null; allocatedExpenseMinor:number|null;
    totalMinor:number|null; unitCost:{numerator:number;denominator:number}|null }>;
  totals: { merchandiseMinor:number|null; additionalMinor:number|null; landedMinor:number|null };
  fx: { numerator:number; denominator:number; observedAt:string } | null;
  projectionHash:string;
};
const money = (minor:number|null, currency:string) => minor === null ? 'Kur bekleniyor' : new Intl.NumberFormat('tr-TR',{style:'currency',currency}).format(minor/100);

export function PurchaseProductRow({ line, lot, pricing, estimate, showLandedCost=Boolean(pricing || lot) }: { line:PurchaseTreeLine; lot?:Lot;
  pricing?:DraftPricing; estimate?:DraftPricing['lines'][number]; showLandedCost?:boolean }) {
  const currency = pricing?.currency;
  return <tr className="border-t"><td className="min-w-48 py-3 font-bold">{line.product.sku}<small className="block font-normal text-text-muted">Tedarik no {line.product.supplierCode || '—'} · {line.product.nameTr || line.product.nameEn || line.product.title}</small></td>
    <td>{line.quote.originalQuantity} {line.normalizedQuantity.baseUomCode}</td>
    <td>{line.plannedPackages ? <span>{line.plannedPackages.count} paket · {line.plannedPackages.distribution.map(entry => `${entry.count}×${entry.quantity}`).join(' + ')}{line.plannedPackages.mixedCount > 0 && <small className="block text-text-muted">{line.plannedPackages.mixedCount} karışık kaynak koliden ayrılacak</small>}</span> : line.packing ? `${line.packing.boxCount} koli × ${line.packing.unitsPerBox}` : '—'}</td>
    <td className="min-w-40 px-3"><span>Birim: {money(line.quote.supplierUnitPriceMinor,line.quote.currency)}</span><strong className="block">Toplam: {line.sourceLineAmountMinor == null ? '—' : money(line.sourceLineAmountMinor,line.quote.currency)}</strong></td>
    {showLandedCost && <td className="min-w-48 border-l px-3">{pricing ? currency && estimate?.unitCost ? <span>Birim: {money(estimate.unitCost.numerator/estimate.unitCost.denominator,currency)}<strong className="block text-primary">Toplam: {money(estimate.totalMinor,currency)}</strong><small className="block text-text-muted">Dağıtılan ek gider: {money(estimate.allocatedExpenseMinor,currency)}</small>{pricing.fxPending && <small className="block text-text-muted">{currency === 'TRY' ? 'USD' : 'TL'} karşılığı: Kur bekleniyor</small>}</span> : 'Kur bekleniyor' : lot ? <span>Birim: {tryMoney(lot.normalizedAcquisitionUnitCostTry.numerator/lot.normalizedAcquisitionUnitCostTry.denominator)}<strong className="block">Toplam: {tryMoney(lot.landedCostTryMinor)}</strong><small className="block text-text-muted">Ek gider: {tryMoney(lot.landedCostTryMinor-lot.merchandiseCostTryMinor)}</small></span> : 'Bekliyor'}</td>}
  </tr>;
}

type Group = { key: string; name: string; totalUsdMinor: number | null; productCount: number; lineCount: number; children: Group[]; lines: PurchaseTreeLine[] };
const materialOrder = ['Aluminum','Cast Iron','Premium Cast Iron','Carbon Steel','PPR'];
const label = (value?: string | null) => value?.trim() || 'Belirtilmemiş';
const usd = (minor: number | null) => minor === null ? '—' : new Intl.NumberFormat('tr-TR',{ style:'currency',currency:'USD' }).format(minor/100);
const tryMoney = (minor: number) => new Intl.NumberFormat('tr-TR',{ style:'currency',currency:'TRY' }).format(minor/100);
const lineUsd = (line: PurchaseTreeLine) => line.quote.currency === 'USD' && Number.isSafeInteger(line.sourceLineAmountMinor)
  ? line.sourceLineAmountMinor! : null;
const totals = (lines: PurchaseTreeLine[]) => {
  const amounts = lines.map(lineUsd);
  const total = amounts.every(amount => amount !== null) ? amounts.reduce((sum,amount) => sum + amount!,0) : null;
  return { totalUsdMinor: total !== null && Number.isSafeInteger(total) ? total : null,
    productCount: new Set(lines.map(line => line.productId)).size, lineCount: lines.length };
};
const group = (lines: PurchaseTreeLine[], level: number, parentKey: string): Group[] => {
  if (level > 2) return [];
  const getName = [(line: PurchaseTreeLine) => label(line.product.material),
    (line: PurchaseTreeLine) => label(line.product.profileType),
    (line: PurchaseTreeLine) => label(line.product.size)][level];
  const buckets = new Map<string,PurchaseTreeLine[]>();
  for (const line of lines) {
    const name = getName(line), current = buckets.get(name) || [];
    current.push(line); buckets.set(name,current);
  }
  return [...buckets].sort(([a],[b]) => level === 0
    ? (materialOrder.indexOf(a) < 0 ? 99 : materialOrder.indexOf(a)) - (materialOrder.indexOf(b) < 0 ? 99 : materialOrder.indexOf(b)) || a.localeCompare(b,'tr')
    : a.localeCompare(b,'tr',{ numeric:true })).map(([name,children]) => ({
      key: `${parentKey}/${name}`, name, ...totals(children), children: group(children,level+1,`${parentKey}/${name}`), lines: level === 2 ? children : [],
    }));
};
export const groupPurchaseLines = (lines: PurchaseTreeLine[]) => ({ ...totals(lines), materials: group(lines,0,'material') });

export function PurchaseProductTree({ lines, lots, pricing, isDraft=false }: { lines: PurchaseTreeLine[]; lots: Lot[]; pricing?:DraftPricing; isDraft?:boolean }) {
  const [search,setSearch] = useState('');
  const [expanded,setExpanded] = useState<Set<string>>(new Set());
  const [collapsedSearch,setCollapsedSearch] = useState<Set<string>>(new Set());
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('tr-TR');
    return term ? lines.filter(line => [line.product.sku,line.product.supplierCode,line.product.nameTr,line.product.nameEn,
      line.product.title,line.product.material,line.product.profileType,line.product.size].some(value => value?.toLocaleLowerCase('tr-TR').includes(term))) : lines;
  },[lines,search]);
  const tree = useMemo(() => groupPurchaseLines(filtered),[filtered]);
  const estimates = useMemo(() => new Map(pricing?.lines.map(line => [line.lineId,line]) || []),[pricing]);
  const lotByLine = useMemo(() => new Map(lots.map(lot => [lot.lineId,lot])),[lots]);
  const allKeys = (groups: Group[]): string[] => groups.flatMap(item => [item.key,...allKeys(item.children)]);
  const toggle = (key: string) => {
    const setter = search.trim() ? setCollapsedSearch : setExpanded;
    setter(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  };
  const groupLines = (item:Group):PurchaseTreeLine[] => item.lines.length ? item.lines : item.children.flatMap(groupLines);
  const landedTotal = (item:Group) => {
    if (!pricing?.currency) return null;
    const amounts = groupLines(item).map(line => estimates.get(line.id)?.totalMinor ?? null);
    return amounts.every(amount => amount !== null) ? amounts.reduce((sum,amount) => sum+amount!,0) : null;
  };
  const showLandedCost = Boolean(pricing) || !isDraft;
  const render = (items: Group[], level: number): React.ReactNode => items.map(item => {
    const open = search.trim() ? !collapsedSearch.has(item.key) : expanded.has(item.key);
    return <div key={item.key} className={level ? 'ml-3 border-l border-border-color pl-3' : 'border-t border-border-color'}>
      <button type="button" aria-expanded={open} onClick={() => toggle(item.key)} className="flex w-full items-center justify-between gap-3 py-3 text-left hover:text-primary">
        <span className="font-bold">{open ? '▾' : '▸'} {level === 2 ? item.name.replace(/(\d)\s*x\s*(\d)/gi,'$1×$2') : item.name}</span>
        <span className="flex flex-wrap justify-end gap-x-3 text-xs text-text-muted"><span>{item.productCount} ürün · {item.lineCount} alış satırı</span><span>Alış <strong className="text-text-main">{usd(item.totalUsdMinor)}</strong></span>{pricing?.currency && <span>Landed <strong className="text-primary">{money(landedTotal(item),pricing.currency)}</strong></span>}</span>
      </button>
      {open && (level < 2 ? render(item.children,level+1) : <div className="overflow-x-auto pb-3"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-text-muted"><th>SKU / Ürün</th><th>Miktar</th><th>Paketleme</th><th className="px-3">ALIŞ FİYATI</th>{showLandedCost && <th className="border-l px-3">{pricing ? 'LANDED COST ÖNİZLEME' : 'FINAL LANDED COST'}</th>}</tr></thead><tbody>{item.lines.map(line => <PurchaseProductRow key={line.id} line={line} lot={lotByLine.get(line.id)} pricing={pricing} estimate={estimates.get(line.id)} showLandedCost={showLandedCost}/>)}</tbody></table></div>)}
    </div>;
  });
  return <div className="space-y-3">{pricing && <div className="grid gap-3 rounded-xl bg-bg-main p-4 md:grid-cols-2">
    <div><h4 className="text-sm font-bold">Toplam Alış Bedeli</h4><strong className="text-lg">{lines.length && lines.every(line => line.quote.currency === lines[0].quote.currency && line.sourceLineAmountMinor != null) ? money(lines.reduce((sum,line) => sum+line.sourceLineAmountMinor!,0),lines[0].quote.currency) : '—'}</strong>{pricing.currency === 'TRY' && <small className="block text-text-muted">{money(pricing.totals.merchandiseMinor,'TRY')}</small>}</div>
    <div><h4 className="text-sm font-bold">Tahmini Toplam Landed Cost</h4><strong className="text-lg text-primary">{pricing.currency ? money(pricing.totals.landedMinor,pricing.currency) : 'Kur bekleniyor'}</strong><small className="block text-text-muted">Ek gider: {pricing.currency ? money(pricing.totals.additionalMinor,pricing.currency) : 'Kur bekleniyor'}{pricing.currency === 'TRY' && pricing.fx && pricing.landedUsdMinor !== null ? ` · Yaklaşık ${money(pricing.landedUsdMinor,'USD')}` : ''}</small></div>
    <p className="text-xs text-text-muted md:col-span-2">Salt okunur tahmin · {pricing.fx ? `${(pricing.fx.numerator/pricing.fx.denominator).toLocaleString('tr-TR')} TL/USD · ${pricing.fx.observedAt}` : 'TL/USD karşılığı: Kur bekleniyor'}. FINAL maliyet onayı değildir.</p>
  </div>}<div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="font-black">Ürünler</h4><p className="text-xs text-text-muted">{tree.productCount} ürün · {tree.lineCount} alış satırı · {usd(tree.totalUsdMinor)}</p></div><div className="flex flex-wrap gap-2"><Input aria-label="Ürün ara" placeholder="SKU, tedarik no veya ürün ara" value={search} onChange={event => { setSearch(event.target.value); setCollapsedSearch(new Set()); }}/><button type="button" className="rounded-lg border px-3 text-xs font-bold" onClick={() => { setExpanded(new Set(allKeys(tree.materials))); setCollapsedSearch(new Set()); }}>Tümünü Aç</button><button type="button" className="rounded-lg border px-3 text-xs font-bold" onClick={() => { setSearch(''); setExpanded(new Set()); setCollapsedSearch(new Set()); }}>Tümünü Kapat</button></div></div>{tree.materials.length ? render(tree.materials,0) : <p className="text-sm text-text-muted">Eşleşen ürün yok.</p>}</div>;
}
