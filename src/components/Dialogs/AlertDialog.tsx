import { useLayoutEffect, useEffect, useRef, useCallback, useId, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { pushDialog, popDialog } from '../../utils/dialogStack';

interface AlertDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  closeOnBackdropClick?: boolean;
  'data-testid'?: string;
}

function focusInitial(container: HTMLElement): void {
  const primary = container.querySelector<HTMLElement>('[data-primary-action]:not(:disabled)');
  if (primary && primary.getClientRects().length > 0) {
    primary.focus();
    return;
  }

  const firstButton = container.querySelector<HTMLElement>('button:not(:disabled)');
  if (firstButton && firstButton.getClientRects().length > 0) {
    firstButton.focus();
    return;
  }

  container.focus();
}

export function AlertDialog({
  open,
  title,
  children,
  actions,
  onClose,
  closeOnBackdropClick = true,
  'data-testid': testId,
}: AlertDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const titleId = useId();

  useFocusTrap(containerRef, { enabled: open });

  useLayoutEffect(() => {
    if (!open) return;
    const el = containerRef.current;
    if (!el) return;
    triggerRef.current = document.activeElement;
    pushDialog(el);
    if (!el.contains(document.activeElement)) {
      el.focus();
    }
    return () => {
      popDialog(el);
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement && document.body.contains(trigger)) {
        trigger.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    if (!el) return;
    const rafId = requestAnimationFrame(() => focusInitial(el));
    return () => cancelAnimationFrame(rafId);
  }, [open]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape' && !e.repeat && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      // Prevent shortcut leakage to underlying dialogs.
      e.stopPropagation();
    },
    [onClose],
  );

  const handleBackdropClick = useCallback(() => {
    if (closeOnBackdropClick) {
      onClose();
    }
  }, [closeOnBackdropClick, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 z-[60] flex items-center justify-center"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="absolute inset-0 bg-overlay" onClick={handleBackdropClick} />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative bg-panel border border-border rounded-lg shadow-xl max-w-sm w-full mx-4"
        data-testid={testId}
      >
        <div className="px-4 py-3 border-b border-border">
          <h2 id={titleId} className="text-lg font-medium">{title}</h2>
        </div>
        <div className="p-4 space-y-4">
          {children}
          <div className="flex justify-end gap-2 pt-4 border-t border-border">
            {actions}
          </div>
        </div>
      </div>
    </div>,
    document.getElementById('dialog-root') ?? document.body,
  );
}
