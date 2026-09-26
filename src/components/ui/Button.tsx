import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './utils';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover border-transparent',
  secondary: 'bg-white text-text-main border-border-color hover:bg-bg-main',
  danger: 'bg-danger text-white hover:bg-danger/90 border-transparent',
  ghost: 'bg-transparent text-text-main border-transparent hover:bg-bg-main',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'min-h-8 px-3 py-1.5 text-xs',
  md: 'min-h-10 px-4 py-2 text-sm',
  lg: 'min-h-11 px-6 py-2.5 text-sm',
};

export function buttonClassName(variant: ButtonVariant = 'primary', size: ButtonSize = 'md') {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition-all',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2',
    'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
    variantClasses[variant],
    sizeClasses[size],
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingText?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading = false, loadingText, disabled, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonClassName(variant, size), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      )}
      {loading && loadingText ? loadingText : children}
    </button>
  );
});
