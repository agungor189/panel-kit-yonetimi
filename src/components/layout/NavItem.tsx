import type { ComponentType } from 'react';
import type { View } from '../../lib/navigation';
import { cn } from '../ui';

export type NavTone = 'teal' | 'purple' | 'orange';

export type NavItemDefinition = {
  id: View;
  label: string;
  icon: ComponentType<{ className?: string }>;
  tone?: NavTone;
};

export function isNavItemActive(currentView: View, itemView: View) {
  return currentView === itemView
    || (itemView === 'products' && (currentView === 'product-detail' || currentView === 'product-wizard'));
}

type NavItemProps = {
  item: NavItemDefinition;
  active: boolean;
  expanded: boolean;
  onSelect: (view: View) => void;
};

export function NavItem({ item, active, expanded, onSelect }: NavItemProps) {
  const Icon = item.icon;
  const activeClass =
    item.tone === 'purple'
      ? 'border-violet-300/20 bg-[#15263f] text-white shadow-[0_10px_24px_rgba(2,12,27,0.2)]'
      : item.tone === 'orange'
        ? 'border-amber-300/20 bg-[#1f2a38] text-white shadow-[0_10px_24px_rgba(2,12,27,0.2)]'
        : 'border-cyan-300/20 bg-[#12324a] text-white shadow-[0_10px_24px_rgba(2,12,27,0.22)]';

  return (
    <button
      onClick={() => onSelect(item.id)}
      title={!expanded ? item.label : undefined}
      className={cn(
        'group relative flex h-11 items-center rounded-xl border text-sm font-bold transition-all duration-200',
        expanded ? 'mx-3 w-[calc(100%-1.5rem)] px-3.5' : 'mx-auto w-11 justify-center px-0',
        active ? activeClass : 'border-transparent text-slate-300 hover:bg-white/[0.07] hover:text-white',
      )}
    >
      <Icon className={cn(
        'h-5 w-5 shrink-0 transition-colors',
        expanded && 'mr-3',
        active ? 'text-white' : 'text-slate-300 group-hover:text-white',
      )} />
      {expanded && <span className="min-w-0 truncate">{item.label}</span>}
    </button>
  );
}
