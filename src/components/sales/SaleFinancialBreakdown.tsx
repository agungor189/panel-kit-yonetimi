import React from 'react';

const money = (minor: number | null | undefined, currency = 'TRY') => {
  if (minor === null || minor === undefined) return 'Bilinmiyor';
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency }).format(minor / 100);
};

const expenseLabels: Record<string, string> = {
  shipping: 'Kargo',
  packaging: 'Paketleme',
  advertising: 'Reklam',
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
  const rows = [
    ['Brüt satış', money(totals.grossMinor, currency)],
    ['KDV', money(totals.vatMinor, currency)],
    ['KDV hariç net gelir', money(totals.netRevenueMinor, currency)],
    ['Komisyon', money(totals.commissionMinor, currency)],
    ['Gerçek FIFO maliyeti', money(totals.actualCogsTryMinor, 'TRY')],
    ...Object.entries(expenseLabels).map(([key, label]) => {
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
