import { useEffect, useId, type MouseEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import { cn } from './utils';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

const sizeClasses: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
};

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  className?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  showCloseButton?: boolean;
  ariaLabel?: string;
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  className,
  closeOnBackdrop = true,
  closeOnEscape = true,
  showCloseButton = true,
  ariaLabel,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeOnEscape, onClose, open]);

  if (!open) return null;

  const handleBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (closeOnBackdrop && event.target === event.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-sidebar-bg/60 p-4 backdrop-blur-sm"
      onMouseDown={handleBackdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={!title ? ariaLabel : undefined}
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          'relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl border border-border-color bg-card-bg shadow-2xl',
          sizeClasses[size],
          className,
        )}
      >
        {(title || description || showCloseButton) && (
          <div className="flex items-start justify-between gap-4 border-b border-border-color px-6 py-5">
            <div>
              {title && <h2 id={titleId} className="text-lg font-bold text-text-main">{title}</h2>}
              {description && <p id={descriptionId} className="mt-1 text-sm text-text-muted">{description}</p>}
            </div>
            {showCloseButton && (
              <Button variant="ghost" size="sm" className="-mr-2 -mt-1 px-2 text-text-muted" onClick={onClose} aria-label="Kapat">
                <X className="h-5 w-5" />
              </Button>
            )}
          </div>
        )}
        <div className="overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-3 border-t border-border-color bg-bg-main/50 px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

export type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  className?: string;
};

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Onayla',
  cancelLabel = 'Vazgeç',
  destructive = false,
  loading = false,
  className,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      className={className}
      closeOnBackdrop={!loading}
      closeOnEscape={!loading}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>{cancelLabel}</Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={() => void onConfirm()}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {description && <div className="text-sm leading-6 text-text-muted">{description}</div>}
    </Modal>
  );
}
