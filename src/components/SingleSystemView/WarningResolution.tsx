import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { ChevronLeftIcon, CenterMapIcon } from '../common/icons';
import { formatFixed } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { useActiveStations } from '../../hooks/useActiveStations';
import { normalizeAzimuth, averageAzimuth } from '../../utils/azimuth';
import { computeGhostEnd, horizontalLength } from '../../utils/resolutionPreview';
import { setSource } from '../../utils/telemetry';
import type { Section, Shot, ShotUpdates } from '../../types/project';
import type { GeometryPreview } from '../../store/uiStore';
import type { ProjectWarning } from '../../types/commands';

/** Color for the on-map resolution preview ghost (issue #57). */
const PREVIEW_COLOR = '#38bdf8';

/** Average of the recorded pitch legs (degrees), or null if none recorded. */
function recordedPitch(shot: Shot): number | null {
  if (shot.pitch_in != null && shot.pitch_out != null) return (shot.pitch_in + shot.pitch_out) / 2;
  return shot.pitch_in ?? shot.pitch_out ?? null;
}

// Below ~2.9° a recorded inclination can't meaningfully imply a slope length
// (length = |dz| / |sin θ| explodes), so length-from-inclination is withheld.
const MIN_SIN_INCLINATION = 0.05;

/** Inclination implied by the depth change and slope length, expressed in the
 *  recorded pitch's own sign. The geometric constraint |dz| = length·sin(|pitch|)
 *  is on magnitude; pitch sign is an unenforced per-source convention, so we keep
 *  whatever sign the recorded value uses (matching the backend check). */
function impliedInclination(shot: Shot): number {
  const dz = shot.depth_out - shot.depth_in;
  const mag = shot.length > 0 ? (Math.asin(Math.min(1, Math.abs(dz) / shot.length)) * 180) / Math.PI : 0;
  const recorded = recordedPitch(shot);
  return (recorded !== null && recorded < 0 ? -1 : 1) * mag;
}

/** What a manual option needs to render as an inline editable field. */
type ManualKind =
  | 'azimuth' // single corrected azimuth, applied to both in & out
  | 'azimuthInOut' // separate in / out azimuths
  | 'length'
  | 'depth' // depth in / out
  | 'lrud'; // L R U D

interface ResolutionOption {
  id: string;
  /** Action label (e.g. "Average"); a computed value is appended in render. */
  label: string;
  /** Optional formatted preview value shown after the label, e.g. "(57.0°)". */
  detail?: string | undefined;
  /** Extra context shown below the option only while it is selected (like the
   *  inline manual editors), e.g. the inclination a length was derived from. */
  selectedNote?: string | undefined;
  /** Destructive option (e.g. delete the shot) — rendered in red. */
  danger?: boolean | undefined;
  /** Disabled (frozen / closure-adjusted view) — applies to data fixes. */
  disabled?: boolean;
  /** Reveals an inline editor when selected. */
  manual?: ManualKind;
  /** Selecting this navigates away instead of applying a fix. */
  navigate?: boolean;
  /** Suppress (Ignore) rather than fix the data. */
  ignore?: boolean;
}

interface WarningResolutionProps {
  warning: ProjectWarning;
  section: Section | undefined;
  shot: Shot | undefined;
  /** Present only during "Resolve all"; drives the "n of N" header + Skip. */
  position?: { index: number; total: number } | undefined;
  /** ‹ Back (single) / Exit (resolve-all). */
  onExit: () => void;
  /** A fix was applied or the warning was ignored — advance. */
  onResolved: () => void;
  /** Skip this warning without changing anything — advance. */
  onSkip: () => void;
}

const LRUD_FIELDS = ['left', 'right', 'up', 'down'] as const;
type LrudField = (typeof LRUD_FIELDS)[number];

export function WarningResolution({
  warning,
  section,
  shot,
  position,
  onExit,
  onResolved,
  onSkip,
}: WarningResolutionProps) {
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
  const { updateShot, removeZeroDatum, deleteShot, resolveWarning, isShotFrozen } = useProjectStore(
    useShallow((s) => ({
      updateShot: s.updateShot,
      removeZeroDatum: s.removeZeroDatum,
      deleteShot: s.deleteShot,
      resolveWarning: s.resolveWarning,
      isShotFrozen: s.isShotFrozen,
    })),
  );
  const { setSelection, setDetailPanelTab, triggerCenterOnStation, showToast, setGeometryPreview, triggerZoomToShot } = useUIStore(
    useShallow((s) => ({
      setSelection: s.setSelection,
      setDetailPanelTab: s.setDetailPanelTab,
      triggerCenterOnStation: s.triggerCenterOnStation,
      showToast: s.showToast,
      setGeometryPreview: s.setGeometryPreview,
      triggerZoomToShot: s.triggerZoomToShot,
    })),
  );
  const geometryReadOnly = useUIStore((s) => s.geometryMode === 'closureAdjusted');
  const activeStations = useActiveStations();

  const frozen = isShotFrozen(warning.sectionId, warning.shotIndex);
  const geometryDisabled = geometryReadOnly || frozen;

  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  // Inline manual-edit fields (string-backed like EditShotDialog).
  const [manual, setManual] = useState<Record<string, string>>({});

  const az = (v: number) => `${formatFixed(v, undefined, precision.azimuth)}°`;
  const len = (v: number) => `${formatFixed(v, undefined, precision.length)} ${t('common.units.meters')}`;
  const dep = (v: number) => `${formatFixed(v, undefined, precision.depth)} ${t('common.units.meters')}`;

  // Which LRUD fields are negative (NEGATIVE_LRUD can flag any of them).
  const negativeLrud = useMemo<LrudField[]>(
    () => (shot ? LRUD_FIELDS.filter((f) => (shot[f] ?? 0) < 0) : []),
    [shot],
  );

  const options = useMemo<ResolutionOption[]>(() => {
    if (!shot) return [];
    const ignore: ResolutionOption = {
      id: 'ignore',
      label: t('detailPanel.warnings.resolveOptions.ignore'),
      ignore: true,
    };
    switch (warning.code) {
      case 'AZIMUTH_DEVIATION': {
        const avg = averageAzimuth(shot.azimuth_in, shot.azimuth_out);
        return [
          { id: 'use-in', label: t('detailPanel.warnings.resolveOptions.useIn'), detail: az(shot.azimuth_in), disabled: geometryDisabled },
          { id: 'use-out', label: t('detailPanel.warnings.resolveOptions.useOut'), detail: az(shot.azimuth_out), disabled: geometryDisabled },
          { id: 'average', label: t('detailPanel.warnings.resolveOptions.average'), detail: az(avg), disabled: geometryDisabled },
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manual'), manual: 'azimuth', disabled: geometryDisabled },
          ignore,
        ];
      }
      case 'INVALID_AZIMUTH':
        return [
          { id: 'normalize', label: t('detailPanel.warnings.resolveOptions.normalize'), detail: `${az(normalizeAzimuth(shot.azimuth_in))} / ${az(normalizeAzimuth(shot.azimuth_out))}`, disabled: geometryDisabled },
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manual'), manual: 'azimuthInOut', disabled: geometryDisabled },
          ignore,
        ];
      case 'LONG_SHOT':
        return [
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manualLength'), manual: 'length', disabled: geometryDisabled },
          ignore,
        ];
      case 'ZERO_LENGTH':
      case 'NEGATIVE_LENGTH':
      case 'SHORT_SHOT':
        // Failing the minimum-length test: correct the length, delete the shot
        // (a spurious too-short segment is often best removed), or ignore.
        return [
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manualLength'), manual: 'length', disabled: geometryDisabled },
          { id: 'delete-shot', label: t('detailPanel.warnings.resolveOptions.deleteShot'), disabled: geometryReadOnly, danger: true },
          ignore,
        ];
      case 'LARGE_DEPTH_CHANGE':
        return [
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manualDepth'), manual: 'depth', disabled: geometryDisabled },
          ignore,
        ];
      case 'NEGATIVE_LRUD':
        return [
          { id: 'lrud-abs', label: t('detailPanel.warnings.resolveOptions.useAbs'), disabled: geometryReadOnly },
          { id: 'lrud-clear', label: t('detailPanel.warnings.resolveOptions.clear'), disabled: geometryReadOnly },
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manual'), manual: 'lrud', disabled: geometryReadOnly },
          ignore,
        ];
      case 'LENGTH_BELOW_DEPTH_CHANGE': {
        const dz = shot.depth_out - shot.depth_in;
        const recorded = recordedPitch(shot);
        const sinP = recorded === null ? null : Math.sin((recorded * Math.PI) / 180);
        const lengthFromIncl = sinP !== null && Math.abs(sinP) > MIN_SIN_INCLINATION ? Math.abs(dz) / Math.abs(sinP) : null;
        return [
          // Default: shortest valid length is the vertical change (vertical shot).
          { id: 'length-from-depth', label: t('detailPanel.warnings.resolveOptions.lengthFromDepth'), detail: len(Math.abs(dz)), disabled: geometryDisabled },
          ...(lengthFromIncl !== null && recorded !== null
            ? [{ id: 'length-from-incl', label: t('detailPanel.warnings.resolveOptions.lengthFromInclination'), detail: len(lengthFromIncl), selectedNote: t('detailPanel.warnings.fromInclinationNote', { value: formatFixed(recorded, undefined, precision.inclination) }), disabled: geometryDisabled }]
            : []),
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manualLength'), manual: 'length', disabled: geometryDisabled },
          ignore,
        ];
      }
      case 'INCLINATION_DEPTH_MISMATCH': {
        // Depth gauges are trusted, so the depth change is never altered here.
        // The geometric constraint is on the inclination MAGNITUDE (|dz| =
        // length·sin|pitch|); pitch sign is an unenforced convention, so the
        // implied inclination keeps the recorded value's sign. Offer to adjust
        // the length (keep the recorded inclination), the inclination (keep the
        // recorded length), or split the correction between them.
        const dz = shot.depth_out - shot.depth_in;
        const implied = impliedInclination(shot);
        const recorded = recordedPitch(shot);
        const sinR = recorded === null ? null : Math.sin((recorded * Math.PI) / 180);
        const lengthFromIncl = sinR !== null && Math.abs(sinR) > MIN_SIN_INCLINATION ? Math.abs(dz) / Math.abs(sinR) : null;
        const midPitch = recorded === null ? null : (recorded + implied) / 2;
        const sinMid = midPitch === null ? null : Math.sin((midPitch * Math.PI) / 180);
        const splitLength = sinMid !== null && Math.abs(sinMid) > MIN_SIN_INCLINATION ? Math.abs(dz) / Math.abs(sinMid) : null;
        return [
          // Default (first): trust the recorded length, adjust the inclination.
          { id: 'incl-from-depth', label: t('detailPanel.warnings.resolveOptions.adjustInclination'), detail: `${formatFixed(implied, undefined, precision.inclination)}°`, disabled: geometryDisabled },
          ...(lengthFromIncl !== null && recorded !== null
            ? [{ id: 'length-from-incl', label: t('detailPanel.warnings.resolveOptions.adjustLength'), detail: len(lengthFromIncl), selectedNote: t('detailPanel.warnings.fromInclinationNote', { value: formatFixed(recorded, undefined, precision.inclination) }), disabled: geometryDisabled }]
            : []),
          ...(splitLength !== null && midPitch !== null
            ? [{ id: 'split-incl-length', label: t('detailPanel.warnings.resolveOptions.splitInclLength'), detail: `${formatFixed(midPitch, undefined, precision.inclination)}° · ${len(splitLength)}`, disabled: geometryDisabled }]
            : []),
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manualLength'), manual: 'length', disabled: geometryDisabled },
          ignore,
        ];
      }
      case 'multiple_datums_per_merge_component':
        // Over-anchoring is a structural error, not a suppressible nuisance
        // (issue #57): no Ignore — it must be fixed by removing a datum.
        return [
          { id: 'remove-datum', label: t('detailPanel.warnings.resolveOptions.removeDatum'), disabled: geometryReadOnly || warning.datumStationIndex === undefined },
          { id: 'go-to-station', label: t('detailPanel.warnings.resolveOptions.goToStation'), navigate: true },
        ];
      default:
        return [ignore];
    }
  }, [warning.code, warning.datumStationIndex, shot, geometryDisabled, geometryReadOnly, t, precision]);

  // Default selection: prefer "Average" (the safe azimuth fix) when offered,
  // else the first enabled option (falls back to Ignore when every fix is
  // locked, e.g. a frozen shot in the closure-adjusted view).
  useEffect(() => {
    const enabled = options.filter((o) => !o.disabled);
    const preferred = enabled.find((o) => o.id === 'average') ?? enabled[0] ?? options[options.length - 1];
    setSelected(preferred?.id ?? '');
    if (shot) {
      setManual({
        azimuth: '',
        azimuthIn: shot.azimuth_in.toString(),
        azimuthOut: shot.azimuth_out.toString(),
        length: shot.length > 0 ? shot.length.toString() : '',
        depthIn: shot.depth_in.toString(),
        depthOut: shot.depth_out.toString(),
        left: shot.left?.toString() ?? '',
        right: shot.right?.toString() ?? '',
        up: shot.up?.toString() ?? '',
        down: shot.down?.toString() ?? '',
      });
    }
    // Re-seed only when the warning being resolved changes (resolve-all
    // stepping). Deliberately NOT keyed on `options`/`shot` object identity: a
    // background project refresh rebuilds those references and would otherwise
    // wipe the user's in-progress manual edit and reset their selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warning.sectionId, warning.shotId, warning.code]);

  const num = (key: string): number => parseFloat(manual[key] ?? '');

  // Azimuth fields: reject NaN or values outside [-360, 360]; otherwise
  // normalize into [0, 360) (wrap, not clip). Returns null on rejection.
  const parseAzimuth = (key: string): number | null => {
    const v = num(key);
    if (Number.isNaN(v) || v < -360 || v > 360) return null;
    return normalizeAzimuth(v);
  };

  // Live on-map preview of the proposed geometry as the user tries options
  // (issue #57). Anchored to the real solved endpoint so it shows just the
  // change; returns null (no ghost) for options that don't move stations, or
  // when our planar model can't reproduce the current endpoint (e.g. a
  // rotated/offset section) — better to show nothing than a misleading ghost.
  const preview = useMemo<GeometryPreview | null>(() => {
    if (!shot) return null;
    const opt = options.find((o) => o.id === selected);
    if (!opt || opt.ignore || opt.navigate || opt.id === 'remove-datum') return null;
    if (opt.id === 'lrud-abs' || opt.id === 'lrud-clear' || opt.manual === 'lrud') return null;

    const stationAt = (stationIndex: number) =>
      activeStations.find(
        (s) => s.station_ref.section_id === warning.sectionId && s.station_ref.station_index === stationIndex,
      )?.coordinates;
    const start = stationAt(warning.shotIndex);
    const end = stationAt(warning.shotIndex + 1);
    if (!start || !end) return null;

    const depthChange = shot.depth_out - shot.depth_in;
    const currentHoriz = horizontalLength(shot.length, depthChange);
    const currentAz = averageAzimuth(shot.azimuth_in, shot.azimuth_out);

    let propAz = currentAz;
    let propHoriz = currentHoriz;
    switch (opt.id) {
      case 'use-in': propAz = shot.azimuth_in; break;
      case 'use-out': propAz = shot.azimuth_out; break;
      case 'average': propAz = averageAzimuth(shot.azimuth_in, shot.azimuth_out); break;
      case 'normalize':
        propAz = averageAzimuth(normalizeAzimuth(shot.azimuth_in), normalizeAzimuth(shot.azimuth_out));
        break;
      case 'manual':
        if (opt.manual === 'azimuth') {
          const n = parseAzimuth('azimuth');
          if (n === null) return null;
          propAz = n;
        } else if (opt.manual === 'azimuthInOut') {
          const ni = parseAzimuth('azimuthIn'); const no = parseAzimuth('azimuthOut');
          if (ni === null || no === null) return null;
          propAz = averageAzimuth(ni, no);
        } else if (opt.manual === 'length') {
          const v = num('length');
          if (Number.isNaN(v) || v <= 0) return null;
          propHoriz = horizontalLength(v, depthChange);
        } else if (opt.manual === 'depth') {
          const vi = num('depthIn'); const vo = num('depthOut');
          if (Number.isNaN(vi) || Number.isNaN(vo)) return null;
          propHoriz = horizontalLength(shot.length, vo - vi);
        } else {
          return null;
        }
        break;
      // Length-changing fixes move the endpoint (same azimuth, new horizontal).
      // incl-from-depth only changes pitch (metadata) → no ghost (default null).
      case 'length-from-depth':
        propHoriz = horizontalLength(Math.abs(depthChange), depthChange);
        break;
      case 'length-from-incl': {
        const recorded = recordedPitch(shot);
        const sinP = recorded === null ? 0 : Math.sin((recorded * Math.PI) / 180);
        if (Math.abs(sinP) < MIN_SIN_INCLINATION) return null;
        propHoriz = horizontalLength(Math.abs(depthChange) / Math.abs(sinP), depthChange);
        break;
      }
      case 'split-incl-length': {
        const recorded = recordedPitch(shot);
        if (recorded === null) return null;
        const mid = (recorded + impliedInclination(shot)) / 2;
        const sinMid = Math.sin((mid * Math.PI) / 180);
        if (Math.abs(sinMid) < MIN_SIN_INCLINATION) return null;
        propHoriz = horizontalLength(Math.abs(depthChange) / Math.abs(sinMid), depthChange);
        break;
      }
      default:
        return null;
    }

    const ghostEnd = computeGhostEnd(start, end, currentAz, currentHoriz, propAz, propHoriz);
    if (!ghostEnd) return null;

    return {
      shots: [{ from: { x: start.x, y: start.y }, to: ghostEnd }],
      stations: [ghostEnd],
      color: PREVIEW_COLOR,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, manual, shot, options, activeStations, warning.sectionId, warning.shotIndex]);

  // Push the preview to the map; clear it when leaving the resolution view.
  useEffect(() => {
    setGeometryPreview(preview);
  }, [preview, setGeometryPreview]);
  useEffect(() => () => setGeometryPreview(null), [setGeometryPreview]);

  /**
   * Apply the selected option.
   * - 'resolved': a suppression/fix was applied (advance + count).
   * - 'navigated': the user jumped elsewhere; do not count as resolved.
   * - 'failed': nothing applied (validation/command error); stay put.
   */
  const apply = async (): Promise<'resolved' | 'navigated' | 'failed'> => {
    if (!shot || !section) return 'failed';
    const opt = options.find((o) => o.id === selected);
    if (!opt) return 'failed';

    if (opt.ignore) {
      await resolveWarning(warning.sectionId, warning.shotId, warning.code);
      return 'resolved';
    }

    if (opt.navigate) {
      if (warning.datumStationIndex !== undefined) {
        const ref = { section_id: warning.sectionId, station_index: warning.datumStationIndex };
        setSource('detail-panel');
        setSelection({ type: 'station', stationRef: ref });
        triggerCenterOnStation(ref);
        setDetailPanelTab('details');
      }
      return 'navigated'; // jumped to the station; nothing was suppressed or fixed
    }

    if (opt.id === 'remove-datum') {
      if (warning.datumStationIndex === undefined) return 'failed';
      const result = await removeZeroDatum({ section_id: warning.sectionId, station_index: warning.datumStationIndex });
      if (!result.success) showToast(result.error ?? t('detailPanel.warnings.resolveFailed'), 'warning-resolve');
      return result.success ? 'resolved' : 'failed';
    }

    if (opt.id === 'delete-shot') {
      const result = await deleteShot(warning.sectionId, warning.shotId);
      if (!result.success) showToast(result.error ?? t('detailPanel.warnings.resolveFailed'), 'warning-resolve');
      return result.success ? 'resolved' : 'failed';
    }

    // Data fixes via the undoable update_shot command.
    const patch: Partial<ShotUpdates> = {};
    switch (opt.id) {
      case 'use-in':
        patch.azimuth_out = shot.azimuth_in;
        break;
      case 'use-out':
        patch.azimuth_in = shot.azimuth_out;
        break;
      case 'average': {
        const avg = averageAzimuth(shot.azimuth_in, shot.azimuth_out);
        patch.azimuth_in = avg;
        patch.azimuth_out = avg;
        break;
      }
      case 'normalize':
        patch.azimuth_in = normalizeAzimuth(shot.azimuth_in);
        patch.azimuth_out = normalizeAzimuth(shot.azimuth_out);
        break;
      case 'incl-from-depth': {
        // Keep length + depth (depth is trusted): set the inclination to the
        // magnitude implied by the geometry, in the recorded value's own sign.
        const p = impliedInclination(shot);
        patch.pitch_in = p;
        patch.pitch_out = p;
        break;
      }
      case 'split-incl-length': {
        // Keep depth; split the disagreement between inclination and length: set
        // pitch to the midpoint of recorded and the implied magnitude, then make
        // the length consistent with that midpoint (length = |dz| / |sin(mid)|),
        // yielding a geometrically consistent shot at the compromise inclination.
        const recorded = recordedPitch(shot);
        if (recorded === null) { showToast(t('detailPanel.warnings.resolveInvalid'), 'warning-resolve'); return 'failed'; }
        const dz = shot.depth_out - shot.depth_in;
        const mid = (recorded + impliedInclination(shot)) / 2;
        const sinMid = Math.sin((mid * Math.PI) / 180);
        if (Math.abs(sinMid) < MIN_SIN_INCLINATION) { showToast(t('detailPanel.warnings.resolveInvalid'), 'warning-resolve'); return 'failed'; }
        patch.pitch_in = mid;
        patch.pitch_out = mid;
        patch.length = Math.abs(dz) / Math.abs(sinMid);
        break;
      }
      case 'length-from-depth':
        // Shortest valid slope length is the vertical change itself (vertical shot).
        patch.length = Math.abs(shot.depth_out - shot.depth_in);
        break;
      case 'length-from-incl': {
        // |depth change| = length·sin(pitch) → length = |dz| / |sin(pitch)|.
        const recorded = recordedPitch(shot);
        const sinP = recorded === null ? 0 : Math.sin((recorded * Math.PI) / 180);
        if (Math.abs(sinP) < MIN_SIN_INCLINATION) { showToast(t('detailPanel.warnings.resolveInvalid'), 'warning-resolve'); return 'failed'; }
        patch.length = Math.abs(shot.depth_out - shot.depth_in) / Math.abs(sinP);
        break;
      }
      case 'lrud-abs':
        for (const f of negativeLrud) patch[f] = Math.abs(shot[f] ?? 0);
        break;
      case 'lrud-clear':
        for (const f of negativeLrud) patch[f] = null;
        break;
      case 'manual':
        if (opt.manual === 'azimuth') {
          const n = parseAzimuth('azimuth');
          if (n === null) { showToast(t('detailPanel.warnings.resolveInvalidAzimuth'), 'warning-resolve'); return 'failed'; }
          patch.azimuth_in = n;
          patch.azimuth_out = n;
        } else if (opt.manual === 'azimuthInOut') {
          const ni = parseAzimuth('azimuthIn'); const no = parseAzimuth('azimuthOut');
          if (ni === null || no === null) { showToast(t('detailPanel.warnings.resolveInvalidAzimuth'), 'warning-resolve'); return 'failed'; }
          patch.azimuth_in = ni;
          patch.azimuth_out = no;
        } else if (opt.manual === 'length') {
          const v = num('length');
          if (Number.isNaN(v) || v <= 0) { showToast(t('detailPanel.warnings.resolveInvalidLength'), 'warning-resolve'); return 'failed'; }
          patch.length = v;
        } else if (opt.manual === 'depth') {
          const vi = num('depthIn'); const vo = num('depthOut');
          if (Number.isNaN(vi) || Number.isNaN(vo)) { showToast(t('detailPanel.warnings.resolveInvalid'), 'warning-resolve'); return 'failed'; }
          patch.depth_in = vi;
          patch.depth_out = vo;
        } else if (opt.manual === 'lrud') {
          for (const f of LRUD_FIELDS) {
            const raw = manual[f]?.trim() ?? '';
            patch[f] = raw === '' ? null : parseFloat(raw);
          }
          if (LRUD_FIELDS.some((f) => patch[f] !== null && Number.isNaN(patch[f] as number))) {
            showToast(t('detailPanel.warnings.resolveInvalid'), 'warning-resolve');
            return 'failed';
          }
        }
        break;
      default:
        return 'failed';
    }

    // Guard against a no-op (e.g. lrud-abs/clear when nothing is negative after a
    // refresh): an empty patch would still push an undo entry and report success.
    if (Object.keys(patch).length === 0) {
      showToast(t('detailPanel.warnings.resolveInvalid'), 'warning-resolve');
      return 'failed';
    }

    const result = await updateShot(warning.sectionId, warning.shotId, patch);
    if (!result.success) showToast(result.error ?? t('detailPanel.warnings.resolveFailed'), 'warning-resolve');
    return result.success ? 'resolved' : 'failed';
  };

  const handleApply = async () => {
    setBusy(true);
    try {
      const result = await apply();
      if (result === 'resolved') onResolved();
      else if (result === 'navigated') onExit();
      // 'failed' → stay on this warning (a toast explained why).
    } finally {
      setBusy(false);
    }
  };

  const isResolveAll = position !== undefined;
  const selectedOption = options.find((o) => o.id === selected);

  return (
    <div className="p-2" data-testid="warning-resolution">
      {/* Header: back · zoom button + (n of N) */}
      <div className="flex items-center justify-between mb-2 px-1">
        <button
          onClick={onExit}
          className="flex items-center gap-1 text-sm text-accent hover:underline"
          data-testid="warning-resolution-back"
        >
          <ChevronLeftIcon size={16} />
          {isResolveAll ? t('detailPanel.warnings.resolveExit') : t('detailPanel.warnings.resolveBack')}
        </button>
        <div className="flex items-center gap-2">
          {isResolveAll && position && (
            <span className="text-xs text-text-secondary" data-testid="warning-resolution-progress">
              {t('detailPanel.warnings.resolvePosition', { index: position.index + 1, total: position.total })}
            </span>
          )}
          {/* Each click zooms one step closer onto the problematic shot. */}
          <button
            type="button"
            onClick={() => triggerZoomToShot(warning.sectionId, warning.shotId)}
            className="p-1 text-text-secondary hover:text-text-primary rounded hover:bg-background-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
            title={t('detailPanel.warnings.zoomToShot')}
            aria-label={t('detailPanel.warnings.zoomToShot')}
            data-testid="warning-resolution-zoom"
          >
            <CenterMapIcon size={16} />
          </button>
        </div>
      </div>

      {/* The warning + current values */}
      <div className="px-1 mb-3">
        <div className="text-sm text-text-primary">{warning.message}</div>
        {shot && (warning.code === 'AZIMUTH_DEVIATION' || warning.code === 'INVALID_AZIMUTH') && (
          <div className="text-xs text-text-secondary mt-1">
            {t('detailPanel.labels.azimuthIn')} {az(shot.azimuth_in)} · {t('detailPanel.labels.azimuthOut')} {az(shot.azimuth_out)}
          </div>
        )}
        {shot && warning.code === 'LARGE_DEPTH_CHANGE' && (
          <div className="text-xs text-text-secondary mt-1">
            {t('detailPanel.labels.depthIn')} {dep(shot.depth_in)} · {t('detailPanel.labels.depthOut')} {dep(shot.depth_out)}
          </div>
        )}
        {shot && (warning.code === 'ZERO_LENGTH' || warning.code === 'NEGATIVE_LENGTH' || warning.code === 'SHORT_SHOT' || warning.code === 'LONG_SHOT') && (
          <div className="text-xs text-text-secondary mt-1">{t('detailPanel.labels.length')} {len(shot.length)}</div>
        )}
      </div>

      {!shot ? (
        <div className="px-1 text-sm text-text-secondary">{t('detailPanel.selectionNotFound')}</div>
      ) : (
        <div className="border-t border-border pt-2 space-y-1" role="radiogroup" aria-label={t('detailPanel.warnings.resolveTitle')}>
          {options.map((opt) => (
            <div key={opt.id}>
              <label
                className={`flex items-center gap-2 px-1 py-1 rounded text-sm cursor-pointer hover:bg-background-50 ${opt.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <input
                  type="radio"
                  name="warning-resolution-option"
                  value={opt.id}
                  checked={selected === opt.id}
                  disabled={opt.disabled}
                  onChange={() => setSelected(opt.id)}
                  data-testid={`warning-resolution-option-${opt.id}`}
                />
                <span className={opt.danger ? 'text-error font-medium' : undefined}>
                  {opt.label}
                  {opt.detail && <span className="text-text-secondary"> ({opt.detail})</span>}
                </span>
              </label>
              {/* Inline manual editors, shown when their option is selected. */}
              {selected === opt.id && opt.manual && (
                <div className="pl-6 pr-1 pb-1">
                  {opt.manual === 'azimuth' && (
                    <ManualField value={manual.azimuth ?? ''} onChange={(v) => setManual((m) => ({ ...m, azimuth: v }))} unit="°" placeholder={t('detailPanel.warnings.azimuthLabel')} testId="manual-azimuth" />
                  )}
                  {opt.manual === 'azimuthInOut' && (
                    <div className="grid grid-cols-2 gap-2">
                      <ManualField value={manual.azimuthIn ?? ''} onChange={(v) => setManual((m) => ({ ...m, azimuthIn: v }))} unit="°" placeholder={t('detailPanel.labels.azimuthIn')} testId="manual-azimuth-in" />
                      <ManualField value={manual.azimuthOut ?? ''} onChange={(v) => setManual((m) => ({ ...m, azimuthOut: v }))} unit="°" placeholder={t('detailPanel.labels.azimuthOut')} testId="manual-azimuth-out" />
                    </div>
                  )}
                  {opt.manual === 'length' && (
                    <ManualField value={manual.length ?? ''} onChange={(v) => setManual((m) => ({ ...m, length: v }))} unit={t('common.units.meters')} placeholder={t('detailPanel.labels.length')} testId="manual-length" />
                  )}
                  {opt.manual === 'depth' && (
                    <div className="grid grid-cols-2 gap-2">
                      <ManualField value={manual.depthIn ?? ''} onChange={(v) => setManual((m) => ({ ...m, depthIn: v }))} unit={t('common.units.meters')} placeholder={t('detailPanel.labels.depthIn')} testId="manual-depth-in" />
                      <ManualField value={manual.depthOut ?? ''} onChange={(v) => setManual((m) => ({ ...m, depthOut: v }))} unit={t('common.units.meters')} placeholder={t('detailPanel.labels.depthOut')} testId="manual-depth-out" />
                    </div>
                  )}
                  {opt.manual === 'lrud' && (
                    <div className="grid grid-cols-4 gap-2">
                      {LRUD_FIELDS.map((f) => (
                        <ManualField key={f} value={manual[f] ?? ''} onChange={(v) => setManual((m) => ({ ...m, [f]: v }))} placeholder={f[0]!.toUpperCase()} testId={`manual-${f}`} />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {/* Extra context (e.g. the inclination used), shown only while
                  this option is selected — mirrors the inline manual editors. */}
              {selected === opt.id && opt.selectedNote && (
                <div className="pl-6 pr-1 pb-1 text-xs text-text-secondary" data-testid={`warning-resolution-note-${opt.id}`}>
                  {opt.selectedNote}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-2 pt-3 mt-2 border-t border-border">
        {isResolveAll ? (
          <Button size="sm" onClick={onSkip} disabled={busy} data-testid="warning-resolution-skip">
            {t('detailPanel.warnings.resolveSkip')}
          </Button>
        ) : (
          <span />
        )}
        <Button
          size="sm"
          variant="primary"
          onClick={() => void handleApply()}
          disabled={busy || !shot || !selectedOption || (selectedOption.disabled ?? false)}
          data-testid="warning-resolution-apply"
        >
          {isResolveAll ? t('detailPanel.warnings.resolveApplyNext') : t('detailPanel.warnings.resolveApply')}
        </Button>
      </div>
    </div>
  );
}

function ManualField({
  value,
  onChange,
  unit,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        inputMode="decimal"
        step="0.1"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full"
        data-testid={testId}
      />
      {unit && <span className="text-xs text-text-secondary">{unit}</span>}
    </div>
  );
}
