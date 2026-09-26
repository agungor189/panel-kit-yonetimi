import type { ReactNode } from 'react';
import { cn } from './utils';

export type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon && <div className="mb-4 text-text-muted">{icon}</div>}
      <h3 className="text-sm font-bold text-text-main">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export type LoadingStateProps = {
  label?: ReactNode;
  className?: string;
  compact?: boolean;
};

export function LoadingState({ label = 'Yükleniyor...', className, compact = false }: LoadingStateProps) {
  return (
    <div className={cn('flex items-center justify-center gap-3 text-sm font-medium text-text-muted', compact ? 'p-4' : 'p-12', className)} role="status">
      <span aria-hidden="true" className="h-6 w-6 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
      <span>{label}</span>
    </div>
  );
}
