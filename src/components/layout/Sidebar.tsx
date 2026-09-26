import { ChevronRight, LogOut, X } from 'lucide-react';
import type { View } from '../../lib/navigation';
import { cn } from '../ui';
import { isNavItemActive, NavItem, type NavItemDefinition } from './NavItem';

export function isSidebarExpanded(isOpen: boolean, isMobileOpen: boolean) {
  return isOpen || isMobileOpen;
}

export function getVisibleSidebarItems(items: NavItemDefinition[], isReadOnly: boolean) {
  return isReadOnly ? items.filter(item => item.id !== 'b2b') : items;
}

type SidebarProps = {
  appVersion: string;
  currentView: View;
  isOpen: boolean;
  isMobileOpen: boolean;
  isReadOnly: boolean;
  primaryItems: NavItemDefinition[];
  financeItems: NavItemDefinition[];
  analyticsItems: NavItemDefinition[];
  integrationItems: NavItemDefinition[];
  systemItems: NavItemDefinition[];
  onSelect: (view: View) => void;
  onToggle: () => void;
  onCloseMobile: () => void;
  onLogout: () => void;
};

export function Sidebar({
  appVersion,
  currentView,
  isOpen,
  isMobileOpen,
  isReadOnly,
  primaryItems,
  financeItems,
  analyticsItems,
  integrationItems,
  systemItems,
  onSelect,
  onToggle,
  onCloseMobile,
  onLogout,
}: SidebarProps) {
  const expanded = isSidebarExpanded(isOpen, isMobileOpen);
  const visiblePrimaryItems = getVisibleSidebarItems(primaryItems, isReadOnly);

  const sectionLabel = (label: string) => expanded && (
    <div className="px-6 pb-2 pt-4">
      <p className="text-[10px] font-black uppercase tracking-[0.17em] text-slate-400">{label}</p>
    </div>
  );

  const renderItem = (item: NavItemDefinition) => (
    <NavItem
      key={item.id}
      item={item}
      active={isNavItemActive(currentView, item.id)}
      expanded={expanded}
      onSelect={onSelect}
    />
  );

  return (
    <aside className={cn(
      'fixed left-0 top-0 z-50 flex h-full flex-col border-r border-white/10 bg-[#1e2a3d] text-white shadow-[18px_0_45px_rgba(8,24,43,0.18)] transition-all duration-300',
      isOpen ? 'w-64' : 'w-20',
      'md:translate-x-0',
      isMobileOpen ? 'w-64 translate-x-0' : '-translate-x-full md:translate-x-0',
    )}>
      <div className={cn(
        'flex h-20 shrink-0 items-center border-b border-white/10 px-4',
        expanded ? 'justify-between' : 'justify-center px-0',
      )}>
        <div className={cn('flex min-w-0 items-center', expanded ? 'gap-2' : 'justify-center')}>
          <img src="/logo.svg" alt="DSDST Logo" className="h-9 w-9 shrink-0 drop-shadow-[0_0_14px_rgba(20,225,205,0.2)]" />
          {expanded && (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <h1 className="min-w-0 flex-1 whitespace-nowrap text-[17px] font-black leading-none tracking-normal text-white">
                DSDST Panel
              </h1>
              <span className="shrink-0 rounded-full border border-white/10 bg-white/10 px-2 py-1 text-[10px] font-black tracking-normal text-cyan-200 shadow-inner">
                {appVersion}
              </span>
            </div>
          )}
        </div>

        {expanded && (
          <button
            onClick={onCloseMobile}
            className="rounded-xl p-2 text-slate-400 transition-colors hover:bg-white/10 hover:text-white md:hidden"
            aria-label="Menüyü kapat"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto py-3">
        {sectionLabel('Ana Menü')}
        {visiblePrimaryItems.map(renderItem)}

        <div className="mx-4 my-3 h-px bg-white/10" />
        {sectionLabel('Finans & Raporlama')}
        {financeItems.map(renderItem)}
        {analyticsItems.map(renderItem)}

        {!isReadOnly && (
          <>
            <div className="mx-4 my-3 h-px bg-white/10" />
            {sectionLabel('Entegrasyonlar')}
            {integrationItems.map(renderItem)}
          </>
        )}

        <div className="mx-4 my-3 h-px bg-white/10" />
        {sectionLabel('Sistem')}
        {systemItems.map(renderItem)}
      </nav>

      <div className="shrink-0 border-t border-white/10 pb-4 pt-3">
        {expanded ? (
          <div className="mx-3 mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-2 shadow-inner">
            <button
              onClick={onLogout}
              className="logout-override-ignore flex h-11 w-full items-center rounded-lg px-3.5 text-sm font-black text-red-400 transition-all hover:bg-red-500 hover:text-white"
            >
              <LogOut className="mr-3 h-5 w-5" />
              <span>Çıkış Yap</span>
            </button>
          </div>
        ) : (
          <div className="mt-4 flex justify-center">
            <button
              onClick={onLogout}
              className="logout-override-ignore flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] text-red-400 transition-all hover:bg-red-500 hover:text-white"
              title="Çıkış Yap"
            >
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        )}
      </div>

      <button
        onClick={onToggle}
        className="absolute bottom-5 right-[-13px] hidden h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-[#25344a] text-slate-300 shadow-lg transition-all hover:bg-[#2d3d55] hover:text-white md:flex"
        aria-label={isOpen ? 'Menüyü daralt' : 'Menüyü genişlet'}
      >
        <ChevronRight className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')} />
      </button>
    </aside>
  );
}
