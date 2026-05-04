import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock3,
  FileDown,
  Filter,
  PackageOpen,
  RefreshCw,
  Search,
  Truck,
  User,
  XCircle,
} from 'lucide-react';
import { useCurrency } from '../../CurrencyContext';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type OrderTab = 'all' | 'new' | 'shipping' | 'delivered' | 'problem' | 'missing_shipping';
type SortKey = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc' | 'customer_asc';

type OrderFilters = {
  customer: string;
  orderNo: string;
  platformOrderNo: string;
  trackingNo: string;
  shippingCompany: string;
  channel: string;
  product: string;
  startDate: string;
  endDate: string;
};

const emptyFilters: OrderFilters = {
  customer: '',
  orderNo: '',
  platformOrderNo: '',
  trackingNo: '',
  shippingCompany: '',
  channel: '',
  product: '',
  startDate: '',
  endDate: '',
};

const finalStatuses = ['İptal Edildi', 'İade Edildi'];
const deliveredStatuses = ['Tamamlandı'];

const normalizeSearchText = (value: unknown) => String(value || '').toLocaleLowerCase('tr-TR');

const getSaleDate = (sale: any) => new Date(sale.created_at || sale.date || 0);

const getOrderCode = (sale: any) => sale.order_code || sale.id?.slice(0, 8)?.toUpperCase() || '-';

const isFinalSale = (sale: any) => finalStatuses.includes(sale.status);

const isDelayedSale = (sale: any) => {
  if (sale.status !== 'Hazırlanıyor') return false;
  const saleDate = getSaleDate(sale);
  if (Number.isNaN(saleDate.getTime())) return false;
  return Date.now() - saleDate.getTime() > 24 * 60 * 60 * 1000;
};

const isMissingShippingInfo = (sale: any) => {
  if (isFinalSale(sale) || deliveredStatuses.includes(sale.status)) return false;
  return !String(sale.shipping_company || '').trim() || !String(sale.tracking_number || '').trim();
};

const matchesTab = (sale: any, tab: OrderTab) => {
  if (tab === 'all') return true;
  if (tab === 'new') return sale.status === 'Hazırlanıyor';
  if (tab === 'shipping') return sale.status === 'Gönderildi';
  if (tab === 'delivered') return sale.status === 'Tamamlandı';
  if (tab === 'problem') return isFinalSale(sale);
  if (tab === 'missing_shipping') return isMissingShippingInfo(sale);
  return true;
};

const getSaleStatusClass = (status?: string) => {
  switch (status) {
    case 'Hazırlanıyor':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'Gönderildi':
      return 'border-blue-200 bg-blue-50 text-blue-700';
    case 'Tamamlandı':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'İptal Edildi':
      return 'border-slate-300 bg-slate-100 text-slate-700';
    case 'İade Edildi':
      return 'border-red-200 bg-red-50 text-red-700';
    default:
      return 'border-gray-200 bg-gray-50 text-gray-700';
  }
};

const getStatusIcon = (status?: string) => {
  switch (status) {
    case 'Hazırlanıyor':
      return <Clock3 className="h-3.5 w-3.5" />;
    case 'Gönderildi':
      return <Truck className="h-3.5 w-3.5" />;
    case 'Tamamlandı':
      return <CheckCircle2 className="h-3.5 w-3.5" />;
    case 'İptal Edildi':
    case 'İade Edildi':
      return <XCircle className="h-3.5 w-3.5" />;
    default:
      return <ClipboardList className="h-3.5 w-3.5" />;
  }
};

const filterInputClass =
  'h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-primary focus:ring-2 focus:ring-primary/15';

const escapeCsvCell = (value: unknown) => {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
};

export default function SalesList({ refreshKey = 0, onSaleClick }: { refreshKey?: number; onSaleClick?: (sale: any) => void }) {
  const { FormatAmount } = useCurrency();
  const [sales, setSales] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<OrderTab>('new');
  const [filters, setFilters] = useState<OrderFilters>(emptyFilters);
  const [draftFilters, setDraftFilters] = useState<OrderFilters>(emptyFilters);
  const [sortKey, setSortKey] = useState<SortKey>('date_desc');
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    loadSales();
  }, [refreshKey]);

  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [activeTab, filters, sortKey, pageSize]);

  const loadSales = async () => {
    setLoading(true);
    try {
      const data = await api.get('/sales');
      setSales(Array.isArray(data) ? data : []);
      setLastUpdated(new Date());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const tabOptions = useMemo(() => {
    const count = (tab: OrderTab) => sales.filter((sale) => matchesTab(sale, tab)).length;
    return [
      { key: 'all' as const, label: 'Tüm Siparişler', count: count('all') },
      { key: 'new' as const, label: 'Yeni', count: count('new') },
      { key: 'shipping' as const, label: 'Kargoda', count: count('shipping') },
      { key: 'delivered' as const, label: 'Teslim Edilen', count: count('delivered') },
      { key: 'problem' as const, label: 'İptal / İade', count: count('problem') },
      { key: 'missing_shipping' as const, label: 'Eksik Kargo', count: count('missing_shipping') },
    ];
  }, [sales]);

  const stats = useMemo(() => {
    const delayed = sales.filter(isDelayedSale).length;
    const readyToShip = sales.filter((sale) => sale.status === 'Hazırlanıyor').length;
    const missingShipping = sales.filter(isMissingShippingInfo).length;
    const activeOrders = sales.filter((sale) => !isFinalSale(sale) && sale.status !== 'Tamamlandı').length;
    return { delayed, readyToShip, missingShipping, activeOrders };
  }, [sales]);

  const filteredSales = useMemo(() => {
    const startDate = filters.startDate ? new Date(`${filters.startDate}T00:00:00`) : null;
    const endDate = filters.endDate ? new Date(`${filters.endDate}T23:59:59`) : null;

    const result = sales.filter((sale) => {
      if (!matchesTab(sale, activeTab)) return false;

      const saleDate = getSaleDate(sale);
      if (startDate && (!saleDate || saleDate < startDate)) return false;
      if (endDate && (!saleDate || saleDate > endDate)) return false;

      const checks = [
        [filters.customer, [sale.customer_name, sale.customer_phone]],
        [filters.orderNo, [sale.order_code, sale.id]],
        [filters.platformOrderNo, [sale.external_order_id]],
        [filters.trackingNo, [sale.tracking_number]],
        [filters.shippingCompany, [sale.shipping_company]],
        [filters.channel, [sale.platform]],
        [
          filters.product,
          (sale.items || []).flatMap((item: any) => [item.product_name, item.product_id]),
        ],
      ] as const;

      return checks.every(([needle, haystack]) => {
        const query = normalizeSearchText(needle).trim();
        if (!query) return true;
        return haystack.map(normalizeSearchText).join(' ').includes(query);
      });
    });

    return [...result].sort((a, b) => {
      if (sortKey === 'date_asc') return getSaleDate(a).getTime() - getSaleDate(b).getTime();
      if (sortKey === 'amount_desc') return Number(b.net_total || b.total_amount || 0) - Number(a.net_total || a.total_amount || 0);
      if (sortKey === 'amount_asc') return Number(a.net_total || a.total_amount || 0) - Number(b.net_total || b.total_amount || 0);
      if (sortKey === 'customer_asc') return String(a.customer_name || '').localeCompare(String(b.customer_name || ''), 'tr');
      return getSaleDate(b).getTime() - getSaleDate(a).getTime();
    });
  }, [activeTab, filters, sales, sortKey]);

  const totalPages = Math.max(1, Math.ceil(filteredSales.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedSales = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredSales.slice(start, start + pageSize);
  }, [filteredSales, pageSize, safePage]);

  const selectedOnPage = pagedSales.length > 0 && pagedSales.every((sale) => selectedIds.has(sale.id));

  const updateDraftFilter = (field: keyof OrderFilters, value: string) => {
    setDraftFilters((prev) => ({ ...prev, [field]: value }));
  };

  const applyFilters = () => {
    setFilters(draftFilters);
  };

  const clearFilters = () => {
    setDraftFilters(emptyFilters);
    setFilters(emptyFilters);
  };

  const toggleSelected = (saleId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(saleId)) {
        next.delete(saleId);
      } else {
        next.add(saleId);
      }
      return next;
    });
  };

  const togglePageSelection = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selectedOnPage) {
        pagedSales.forEach((sale) => next.delete(sale.id));
      } else {
        pagedSales.forEach((sale) => next.add(sale.id));
      }
      return next;
    });
  };

  const exportFilteredSales = () => {
    const headers = [
      'Sipariş Kodu',
      'Platform Sipariş No',
      'Müşteri',
      'Telefon',
      'Kanal',
      'Kargo Firması',
      'Takip No',
      'Durum',
      'Toplam Adet',
      'Toplam Ağırlık',
      'Net Toplam',
      'Net Kar',
      'Tarih',
      'Ürünler',
    ];

    const rows = filteredSales.map((sale) => [
      getOrderCode(sale),
      sale.external_order_id || '',
      sale.customer_name || '',
      sale.customer_phone || '',
      sale.platform || 'Satış Sistemi',
      sale.shipping_company || '',
      sale.tracking_number || '',
      sale.status || 'Hazırlanıyor',
      sale.total_quantity || 0,
      sale.total_weight || 0,
      sale.net_total || sale.total_amount || 0,
      sale.net_profit || 0,
      getSaleDate(sale).toLocaleString('tr-TR'),
      (sale.items || []).map((item: any) => `${item.product_name} x${item.quantity}`).join(' | '),
    ]);

    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map(escapeCsvCell).join(';')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dsdst-siparisler-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-500 shadow-sm">
        <RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin text-primary" />
        <div className="font-black">Siparişler yükleniyor...</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 lg:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-black uppercase tracking-wider text-slate-500">Aktif İşlem</div>
          <div className="mt-2 flex items-end justify-between gap-3">
            <div className="text-2xl font-black text-slate-900">{stats.activeOrders} Adet</div>
            <ClipboardList className="h-6 w-6 text-primary" />
          </div>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <div className="text-xs font-black uppercase tracking-wider text-amber-700">Geciken Siparişler</div>
          <div className="mt-2 flex items-end justify-between gap-3">
            <div className="text-2xl font-black text-amber-900">{stats.delayed} Adet</div>
            <AlertTriangle className="h-6 w-6 text-amber-600" />
          </div>
        </div>
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 shadow-sm">
          <div className="text-xs font-black uppercase tracking-wider text-blue-700">Kargo Bekleyen</div>
          <div className="mt-2 flex items-end justify-between gap-3">
            <div className="text-2xl font-black text-blue-950">{stats.readyToShip} Adet</div>
            <Truck className="h-6 w-6 text-blue-600" />
          </div>
        </div>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 shadow-sm">
          <div className="text-xs font-black uppercase tracking-wider text-red-700">Eksik Kargo Bilgisi</div>
          <div className="mt-2 flex items-end justify-between gap-3">
            <div className="text-2xl font-black text-red-950">{stats.missingShipping} Adet</div>
            <XCircle className="h-6 w-6 text-red-600" />
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex overflow-x-auto border-b border-slate-200 bg-white">
          {tabOptions.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex shrink-0 items-center gap-2 border-b-2 px-5 py-4 text-sm font-black transition-colors',
                activeTab === tab.key
                  ? 'border-orange-500 text-orange-600'
                  : 'border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              )}
            >
              {tab.label}
              <span className={cn(
                'rounded-full px-2 py-0.5 text-[11px]',
                activeTab === tab.key ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-500'
              )}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        <div className="border-b border-slate-200 bg-slate-50/70 p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-black text-slate-700">
            <Filter className="h-4 w-4 text-primary" />
            Sipariş Filtreleri
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-slate-500">Müşteri Adı</label>
              <input value={draftFilters.customer} onChange={(event) => updateDraftFilter('customer', event.target.value)} placeholder="Müşteri adı" className={filterInputClass} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-slate-500">Sipariş No</label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input value={draftFilters.orderNo} onChange={(event) => updateDraftFilter('orderNo', event.target.value)} placeholder="DSDST sipariş kodu" className={cn(filterInputClass, 'pl-9')} />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-slate-500">Platform Sipariş No</label>
              <input value={draftFilters.platformOrderNo} onChange={(event) => updateDraftFilter('platformOrderNo', event.target.value)} placeholder="Pazar yeri no" className={filterInputClass} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-slate-500">Kargo / Barkod</label>
              <input value={draftFilters.trackingNo} onChange={(event) => updateDraftFilter('trackingNo', event.target.value)} placeholder="Takip no" className={filterInputClass} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-slate-500">Kargo Firması</label>
              <input value={draftFilters.shippingCompany} onChange={(event) => updateDraftFilter('shippingCompany', event.target.value)} placeholder="Yurtiçi, MNG..." className={filterInputClass} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-slate-500">Satış Kanalı</label>
              <input value={draftFilters.channel} onChange={(event) => updateDraftFilter('channel', event.target.value)} placeholder="Trendyol, Website..." className={filterInputClass} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-slate-500">Başlangıç Tarihi</label>
              <input type="date" value={draftFilters.startDate} onChange={(event) => updateDraftFilter('startDate', event.target.value)} className={filterInputClass} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-slate-500">Bitiş Tarihi</label>
              <input type="date" value={draftFilters.endDate} onChange={(event) => updateDraftFilter('endDate', event.target.value)} className={filterInputClass} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-slate-500">Ürün / Model</label>
              <input value={draftFilters.product} onChange={(event) => updateDraftFilter('product', event.target.value)} placeholder="Ürün adı veya model" className={filterInputClass} />
            </div>
            <div className="flex items-end gap-2">
              <button type="button" onClick={clearFilters} className="h-11 flex-1 rounded-lg border border-slate-900 px-4 text-sm font-black text-slate-800 transition hover:bg-slate-100">
                Temizle
              </button>
              <button type="button" onClick={applyFilters} className="h-11 flex-1 rounded-lg bg-slate-900 px-4 text-sm font-black text-white transition hover:bg-slate-800">
                Filtrele
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 border-b border-slate-200 bg-white px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="text-xl font-black text-slate-900">
              {tabOptions.find((tab) => tab.key === activeTab)?.label || 'Siparişler'}
            </div>
            <div className="mt-1 text-sm font-semibold text-slate-500">
              Filtreleme Sonuçları: <span className="font-black text-slate-800">Toplam {filteredSales.length} sipariş bilgisi</span>
              {lastUpdated && <span className="ml-2">Son güncelleme: {lastUpdated.toLocaleString('tr-TR')}</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={selectedIds.size === 0}
              className="h-10 rounded-lg bg-orange-200 px-4 text-sm font-black text-orange-800 transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              Seçili: {selectedIds.size}
            </button>
            <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)} className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-black text-slate-700 outline-none">
              <option value="date_desc">Sipariş Tarihi (Yeniden Eskiye)</option>
              <option value="date_asc">Sipariş Tarihi (Eskiden Yeniye)</option>
              <option value="amount_desc">Tutar (Yüksekten Düşüğe)</option>
              <option value="amount_asc">Tutar (Düşükten Yükseğe)</option>
              <option value="customer_asc">Müşteri (A-Z)</option>
            </select>
            <button
              type="button"
              onClick={exportFilteredSales}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-900 px-4 text-sm font-black text-slate-800 transition hover:bg-slate-100"
            >
              <FileDown className="h-4 w-4" />
              Excel ile İndir
            </button>
            <button
              type="button"
              onClick={loadSales}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-black text-slate-600 transition hover:bg-slate-100"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] text-left text-sm">
            <thead className="border-b border-slate-300 bg-slate-100 text-[11px] font-black uppercase tracking-wider text-slate-600">
              <tr>
                <th className="w-12 px-4 py-4">
                  <input
                    type="checkbox"
                    checked={selectedOnPage}
                    onChange={togglePageSelection}
                    className="h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary"
                  />
                </th>
                <th className="px-4 py-4">Sipariş Bilgileri</th>
                <th className="px-4 py-4">Alıcı</th>
                <th className="px-4 py-4">Bilgiler</th>
                <th className="px-4 py-4 text-right">Birim / Tutar</th>
                <th className="px-4 py-4">Kargo</th>
                <th className="px-4 py-4">Fatura</th>
                <th className="px-4 py-4">Durum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {pagedSales.map((sale) => {
                const itemCount = (sale.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0) || sale.total_quantity || 0;
                const firstItem = sale.items?.[0];
                const moreItems = Math.max(0, (sale.items?.length || 0) - 1);
                const isProblem = isFinalSale(sale);
                return (
                  <tr
                    key={sale.id}
                    onClick={() => onSaleClick && onSaleClick(sale)}
                    className="cursor-pointer transition-colors hover:bg-slate-50"
                  >
                    <td className="px-4 py-5 align-top" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(sale.id)}
                        onChange={() => toggleSelected(sale.id)}
                        className="h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary"
                      />
                    </td>
                    <td className="px-4 py-5 align-top">
                      <div className="inline-flex rounded-md bg-slate-900 px-2.5 py-1 font-mono text-xs font-black tracking-wide text-white">
                        {getOrderCode(sale)}
                      </div>
                      {sale.external_order_id && (
                        <div className="mt-2 text-xs font-black text-slate-600">
                          Platform No: <span className="font-mono">{sale.external_order_id}</span>
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                        <CalendarDays className="h-3.5 w-3.5" />
                        {getSaleDate(sale).toLocaleString('tr-TR')}
                      </div>
                      <div className="mt-2 inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-black text-blue-700">
                        {sale.platform || 'Satış Sistemi'}
                      </div>
                    </td>
                    <td className="px-4 py-5 align-top">
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100">
                          <User className="h-4 w-4 text-slate-500" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-black text-slate-900" title={sale.customer_name}>
                            {sale.customer_name || '-'}
                          </div>
                          <div className="mt-1 text-xs font-semibold text-slate-500">{sale.customer_phone || 'Telefon yok'}</div>
                          {sale.customer_address && (
                            <div className="mt-2 line-clamp-2 max-w-[220px] text-xs font-medium text-slate-500" title={sale.customer_address}>
                              {sale.customer_address}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-5 align-top">
                      <div className="font-black text-slate-900">{firstItem?.product_name || 'Ürün bilgisi yok'}</div>
                      {moreItems > 0 && <div className="mt-1 text-xs font-black text-primary">+{moreItems} ürün daha</div>}
                      <div className="mt-3 flex flex-wrap gap-2 text-xs font-black">
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">{itemCount} Adet</span>
                        <span className="rounded-full bg-orange-50 px-2.5 py-1 text-orange-700">
                          {sale.total_weight ? `${Number(sale.total_weight).toFixed(2)} kg` : 'Kg yok'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-5 text-right align-top">
                      <div className="text-xs font-black uppercase tracking-wider text-slate-500">Net Toplam</div>
                      <div className="mt-1 text-lg font-black text-primary">
                        <FormatAmount amount={Number(sale.net_total || sale.total_amount || 0)} exchangeRateAtTransaction={sale.exchange_rate_at_transaction} />
                      </div>
                      <div className={cn('mt-2 text-xs font-black', isProblem || Number(sale.net_profit || 0) < 0 ? 'text-red-600' : 'text-emerald-600')}>
                        Kar: <FormatAmount amount={Number(sale.net_profit || 0)} exchangeRateAtTransaction={sale.exchange_rate_at_transaction} />
                      </div>
                    </td>
                    <td className="px-4 py-5 align-top">
                      <div className="flex items-start gap-2">
                        <Truck className={cn('mt-0.5 h-4 w-4', isMissingShippingInfo(sale) ? 'text-red-500' : 'text-slate-500')} />
                        <div>
                          <div className="font-black text-slate-900">{sale.shipping_company || 'Kargo firması yok'}</div>
                          <div className="mt-1 font-mono text-xs font-bold text-slate-500">{sale.tracking_number || 'Takip no yok'}</div>
                          {isMissingShippingInfo(sale) && (
                            <div className="mt-2 inline-flex rounded-full bg-red-50 px-2 py-1 text-[11px] font-black text-red-700">
                              Bilgi eksik
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-5 align-top">
                      <div className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-600">
                        Kayıt Yok
                      </div>
                      <div className="mt-2 text-xs font-semibold text-slate-500">Fatura entegrasyonu bekliyor</div>
                    </td>
                    <td className="px-4 py-5 align-top">
                      <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-black uppercase tracking-wider', getSaleStatusClass(sale.status))}>
                        {getStatusIcon(sale.status)}
                        {sale.status || 'Hazırlanıyor'}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {pagedSales.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-6 py-20 text-center">
                    <PackageOpen className="mx-auto h-16 w-16 text-orange-300" />
                    <div className="mt-5 text-2xl font-black text-slate-900">Sipariş bulunmamaktadır.</div>
                    <div className="mt-2 text-sm font-semibold text-slate-500">
                      Filtreleri temizleyebilir veya farklı bir durum sekmesi seçebilirsin.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-4 border-t border-slate-200 bg-white px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="text-sm font-bold text-slate-500">
            {filteredSales.length > 0
              ? `${(safePage - 1) * pageSize + 1}-${Math.min(safePage * pageSize, filteredSales.length)} / ${filteredSales.length} sipariş`
              : '0 sipariş'}
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm font-black text-slate-700">Her Sayfada</label>
            <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-black text-slate-700 outline-none">
              <option value={20}>20 Ürün</option>
              <option value={50}>50 Ürün</option>
              <option value={100}>100 Ürün</option>
            </select>
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={safePage <= 1}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="min-w-14 text-center text-sm font-black text-slate-700">{safePage}/{totalPages}</div>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={safePage >= totalPages}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
