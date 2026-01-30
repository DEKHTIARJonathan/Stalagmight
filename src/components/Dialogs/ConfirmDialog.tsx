import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { StationRef } from '../../types/project';
import type { SectionRelationships } from '../../types/commands';

export default function ConfirmDialog() {
  const { closeDialog, dialogData, clearSelection } = useUIStore();
  const { deleteShot, deleteSection, deleteLastShotAndSection } = useProjectStore();

  const type = dialogData.type as 'station' | 'shot' | 'section' | undefined;
  const message = dialogData.message as string | undefined;
  const stationRef = dialogData.stationRef as StationRef | undefined;
  const sectionId = dialogData.sectionId as number | undefined;
  const shotId = dialogData.shotId as number | undefined;
  const totalShots = dialogData.totalShots as number | undefined;
  const splitRequired = dialogData.splitRequired as boolean | undefined;

  const [relationships, setRelationships] = useState<SectionRelationships | null>(null);

  // Fetch relationships when dialog opens for section deletion
  useEffect(() => {
    if (type === 'section' && sectionId !== undefined) {
      invoke<SectionRelationships>('get_section_relationships', { sectionId })
        .then(setRelationships)
        .catch(() => setRelationships(null));
    } else {
      setRelationships(null);
    }
  }, [type, sectionId]);

  const handleConfirm = async () => {
    if (type === 'shot' && sectionId !== undefined && shotId !== undefined) {
      if (totalShots === 1) {
        // Last remaining shot: delete shot + section
        await deleteLastShotAndSection(sectionId, shotId);
      } else {
        // Edge shot (or legacy caller without position data): simple delete
        await deleteShot(sectionId, shotId);
      }
      clearSelection();
    } else if (type === 'section' && sectionId !== undefined) {
      await deleteSection(sectionId);
      clearSelection();
    } else if (type === 'station' && stationRef) {
      // Deleting a station requires deleting connected shots
      // For now, show a message that this is not directly supported
      // The user should delete the shots instead
    }
    closeDialog();
  };

  const getTitle = () => {
    switch (type) {
      case 'station':
        return 'Delete Station';
      case 'shot':
        return 'Delete Shot';
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
          <div className="p-3 bg-warning/10 border border-warning/20 rounded text-warning text-sm">
            Note: To delete a station, delete the shots connected to it instead.
          </div>
        )}

        {type === 'shot' && splitRequired && (
          <div className="p-3 bg-warning/10 border border-warning/20 rounded text-warning text-sm">
            Mid-section shot deletion requires section splitting. This feature is coming soon.
          </div>
        )}

        {type === 'section' && hasRelationships && (
          <div className="p-3 bg-warning/10 border border-warning/20 rounded text-sm space-y-1">
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

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="danger" onClick={handleConfirm} disabled={type === 'station' || !!splitRequired}>
            Delete
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
