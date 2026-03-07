import { useState, useMemo, useEffect, useRef } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { trackDialogComplete } from '../../utils/telemetry';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { StationRef, ShotData } from '../../types/project';

export default function DrawShotDialog() {
  const { closeDialog, dialogData, setDrawFromStation, setSelection } = useUIStore();
  const { createShot, project, stations } = useProjectStore();

  const fromStation = dialogData.fromStation as StationRef | undefined;
  const allowZeroLength = dialogData.allowZeroLength as boolean | undefined;
  const prependMode = dialogData.prependMode as boolean | undefined;
  const appendMode = dialogData.appendMode as boolean | undefined;
  const sourceGeometry = dialogData.sourceGeometry as {
    azimuth_in: number;
    azimuth_out: number;
    depth_in: number;
    depth_out: number;
    pitch_in: number | null;
    pitch_out: number | null;
  } | undefined;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Normalize azimuth to 0-360 range
  const normalizeAzimuth = (value: number): number => {
    let normalized = value % 360;
    if (normalized < 0) normalized += 360;
    return normalized;
  };

  const initialAzimuthIn = useMemo(() => {
    if (!sourceGeometry) return '';
    const base = sourceGeometry.azimuth_in;
    const reversed = prependMode ? normalizeAzimuth(base + 180) : base;
    return String(reversed);
  }, [sourceGeometry, prependMode]);

  const initialAzimuthOut = useMemo(() => {
    if (!sourceGeometry) return '';
    const base = sourceGeometry.azimuth_out;
    const reversed = prependMode ? normalizeAzimuth(base + 180) : base;
    return String(reversed);
  }, [sourceGeometry, prependMode]);

  // Form state — prefill from source geometry if provided
  const [azimuthIn, setAzimuthIn] = useState(initialAzimuthIn);
  const [azimuthOut, setAzimuthOut] = useState(initialAzimuthOut);
  const [length, setLength] = useState((prependMode || appendMode) ? '0' : '');
  const [depthIn, setDepthIn] = useState(sourceGeometry ? String(sourceGeometry.depth_in) : '');
  const [depthOut, setDepthOut] = useState(sourceGeometry ? String(sourceGeometry.depth_out) : '');
  const [isReference, setIsReference] = useState(false);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [up, setUp] = useState('');
  const [down, setDown] = useState('');

  // Get section info
  const section = useMemo(() => {
    if (!fromStation) return null;
    return project?.sections.find((s) => s.id === fromStation.section_id);
  }, [fromStation, project]);

  const sectionName = section?.name ?? `Section ${fromStation?.section_id}`;

  // Get current station depth for default
  const currentStationDepth = useMemo(() => {
    if (!fromStation) return 0;
    const station = stations.find(
      (s) => s.station_ref.section_id === fromStation.section_id && s.station_ref.station_index === fromStation.station_index
    );
    return station?.coordinates.z ?? 0;
  }, [fromStation, stations]);

  // Track if depth/length were auto-initialized (for isDirty calculation)
  const depthAutoInitialized = useRef(!!sourceGeometry);
  const lengthAutoInitialized = useRef(!!(prependMode || appendMode));

  // Initialize depth_in with current station depth on mount
  useEffect(() => {
    if (depthIn === '' && currentStationDepth !== 0) {
      setDepthIn(currentStationDepth.toFixed(1));
      depthAutoInitialized.current = true;
    }
  }, [currentStationDepth]); // Only run when currentStationDepth changes

  const handleClose = () => {
    setDrawFromStation(null);
    closeDialog();
  };

  const validateForm = (): boolean => {
    const lengthVal = parseFloat(length);
    if (!length || isNaN(lengthVal) || (allowZeroLength ? lengthVal < 0 : lengthVal <= 0)) {
      setError(allowZeroLength ? 'Length must be 0 or greater' : 'Length must be greater than 0');
      return false;
    }
    const azVal = parseFloat(azimuthIn);
    if (!azimuthIn || isNaN(azVal)) {
      setError('Azimuth In is required');
      return false;
    }
    if (azVal < -360 || azVal > 360) {
      setError('Azimuth must be between -360 and 360');
      return false;
    }
    return true;
  };

  const handleCreate = async () => {
    if (!fromStation || !section) return;

    if (!validateForm()) return;

    setIsLoading(true);
    setError(null);

    try {
      // Build shot data with normalized azimuths
      // In prepend mode with existing shots, reverse the azimuth by 180° (user enters forward direction, shot stores backward)
      // For empty sections (no reference shot), skip reversal — the first shot added is just a normal shot
      const rawAzimuthIn = parseFloat(azimuthIn);
      const rawAzimuthOut = azimuthOut ? parseFloat(azimuthOut) : rawAzimuthIn;
      const shouldReverse = prependMode && section.shots.length > 0;
      const normalizedAzimuthIn = normalizeAzimuth(shouldReverse ? rawAzimuthIn + 180 : rawAzimuthIn);
      const normalizedAzimuthOut = normalizeAzimuth(shouldReverse ? rawAzimuthOut + 180 : rawAzimuthOut);
      const shotData: ShotData = {
        azimuth_in: normalizedAzimuthIn,
        azimuth_out: normalizedAzimuthOut,
        length: parseFloat(length),
        depth_in: depthIn ? parseFloat(depthIn) : currentStationDepth,
        depth_out: depthOut ? parseFloat(depthOut) : (depthIn ? parseFloat(depthIn) : currentStationDepth),
        pitch_in: sourceGeometry?.pitch_in ?? null,
        pitch_out: sourceGeometry?.pitch_out ?? null,
        left: left ? parseFloat(left) : null,
        right: right ? parseFloat(right) : null,
        up: up ? parseFloat(up) : null,
        down: down ? parseFloat(down) : null,
        comment: null,
        is_reference: isReference,
        marker_index: null,
        temperature: null,
      };

      // Determine where to insert the shot
      let afterShotId: number | undefined;
      let beforeShotId: number | undefined;
      if (prependMode && section.shots.length > 0) {
        // Prepend: insert before the first shot
        beforeShotId = section.shots[0]?.id;
      } else if (fromStation.station_index > 0 && fromStation.station_index <= section.shots.length) {
        // Append after the shot at station_index - 1
        afterShotId = section.shots[fromStation.station_index - 1]?.id;
      }

      const result = await createShot(fromStation.section_id, shotData, afterShotId, beforeShotId);

      if (result.success) {
        // Select the newly created shot
        if (result.shot_id != null) {
          setSelection({
            type: 'shot',
            sectionId: fromStation.section_id,
            shotId: result.shot_id,
          });
        }
        setDrawFromStation(null);
        trackDialogComplete('draw-shot');
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to create shot');
      }
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to create shot'));
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-fill azimuth out when azimuth in changes
  const handleAzimuthInChange = (value: string) => {
    setAzimuthIn(value);
    if (!azimuthOut && value) {
      setAzimuthOut(value);
    }
  };

  // Auto-fill depth out when depth in changes
  const handleDepthInChange = (value: string) => {
    setDepthIn(value);
    if (!depthOut && value) {
      setDepthOut(value);
    }
  };

  // Track if form has been modified (exclude auto-initialized depth/length from making dirty)
  const userModifiedDepth = depthIn !== '' && !depthAutoInitialized.current;
  const userModifiedLength = length !== '' && !lengthAutoInitialized.current;
  const isDirty = azimuthIn !== '' || userModifiedLength || userModifiedDepth || isReference || left !== '' || right !== '' || up !== '' || down !== '';

  if (!fromStation) {
    return null;
  }

  return (
    <DialogWrapper title={prependMode ? 'Add Shot Before Section' : appendMode ? `Add Shot After Station #${fromStation.station_index}` : 'Draw New Shot'} onClose={handleClose} size="md" isDirty={isDirty} data-testid="draw-shot-dialog">
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm">{error}</div>
        )}

        {/* From station info */}
        <div className="p-3 bg-background rounded">
          <span className="text-text-secondary">From:</span>{' '}
          <span className="font-medium">
            {sectionName} #{fromStation.station_index}
          </span>
        </div>

        {/* Main fields */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              Azimuth In (degrees) <span className="text-error">*</span>
            </label>
            <input
              type="number"
              min="0"
              max="359.99"
              step="0.1"
              value={azimuthIn}
              onChange={(e) => handleAzimuthInChange(e.target.value)}
              className="w-full"
              placeholder="0-360"
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Azimuth Out (degrees)</label>
            <input
              type="number"
              min="0"
              max="359.99"
              step="0.1"
              value={azimuthOut}
              onChange={(e) => setAzimuthOut(e.target.value)}
              className="w-full"
              placeholder="Same as in"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">
            Length (meters) <span className="text-error">*</span>
          </label>
          <input
            type="number"
            min={allowZeroLength ? '0' : '0.01'}
            step="0.01"
            value={length}
            onChange={(e) => { lengthAutoInitialized.current = false; setLength(e.target.value); }}
            className="w-full"
            placeholder="Shot distance"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Depth In (meters)</label>
            <input
              type="number"
              step="0.1"
              value={depthIn}
              onChange={(e) => handleDepthInChange(e.target.value)}
              className="w-full"
              placeholder={currentStationDepth.toFixed(1)}
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Depth Out (meters)</label>
            <input
              type="number"
              step="0.1"
              value={depthOut}
              onChange={(e) => setDepthOut(e.target.value)}
              className="w-full"
              placeholder="Same as in"
            />
          </div>
        </div>

        {/* LRUD fields (collapsed by default) */}
        <details className="border border-border rounded">
          <summary className="px-3 py-2 cursor-pointer text-text-secondary hover:text-text-primary">
            LRUD (optional)
          </summary>
          <div className="p-3 pt-0 grid grid-cols-4 gap-2">
            <div>
              <label className="block text-xs text-text-secondary mb-1">Left</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={left}
                onChange={(e) => setLeft(e.target.value)}
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Right</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={right}
                onChange={(e) => setRight(e.target.value)}
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Up</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={up}
                onChange={(e) => setUp(e.target.value)}
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Down</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={down}
                onChange={(e) => setDown(e.target.value)}
                className="w-full"
              />
            </div>
          </div>
        </details>

        {/* Reference checkbox */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isReference} onChange={(e) => setIsReference(e.target.checked)} />
          <span>Mark as Jump/Reference shot</span>
          <span className="text-text-secondary text-sm">(temporary connection)</span>
        </label>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={handleClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleCreate} disabled={isLoading}>
            {isLoading ? 'Creating...' : 'Create Shot'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
