import { useMemo, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { Select } from '../common/Select';
import type { ClosureStrategy, StationRef } from '../../types/project';
import type { TransitVerticalMode } from '../../types/config';

const METHOD_OPTIONS: { value: ClosureStrategy; label: string }[] = [
  { value: 'Sequential', label: 'Sequential' },
  { value: 'TransitRule', label: 'Transit Rule' },
  { value: 'LeastSquaresWeighted', label: 'Least Squares (Weighted)' },
];

const DISTRIBUTION_OPTIONS: { value: ClosureStrategy; label: string }[] = [
  { value: 'ProportionalByLength', label: 'Proportional by Length' },
  { value: 'EqualDistribution', label: 'Equal Distribution' },
  { value: 'TransitRule', label: 'Transit Rule' },
];

const VERTICAL_OPTIONS: { value: TransitVerticalMode; label: string }[] = [
  { value: 'ignore', label: 'Ignore vertical' },
  { value: 'length_proportional', label: 'Length proportional' },
  { value: 'equal', label: 'Equal' },
];

export default function AdjustClosuresDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const { project, config, adjustLoopClosures } = useProjectStore();

  const anchorStation = dialogData.anchorStation as StationRef | undefined;
  const anchorSection = project?.sections.find((s) => s.id === anchorStation?.section_id);

  const [method, setMethod] = useState<ClosureStrategy>('Sequential');
  const [useStrategyFilter, setUseStrategyFilter] = useState(true);
  const [sequentialDistribution, setSequentialDistribution] = useState<ClosureStrategy>(
    config?.closure_adjustment?.sequential_distribution_default ?? 'ProportionalByLength'
  );
  const [transitVerticalMode, setTransitVerticalMode] = useState<TransitVerticalMode>(
    config?.closure_adjustment?.transit_vertical_mode ?? 'ignore'
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showDistribution = method === 'Sequential';
  const showTransitVertical = method === 'TransitRule'
    || (method === 'Sequential' && sequentialDistribution === 'TransitRule');

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
      const result = await adjustLoopClosures(
        anchorStation,
        method,
        useStrategyFilter,
        sequentialDistribution,
        transitVerticalMode
      );
      if (result.success) {
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to adjust closures');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to adjust closures');
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
          <div>
            <label className="block text-sm text-text-secondary mb-1">Method</label>
            <Select
              value={method}
              onChange={(v) => setMethod(v as ClosureStrategy)}
              options={METHOD_OPTIONS}
              className="w-full"
              data-testid="adjust-closures-method"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useStrategyFilter}
              onChange={(e) => setUseStrategyFilter(e.target.checked)}
              className="accent-accent"
              data-testid="adjust-closures-filter"
            />
            Use only closures with selected strategy
          </label>

          {showDistribution && (
            <div>
              <label className="block text-sm text-text-secondary mb-1">Sequential distribution</label>
              <Select
                value={sequentialDistribution}
                onChange={(v) => setSequentialDistribution(v as ClosureStrategy)}
                options={DISTRIBUTION_OPTIONS}
                className="w-full"
                data-testid="adjust-closures-distribution"
              />
            </div>
          )}

          {showTransitVertical && (
            <div>
              <label className="block text-sm text-text-secondary mb-1">Vertical handling</label>
              <Select
                value={transitVerticalMode}
                onChange={(v) => setTransitVerticalMode(v as TransitVerticalMode)}
                options={VERTICAL_OPTIONS}
                className="w-full"
                data-testid="adjust-closures-vertical"
              />
            </div>
          )}

          {method === 'LeastSquaresWeighted' && (
            <div className="text-xs text-text-secondary space-y-1">
              <div>Base sigma (length): {baseSigmas.length} m</div>
              <div>Base sigma (azimuth): {baseSigmas.azimuth} deg</div>
              <div>Base sigma (depth): {baseSigmas.depth} m</div>
            </div>
          )}

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
