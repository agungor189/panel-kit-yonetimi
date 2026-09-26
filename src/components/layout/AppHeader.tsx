import { AlertTriangle, Bell, Menu, RefreshCw, Search } from 'lucide-react';
import type { CurrencyView } from '../../CurrencyContext';
import type { UserRole } from '../../types';
import { cn } from '../ui';

type AppHeaderProps = {
  currentViewLabel: string;
  userRole: UserRole;
  viewCurrency: CurrencyView;
  activeRate: number;
  rateSource: string | null;
  rateFetchedAt: string | null;
  isRateLoading: boolean;
  isRateError: boolean;
  onOpenMobileMenu: () => void;
  onCurrencyChange: (currency: CurrencyView) => void;
  onRefreshRate: () => void;
};

export function AppHeader({
  currentViewLabel,
  userRole,
  viewCurrency,
  activeRate,
  rateSource,
  rateFetchedAt,
  isRateLoading,
  isRateError,
  onOpenMobileMenu,
  onCurrencyChange,
  onRefreshRate,
}: AppHeaderProps) {
  return (
    <div className="sticky top-0 z-40 border-b border-border-color bg-white shadow-sm">
      <header className="flex h-16 items-center justify-between px-4 md:px-8">
        <div className="flex items-center space-x-4 md:space-x-6">
          <button
            onClick={onOpenMobileMenu}
            className="p-2 text-text-muted transition-colors hover:text-primary md:hidden"
            aria-label="Menüyü aç"
          >
            <Menu className="h-6 w-6" />
          </button>
          <h2 className="truncate text-base font-semibold text-text-main md:text-lg">{currentViewLabel}</h2>
        </div>

        <div className="flex items-center space-x-2 md:space-x-6">
          <div
            className="group relative hidden items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-1.5 transition-all hover:bg-gray-100 md:flex"
            title={`Kaynak: ${rateSource || 'Bilinmiyor'}`}
          >
            {isRateError && <AlertTriangle className="h-4 w-4 text-red-500" />}
            <span className="whitespace-nowrap text-sm font-bold text-gray-700">
              USD/TRY: ₺{activeRate?.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            {rateFetchedAt && (
              <span className="whitespace-nowrap text-[10px] font-medium text-gray-500">
                · Son güncelleme: {new Date(rateFetchedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button onClick={onRefreshRate} disabled={isRateLoading} className="ml-1 rounded-md p-1 transition-colors hover:bg-gray-200 disabled:opacity-50">
              <RefreshCw className={cn('h-3.5 w-3.5 text-gray-500', isRateLoading && 'animate-spin')} />
            </button>
          </div>

          <CurrencyToggle viewCurrency={viewCurrency} onChange={onCurrencyChange} />

          <div className="search-bar-container relative hidden md:block">
            <input
              type="text"
              placeholder="Ürün Ara..."
              className="w-40 rounded-lg border border-border-color bg-bg-main py-1.5 pl-9 pr-4 text-sm outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20 md:w-60"
            />
            <Search className="absolute left-3 top-2 h-4 w-4 text-text-muted" />
          </div>
          <button className="p-2 text-text-muted transition-colors hover:text-primary" aria-label="Bildirimler">
            <Bell className="h-5 w-5" />
          </button>
          <div className="flex items-center space-x-2 border-l border-border-color pl-2 md:space-x-3 md:pl-6">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white">
              {userRole === 'admin' ? 'AD' : userRole === 'readonly' ? 'RO' : 'US'}
            </div>
            <span className="hidden text-sm font-semibold capitalize text-text-main sm:inline">{userRole}</span>
          </div>
        </div>
      </header>

      <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50 px-4 py-2.5 sm:hidden">
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap text-xs font-bold text-gray-700">
            ₺{activeRate?.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <button onClick={onRefreshRate} disabled={isRateLoading} className="rounded-md p-1 transition-colors hover:bg-gray-200 disabled:opacity-50">
            <RefreshCw className={cn('h-3 w-3 text-gray-500', isRateLoading && 'animate-spin')} />
          </button>
        </div>

        <CurrencyToggle viewCurrency={viewCurrency} onChange={onCurrencyChange} mobile />
      </div>
    </div>
  );
}

function CurrencyToggle({ viewCurrency, onChange, mobile = false }: {
  viewCurrency: CurrencyView;
  onChange: (currency: CurrencyView) => void;
  mobile?: boolean;
}) {
  const currencies: Array<{ value: CurrencyView; label: string }> = [
    { value: 'TRY', label: 'TL' },
    { value: 'USD', label: 'USD' },
    { value: 'TL+USD', label: 'TL+USD' },
  ];

  return (
    <div className={mobile
      ? 'flex items-center gap-1 rounded-lg bg-gray-200/50 p-1'
      : 'hidden items-center gap-1 rounded-xl bg-gray-100 p-1 sm:flex'}
    >
      {currencies.map(currency => (
        <button
          key={currency.value}
          onClick={() => onChange(currency.value)}
          className={mobile
            ? cn(
                'rounded-[5px] px-2 py-1 text-[10px] font-bold transition-all',
                viewCurrency === currency.value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500',
              )
            : cn(
                'rounded-lg px-3 py-1.5 text-xs font-bold transition-all',
                viewCurrency === currency.value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700',
              )}
        >
          {currency.label}
        </button>
      ))}
    </div>
  );
}
