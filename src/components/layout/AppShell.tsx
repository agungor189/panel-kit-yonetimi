import type { ReactNode } from 'react';
import { Eye, LogOut } from 'lucide-react';
import type { CurrencyView } from '../../CurrencyContext';
import type { View } from '../../lib/navigation';
import type { UserRole } from '../../types';
import { cn } from '../ui';
import { AppHeader } from './AppHeader';
import type { NavItemDefinition } from './NavItem';
import { PageContainer } from './PageContainer';
import { Sidebar } from './Sidebar';

type AppShellProps = {
  children: ReactNode;
  appVersion: string;
  currentView: View;
  currentViewLabel: string;
  userRole: UserRole;
  isReadOnly: boolean;
  isSidebarOpen: boolean;
  isMobileMenuOpen: boolean;
  showLogoutConfirm: boolean;
  primaryNavItems: NavItemDefinition[];
  financeNavItems: NavItemDefinition[];
  analyticsNavItems: NavItemDefinition[];
  integrationNavItems: NavItemDefinition[];
  systemNavItems: NavItemDefinition[];
  viewCurrency: CurrencyView;
  activeRate: number;
  rateSource: string | null;
  rateFetchedAt: string | null;
  isRateLoading: boolean;
  isRateError: boolean;
  onSelectView: (view: View) => void;
  onToggleSidebar: () => void;
  onOpenMobileMenu: () => void;
  onCloseMobileMenu: () => void;
  onCurrencyChange: (currency: CurrencyView) => void;
  onRefreshRate: () => void;
  onLogout: () => void;
  onConfirmLogout: () => void;
  onCancelLogout: () => void;
};

export function AppShell(props: AppShellProps) {
  return (
    <div
      className="min-h-screen bg-bg-main font-sans text-text-main selection:bg-primary/10"
      data-role={props.userRole}
      data-readonly={props.isReadOnly ? 'true' : 'false'}
    >
      <Sidebar
        appVersion={props.appVersion}
        currentView={props.currentView}
        isOpen={props.isSidebarOpen}
        isMobileOpen={props.isMobileMenuOpen}
        isReadOnly={props.isReadOnly}
        primaryItems={props.primaryNavItems}
        financeItems={props.financeNavItems}
        analyticsItems={props.analyticsNavItems}
        integrationItems={props.integrationNavItems}
        systemItems={props.systemNavItems}
        onSelect={props.onSelectView}
        onToggle={props.onToggleSidebar}
        onCloseMobile={props.onCloseMobileMenu}
        onLogout={props.onLogout}
      />

      {props.isMobileMenuOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={props.onCloseMobileMenu} />
      )}

      <main className={cn(
        'flex min-h-screen w-full flex-col overflow-x-hidden transition-all duration-300',
        props.isSidebarOpen ? 'md:pl-64' : 'md:pl-20',
      )}>
        <AppHeader
          currentViewLabel={props.currentViewLabel}
          userRole={props.userRole}
          viewCurrency={props.viewCurrency}
          activeRate={props.activeRate}
          rateSource={props.rateSource}
          rateFetchedAt={props.rateFetchedAt}
          isRateLoading={props.isRateLoading}
          isRateError={props.isRateError}
          onOpenMobileMenu={props.onOpenMobileMenu}
          onCurrencyChange={props.onCurrencyChange}
          onRefreshRate={props.onRefreshRate}
        />

        {props.isReadOnly && <ReadOnlyBanner />}
        {props.isReadOnly && <ReadOnlyConstraints />}

        <PageContainer>{props.children}</PageContainer>

        {props.showLogoutConfirm && (
          <LogoutConfirmDialog onConfirm={props.onConfirmLogout} onCancel={props.onCancelLogout} />
        )}
      </main>
    </div>
  );
}

function ReadOnlyBanner() {
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 md:px-8">
      <div className="mx-auto flex max-w-[1600px] items-center gap-3 text-amber-900">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-amber-200 bg-amber-100">
          <Eye className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm font-black">Salt okunur moddasınız</p>
          <p className="text-xs font-medium text-amber-800">Verileri görüntüleyebilirsiniz; ekleme, düzenleme, silme, yedekleme ve API anahtarı yönetimi kapalıdır.</p>
        </div>
      </div>
    </div>
  );
}

function ReadOnlyConstraints() {
  return (
    <style>{`
       [data-readonly="true"] button[data-write-action="true"],
       [data-readonly="true"] a[data-write-action="true"],
       [data-readonly="true"] label[data-write-action="true"],
       [data-readonly="true"] button.btn-primary,
       [data-readonly="true"] button:has(svg.lucide-plus),
       [data-readonly="true"] button:has(svg.lucide-save),
       [data-readonly="true"] button:has(svg.lucide-edit-3),
       [data-readonly="true"] button:has(svg.lucide-trash),
       [data-readonly="true"] button:has(svg.lucide-trash-2),
       [data-readonly="true"] button:has(svg.lucide-minus),
       [data-readonly="true"] button:has(svg.lucide-upload),
       [data-readonly="true"] button:has(svg.lucide-calculator),
       [data-readonly="true"] button.text-red-500:not(.logout-override-ignore),
       [data-readonly="true"] button.text-red-600,
       [data-readonly="true"] button.text-danger,
       [data-readonly="true"] button.border-red-200,
       [data-readonly="true"] label.text-danger,
       [data-readonly="true"] label.border-red-200 {
          display: none !important;
       }
    `}</style>
  );
}

function LogoutConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm animate-in fade-in duration-200" onClick={onCancel}>
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={event => event.stopPropagation()}>
        <div className="p-6 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <LogOut className="h-8 w-8 text-red-500" />
          </div>
          <h3 className="mb-2 text-xl font-bold text-gray-900">Çıkış Yap</h3>
          <p className="mb-6 text-sm text-gray-500">Hesabınızdan çıkış yapmak istediğinize emin misiniz?</p>
          <div className="flex flex-col gap-3">
            <button onClick={onConfirm} className="w-full rounded-xl bg-red-500 py-3 font-bold text-white transition-colors hover:bg-red-600">
              Evet, Çıkış Yap
            </button>
            <button onClick={onCancel} className="w-full rounded-xl bg-gray-100 py-3 font-bold text-gray-700 transition-colors hover:bg-gray-200">
              İptal
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
