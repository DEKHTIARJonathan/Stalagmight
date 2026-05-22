import { useState, useCallback, useEffect, useRef } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { trackDialogComplete } from '../../utils/telemetry';
import type { SectionId } from '../../types/project';

/**
 * Dialog for adjusting section position with dx/dy offset.
 * Provides live preview as values change.
 */
export default function SectionAdjustDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const { project, moveSection } = useProjectStore();

  const sectionId = dialogData.sectionId as SectionId | undefined;
  const section = project?.sections.find((s) => s.id === sectionId);

  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track preview state for live updates
  const [previewApplied, setPreviewApplied] = useState(false);
  const lastPreviewOffset = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  // Apply preview offset when values change
  const applyPreview = useCallback(async (newDx: number, newDy: number) => {
    if (sectionId === undefined) return;

    // Calculate delta from last preview
    const deltaDx = newDx - lastPreviewOffset.current.dx;
    const deltaDy = newDy - lastPreviewOffset.current.dy;

    // Only apply if there's a meaningful change
    if (Math.abs(deltaDx) < 0.001 && Math.abs(deltaDy) < 0.001) return;

    // Apply the delta offset
    const result = await moveSection(sectionId, { x: deltaDx, y: deltaDy, z: 0 });
    if (result.success) {
      lastPreviewOffset.current = { dx: newDx, dy: newDy };
      setPreviewApplied(true);
    }
  }, [sectionId, moveSection]);

  // Debounce preview updates
  const previewTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleDxChange = useCallback((value: number) => {
    setDx(value);
    // Debounce the preview
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }
    previewTimeoutRef.current = setTimeout(() => {
      applyPreview(value, dy);
    }, 150);
  }, [dy, applyPreview]);

  const handleDyChange = useCallback((value: number) => {
    setDy(value);
    // Debounce the preview
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }
    previewTimeoutRef.current = setTimeout(() => {
      applyPreview(dx, value);
    }, 150);
  }, [dx, applyPreview]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (previewTimeoutRef.current) {
        clearTimeout(previewTimeoutRef.current);
      }
    };
  }, []);

  const handleApply = async () => {
    if (sectionId === undefined) return;

    setIsLoading(true);
    setError(null);

    try {
      // If preview was already applied, we just need to close
      // Otherwise, apply the full offset
      if (!previewApplied) {
        const result = await moveSection(sectionId, { x: dx, y: dy, z: 0 });
        if (!result.success) {
          setError(result.error ?? 'Failed to adjust section position');
          return;
        }
      } else {
        // Ensure final offset is applied (in case debounce didn't fire)
        const deltaDx = dx - lastPreviewOffset.current.dx;
        const deltaDy = dy - lastPreviewOffset.current.dy;
        if (Math.abs(deltaDx) >= 0.001 || Math.abs(deltaDy) >= 0.001) {
          const result = await moveSection(sectionId, { x: deltaDx, y: deltaDy, z: 0 });
          if (!result.success) {
            setError(result.error ?? 'Failed to adjust section position');
            return;
          }
        }
      }
      trackDialogComplete('section-adjust');
      closeDialog();
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to adjust section position'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async () => {
    // If preview was applied, we need to revert it
    if (previewApplied && sectionId !== undefined) {
      // Apply inverse offset to revert
      await moveSection(sectionId, {
        x: -lastPreviewOffset.current.dx,
        y: -lastPreviewOffset.current.dy,
        z: 0
      });
    }
    closeDialog();
  };

  // Track if form has been modified
  const isDirty = dx !== 0 || dy !== 0;

  if (!section) {
    return (
      <DialogWrapper
        title="Adjust Section Position"
        onClose={closeDialog}
        size="sm"
        data-testid="section-adjust-dialog"
      >
        <div className="text-error">Section not found</div>
      </DialogWrapper>
    );
  }

  return (
    <DialogWrapper
      title="Adjust Section Position"
      onClose={handleCancel}
      size="sm"
      isDirty={isDirty}
      data-testid="section-adjust-dialog"
    >
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm">
            {error}
          </div>
        )}

        <div className="text-sm text-text-secondary mb-4">
          Adjusting: <span className="text-text-primary font-medium">{section.name ?? `Section ${section.id}`}</span>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              dx (meters)
            </label>
            <input
              type="number" inputMode="decimal"
              value={dx}
              onChange={(e) => handleDxChange(parseFloat(e.target.value) || 0)}
              className="w-full"
              step="0.1"
              data-testid="dx-input"
            />
            <p className="text-xs text-text-secondary mt-1">Positive = East</p>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">
              dy (meters)
            </label>
            <input
              type="number" inputMode="decimal"
              value={dy}
              onChange={(e) => handleDyChange(parseFloat(e.target.value) || 0)}
              className="w-full"
              step="0.1"
              data-testid="dy-input"
            />
            <p className="text-xs text-text-secondary mt-1">Positive = North</p>
          </div>
        </div>

        {previewApplied && (
          <p className="text-xs text-accent">
            Preview applied. Press Apply to confirm or Cancel to revert.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={handleCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleApply} disabled={isLoading}>
            {isLoading ? 'Applying...' : 'Apply'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
