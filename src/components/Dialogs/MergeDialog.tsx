import { useState, useMemo } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { StationRef } from '../../types/project';

export default function MergeDialog() {
  const { closeDialog, dialogData, clearMergeStations } = useUIStore();
  const { mergeStations, project } = useProjectStore();

  const stationA = dialogData.stationA as StationRef | undefined;
  const stationB = dialogData.stationB as StationRef | undefined;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get section names
  const sectionAName = useMemo(() => {
    if (!stationA) return 'Unknown';
    return project?.sections.find((s) => s.id === stationA.section_id)?.name ?? `Section ${stationA.section_id}`;
  }, [stationA, project]);

  const sectionBName = useMemo(() => {
    if (!stationB) return 'Unknown';
    return project?.sections.find((s) => s.id === stationB.section_id)?.name ?? `Section ${stationB.section_id}`;
  }, [stationB, project]);

  const handleClose = () => {
    clearMergeStations();
    closeDialog();
  };

  const handleMerge = async () => {
    if (!stationA || !stationB) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await mergeStations(stationA, stationB);
      if (result.success) {
        clearMergeStations();
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to merge stations');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to merge stations');
    } finally {
      setIsLoading(false);
    }
  };

  if (!stationA || !stationB) {
    return null;
  }

  return (
    <DialogWrapper title="Merge Stations" onClose={handleClose} size="lg" data-testid="merge-dialog">
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm">{error}</div>
        )}

        {/* Station details */}
        <div className="space-y-2">
          <div className="flex justify-between items-center py-2 border-b border-border">
            <span className="text-text-secondary">Station A:</span>
            <span>{sectionAName} #{stationA.station_index}</span>
          </div>
          <div className="flex justify-between items-center py-2 border-b border-border">
            <span className="text-text-secondary">Station B:</span>
            <span>{sectionBName} #{stationB.station_index}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={handleClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleMerge} disabled={isLoading}>
            {isLoading ? 'Merging...' : 'Merge'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
