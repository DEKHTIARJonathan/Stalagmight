import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Panel } from '../common/Panel';
import { Button } from '../common/Button';
import type { Station, Shot, Section } from '../../types/project';

export default function DetailPanel() {
  const { selection } = useUIStore();
  const { project, stations } = useProjectStore();

  if (!selection) {
    return (
      <div className="h-full bg-panel p-4">
        <div className="text-text-secondary text-center">
          <p>No selection</p>
          <p className="text-sm mt-2">
            Click on a station or shot to view details
          </p>
        </div>
      </div>
    );
  }

  if (selection.type === 'station' && selection.stationRef) {
    const station = stations.find(
      (s) =>
        s.station_ref.section_id === selection.stationRef?.section_id &&
        s.station_ref.station_index === selection.stationRef?.station_index
    );

    if (station) {
      return <StationDetail station={station} />;
    }
  }

  if (selection.type === 'shot' && selection.sectionId !== undefined && selection.shotId !== undefined) {
    const section = project?.sections.find((s) => s.id === selection.sectionId);
    const shot = section?.shots.find((s) => s.id === selection.shotId);

    if (section && shot) {
      return <ShotDetail section={section} shot={shot} />;
    }
  }

  if (selection.type === 'section' && selection.sectionId !== undefined) {
    const section = project?.sections.find((s) => s.id === selection.sectionId);

    if (section) {
      return <SectionDetail section={section} />;
    }
  }

  return (
    <div className="h-full bg-panel p-4">
      <div className="text-text-secondary">Selection not found</div>
    </div>
  );
}

function StationDetail({ station }: { station: Station }) {
  const { project } = useProjectStore();
  const { openDialog } = useUIStore();
  const section = project?.sections.find(
    (s) => s.id === station.station_ref.section_id
  );

  const handleEdit = () => {
    openDialog('edit-station', { stationRef: station.station_ref });
  };

  return (
    <div className="h-full bg-panel overflow-auto">
      <Panel title="Station">
        <div className="space-y-3">
          <DetailRow
            label="ID"
            value={`${station.station_ref.section_id}:${station.station_ref.station_index}`}
          />
          <DetailRow label="Section" value={section?.name ?? `Section ${station.station_ref.section_id}`} />
          <DetailRow label="X" value={`${station.coordinates.x.toFixed(2)} m`} />
          <DetailRow label="Y" value={`${station.coordinates.y.toFixed(2)} m`} />
          <DetailRow label="Depth" value={`${station.coordinates.z.toFixed(1)} m`} />

          {station.is_zero_datum && (
            <div className="pt-2 border-t border-border">
              <span className="text-warning">★ Zero Datum</span>
              {station.gps_coordinates && (
                <div className="mt-2 text-sm">
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
            <div className="pt-2 border-t border-border">
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
        </div>
      </Panel>

      <div className="p-3 border-t border-border">
        <Button size="sm" className="w-full" onClick={handleEdit}>
          Edit
        </Button>
      </div>
    </div>
  );
}

function ShotDetail({ section, shot }: { section: Section; shot: Shot }) {
  const { setShotVirtual } = useProjectStore();
  const { openDialog } = useUIStore();

  const handleToggleVirtual = async () => {
    await setShotVirtual(section.id, shot.id, !shot.is_virtual);
  };

  const handleDelete = () => {
    openDialog('confirm-delete', {
      type: 'shot',
      sectionId: section.id,
      shotId: shot.id,
      message: 'Are you sure you want to delete this shot?',
    });
  };

  return (
    <div className="h-full bg-panel overflow-auto">
      <Panel title="Shot">
        <div className="space-y-3">
          <DetailRow label="ID" value={`${section.id}:${shot.id}`} />
          <DetailRow label="Section" value={section.name ?? `Section ${section.id}`} />
          <DetailRow label="Length" value={`${shot.length.toFixed(2)} m`} />
          <DetailRow label="Azimuth In" value={`${shot.azimuth_in.toFixed(1)}°`} />
          <DetailRow label="Azimuth Out" value={`${shot.azimuth_out.toFixed(1)}°`} />
          <DetailRow label="Depth In" value={`${shot.depth_in.toFixed(1)} m`} />
          <DetailRow label="Depth Out" value={`${shot.depth_out.toFixed(1)} m`} />

          {(shot.left !== null || shot.right !== null || shot.up !== null || shot.down !== null) && (
            <div className="pt-2 border-t border-border">
              <span className="text-sm text-text-secondary">LRUD:</span>
              <div className="grid grid-cols-2 gap-2 mt-1 text-sm">
                <DetailRow label="L" value={shot.left?.toFixed(1) ?? '-'} />
                <DetailRow label="R" value={shot.right?.toFixed(1) ?? '-'} />
                <DetailRow label="U" value={shot.up?.toFixed(1) ?? '-'} />
                <DetailRow label="D" value={shot.down?.toFixed(1) ?? '-'} />
              </div>
            </div>
          )}

          {shot.is_virtual && (
            <div className="text-warning text-sm">Virtual shot</div>
          )}

          {shot.comment && (
            <div className="pt-2 border-t border-border">
              <span className="text-sm text-text-secondary">Comment:</span>
              <p className="text-sm mt-1">{shot.comment}</p>
            </div>
          )}
        </div>
      </Panel>

      <div className="p-3 border-t border-border space-y-2">
        <Button size="sm" className="w-full" onClick={handleToggleVirtual}>
          {shot.is_virtual ? 'Mark as Real' : 'Mark as Virtual'}
        </Button>
        <Button size="sm" variant="danger" className="w-full" onClick={handleDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function SectionDetail({ section }: { section: Section }) {
  const { openDialog } = useUIStore();

  const stats = {
    shotCount: section.shots.length,
    length: section.shots.reduce((sum, s) => sum + s.length, 0),
    virtualCount: section.shots.filter((s) => s.is_virtual).length,
  };

  const handleEditSection = () => {
    openDialog('edit-section', { sectionId: section.id });
  };

  return (
    <div className="h-full bg-panel overflow-auto">
      <Panel title="Section">
        <div className="space-y-3">
          <DetailRow label="Name" value={section.name ?? 'Unnamed'} />
          <DetailRow label="Surveyor" value={section.surveyor ?? '-'} />
          <DetailRow label="Date" value={section.date ?? '-'} />
          <DetailRow label="Color" value={
            <div className="flex items-center gap-2">
              <span
                className="w-4 h-4 rounded"
                style={{ backgroundColor: section.color }}
              />
              <span>{section.color}</span>
            </div>
          } />

          <div className="pt-2 border-t border-border">
            <span className="text-sm text-text-secondary">Statistics:</span>
            <div className="mt-1 text-sm">
              <DetailRow label="Shots" value={String(stats.shotCount)} />
              <DetailRow label="Length" value={`${stats.length.toFixed(1)} m`} />
              {stats.virtualCount > 0 && (
                <DetailRow label="Virtual" value={String(stats.virtualCount)} />
              )}
            </div>
          </div>
        </div>
      </Panel>

      <div className="p-3 border-t border-border">
        <Button size="sm" className="w-full" onClick={handleEditSection}>
          Edit Section
        </Button>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-text-secondary">{label}:</span>
      <span>{value}</span>
    </div>
  );
}
