import { useMemo, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { trackDialogComplete } from '../../utils/telemetry';
import type { ClosureStrategy, StationRef } from '../../types/project';
const METHOD: ClosureStrategy = 'LeastSquaresWeighted';

export default function AdjustClosuresDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const { project, config, adjustLoopClosures } = useProjectStore();

  const anchorStation = dialogData.anchorStation as StationRef | undefined;
  const anchorSection = project?.sections.find((s) => s.id === anchorStation?.section_id);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baseSigmas = useMemo(() => ({
    length: config?.closure_adjustment?.base_sigma_length_m ?? 0.05,
    azimuth: config?.closure_adjustment?.base_sigma_azimuth_deg ?? 1.0,
    depth: config?.closure_adjustment?.base_sigma_depth_m ?? 0.05,
  }), [config]);

  const handleAdjust = async () => {
    if (!anchorStation) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await adjustLoopClosures(anchorStation, METHOD);
      if (result.success) {
        trackDialogComplete('adjust-closures');
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to adjust closures');
      }
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to adjust closures'));
    } finally {
      setIsLoading(false);
    }
  };

  if (!anchorStation) return null;

  return (
    <DialogWrapper
      title="Adjust Loop Closures"
      onClose={closeDialog}
      size="lg"
      data-testid="adjust-closures-dialog"
    >
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm">
            {error}
          </div>
        )}

        <div className="text-sm text-text-secondary">
          Anchor: <span className="text-text-primary">{anchorSection?.name ?? `Section ${anchorStation.section_id}`}</span>
          {' '}#{anchorStation.station_index}
        </div>

        <div className="space-y-3">
          <div className="text-xs text-text-secondary space-y-1">
            <div>Method: Least Squares (Weighted)</div>
            <div>Base sigma (length): {baseSigmas.length} m</div>
            <div>Base sigma (azimuth): {baseSigmas.azimuth} deg</div>
            <div>Base sigma (depth): {baseSigmas.depth} m</div>
          </div>

          <div className="text-xs text-text-secondary">
            Zero datums are fixed and will never move.
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button onClick={closeDialog} disabled={isLoading}>Cancel</Button>
          <Button variant="primary" onClick={handleAdjust} disabled={isLoading}>
            {isLoading ? 'Adjusting...' : 'Run Adjustment'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
