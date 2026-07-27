import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useGasPlanStore } from '../../store/gasPlanStore';
import { useUIStore } from '../../store/uiStore';
import { getThemeColor } from '../../utils/themeColors';
import { formatGasLength } from '../../utils/formatGas';
import { formatFixed } from '../../i18n/format';
import { saveDialog, exportSaveFilters, ensureExtension } from '../../utils/fileDialogs';
import { exportDiveProfile, renderDiveProfileText } from '../../utils/divePlanApi';
import {
  buildRouteProfile,
  projectProfile,
  axisTicks,
  depthTicks,
  type ProfileAxis,
  type ProfileMarker,
} from '../../utils/routeProfile';

/** Room for the depth labels, the x-axis labels and the marker flags above the surface line. */
const PAD_LEFT = 46;
const PAD_RIGHT = 12;
const PAD_TOP = 14;
const PAD_BOTTOM = 22;
/** Below this the axis furniture costs more than it explains, so the line is drawn bare. */
const MIN_LABELLED_HEIGHT = 130;

/**
 * The anticipated dive profile (#299) - the Plan panel's "Profile" tab.
 *
 * Depth against either swum distance or runtime, for the whole round trip: out to the turnaround,
 * then home. Both axes come from `GasReachField.route_profile`, which the engine builds from the
 * same vectors it derives the Plan readout's distance and depth from - so this chart cannot drift
 * from the numbers in the sidebar beside it.
 *
 * The two axes are not interchangeable views of one shape. The engine prices the way in at the
 * survey speed and the way out at the (never slower) exit speed, so the turnaround sits at the
 * halfway mark on the distance axis but later than halfway on the time axis. That difference is the
 * point of the toggle.
 *
 * Hand-rolled SVG, matching the map legends - no charting dependency. A passive consumer of the
 * store: `MapCanvas` owns the compute, and this must never trigger one.
 */
export function ProfileChart() {
  const { t } = useTranslation();
  const clipId = useId();
  // Subscribe to the theme so getThemeColor re-reads the CSS vars on a light/dark flip.
  useUIStore((s) => s.resolvedTheme);
  const { reachField, units } = useGasPlanStore(
    useShallow((s) => ({ reachField: s.reachField, units: s.gasConfig.units }))
  );
  const [axis, setAxis] = useState<ProfileAxis>('distance');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // The panel is user-resizable (100-500 px) and has a fullscreen mode, so the box is only known at
  // runtime. Guarded for jsdom, which has no ResizeObserver.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => buildRouteProfile(reachField, axis), [reachField, axis]);

  return (
    <div className="h-full flex flex-col" data-testid="plan-profile">
      <ProfileHeader axis={axis} onAxis={setAxis} exportable={geo !== null} />
      <div ref={containerRef} className="flex-1 min-h-0 px-2 pb-2" data-testid="plan-profile-plot">
        {geo ? (
          <ProfilePlot geo={geo} units={units} size={size} clipId={clipId} />
        ) : (
          <div
            className="h-full flex items-center justify-center text-xs text-text-secondary text-center px-4"
            data-testid="plan-profile-empty"
          >
            {reachField
              ? t('planTables.profile.noRoute')
              : t('gasPanel.readout.computing')}
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileHeader({
  axis,
  onAxis,
  exportable,
}: {
  axis: ProfileAxis;
  onAxis: (a: ProfileAxis) => void;
  exportable: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1 shrink-0">
      <span className="text-xs opacity-70" title={t('planTables.profile.subtitle')}>
        {t('planTables.profile.title')}
      </span>
      <ProfileExportControls enabled={exportable} />
      <div
        className="flex rounded overflow-hidden border border-border"
        role="group"
        aria-label={t('planTables.profile.axisLabel')}
      >
        {(['distance', 'time'] as const).map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => onAxis(a)}
            aria-pressed={axis === a}
            data-testid={`plan-profile-axis-${a}`}
            className={`px-2 py-0.5 text-xs ${axis === a ? 'bg-accent text-accent-on' : 'opacity-70'}`}
          >
            {t(`planTables.profile.axis.${a}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Export the plan straight from the tab it is drawn in, rather than through the project Export
 * panel: a dive profile is not project data, and it only exists while a plan is live.
 *
 * Both actions send the plan INPUTS and let the backend recompute - see `DiveProfileRequest`. Copy
 * is best-effort on the clipboard write (`navigator.clipboard` is unavailable in some contexts),
 * matching how the debug-log copy handles it.
 */
function ProfileExportControls({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const request = useGasPlanStore(
    useShallow((s) => ({
      origin: s.origin,
      endpoint: s.endpoint,
      waypoints: s.waypoints,
      diver: s.diver,
      cylinders: s.cylinders,
      gas_config: s.gasConfig,
      stage_drop_overrides: s.stageDropOverrides,
    }))
  );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      console.error('Dive profile export failed:', e);
    } finally {
      setBusy(false);
    }
  };

  const onExport = () =>
    run(async () => {
      const path = await saveDialog({
        filters: exportSaveFilters(t('planTables.profile.export.xmlFilter'), 'xml'),
      });
      if (!path) return;
      await exportDiveProfile(ensureExtension(path, '.xml'), 'subsurface-xml', request);
    });

  const onCopy = () =>
    run(async () => {
      const text = await renderDiveProfileText(request);
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });

  return (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={onCopy}
        disabled={!enabled || busy}
        data-testid="plan-profile-copy"
        title={t('planTables.profile.export.copyHint')}
        className="px-2 py-0.5 text-xs border border-border rounded disabled:opacity-40"
      >
        {copied ? t('planTables.profile.export.copied') : t('planTables.profile.export.copy')}
      </button>
      <button
        type="button"
        onClick={onExport}
        disabled={!enabled || busy}
        data-testid="plan-profile-export-xml"
        title={t('planTables.profile.export.xmlHint')}
        className="px-2 py-0.5 text-xs border border-border rounded disabled:opacity-40"
      >
        {t('planTables.profile.export.xml')}
      </button>
    </div>
  );
}

function ProfilePlot({
  geo,
  units,
  size,
  clipId,
}: {
  geo: NonNullable<ReturnType<typeof buildRouteProfile>>;
  units: 'metric' | 'imperial';
  size: { width: number; height: number };
  clipId: string;
}) {
  const { t } = useTranslation();
  // Fall back to a sane box before the first ResizeObserver callback (and under jsdom, where
  // clientWidth is always 0) so the paths are still well-formed and assertable.
  const width = size.width > 0 ? size.width : 480;
  const height = size.height > 0 ? size.height : 180;
  const labelled = height >= MIN_LABELLED_HEIGHT;
  const box = {
    width,
    height,
    padLeft: labelled ? PAD_LEFT : 4,
    padRight: PAD_RIGHT,
    padTop: PAD_TOP,
    padBottom: labelled ? PAD_BOTTOM : 4,
  };
  const p = projectProfile(geo, box);
  const shallow = getThemeColor('--cc-depth-shallow');
  const deep = getThemeColor('--cc-depth-deep');
  const accent = getThemeColor('--cc-accent');
  const border = getThemeColor('--cc-border');
  const text = getThemeColor('--cc-text-secondary');
  const error = getThemeColor('--cc-error');

  const xTicks = axisTicks(geo, units, 4);
  const yTicks = depthTicks(geo, units, 3);
  const turnDepth = geo.markers.find((m) => m.kind === 'turn')?.depth_m ?? 0;

  const axisSuffix =
    geo.axis === 'time' ? t('planTables.profile.units.minutes') : units === 'imperial' ? 'ft' : 'm';

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      data-testid="plan-profile-svg"
      data-axis={geo.axis}
      aria-label={t('planTables.profile.aria', {
        depth: formatGasLength(geo.depthMax, units),
        distance: formatGasLength(geo.points[geo.points.length - 1]?.distance_m ?? 0, units),
        runtime: formatFixed(geo.points[geo.points.length - 1]?.elapsed_min ?? 0, undefined, 0),
      })}
    >
      <defs>
        <linearGradient id={`${clipId}-fill`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={shallow} stopOpacity="0.35" />
          <stop offset="100%" stopColor={deep} stopOpacity="0.15" />
        </linearGradient>
      </defs>

      {labelled &&
        yTicks.map((tick) => (
          <g key={`y${tick.display}`}>
            <line
              x1={p.plotLeft}
              y1={p.y(tick.value)}
              x2={p.plotRight}
              y2={p.y(tick.value)}
              stroke={border}
              strokeWidth="1"
            />
            <text
              x={p.plotLeft - 6}
              y={p.y(tick.value) + 3}
              textAnchor="end"
              fontSize="9"
              fill={text}
            >
              {formatFixed(tick.display, undefined, 0)}
            </text>
          </g>
        ))}

      <path d={p.areaPath} fill={`url(#${clipId}-fill)`} stroke="none" />
      <path
        d={p.linePath}
        fill="none"
        stroke={accent}
        strokeWidth="1.5"
        strokeLinejoin="round"
        data-testid="plan-profile-line"
      />

      {/* The turnaround: everything right of this line is the way home. */}
      <line
        x1={p.x(geo.turnX)}
        y1={p.plotTop}
        x2={p.x(geo.turnX)}
        y2={p.plotBottom}
        stroke={accent}
        strokeWidth="1"
        strokeDasharray="3 3"
        data-testid="plan-profile-turn-line"
      />

      {geo.markers
        .filter((m) => m.kind !== 'turn')
        .map((m) => (
          <Marker key={`${m.kind}-${m.ordinal}`} marker={m} p={p} accent={accent} error={error} />
        ))}
      <circle
        cx={p.x(geo.turnX)}
        cy={p.y(turnDepth)}
        r="3.5"
        fill={accent}
        data-testid="plan-profile-marker-turn"
      />

      {labelled &&
        xTicks.map((tick) => (
          <text
            key={`x${tick.display}`}
            x={p.x(tick.value)}
            y={height - 6}
            textAnchor="middle"
            fontSize="9"
            fill={text}
          >
            {`${formatFixed(tick.display, undefined, 0)}${tick.display === xTicks[xTicks.length - 1]?.display ? ` ${axisSuffix}` : ''}`}
          </text>
        ))}
    </svg>
  );
}

function Marker({
  marker,
  p,
  accent,
  error,
}: {
  marker: ProfileMarker;
  p: ReturnType<typeof projectProfile>;
  accent: string;
  error: string;
}) {
  const color = marker.overReserve ? error : accent;
  const x = p.x(marker.x);
  return (
    <g
      data-testid={`plan-profile-marker-${marker.kind}-${marker.ordinal}`}
      data-over-reserve={String(marker.overReserve)}
    >
      <line
        x1={x}
        y1={p.plotTop}
        x2={x}
        y2={p.y(marker.depth_m)}
        stroke={color}
        strokeWidth="1"
        strokeDasharray={marker.kind === 'stage-drop' ? '2 2' : undefined}
        opacity="0.8"
      />
      {marker.kind === 'stage-drop' ? (
        <rect x={x - 3} y={p.y(marker.depth_m) - 3} width="6" height="6" fill={color} />
      ) : (
        <circle cx={x} cy={p.y(marker.depth_m)} r="3" fill={color} />
      )}
    </g>
  );
}
