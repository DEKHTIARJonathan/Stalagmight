import { useState, useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { trackDialogComplete } from '../../utils/telemetry';
import { MIN_SPLIT_CHILD_LENGTH_M } from '../../utils/shotSplit';
import { isEditingBlockedNow } from '../../hooks/useEditingBlocked';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

export default function InsertStationDialog() {
  const { closeDialog, dialogData, setSelection } = useUIStore();
  const { splitShotAtDistance } = useProjectStore();

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
    parsedDistance >= MIN_SPLIT_CHILD_LENGTH_M &&
    shotLength - parsedDistance >= MIN_SPLIT_CHILD_LENGTH_M;
  const remaining = isValid ? shotLength - parsedDistance : null;

  const isDirty = distance.trim().length > 0;

  const handleConfirm = async () => {
    if (isLoading || sectionId === undefined || shotId === undefined || !isValid) return;

    // Read-only self-check at confirm time: a split has NO server backstop for
    // the local closure-adjusted / Plan / Export case (see useEditingBlocked's
    // backstop-asymmetry note), so a dialog left open across a view switch to a
    // read-only mode must refuse here rather than mutate. Re-checked now, not at
    // open time, because the mode can flip while the dialog is up.
    if (isEditingBlockedNow()) {
      setError('Editing is disabled in the current view.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await splitShotAtDistance(sectionId, shotId, parsedDistance);
      if (result.success) {
        // Re-derive the new station's index from the REFRESHED store state
        // rather than a pre-await snapshot (#59 fix D): the tail keeps its
        // shot id, and its post-split index IS the new station's index
        // (station i sits between shots i-1 and i). If the section/shot is
        // gone by the time the split resolves (project switched, or a racing
        // mutation), skip the selection and just close.
        const refreshedProject = useProjectStore.getState().project;
        const section = refreshedProject?.sections.find((s) => s.id === sectionId);
        const newStationIndex = section?.shots.findIndex((sh) => sh.id === shotId) ?? -1;
        if (newStationIndex >= 0) {
          setSelection({
            type: 'station',
            stationRef: { section_id: sectionId, station_index: newStationIndex },
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
            min={MIN_SPLIT_CHILD_LENGTH_M}
            max={shotLength - MIN_SPLIT_CHILD_LENGTH_M}
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
            : `Total shot length: ${shotLength.toFixed(2)} m (both sides must be at least ${MIN_SPLIT_CHILD_LENGTH_M.toFixed(2)} m)`}
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
