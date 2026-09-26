import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './utils';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const cardPaddingClasses: Record<CardPadding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-6 lg:p-8',
};

export function cardClassName(padding: CardPadding = 'none') {
  return cn('card', cardPaddingClasses[padding]);
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
}

export function Card({ className, padding = 'none', ...props }: CardProps) {
  return <div className={cn(cardClassName(padding), className)} {...props} />;
}

export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger';

const badgeVariantClasses: Record<BadgeVariant, string> = {
  default: 'bg-bg-main text-text-muted border-border-color',
  primary: 'bg-primary/10 text-primary border-primary/20',
  success: 'bg-success/10 text-success border-success/20',
  warning: 'bg-warning/10 text-warning border-warning/20',
  danger: 'bg-danger/10 text-danger border-danger/20',
};

export function badgeClassName(variant: BadgeVariant = 'default') {
  return cn('inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold', badgeVariantClasses[variant]);
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return <span className={cn(badgeClassName(variant), className)} {...props} />;
}

export type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between', className)}>
      <div className="min-w-0">
        <h2 className="text-xl font-bold tracking-tight text-text-main lg:text-2xl">{title}</h2>
        {description && <p className="mt-1 text-xs text-text-muted lg:text-sm">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
