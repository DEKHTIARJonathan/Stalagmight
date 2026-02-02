import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import DeleteShotImpactDetails from './DeleteShotImpactDetails';
import type { DeleteShotImpact } from '../../types/commands';

export default function DeleteShotChoiceDialog() {
  const { closeDialog, dialogData, openDialog, clearSelection } = useUIStore();
  const { deleteShot } = useProjectStore();

  const sectionId = dialogData.sectionId as number | undefined;
  const shotId = dialogData.shotId as number | undefined;
  const sectionName = dialogData.sectionName as string | undefined;

  const [impact, setImpact] = useState<DeleteShotImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (sectionId !== undefined && shotId !== undefined) {
      invoke<DeleteShotImpact>('preview_delete_shot', { sectionId, shotId })
        .then((result) => {
          setImpact(result);
          setImpactError(null);
        })
        .catch((e) => {
          setImpact(null);
          setImpactError(e instanceof Error ? e.message : 'Failed to load shot impacts');
        });
    } else {
      setImpact(null);
      setImpactError(null);
    }
  }, [sectionId, shotId]);

  const handleSplit = () => {
    if (sectionId === undefined || shotId === undefined) return;
    openDialog('split-section', {
      sectionId,
      shotId,
      sectionName,
    });
  };

  const handleShift = async () => {
    if (sectionId === undefined || shotId === undefined) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await deleteShot(sectionId, shotId);
      if (result.success) {
        clearSelection();
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to delete shot');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete shot');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DialogWrapper title="Delete Shot" onClose={isLoading ? () => {} : closeDialog} size="md" data-testid="delete-shot-choice-dialog">
      <div className="space-y-4">
        <p className="text-text-secondary">
          This shot is in the middle of the section. Choose whether to split the section or shift geometry.
        </p>

        {error && (
          <div className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm">
            {error}
          </div>
        )}

        {impactError && (
          <div className="p-3 bg-warning-10 border border-warning-20 rounded text-warning text-sm">
            {impactError}
          </div>
        )}

        <DeleteShotImpactDetails
          impact={impact}
          title="If you choose Shift Geometry, these relationships will update:"
        />

        <div className="flex justify-end gap-2">
          <Button onClick={closeDialog} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSplit} disabled={isLoading}>
            Split Section
          </Button>
          <Button variant="danger" onClick={handleShift} disabled={isLoading} data-primary-action="">
            {isLoading ? 'Deleting...' : 'Shift Geometry'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
