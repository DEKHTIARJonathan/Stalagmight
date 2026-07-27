import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useGasPlanStore } from '../../store/gasPlanStore';
import { PositiveNumberField } from '../common/PositiveNumberField';
import { formatStationId } from '../../utils/formatters';
import { speedFromDisplay, speedToDisplay } from '../../utils/formatGas';
import type { StationRef } from '../../types/project';

function sameStation(a: StationRef | null, b: StationRef | null): boolean {
  return a != null && b != null && a.section_id === b.section_id && a.station_index === b.station_index;
}

/**
 * The per-span pace/propulsion editor (#317) - the "Segments" tab of the Plan-mode bottom
 * panel. A plan has exactly `waypoints.length + 1` segments: segment k spans way point
 * k-1 -> k, and the last covers the open field past the final way point (the whole route,
 * when there are no way points at all). Edits flow to gasPlanStore, which nulls the cached
 * reach field so the map overlay refetches - a segment is a gas input, same as the
 * cylinders/config it sits next to.
 *
 * `on_scooter` covers both towing and parking a DPV - they are numerically identical
 * (swim-speed gas, no scooter range spent) and differ only in narrative, so there is no
 * separate "parked" state to set here. The park point itself is DERIVED by the engine (the
 * boundary after the last scootered segment, `GasReachField.scooter_drop_ref`) and can only
 * ever land on one of the way points (never the origin or the open-ended tail - see
 * `scooter_drop_index`, gas/scooter.rs) - the panel just marks whichever boundary it names,
 * it never places it.
 */
export function SegmentsTable() {
  const { t } = useTranslation();
  const { segments, waypoints, origin, endpoint, gasConfig, reachField, setSegments } =
    useGasPlanStore(
      useShallow((s) => ({
        segments: s.segments,
        waypoints: s.waypoints,
        origin: s.origin,
        endpoint: s.endpoint,
        gasConfig: s.gasConfig,
        reachField: s.reachField,
        setSegments: s.setSegments,
      }))
    );
  const units = gasConfig.units;
  // Riding a DPV needs a rig configured in Settings; with none, the checkbox is disabled
  // (not hidden) so the reason stays visible in place, mirroring the backend: `resolve_segments`
  // drops `on_scooter` entirely without a rig, so a checked-but-inert box would be a lie.
  const hasRig = gasConfig.dpv != null;
  const dropRef = reachField?.scooter_drop_ref ?? null;

  // Every boundary the panel can NAME, in visit order: before segment 0 (the origin, or the
  // entrance default), each way point in between, and after the last segment (the chosen
  // endpoint, or nothing when the route simply ends wherever the budget does). Segment k
  // spans boundary[k] -> boundary[k + 1].
  const boundaryLabels = [
    origin ? formatStationId(origin.section_id, origin.station_index) : t('gasPanel.origin.entrance'),
    ...waypoints.map((w) => formatStationId(w.section_id, w.station_index)),
    t('gasPanel.segments.onward'),
  ];
  const boundaryRefs: (StationRef | null)[] = [origin, ...waypoints, endpoint];

  const setSpeed = (idx: number, speedMPerMin: number) =>
    setSegments(segments.map((seg, i) => (i === idx ? { ...seg, speed_m_per_min: speedMPerMin } : seg)));
  const setScooter = (idx: number, onScooter: boolean) =>
    setSegments(segments.map((seg, i) => (i === idx ? { ...seg, on_scooter: onScooter } : seg)));

  return (
    <div className="h-full overflow-auto p-3 text-sm text-text-primary" data-testid="segments-table">
      <table className="w-full text-left">
        <thead className="text-xs uppercase tracking-wide opacity-60">
          <tr>
            <th className="py-1 pr-3 font-semibold">{t('gasPanel.segments.colFrom')}</th>
            <th className="py-1 pr-3 font-semibold">{t('gasPanel.segments.colTo')}</th>
            <th className="py-1 pr-3 font-semibold">{t('gasPanel.segments.colSpeed')}</th>
            <th className="py-1 pr-3 font-semibold">{t('gasPanel.segments.colScooter')}</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((seg, idx) => {
            const from = boundaryLabels[idx] ?? '';
            const to = boundaryLabels[idx + 1] ?? '';
            const parksAfter = sameStation(dropRef, boundaryRefs[idx + 1] ?? null);
            return (
              <tr className="border-t border-border" key={idx} data-testid={`segment-row-${idx}`}>
                <td className="py-1 pr-3 font-mono">{from}</td>
                <td className="py-1 pr-3 font-mono">
                  {to}
                  {parksAfter && (
                    <span
                      className="ml-2 text-xs opacity-70"
                      title={t('gasPanel.segments.parkHereHint')}
                      data-testid={`segment-park-${idx}`}
                    >
                      {t('gasPanel.segments.parkHere')}
                    </span>
                  )}
                </td>
                <td className="py-1 pr-3">
                  <div className="flex items-center gap-1">
                    <PositiveNumberField
                      value={speedToDisplay(seg.speed_m_per_min, units)}
                      onCommit={(n) => setSpeed(idx, speedFromDisplay(n, units))}
                      step={units === 'imperial' ? 5 : 1}
                      displayPrecision={1}
                      className="w-20 bg-transparent border border-border rounded px-1 py-0.5"
                      ariaLabel={t('gasPanel.segments.speedAria', { from, to })}
                      testId={`segment-speed-${idx}`}
                    />
                    <span className="text-xs opacity-70">
                      {t(
                        units === 'imperial'
                          ? 'gasPanel.swimSpeed.unitImperial'
                          : 'gasPanel.swimSpeed.unit'
                      )}
                    </span>
                  </div>
                </td>
                <td className="py-1 pr-3">
                  <input
                    type="checkbox"
                    checked={seg.on_scooter}
                    disabled={!hasRig}
                    onChange={(e) => setScooter(idx, e.target.checked)}
                    title={hasRig ? undefined : t('gasPanel.segments.noRigHint')}
                    aria-label={t('gasPanel.segments.scooterAria', { from, to })}
                    data-testid={`segment-scooter-${idx}`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!hasRig && (
        <p className="text-xs opacity-60 mt-2" data-testid="segments-no-rig-hint">
          {t('gasPanel.segments.noRigHint')}
        </p>
      )}
    </div>
  );
}
