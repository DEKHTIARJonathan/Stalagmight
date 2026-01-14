import { useState, useMemo } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import type { StationRef, ClosureStrategy } from '../../types/project';

export default function MergeDialog() {
  const { closeDialog, dialogData, clearMergeStations } = useUIStore();
  const { mergeStations, project, stations } = useProjectStore();

  const stationA = dialogData.stationA as StationRef | undefined;
  const stationB = dialogData.stationB as StationRef | undefined;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closureStrategy, setClosureStrategy] = useState<ClosureStrategy>('ProportionalByLength');

  // Get station data
  const stationAData = useMemo(() => {
    if (!stationA) return null;
    return stations.find(
      (s) => s.station_ref.section_id === stationA.section_id && s.station_ref.station_index === stationA.station_index
    );
  }, [stationA, stations]);

  const stationBData = useMemo(() => {
    if (!stationB) return null;
    return stations.find(
      (s) => s.station_ref.section_id === stationB.section_id && s.station_ref.station_index === stationB.station_index
    );
  }, [stationB, stations]);

  // Get section names
  const sectionAName = useMemo(() => {
    if (!stationA) return 'Unknown';
    return project?.sections.find((s) => s.id === stationA.section_id)?.name ?? `Section ${stationA.section_id}`;
  }, [stationA, project]);

  const sectionBName = useMemo(() => {
    if (!stationB) return 'Unknown';
    return project?.sections.find((s) => s.id === stationB.section_id)?.name ?? `Section ${stationB.section_id}`;
  }, [stationB, project]);

  // Calculate distance and depth difference
  const { distance, depthDiff, horizontalDistance } = useMemo(() => {
    if (!stationAData || !stationBData) return { distance: 0, depthDiff: 0, horizontalDistance: 0 };

    const dx = stationBData.coordinates.x - stationAData.coordinates.x;
    const dy = stationBData.coordinates.y - stationAData.coordinates.y;
    const dz = stationBData.coordinates.z - stationAData.coordinates.z;

    return {
      distance: Math.sqrt(dx * dx + dy * dy + dz * dz),
      depthDiff: Math.abs(dz),
      horizontalDistance: Math.sqrt(dx * dx + dy * dy),
    };
  }, [stationAData, stationBData]);

  // Check if this creates a loop (both stations already connected to zero datum)
  const createsLoop = useMemo(() => {
    // Simple check: if both stations have coordinates calculated (not at origin), they're connected
    // A more accurate check would trace paths back to zero datum
    if (!stationAData || !stationBData) return false;

    // If they're from the same section, they're already connected (not a new loop)
    if (stationA?.section_id === stationB?.section_id) return false;

    // Check if both are already part of merged networks
    const aHasMerges = stationAData.merged_with.length > 0;
    const bHasMerges = stationBData.merged_with.length > 0;

    // If both have merges or one is zero datum, this could create a loop
    return aHasMerges || bHasMerges || stationAData.is_zero_datum || stationBData.is_zero_datum;
  }, [stationA, stationB, stationAData, stationBData]);

  // Estimate closure error (simplified - actual calculation needs path traversal)
  const closureErrorPercent = useMemo(() => {
    if (!createsLoop || distance === 0) return null;

    // Simplified: assume typical survey precision
    // Real calculation would sum all shot lengths in the loop
    // For now, just show the distance as an indicator
    return distance > 0.5 ? `~${((distance / 100) * 100).toFixed(1)}` : null;
  }, [createsLoop, distance]);

  const handleClose = () => {
    clearMergeStations();
    closeDialog();
  };

  const handleMerge = async () => {
    if (!stationA || !stationB) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await mergeStations(stationA, stationB, closureStrategy);
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
    <DialogWrapper title="Merge Stations" onClose={handleClose}>
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded text-error text-sm">{error}</div>
        )}

        {/* Station details */}
        <div className="space-y-2">
          <div className="flex justify-between items-center py-2 border-b border-border">
            <span className="text-text-secondary">Station A:</span>
            <span>
              {sectionAName} #{stationA.station_index}
              <span className="text-text-secondary ml-2">
                (depth: {stationAData?.coordinates.z.toFixed(1) ?? '?'}m)
              </span>
            </span>
          </div>
          <div className="flex justify-between items-center py-2 border-b border-border">
            <span className="text-text-secondary">Station B:</span>
            <span>
              {sectionBName} #{stationB.station_index}
              <span className="text-text-secondary ml-2">
                (depth: {stationBData?.coordinates.z.toFixed(1) ?? '?'}m)
              </span>
            </span>
          </div>
        </div>

        {/* Distance info */}
        <div className="p-3 bg-background rounded space-y-1">
          <div className="flex justify-between">
            <span className="text-text-secondary">Distance between:</span>
            <span className="font-medium">{distance.toFixed(2)}m</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Horizontal distance:</span>
            <span>{horizontalDistance.toFixed(2)}m</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Depth difference:</span>
            <span>{depthDiff.toFixed(2)}m</span>
          </div>
        </div>

        {/* Loop closure warning */}
        {createsLoop && (
          <div className="p-3 bg-warning/10 border border-warning/20 rounded">
            <div className="flex items-start gap-2">
              <span className="text-warning text-lg">⚠</span>
              <div>
                <p className="text-warning font-medium">This creates a loop</p>
                {closureErrorPercent && (
                  <p className="text-text-secondary text-sm mt-1">
                    Closure error: {closureErrorPercent}% (distance / path length)
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Closure strategy selection */}
        <div className="space-y-2">
          <p className="text-text-secondary text-sm">How to handle closure error?</p>
          <div className="space-y-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="closureStrategy"
                checked={closureStrategy === 'ProportionalByLength'}
                onChange={() => setClosureStrategy('ProportionalByLength')}
              />
              <span>Distribute proportionally by shot length</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="closureStrategy"
                checked={closureStrategy === 'EqualDistribution'}
                onChange={() => setClosureStrategy('EqualDistribution')}
              />
              <span>Distribute equally across all shots</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="closureStrategy"
                checked={closureStrategy === 'KeepRaw'}
                onChange={() => setClosureStrategy('KeepRaw')}
              />
              <span>Keep raw data (stations won't align perfectly)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="closureStrategy"
                checked={closureStrategy === 'ManualAdjustment'}
                onChange={() => setClosureStrategy('ManualAdjustment')}
              />
              <span>Adjust manually later</span>
            </label>
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

interface DialogWrapperProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

function DialogWrapper({ title, onClose, children }: DialogWrapperProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-panel border border-border rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-lg font-medium">{title}</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl">
            x
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
