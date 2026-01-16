import { useEffect, useId, ReactNode, useCallback } from 'react';
import { useUIStore } from '../../store/uiStore';

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
  const { openDialog: showConfirmDialog } = useUIStore();

  const requestClose = useCallback(() => {
    if (isDirty) {
      showConfirmDialog('unsaved-changes', { onConfirm: onClose });
    } else {
      onClose();
    }
  }, [isDirty, onClose, showConfirmDialog]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if ((e.key === 'Escape' || e.key === 'Esc') && !e.repeat && !e.defaultPrevented) {
        e.preventDefault();
        requestClose();
      }
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [requestClose]);

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
            onClick={requestClose}
            className="text-text-secondary hover:text-text-primary text-xl"
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
