import { useState, useEffect, useCallback, useRef } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { trackDialogComplete } from '../../utils/telemetry';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { formatFixed } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { parseGps, detectFormat, type GpsFormat } from '../../utils/gps';
import { humanizeEditError } from '../../utils/editErrors';
import type { GpsCoordinates } from '../../types/project';
import type { StationRef } from '../../types/project';

export default function EditStationDialog() {
  const precision = useDecimalPrecision();
  const { closeDialog, dialogData } = useUIStore();
  const { stations, project, setZeroDatum, removeZeroDatum, updateStationComment } = useProjectStore();

  const stationRef = dialogData.stationRef as StationRef | undefined;
  const forceEnableZeroDatum = dialogData.forceEnableZeroDatum === true;
  const focusGpsInput = dialogData.focusGpsInput === true;

  const station = stations.find(
    (s) =>
      s.station_ref.section_id === stationRef?.section_id &&
      s.station_ref.station_index === stationRef?.station_index
  );

  const section = project?.sections.find(
    (s) => s.id === stationRef?.section_id
  );

  // Form state
  const [isZeroDatum, setIsZeroDatumState] = useState(
    () => forceEnableZeroDatum || station?.is_zero_datum || false
  );
  const [gpsInput, setGpsInput] = useState('');
  const [gpsCoords, setGpsCoords] = useState<GpsCoordinates | null>(null);
  const [gpsFormat, setGpsFormat] = useState<GpsFormat | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gpsInputRef = useRef<HTMLInputElement>(null);

  // Initialize form state from station data
  useEffect(() => {
    if (station) {
      setIsZeroDatumState(forceEnableZeroDatum ? true : station.is_zero_datum);
      setComment(station.comment ?? '');
      if (station.gps_coordinates) {
        const initialInput = `${station.gps_coordinates.latitude}, ${station.gps_coordinates.longitude}`;
        setGpsInput(initialInput);
        setGpsCoords(station.gps_coordinates);
        setGpsFormat('DD');
      }
    }
  }, [forceEnableZeroDatum, station]);

  // Focus GPS input when dialog is opened from "Set Zero Datum" action.
  useEffect(() => {
    if (!focusGpsInput || !isZeroDatum) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      gpsInputRef.current?.focus();
      gpsInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [focusGpsInput, isZeroDatum]);

  // GPS input handler
  const handleGpsInputChange = useCallback((value: string) => {
    setGpsInput(value);
    if (!value.trim()) {
      setGpsCoords(null);
      setGpsFormat(null);
      setGpsError(null);
      return;
    }
    const fmt = detectFormat(value);
    setGpsFormat(fmt ?? null);
    const result = parseGps(value);
    if ('coordinates' in result) {
      setGpsCoords(result.coordinates);
      setGpsError(null);
    } else {
      setGpsCoords(null);
      setGpsError(result.message);
    }
  }, []);

  const handleSave = async () => {
    if (!stationRef || !station) return;

    setIsLoading(true);
    setError(null);

    try {
      const wasZeroDatum = station.is_zero_datum;
      const willBeZeroDatum = isZeroDatum;

      if (!wasZeroDatum && willBeZeroDatum) {
        // Setting new zero datum
        if (!gpsCoords) {
          setError('Please enter valid GPS coordinates');
          return;
        }

        const result = await setZeroDatum(stationRef, {
          latitude: gpsCoords.latitude,
          longitude: gpsCoords.longitude,
          depth_reference: station.coordinates.z,
        });

        if (!result.success) {
          setError(humanizeEditError(result.error, 'Failed to set zero datum'));
          return;
        }
      } else if (wasZeroDatum && !willBeZeroDatum) {
        // Removing zero datum
        const result = await removeZeroDatum(stationRef);
        if (!result.success) {
          setError(humanizeEditError(result.error, 'Failed to remove zero datum'));
          return;
        }
      } else if (wasZeroDatum && willBeZeroDatum) {
        // Updating GPS coordinates - check if changed
        if (!gpsCoords) {
          setError('Please enter valid GPS coordinates');
          return;
        }

        const oldLat = station.gps_coordinates?.latitude;
        const oldLon = station.gps_coordinates?.longitude;

        if (gpsCoords.latitude !== oldLat || gpsCoords.longitude !== oldLon) {
          const result = await setZeroDatum(stationRef, {
            latitude: gpsCoords.latitude,
            longitude: gpsCoords.longitude,
            depth_reference: station.coordinates.z,
          });

          if (!result.success) {
            setError(humanizeEditError(result.error, 'Failed to update zero datum'));
            return;
          }
        }
      }

      // Save comment if changed
      const oldComment = station.comment ?? '';
      if (comment !== oldComment) {
        const commentResult = await updateStationComment(
          stationRef,
          comment.trim() || null
        );
        if (!commentResult.success) {
          setError(humanizeEditError(commentResult.error, 'Failed to update comment'));
          return;
        }
      }

      trackDialogComplete('edit-station');
      closeDialog();
    } catch (e) {
      setError(getErrorMessage(e, 'An error occurred'));
    } finally {
      setIsLoading(false);
    }
  };

  // Track if form has been modified
  const originalGpsInput = station?.gps_coordinates
    ? `${station.gps_coordinates.latitude}, ${station.gps_coordinates.longitude}`
    : '';
  const isDirty = station ? (
    isZeroDatum !== station.is_zero_datum ||
    gpsInput !== originalGpsInput ||
    comment !== (station.comment ?? '')
  ) : false;

  if (!station || !stationRef) {
    return (
      <DialogWrapper title="Edit Station" onClose={closeDialog} size="md" data-testid="edit-station-dialog">
        <div className="text-error">Station not found</div>
      </DialogWrapper>
    );
  }

  return (
    <DialogWrapper title="Edit Station" onClose={closeDialog} size="md" isDirty={isDirty} data-testid="edit-station-dialog">
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm">
            {error}
          </div>
        )}

        <div className="text-sm text-text-secondary">
          Station coordinates are calculated from shots and cannot be edited directly.
        </div>

        <div className="space-y-3 border-t border-border pt-3">
          <DetailRow
            label="ID"
            value={`${stationRef.section_id}:${stationRef.station_index}`}
          />
          <DetailRow
            label="Section"
            value={section?.name ?? `Section ${stationRef.section_id}`}
          />
          <DetailRow label="X" value={`${formatFixed(station.coordinates.x, undefined, precision.coordinates)} m`} />
          <DetailRow label="Y" value={`${formatFixed(station.coordinates.y, undefined, precision.coordinates)} m`} />
          <DetailRow label="Depth" value={`${formatFixed(station.coordinates.z, undefined, precision.depth)} m`} />
        </div>

        {station.merged_with.length > 0 && (
          <div className="border-t border-border pt-3">
            <span className="text-sm text-text-secondary">Merged with:</span>
            <ul className="mt-1">
              {station.merged_with.map((ref, i) => (
                <li key={i} className="text-sm">
                  {ref.section_id}:{ref.station_index}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Comment section */}
        <div className="border-t border-border pt-3 space-y-2">
          <label className="block text-sm font-medium" htmlFor="station-comment">
            Comment
          </label>
          <textarea
            id="station-comment"
            data-testid="station-comment-input"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded resize-y min-h-[60px]"
            placeholder="Add a comment..."
            rows={2}
          />
        </div>

        {/* Zero Datum section */}
        <div className="border-t border-border pt-3 space-y-3">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="zeroDatum"
              checked={isZeroDatum}
              onChange={(e) => setIsZeroDatumState(e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor="zeroDatum" className="text-sm font-medium">
              Set as Zero Datum
            </label>
          </div>

          {isZeroDatum && (
            <div className="space-y-1 pl-6">
              <div className="flex items-center gap-2">
                <label className="text-sm text-text-secondary shrink-0">
                  GPS:
                </label>
                <input
                  ref={gpsInputRef}
                  data-autofocus={focusGpsInput ? 'true' : undefined}
                  type="text"
                  value={gpsInput}
                  onChange={(e) => handleGpsInputChange(e.target.value)}
                  placeholder="48.8584, 2.2945"
                  className="flex-1 px-2 py-1.5 bg-background border border-border rounded text-sm"
                  data-testid="station-gps-input"
                />
                {gpsFormat && (
                  <span
                    className="text-xs px-2 py-1 bg-accent-10 text-accent rounded"
                    data-testid="station-gps-format"
                  >
                    {gpsFormat}
                  </span>
                )}
              </div>
              {gpsError && (
                <div className="text-xs text-error pl-1" data-testid="station-gps-error">
                  {gpsError}
                </div>
              )}
              {gpsCoords && (
                <div className="text-xs text-success pl-1" data-testid="station-gps-parsed">
                  Lat: {formatFixed(gpsCoords.latitude, undefined, precision.gps)}, Lon:{' '}
                  {formatFixed(gpsCoords.longitude, undefined, precision.gps)}
                </div>
              )}
              <p className="text-xs text-text-secondary pt-1">
                GPS coordinates for this station. Other stations will have their
                GPS calculated relative to this datum.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={isLoading}>
            {isLoading ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-text-secondary">{label}:</span>
      <span>{value}</span>
    </div>
  );
}
