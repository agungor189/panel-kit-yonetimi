import React from 'react';

const money = (minor: number | null | undefined, currency = 'TRY') => {
  if (minor === null || minor === undefined) return 'Bilinmiyor';
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency }).format(minor / 100);
};

const expenseLabels: Record<string, string> = {
  shipping: 'Kargo',
  packaging: 'Paketleme',
  other: 'Diğer giderler',
};

const stateLabels: Record<string, string> = {
  COGS_PENDING: 'Maliyet bekleniyor',
  PROVISIONAL: 'Geçici',
  FINAL: 'Kesinleşti',
  LEGACY_UNSNAPSHOTTED: 'Eski kayıt — finansal anlık görüntü yok',
};

export function SaleFinancialBreakdown({ financial }: { financial: any }) {
  if (!financial || financial.state === 'LEGACY_UNSNAPSHOTTED') {
    return (
      <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5" data-testid="legacy-unsnapshotted">
        <h3 className="font-black text-amber-800">Finansal durum: {stateLabels.LEGACY_UNSNAPSHOTTED}</h3>
        <p className="mt-1 text-sm text-amber-700">KDV, komisyon, kur, gider veya maliyet tahmin edilmedi.</p>
      </section>
    );
  }

  const totals = financial.totals;
  const currency = financial.currency || 'TRY';
  const expenseEntries = Object.entries(expenseLabels);
  if (financial.expenses?.advertising) expenseEntries.splice(2, 0, ['advertising', 'Reklam (eski kayıt, katkıya dahil değil)']);
  const rows = [
    ['Brüt satış', money(totals.grossMinor, currency)],
    ['KDV', money(totals.vatMinor, currency)],
    ['KDV hariç net gelir', money(totals.netRevenueMinor, currency)],
    ['Komisyon', money(totals.commissionMinor, currency)],
    ['Gerçek FIFO maliyeti', money(totals.actualCogsTryMinor, 'TRY')],
    ...expenseEntries.map(([key, label]) => {
      const expense = financial.expenses?.[key];
      return [label, expense?.state === 'KNOWN' ? money(expense.amountTryMinor, 'TRY') : 'Bilinmiyor'];
    }),
    ['Brüt kâr', money(totals.grossProfitTryMinor, 'TRY')],
    ['Net katkı', financial.state === 'FINAL' ? money(totals.netContributionTryMinor, 'TRY') : 'Bilinmiyor'],
  ];

  return (
    <section className="rounded-2xl border border-gray-200 bg-gray-50 p-5" data-testid="sale-financial-breakdown">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-xs font-black uppercase tracking-widest text-gray-600">Satış Finansalları</h3>
        <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-black text-gray-700">
          {stateLabels[financial.state] || financial.state}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-gray-100 bg-white p-3">
            <dt className="text-[10px] font-bold uppercase tracking-wide text-gray-500">{label}</dt>
            <dd className="mt-1 font-black text-gray-800">{value}</dd>
          </div>
        ))}
      </dl>
      {financial.state === 'PROVISIONAL' && totals.provisionalNetContributionTryMinor !== null && (
        <p className="mt-3 text-xs font-semibold text-amber-700">
          Bilinen giderlerle geçici katkı: {money(totals.provisionalNetContributionTryMinor, 'TRY')}. Bu değer nihai net kâr değildir.
        </p>
      )}
      {financial.lines?.some((line: any) => line.kitVersion) && (
        <details className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4" open>
          <summary className="cursor-pointer text-sm font-black text-emerald-800">Satılan kit sürümü</summary>
          <div className="mt-3 space-y-2">
            {financial.lines.map((line: any) => line.kitVersion && (
              <div key={line.id} className="rounded-lg border border-emerald-100 bg-white p-3 text-xs">
                <strong>{line.productSku} · v{line.kitVersion.versionNumber}</strong>
                <span className={`ml-2 font-black ${line.kitVersion.current ? 'text-emerald-700' : 'text-amber-700'}`}>{line.kitVersion.current ? 'GÜNCEL' : 'ARTIK GÜNCEL DEĞİL'}</span>
                <p className="mt-1 text-gray-600">Sürüm kimliği: {line.kitVersion.publishedKitVersionId}</p>
                <p className="font-mono text-[10px] text-gray-500">{line.kitVersion.contentHash}</p>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <RecipeList title="Dondurulmuş BOM" rows={(line.kitVersion.snapshot?.components || []).map((item: any) => `${item.component_sku_snapshot} · ${item.quantity_base_int} ${item.base_uom_code_snapshot}`)} />
                  <RecipeList title="Dondurulmuş kesimler" rows={(line.kitVersion.snapshot?.cuts || []).map((cut: any) => `${cut.quantity} × ${cut.length_mm} mm (+${cut.kerf_mm} mm kerf)`)} />
                  <RecipeList title="Dondurulmuş paketler" rows={(line.kitVersion.snapshot?.packages || []).flatMap((pack: any) => pack.items.map((item: any) => `P${pack.package_number} · ${item.component_product_id} · ${item.quantity_base_int} ${item.base_uom_code_snapshot}`))} />
                </div>
                <p className="mt-2 font-bold text-gray-700">Maliyet {money(line.kitVersion.snapshot?.version?.canonical_cost_minor, line.kitVersion.snapshot?.version?.currency)} · Satış {money(line.kitVersion.snapshot?.version?.final_sale_price_minor, line.kitVersion.snapshot?.version?.currency)} · Kılavuz {line.kitVersion.snapshot?.version?.installation_guide_version}</p>
              </div>
            ))}
          </div>
        </details>
      )}
      {financial.lines?.some((line: any) => line.cogsAllocations?.length > 0) && (
        <details className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-black text-gray-700">Tüketilen lot / maliyet ayrıntısı</summary>
          <div className="mt-3 space-y-3">
            {financial.lines.map((line: any) => line.cogsAllocations?.length > 0 && (
              <div key={line.id}>
                <p className="text-xs font-black text-gray-700">{line.productSku} — {line.productTitle}</p>
                <ul className="mt-1 space-y-1 text-xs text-gray-600">
                  {line.cogsAllocations.map((allocation: any) => (
                    <li key={`${line.id}-${allocation.inventoryLotId}`} className="flex flex-wrap justify-between gap-2">
                      <span>Lot {allocation.inventoryLotId} · {allocation.quantityBaseInt} {allocation.baseUomCode}</span>
                      <span className="font-bold">{money(allocation.costTryMinor, 'TRY')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function RecipeList({ title, rows }: { title: string; rows: string[] }) {
  return <div><p className="font-black uppercase text-[10px] text-emerald-700">{title}</p><ul className="mt-1 space-y-1 text-gray-600">{rows.map((row, index) => <li key={`${title}-${index}`}>{row}</li>)}</ul></div>;
}
