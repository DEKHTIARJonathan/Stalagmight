import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import type { StationRef } from '../../types/project';

export default function EditStationDialog() {
  const { closeDialog, dialogData, openDialog } = useUIStore();
  const { stations, project } = useProjectStore();

  const stationRef = dialogData.stationRef as StationRef | undefined;

  const station = stations.find(
    (s) =>
      s.station_ref.section_id === stationRef?.section_id &&
      s.station_ref.station_index === stationRef?.station_index
  );

  const section = project?.sections.find(
    (s) => s.id === stationRef?.section_id
  );

  const handleEditSection = () => {
    if (stationRef) {
      openDialog('edit-section', { sectionId: stationRef.section_id });
    }
  };

  if (!station || !stationRef) {
    return (
      <DialogWrapper title="Station Info" onClose={closeDialog}>
        <div className="text-error">Station not found</div>
      </DialogWrapper>
    );
  }

  return (
    <DialogWrapper title="Station Info" onClose={closeDialog}>
      <div className="space-y-4">
        <div className="text-sm text-text-secondary">
          Station coordinates are calculated from shots and cannot be edited directly.
          To change station positions, edit the shots or merge with other stations.
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

        {station.is_zero_datum && (
          <div className="border-t border-border pt-3">
            <span className="text-warning">★ Zero Datum</span>
            {station.gps_coordinates && (
              <div className="mt-2 space-y-1">
                <DetailRow
                  label="Latitude"
                  value={station.gps_coordinates.latitude.toFixed(6)}
                />
                <DetailRow
                  label="Longitude"
                  value={station.gps_coordinates.longitude.toFixed(6)}
                />
              </div>
            )}
          </div>
        )}

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

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={handleEditSection}>Edit Section</Button>
          <Button variant="primary" onClick={closeDialog}>
            Close
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
      <div className="relative bg-panel border border-border rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-lg font-medium">{title}</h2>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary text-xl"
          >
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
