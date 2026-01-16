import { useEffect, useId, ReactNode, useCallback, useState } from 'react';
import { Button } from '../common/Button';

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

interface DialogWrapperProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  isDirty?: boolean;
  size?: DialogSize;
  'data-testid'?: string;
  maxHeight?: string;
}

export function DialogWrapper({
  title,
  onClose,
  children,
  isDirty = false,
  size = '2xl',
  'data-testid': testId,
  maxHeight = 'max-h-[90vh]',
}: DialogWrapperProps) {
  const titleId = useId();
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

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if ((e.key === 'Escape' || e.key === 'Esc') && !e.repeat && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        if (showConfirm) {
          handleCancelDiscard();
        } else {
          requestClose();
        }
      }
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [requestClose, showConfirm, handleCancelDiscard]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={requestClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className={`relative bg-panel border border-border rounded-lg shadow-xl ${sizeClasses[size]} w-full mx-4 ${maxHeight} overflow-auto`}
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
        <div className="p-4">{children}</div>
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
    </div>
  );
}
