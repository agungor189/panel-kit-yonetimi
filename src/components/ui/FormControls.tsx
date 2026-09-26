import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from './utils';

type FieldShellProps = {
  id: string;
  label?: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  containerClassName?: string;
  children: ReactNode;
};

function FieldShell({ id, label, error, hint, required, containerClassName, children }: FieldShellProps) {
  const descriptionId = error || hint ? `${id}-description` : undefined;
  return (
    <div className={cn('space-y-1.5', containerClassName)}>
      {label && (
        <label htmlFor={id} className="block px-1 text-[11px] font-bold uppercase tracking-widest text-text-muted">
          {label}{required && <span className="ml-1 text-danger" aria-hidden="true">*</span>}
        </label>
      )}
      {children}
      {(error || hint) && (
        <p id={descriptionId} className={cn('px-1 text-xs', error ? 'font-medium text-danger' : 'text-text-muted')}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { id: suppliedId, label, error, hint, containerClassName, className, required, disabled, ...props },
  ref,
) {
  const generatedId = useId();
  const id = suppliedId || generatedId;
  const descriptionId = error || hint ? `${id}-description` : undefined;
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} required={required} containerClassName={containerClassName}>
      <input
        ref={ref}
        id={id}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={descriptionId}
        className={cn(
          'form-input disabled:cursor-not-allowed disabled:bg-bg-main disabled:text-text-muted',
          error && 'border-danger focus:border-danger focus:ring-danger/20',
          className,
        )}
        {...props}
      />
    </FieldShell>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
  containerClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { id: suppliedId, label, error, hint, containerClassName, className, required, disabled, children, ...props },
  ref,
) {
  const generatedId = useId();
  const id = suppliedId || generatedId;
  const descriptionId = error || hint ? `${id}-description` : undefined;
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} required={required} containerClassName={containerClassName}>
      <select
        ref={ref}
        id={id}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={descriptionId}
        className={cn(
          'form-input disabled:cursor-not-allowed disabled:bg-bg-main disabled:text-text-muted',
          error && 'border-danger focus:border-danger focus:ring-danger/20',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    </FieldShell>
  );
});
