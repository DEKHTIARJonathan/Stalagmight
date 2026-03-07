import { useEffect, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import DeleteShotImpactDetails from './DeleteShotImpactDetails';
import type { DeleteShotImpact } from '../../types/commands';
import { setSource, trackDialogComplete } from '../../utils/telemetry';

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
  const shiftBlocked = impact?.shift_blocked ?? false;
  const shiftBlockedReasons = impact?.shift_blocked_reasons ?? [];

  useEffect(() => {
    if (sectionId !== undefined && shotId !== undefined) {
      invokeIpc<DeleteShotImpact>('preview_delete_shot', { sectionId, shotId }, { purpose: 'preview shot deletion' })
        .then((result) => {
          setImpact(result);
          setImpactError(null);
        })
        .catch((e) => {
          setImpact(null);
          setImpactError(getErrorMessage(e, 'Failed to load shot impacts'));
        });
    } else {
      setImpact(null);
      setImpactError(null);
    }
  }, [sectionId, shotId]);

  const handleSplit = () => {
    if (sectionId === undefined || shotId === undefined) return;
    setSource('dialog');
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
        trackDialogComplete('delete-shot-choice');
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to delete shot');
      }
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to delete shot'));
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

        {shiftBlocked && (
          <div className="p-3 bg-warning-10 border border-warning-20 rounded text-warning text-sm">
            <p className="font-medium">Shift Geometry is not available for this shot.</p>
            {shiftBlockedReasons.length > 0 && (
              <ul className="list-disc list-inside">
                {shiftBlockedReasons.map((reason, index) => (
                  <li key={`shift-blocked-${index}`}>{reason}</li>
                ))}
              </ul>
            )}
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
          <Button
            variant="danger"
            onClick={handleShift}
            disabled={isLoading || shiftBlocked}
            data-primary-action=""
          >
            {isLoading ? 'Deleting...' : 'Shift Geometry'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
