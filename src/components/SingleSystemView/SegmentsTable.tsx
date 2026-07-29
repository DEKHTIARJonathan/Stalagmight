import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { planSpeed, useGasPlanStore } from '../../store/gasPlanStore';
import { PositiveNumberField } from '../common/PositiveNumberField';
import { formatStationId } from '../../utils/formatters';
import { speedFromDisplay, speedToDisplay } from '../../utils/formatGas';
import { clamp } from '../../utils/clamp';
import { segmentColor } from '../../utils/segmentColors';
import type { StationRef } from '../../types/project';

/**
 * Mirrors `MIN_SEGMENT_SPEED_M_PER_MIN` in `src-tauri/src/models/project/gas/scooter.rs`. Outside
 * `[MIN, MAX]`, `resolve_segments` silently discards the segment's own speed and falls back to the
 * plan speed - so a committed value outside this range would show one number in this table and
 * price a different one in the engine (and in the exported dive profile). Clamped here so the value
 * the row displays after commit is always the value the engine will actually use.
 */
const MIN_SEGMENT_SPEED_M_PER_MIN = 0.1;
/** Mirrors `MAX_SEGMENT_SPEED_M_PER_MIN` in the same file. */
const MAX_SEGMENT_SPEED_M_PER_MIN = 1000;

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
  // A span with no speed of its own is flown at the plan's speed, so that is what its field shows.
  // Typing in the field sets an explicit speed for that span only; the rest keep following the
  // Swim-speed field above and Settings > Gas.
  const inherited = planSpeed(gasConfig);

  // Every boundary the panel can NAME, in visit order: before segment 0 (the origin, or the
  // entrance default), each way point in between, and after the last segment (the chosen
  // endpoint, or nothing when the route simply ends wherever the budget does). Segment k
  // spans boundary[k] -> boundary[k + 1]. Labeled by ROLE (Origin/WP n/Endpoint), not by
  // station id - the id is still discoverable via a `title` tooltip (`boundaryRefs`) for
  // whichever boundaries actually resolve to one.
  const boundaryLabels = [
    origin ? t('gasPanel.segments.origin') : t('gasPanel.origin.entrance'),
    ...waypoints.map((_, k) => t('gasPanel.segments.waypointN', { n: k + 1 })),
    endpoint ? t('gasPanel.segments.endpoint') : t('gasPanel.segments.onward'),
  ];
  const boundaryRefs: (StationRef | null)[] = [origin, ...waypoints, endpoint];

  const setSpeed = (idx: number, speedMPerMin: number) =>
    setSegments(
      segments.map((seg, i) =>
        i === idx
          ? {
              ...seg,
              speed_m_per_min: clamp(
                speedMPerMin,
                MIN_SEGMENT_SPEED_M_PER_MIN,
                MAX_SEGMENT_SPEED_M_PER_MIN
              ),
            }
          : seg
      )
    );
  // Return a span to inheriting the plan speed (undoes an explicit edit). `speed_m_per_min: null`
  // is the same thing a span has meant since it was created (see `defaultSegment`) - this is the
  // only way back to it once the diver has typed a number, since `setSpeed` above only ever writes
  // one.
  const resetSpeed = (idx: number) =>
    setSegments(segments.map((seg, i) => (i === idx ? { ...seg, speed_m_per_min: null } : seg)));
  // The scooter checkbox and the speed field are kept in a symmetric contract: ticking
  // on_scooter on a span still inheriting the plan speed (`speed_m_per_min: null`) auto-fills
  // the rig's primary speed onto it (riding at swim pace while the range model spends the
  // rig's range by METRES, not by time, would understate the real battery drain - the two
  // only agree once the span's speed actually matches what it's flown at); unticking
  // reverses that - it always returns the span to inheriting (`speed_m_per_min: null`),
  // never leaves the auto-filled number behind. A span that never had a speed of its own
  // still doesn't get one from a tick+untick round trip. The unsafe direction this closes:
  // untick-but-keep-the-speed left the span priced at a scooter pace with no scooter under
  // it, silently overstating range/understating gas until the diver noticed and hit Reset.
  const setScooter = (idx: number, onScooter: boolean) =>
    setSegments(
      segments.map((seg, i) => {
        if (i !== idx) return seg;
        if (!onScooter) return { ...seg, on_scooter: false, speed_m_per_min: null };
        const speed =
          seg.speed_m_per_min == null && gasConfig.dpv
            ? gasConfig.dpv.primary.speed_m_per_min
            : seg.speed_m_per_min;
        return { ...seg, on_scooter: true, speed_m_per_min: speed };
      })
    );

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
            // Role labels (Origin/WP n/Endpoint) name the boundary; the underlying station id,
            // when the boundary resolves to one, stays reachable as a tooltip rather than on
            // the row itself.
            const fromRef = boundaryRefs[idx] ?? null;
            const toRef = boundaryRefs[idx + 1] ?? null;
            const fromTitle = fromRef
              ? formatStationId(fromRef.section_id, fromRef.station_index)
              : undefined;
            const toTitle = toRef ? formatStationId(toRef.section_id, toRef.station_index) : undefined;
            return (
              <tr className="border-t border-border" key={idx} data-testid={`segment-row-${idx}`}>
                <td className="py-1 pr-3 font-mono" title={fromTitle}>
                  <span
                    aria-hidden="true"
                    data-testid={`segment-color-${idx}`}
                    className="inline-block rounded-sm mr-2"
                    style={{
                      width: '10px',
                      height: '10px',
                      backgroundColor: segmentColor(idx),
                    }}
                  />
                  {from}
                </td>
                <td className="py-1 pr-3 font-mono" title={toTitle}>
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
                      value={speedToDisplay(seg.speed_m_per_min ?? inherited, units)}
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
                    {seg.speed_m_per_min != null && (
                      <button
                        type="button"
                        onClick={() => resetSpeed(idx)}
                        className="px-1.5 py-0.5 text-xs border border-border rounded opacity-70 hover:opacity-100"
                        title={t('gasPanel.segments.resetSpeedHint')}
                        aria-label={t('gasPanel.segments.resetSpeedAria', { from, to })}
                        data-testid={`segment-speed-reset-${idx}`}
                      >
                        {t('gasPanel.segments.resetSpeed')}
                      </button>
                    )}
                  </div>
                </td>
                <td className="py-1 pr-3">
                  <input
                    type="checkbox"
                    checked={hasRig && seg.on_scooter}
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
