import { useState, useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

export default function SplitSectionDialog() {
  const { closeDialog, dialogData, setSelection } = useUIStore();
  const { deleteShotAndSplit } = useProjectStore();

  const sectionId = dialogData.sectionId as number | undefined;
  const shotId = dialogData.shotId as number | undefined;
  const sectionName = dialogData.sectionName as string | undefined;

  const defaultNameA = sectionName ? `${sectionName}-A` : 'Section-A';
  const defaultNameB = sectionName ? `${sectionName}-B` : 'Section-B';

  const [nameA, setNameA] = useState(defaultNameA);
  const [nameB, setNameB] = useState(defaultNameB);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-initialize names when sectionName changes
  useEffect(() => {
    setNameA(sectionName ? `${sectionName}-A` : 'Section-A');
    setNameB(sectionName ? `${sectionName}-B` : 'Section-B');
  }, [sectionName]);

  const isDirty = nameA !== defaultNameA || nameB !== defaultNameB;

  const isValid = nameA.trim().length > 0 && nameB.trim().length > 0;

  const handleConfirm = async () => {
    if (sectionId === undefined || shotId === undefined || !isValid) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await deleteShotAndSplit(sectionId, shotId, nameA.trim(), nameB.trim());
      if (result.success) {
        // Select section A (keeps original ID) after split
        setSelection({ type: 'section', sectionId });
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to split section');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to split section');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = isLoading ? () => {} : closeDialog;

  return (
    <DialogWrapper
      title="Delete Shot & Split Section"
      onClose={handleClose}
      size="md"
      isDirty={isDirty}
      closeOnBackdropClick={!isLoading}
      data-testid="split-section-dialog"
    >
      <div className="space-y-4">
        <p className="text-text-secondary">
          Deleting this shot will split the section into two. Name the resulting sections:
        </p>

        {error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded text-error text-sm">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Section A name (first half)</label>
            <input
              type="text"
              value={nameA}
              onChange={(e) => setNameA(e.target.value)}
              className="w-full"
              data-testid="split-name-a"
              disabled={isLoading}
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Section B name (second half)</label>
            <input
              type="text"
              value={nameB}
              onChange={(e) => setNameB(e.target.value)}
              className="w-full"
              data-testid="split-name-b"
              disabled={isLoading}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={handleClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleConfirm}
            disabled={isLoading || !isValid}
            data-testid="split-confirm"
          >
            {isLoading ? 'Splitting...' : 'Delete & Split'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
