import { useState, useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import type { StationRef } from '../../types/project';

export default function EditStationDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const { stations, project, setZeroDatum, removeZeroDatum } = useProjectStore();

  const stationRef = dialogData.stationRef as StationRef | undefined;

  const station = stations.find(
    (s) =>
      s.station_ref.section_id === stationRef?.section_id &&
      s.station_ref.station_index === stationRef?.station_index
  );

  const section = project?.sections.find(
    (s) => s.id === stationRef?.section_id
  );

  // Form state
  const [isZeroDatum, setIsZeroDatumState] = useState(false);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize form state from station data
  useEffect(() => {
    if (station) {
      setIsZeroDatumState(station.is_zero_datum);
      setLatitude(station.gps_coordinates?.latitude.toString() ?? '');
      setLongitude(station.gps_coordinates?.longitude.toString() ?? '');
    }
  }, [station]);

  const handleSave = async () => {
    if (!stationRef || !station) return;

    setIsLoading(true);
    setError(null);

    try {
      const wasZeroDatum = station.is_zero_datum;
      const willBeZeroDatum = isZeroDatum;

      if (!wasZeroDatum && willBeZeroDatum) {
        // Setting new zero datum
        const lat = parseFloat(latitude);
        const lon = parseFloat(longitude);

        if (isNaN(lat) || lat < -90 || lat > 90) {
          setError('Latitude must be between -90 and 90');
          return;
        }
        if (isNaN(lon) || lon < -180 || lon > 180) {
          setError('Longitude must be between -180 and 180');
          return;
        }

        const result = await setZeroDatum(stationRef, {
          latitude: lat,
          longitude: lon,
          depth_reference: station.coordinates.z,
        });

        if (!result.success) {
          setError(result.error ?? 'Failed to set zero datum');
          return;
        }
      } else if (wasZeroDatum && !willBeZeroDatum) {
        // Removing zero datum
        const result = await removeZeroDatum(stationRef);
        if (!result.success) {
          setError(result.error ?? 'Failed to remove zero datum');
          return;
        }
      } else if (wasZeroDatum && willBeZeroDatum) {
        // Updating GPS coordinates - check if changed
        const lat = parseFloat(latitude);
        const lon = parseFloat(longitude);

        if (isNaN(lat) || lat < -90 || lat > 90) {
          setError('Latitude must be between -90 and 90');
          return;
        }
        if (isNaN(lon) || lon < -180 || lon > 180) {
          setError('Longitude must be between -180 and 180');
          return;
        }

        const oldLat = station.gps_coordinates?.latitude;
        const oldLon = station.gps_coordinates?.longitude;

        if (lat !== oldLat || lon !== oldLon) {
          // Remove then re-add with new coordinates
          let result = await removeZeroDatum(stationRef);
          if (!result.success) {
            setError(result.error ?? 'Failed to update zero datum');
            return;
          }

          result = await setZeroDatum(stationRef, {
            latitude: lat,
            longitude: lon,
            depth_reference: station.coordinates.z,
          });

          if (!result.success) {
            setError(result.error ?? 'Failed to update zero datum');
            return;
          }
        }
      }

      closeDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  if (!station || !stationRef) {
    return (
      <DialogWrapper title="Edit Station" onClose={closeDialog}>
        <div className="text-error">Station not found</div>
      </DialogWrapper>
    );
  }

  return (
    <DialogWrapper title="Edit Station" onClose={closeDialog}>
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded text-error text-sm">
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
          <DetailRow label="X" value={`${station.coordinates.x.toFixed(2)} m`} />
          <DetailRow label="Y" value={`${station.coordinates.y.toFixed(2)} m`} />
          <DetailRow label="Depth" value={`${station.coordinates.z.toFixed(1)} m`} />
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
            <div className="space-y-3 pl-6">
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  Latitude
                </label>
                <input
                  type="number"
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                  className="w-full"
                  placeholder="e.g., 25.0340"
                  step="0.000001"
                  min="-90"
                  max="90"
                />
              </div>
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  Longitude
                </label>
                <input
                  type="number"
                  value={longitude}
                  onChange={(e) => setLongitude(e.target.value)}
                  className="w-full"
                  placeholder="e.g., -77.4010"
                  step="0.000001"
                  min="-180"
                  max="180"
                />
              </div>
              <p className="text-xs text-text-secondary">
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

interface DialogWrapperProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

function DialogWrapper({ title, onClose, children }: DialogWrapperProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="relative bg-panel border border-border rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 id="dialog-title" className="text-lg font-medium">{title}</h2>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary text-xl"
          >
            x
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
