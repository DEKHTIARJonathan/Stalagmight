import { useEffect, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import { trackDialogComplete } from '../../utils/telemetry';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { StationRef } from '../../types/project';
import type { DeleteShotImpact, SectionRelationships } from '../../types/commands';
import DeleteShotImpactDetails from './DeleteShotImpactDetails';

export default function ConfirmDialog() {
  const { closeDialog, dialogData, clearSelection, setSelection } = useUIStore();
  const { deleteShot, deleteSection, deleteLastShotAndSection, deleteShotAndSplit } = useProjectStore();

  const type = dialogData.type as 'station' | 'shot' | 'section' | 'last-shot' | undefined;
  const message = dialogData.message as string | undefined;
  const stationRef = dialogData.stationRef as StationRef | undefined;
  const sectionId = dialogData.sectionId as number | undefined;
  const shotId = dialogData.shotId as number | undefined;
  const totalShots = dialogData.totalShots as number | undefined;
  const splitRequired = dialogData.splitRequired as boolean | undefined;
  const sectionName = dialogData.sectionName as string | undefined;

  // Split section names for mid-shot deletion
  const [splitNameA, setSplitNameA] = useState('');
  const [splitNameB, setSplitNameB] = useState('');

  // Initialize split names when dialog opens
  useEffect(() => {
    if (splitRequired && sectionName) {
      setSplitNameA(`${sectionName}-A`);
      setSplitNameB(`${sectionName}-B`);
    }
  }, [splitRequired, sectionName]);

  const [relationships, setRelationships] = useState<SectionRelationships | null>(null);
  const [shotImpact, setShotImpact] = useState<DeleteShotImpact | null>(null);
  const [shotImpactError, setShotImpactError] = useState<string | null>(null);

  // Whether this deletion removes an entire section (explicit last-shot type
  // or legacy shot type with totalShots === 1)
  const removesSection =
    type === 'last-shot' ||
    type === 'section' ||
    (type === 'shot' && totalShots === 1);

  // Fetch relationships when dialog opens for any deletion that removes a section
  useEffect(() => {
    if (removesSection && sectionId !== undefined) {
      invokeIpc<SectionRelationships>('get_section_relationships', { sectionId }, { purpose: 'fetch section relationships for deletion' })
        .then(setRelationships)
        .catch(() => setRelationships(null));
    } else {
      setRelationships(null);
    }
  }, [removesSection, sectionId]);

  // Fetch delete impact for shot deletions (edge shots)
  useEffect(() => {
    if (type === 'shot' && !removesSection && !splitRequired && sectionId !== undefined && shotId !== undefined) {
      invokeIpc<DeleteShotImpact>('preview_delete_shot', { sectionId, shotId }, { purpose: 'preview shot deletion impact' })
        .then((result) => {
          setShotImpact(result);
          setShotImpactError(null);
        })
        .catch((e) => {
          setShotImpact(null);
          setShotImpactError(getErrorMessage(e, 'Failed to load shot impacts'));
        });
    } else {
      setShotImpact(null);
      setShotImpactError(null);
    }
  }, [type, removesSection, splitRequired, sectionId, shotId]);

  const handleConfirm = async () => {
    if (type === 'last-shot' && sectionId !== undefined && shotId !== undefined) {
      // Last remaining shot: delete shot + entire section
      await deleteLastShotAndSection(sectionId, shotId);
      clearSelection();
      trackDialogComplete('confirm-delete');
      closeDialog();
      return;
    }
    if (type === 'shot' && sectionId !== undefined && shotId !== undefined) {
      if (splitRequired) {
        // Mid-section shot: delete and split section
        await deleteShotAndSplit(sectionId, shotId, splitNameA.trim() || 'Section A', splitNameB.trim() || 'Section B');
        // Select section A (keeps original ID) after split
        setSelection({ type: 'section', sectionId });
      } else if (totalShots === 1) {
        // Last remaining shot: delete shot + section
        await deleteLastShotAndSection(sectionId, shotId);
        clearSelection();
      } else {
        // Edge shot (or legacy caller without position data): simple delete
        await deleteShot(sectionId, shotId);
        clearSelection();
      }
    } else if (type === 'section' && sectionId !== undefined) {
      await deleteSection(sectionId);
      clearSelection();
    } else if (type === 'station' && stationRef) {
      // Deleting a station requires deleting connected shots
      // For now, show a message that this is not directly supported
      // The user should delete the shots instead
    }
    trackDialogComplete('confirm-delete');
    closeDialog();
  };

  const getTitle = () => {
    switch (type) {
      case 'station':
        return 'Delete Station';
      case 'shot':
        return splitRequired ? 'Delete Shot & Split Section' : 'Delete Shot';
      case 'last-shot':
        return 'Delete Shot & Section';
      case 'section':
        return 'Delete Section';
      default:
        return 'Confirm';
    }
  };

  const getDefaultMessage = () => {
    switch (type) {
      case 'station':
        return 'Deleting a station will delete all connected shots. Are you sure?';
      case 'shot':
        return 'Are you sure you want to delete this shot?';
      case 'last-shot':
        return 'Deleting the last shot will remove the entire section. Continue?';
      case 'section':
        return 'Are you sure you want to delete this section and all its shots?';
      default:
        return 'Are you sure?';
    }
  };

  const hasRelationships =
    relationships !== null &&
    (relationships.merges.length > 0 ||
      relationships.closures.length > 0 ||
      relationships.has_section_offset ||
      relationships.station_offset_count > 0 ||
      relationships.zero_datum_count > 0);

  return (
    <DialogWrapper title={getTitle()} onClose={closeDialog} size="md" data-testid="confirm-dialog">
      <div className="space-y-4">
        <p className="text-text-secondary">{message ?? getDefaultMessage()}</p>

        {type === 'station' && (
          <div className="p-3 bg-warning-10 border border-warning-20 rounded text-warning text-sm">
            Note: To delete a station, delete the shots connected to it instead.
          </div>
        )}

        {type === 'shot' && splitRequired && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-text-secondary mb-1">Section A name (first half)</label>
              <input
                type="text"
                value={splitNameA}
                onChange={(e) => setSplitNameA(e.target.value)}
                className="w-full"
                data-testid="split-name-a"
              />
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">Section B name (second half)</label>
              <input
                type="text"
                value={splitNameB}
                onChange={(e) => setSplitNameB(e.target.value)}
                className="w-full"
                data-testid="split-name-b"
              />
            </div>
          </div>
        )}

        {removesSection && hasRelationships && (
          <div className="p-3 bg-warning-10 border border-warning-20 rounded text-sm space-y-1">
            <p className="font-medium text-warning">The following relationships will also be removed:</p>
            <ul className="list-disc list-inside text-text-secondary">
              {relationships!.merges.length > 0 && (
                <li>{relationships!.merges.length} station merge{relationships!.merges.length !== 1 ? 's' : ''}</li>
              )}
              {relationships!.closures.length > 0 && (
                <li>{relationships!.closures.length} loop closure{relationships!.closures.length !== 1 ? 's' : ''}</li>
              )}
              {relationships!.has_section_offset && (
                <li>1 section offset</li>
              )}
              {relationships!.station_offset_count > 0 && (
                <li>{relationships!.station_offset_count} station offset{relationships!.station_offset_count !== 1 ? 's' : ''}</li>
              )}
              {relationships!.zero_datum_count > 0 && (
                <li>{relationships!.zero_datum_count} zero datum{relationships!.zero_datum_count !== 1 ? 's' : ''}</li>
              )}
            </ul>
          </div>
        )}

        {type === 'shot' && !removesSection && !splitRequired && (
          <>
            {shotImpactError && (
              <div className="p-3 bg-warning-10 border border-warning-20 rounded text-warning text-sm">
                {shotImpactError}
              </div>
            )}
            <DeleteShotImpactDetails
              impact={shotImpact}
              title="Deleting this shot will update station relationships:"
            />
          </>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="danger" onClick={handleConfirm} disabled={type === 'station'} data-primary-action="">
            {splitRequired ? 'Delete & Split' : 'Delete'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
