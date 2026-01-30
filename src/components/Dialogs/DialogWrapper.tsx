import { useLayoutEffect, useId, useRef, type ReactNode, useCallback, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../common/Button';
import { pushDialog, popDialog } from '../../utils/dialogStack';

/** Resolve portal target once at module level to avoid per-render getElementById calls. */
let portalTargetCache: HTMLElement | null = null;
let portalTargetWarned = false;

function getPortalTarget(): HTMLElement | null {
  // Re-resolve if cached element is detached (HMR/test cleanup can remove it)
  if (portalTargetCache && portalTargetCache.isConnected) return portalTargetCache;
  portalTargetCache = document.getElementById('dialog-root');
  if (!portalTargetCache && !portalTargetWarned && import.meta.env.DEV) {
    portalTargetWarned = true;
    console.warn(
      '[DialogWrapper] #dialog-root element not found in DOM. ' +
      'Ensure <div id="dialog-root"></div> exists in index.html after #root.',
    );
  }
  return portalTargetCache;
}

type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '4xl' | '5xl';

const sizeClasses: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
};

/** Fixed dimensions for dialogs that need constant size regardless of content. */
export interface FixedSize {
  width: string;
  height: string;
}

interface DialogWrapperProps {
  title: string;
  onClose: () => void;
  children: ReactNode | ((props: { requestClose: () => void }) => ReactNode);
  isDirty?: boolean;
  size?: DialogSize;
  'data-testid'?: string;
  maxHeight?: string;
  /** Whether clicking the backdrop closes the dialog. Defaults to true. */
  closeOnBackdropClick?: boolean;
  /** Override overflow behavior. Defaults to 'auto'. Use 'hidden' for fixed footer layouts. */
  overflow?: 'auto' | 'hidden';
  /** Additional className for the body content wrapper. */
  bodyClassName?: string;
  /** Fixed dimensions that override size and maxHeight. Uses CSS min()/clamp() for responsive fallback. */
  fixedSize?: FixedSize;
}

export function DialogWrapper({
  title,
  onClose,
  children,
  isDirty = false,
  size = '2xl',
  'data-testid': testId,
  maxHeight = 'max-h-[90vh]',
  closeOnBackdropClick = true,
  overflow = 'auto',
  bodyClassName = 'p-4',
  fixedSize,
}: DialogWrapperProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const requestClose = useCallback(() => {
    if (isDirty) {
      setShowConfirm(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  const handleConfirmDiscard = useCallback(() => {
    setShowConfirm(false);
    onClose();
  }, [onClose]);

  const handleCancelDiscard = useCallback(() => {
    setShowConfirm(false);
  }, []);

  // Register with dialogStack for inert management and focus the container.
  // useLayoutEffect ensures inert + focus are applied before the browser paints,
  // preventing timing windows where key presses reach global handlers.
  useLayoutEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    pushDialog(el);
    // Focus the dialog container so keyboard events (Escape) are reliably
    // intercepted by onKeyDown rather than falling through to global handlers.
    // Only focus if current active element is outside the dialog to avoid
    // overriding autoFocus on inputs inside dialogs.
    if (!el.contains(document.activeElement)) {
      el.focus();
    }
    return () => {
      popDialog(el);
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if ((e.key === 'Escape' || e.key === 'Esc') && !e.repeat && !e.defaultPrevented) {
        // Don't close dialog if a dropdown is open - let the dropdown close first
        const openDropdown = document.querySelector('[data-dropdown-open]');
        if (openDropdown) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        if (showConfirm) {
          handleCancelDiscard();
        } else {
          requestClose();
        }
      }
    },
    [requestClose, showConfirm, handleCancelDiscard],
  );

  const handleBackdropClick = useCallback(() => {
    if (closeOnBackdropClick) {
      requestClose();
    }
  }, [closeOnBackdropClick, requestClose]);

  const portalTarget = getPortalTarget();
  if (!portalTarget) {
    return null;
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="absolute inset-0 bg-black/50" onClick={handleBackdropClick} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className={`relative bg-panel border border-border rounded-lg shadow-xl ${fixedSize ? '' : `${sizeClasses[size]} ${maxHeight} w-full mx-4`} overflow-${overflow} ${overflow === 'hidden' ? 'flex flex-col' : ''}`}
        style={fixedSize ? { width: fixedSize.width, height: fixedSize.height } : undefined}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 id={titleId} className="text-lg font-medium">{title}</h2>
          <button
            type="button"
            onClick={requestClose}
            className="text-text-secondary hover:text-text-primary text-xl"
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        <div className={bodyClassName}>
          {typeof children === 'function' ? children({ requestClose }) : children}
        </div>
      </div>

      {/* Inline confirm overlay for dirty state */}
      {showConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={handleCancelDiscard} />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-discard-title"
            className="relative bg-panel border border-border rounded-lg shadow-xl max-w-sm w-full mx-4"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h2 id="confirm-discard-title" className="text-lg font-medium">Unsaved Changes</h2>
            </div>
            <div className="p-4 space-y-4">
              <p>You have unsaved changes. Are you sure you want to close?</p>
              <p className="text-text-secondary text-sm">Your changes will be lost.</p>
              <div className="flex justify-end gap-2 pt-4 border-t border-border">
                <Button type="button" onClick={handleCancelDiscard}>Cancel</Button>
                <Button type="button" variant="danger" onClick={handleConfirmDiscard}>
                  Discard Changes
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>,
    portalTarget,
  );
}
