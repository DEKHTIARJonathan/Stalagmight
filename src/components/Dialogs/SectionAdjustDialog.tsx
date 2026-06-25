import { useState, useCallback, useEffect, useRef } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { EntityBlob } from '../common/EntityBlob';
import { DialogWrapper } from './DialogWrapper';
import { trackDialogComplete } from '../../utils/telemetry';
import type { SectionId } from '../../types/project';

// A string the user can be partway through typing into a signed-decimal field:
// '', '-', '.', '-.', '5', '-2.5', '.5'. Lets a controlled input hold these
// intermediate states instead of a number that snaps '-'/'' back to 0 (#161).
const PARTIAL_DECIMAL = /^-?\d*\.?\d*$/;

// Numeric value of such a string; intermediate states with no digits yet read as
// 0 so the live preview neutralizes without forcing the visible text back to '0'.
function offsetValue(raw: string): number {
  const n = parseFloat(raw);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Dialog for adjusting section position with dx/dy offset.
 * Provides live preview as values change.
 */
export default function SectionAdjustDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const { project, moveSection, getConnectedSectionIds } = useProjectStore();

  const sectionId = dialogData.sectionId as SectionId | undefined;
  const section = project?.sections.find((s) => s.id === sectionId);

  // The text inputs are backed by string state so partial entries ('-', '', '.')
  // survive editing; the numeric offset is derived via offsetValue() at the
  // preview / apply / dirty sites (the single-string-input idiom the sibling shot
  // dialogs use). Start empty (not '0') so a leading '-' typed onto the field isn't
  // rejected as '0-' — a pre-filled 0 was un-overwritable without a prior clear,
  // keeping negatives untypable in the natural click-then-type flow (#161). The
  // placeholder still shows "0" so the no-offset default reads clearly.
  const [dxStr, setDxStr] = useState('');
  const [dyStr, setDyStr] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How many sections move together: a section that is merged (or aligned-closure
  // connected) to others is rigidly bound to them, so adjusting it moves the whole
  // group to keep the merge aligned. The set includes this section itself.
  const [connectedCount, setConnectedCount] = useState(1);

  useEffect(() => {
    if (sectionId === undefined) return;
    let cancelled = false;
    void getConnectedSectionIds(sectionId)
      .then((ids) => {
        if (!cancelled) setConnectedCount(Math.max(1, ids.length));
      })
      .catch(() => {
        /* best-effort; default to "just this section" */
      });
    return () => {
      cancelled = true;
    };
  }, [sectionId, getConnectedSectionIds]);

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

  const handleDxChange = useCallback((raw: string) => {
    if (!PARTIAL_DECIMAL.test(raw)) return; // ignore non-numeric keystrokes
    setDxStr(raw);
    // Debounce the preview
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }
    previewTimeoutRef.current = setTimeout(() => {
      applyPreview(offsetValue(raw), offsetValue(dyStr));
    }, 150);
  }, [dyStr, applyPreview]);

  const handleDyChange = useCallback((raw: string) => {
    if (!PARTIAL_DECIMAL.test(raw)) return; // ignore non-numeric keystrokes
    setDyStr(raw);
    // Debounce the preview
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }
    previewTimeoutRef.current = setTimeout(() => {
      applyPreview(offsetValue(dxStr), offsetValue(raw));
    }, 150);
  }, [dxStr, applyPreview]);

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

    // Cancel any pending debounced preview so it can't fire a second move_section
    // concurrently with the Apply below — a slow (>150ms) IPC would otherwise let
    // the late preview double-apply the offset.
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }

    setIsLoading(true);
    setError(null);

    try {
      const dx = offsetValue(dxStr);
      const dy = offsetValue(dyStr);
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
    // Cancel any pending preview before reverting, so it can't re-apply after the
    // revert below and leave the section shifted.
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }
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

  // Track if form has been modified (would Apply move anything?)
  const isDirty = offsetValue(dxStr) !== 0 || offsetValue(dyStr) !== 0;

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
          Adjusting: <EntityBlob entity="section">{section.name ?? `Section ${section.id}`}</EntityBlob>
        </div>

        {connectedCount > 1 && (
          <div
            className="p-2 bg-warning-10 border border-warning-20 rounded text-xs text-warning"
            data-testid="section-adjust-connected-note"
          >
            Merged with {connectedCount - 1} other{connectedCount - 1 === 1 ? '' : 's'} — all {connectedCount} sections
            move together so the merge stays aligned.
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              dx (meters)
            </label>
            {/* type="text" (not number): a number input strips the partial "-"/"."
                being typed, which re-breaks #161. inputMode="text" (not "decimal")
                keeps the minus key on touch keypads. */}
            <input
              type="text" inputMode="text"
              value={dxStr}
              onChange={(e) => handleDxChange(e.target.value)}
              className="w-full"
              placeholder="0"
              disabled={isLoading}
              data-testid="dx-input"
            />
            <p className="text-xs text-text-secondary mt-1">Positive = East</p>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">
              dy (meters)
            </label>
            {/* See dx above: type="text"/inputMode="text" are load-bearing for #161. */}
            <input
              type="text" inputMode="text"
              value={dyStr}
              onChange={(e) => handleDyChange(e.target.value)}
              className="w-full"
              placeholder="0"
              disabled={isLoading}
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
