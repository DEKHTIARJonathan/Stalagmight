import { useState, useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { trackDialogComplete } from '../../utils/telemetry';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

export default function InsertStationDialog() {
  const { closeDialog, dialogData, setSelection } = useUIStore();
  const { project, splitShotAtDistance } = useProjectStore();

  const sectionId = dialogData.sectionId as number | undefined;
  const shotId = dialogData.shotId as number | undefined;
  const shotLength = (dialogData.shotLength as number | undefined) ?? 0;
  const sectionName = dialogData.sectionName as string | undefined;

  const [distance, setDistance] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-initialize when the target shot changes
  useEffect(() => {
    setDistance('');
    setError(null);
  }, [sectionId, shotId]);

  const parsedDistance = parseFloat(distance);
  const isValid =
    distance.trim().length > 0 &&
    Number.isFinite(parsedDistance) &&
    parsedDistance > 0 &&
    parsedDistance < shotLength;
  const remaining = isValid ? shotLength - parsedDistance : null;

  const isDirty = distance.trim().length > 0;

  const handleConfirm = async () => {
    if (sectionId === undefined || shotId === undefined || !isValid) return;

    const section = project?.sections.find((s) => s.id === sectionId);
    const shotIndex = section?.shots.findIndex((sh) => sh.id === shotId) ?? -1;

    setIsLoading(true);
    setError(null);

    try {
      const result = await splitShotAtDistance(sectionId, shotId, parsedDistance);
      if (result.success) {
        if (shotIndex >= 0) {
          setSelection({
            type: 'station',
            stationRef: { section_id: sectionId, station_index: shotIndex + 1 },
          });
        }
        trackDialogComplete('insert-station');
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to insert station');
      }
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to insert station'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = isLoading ? () => {} : closeDialog;

  return (
    <DialogWrapper
      title={sectionName ? `Insert Station in ${sectionName}` : 'Insert Station'}
      onClose={handleClose}
      size="md"
      isDirty={isDirty}
      closeOnBackdropClick={!isLoading}
      data-testid="insert-station-dialog"
    >
      <div className="space-y-4">
        <p className="text-text-secondary">
          Splits the shot into two, adding a station at the given distance from its start.
        </p>

        {error && (
          <div className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm text-text-secondary mb-1">
            Distance from start (meters)
          </label>
          <input
            type="number" inputMode="decimal"
            min="0"
            max={shotLength}
            step="0.01"
            value={distance}
            onChange={(e) => setDistance(e.target.value)}
            className="w-full"
            placeholder={`0-${shotLength}`}
            data-testid="insert-station-distance"
            disabled={isLoading}
          />
        </div>

        <p className="text-sm text-text-secondary" data-testid="insert-station-preview">
          {remaining !== null
            ? `Shot A: ${parsedDistance.toFixed(2)} m / Shot B: ${remaining.toFixed(2)} m`
            : `Total shot length: ${shotLength.toFixed(2)} m`}
        </p>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={handleClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={isLoading || !isValid}
            data-testid="insert-station-confirm"
          >
            {isLoading ? 'Inserting...' : 'Insert Station'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
