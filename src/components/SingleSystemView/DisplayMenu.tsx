import { useState, useRef, useEffect, type ReactNode, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore, type DisplayToggleKey } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useShallow } from 'zustand/react/shallow';
import { GRID_SPACING_OPTIONS } from '../Map/GridOverlay';
import { formatNumber } from '../../i18n/format';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  MapIcon,
  LayersIcon,
  MessageIcon,
  RulerIcon,
  SlidersIcon,
} from '../common/icons';
import {
  EntitySymbol,
  EntityReferenceSymbol,
  EntityDatumSymbol,
  EntityCommentSymbol,
  EntityDataSymbol,
  EntityLabelSymbol,
} from '../common/toolIcons';
import {
  syntacticLevelAtLeast,
  syntacticVarName,
  type BlobEntity,
} from '../../theme/syntacticPalette';
import { getThemeColor } from '../../utils/themeColors';
import { getContrastColor } from '../../utils/colors';
import { setSource } from '../../utils/telemetry';
import { hasEligibleClosures } from '../../utils/closures';

/** A multi-toggle display key shown as a pill, optionally gated on another toggle. */
interface ToggleItem {
  key: Extract<
    DisplayToggleKey,
    | 'showStations'
    | 'showShots'
    | 'showReferenceShots'
    | 'showZeroDatum'
    | 'showSectionNames'
    | 'showStationLabels'
    | 'showStationComments'
    | 'showShotComments'
    | 'showShotData'
    | 'showGrid'
    | 'showSatellite'
  >;
  labelKey: string;
  descriptionKey?: string;
  disabledWhen?: 'showShots';
  /** Element this pill refers to: drives the entity icon + the pill's tint
   *  (--sh-<entity>, the same color the data-table/legend chips use). */
  entity?: BlobEntity;
  /** Badged entity-symbol variant overlaid on the entity glyph. */
  symbol?: 'reference' | 'datum' | 'comment' | 'data' | 'label';
}

const MAP_ELEMENTS: ToggleItem[] = [
  { key: 'showStations', labelKey: 'displayMenu.items.stations', descriptionKey: 'displayMenu.descriptions.stations', entity: 'station' },
  { key: 'showShots', labelKey: 'displayMenu.items.shots', descriptionKey: 'displayMenu.descriptions.shots', entity: 'shot' },
  { key: 'showReferenceShots', labelKey: 'displayMenu.items.referenceShots', descriptionKey: 'displayMenu.descriptions.referenceShots', disabledWhen: 'showShots', entity: 'shot', symbol: 'reference' },
  { key: 'showZeroDatum', labelKey: 'displayMenu.items.zeroDatum', descriptionKey: 'displayMenu.descriptions.zeroDatum', entity: 'station', symbol: 'datum' },
];

const OVERLAYS: ToggleItem[] = [
  { key: 'showGrid', labelKey: 'displayMenu.items.grid', descriptionKey: 'displayMenu.descriptions.grid' },
  { key: 'showSatellite', labelKey: 'displayMenu.items.satellite', descriptionKey: 'displayMenu.descriptions.satellite' },
];

// Each pill is tinted/iconned by the element it annotates (the category header
// already carries the comment glyph), so the comment/label pills inherit their
// PARENT entity's color — station comments read as station-colored, etc. —
// rather than the generic 'comment' role color.
const COMMENTS_LABELS: ToggleItem[] = [
  { key: 'showSectionNames', labelKey: 'displayMenu.items.sectionNames', descriptionKey: 'displayMenu.descriptions.sectionNames', entity: 'section', symbol: 'label' },
  { key: 'showStationLabels', labelKey: 'displayMenu.items.stationLabels', descriptionKey: 'displayMenu.descriptions.stationLabels', entity: 'station', symbol: 'label' },
  { key: 'showStationComments', labelKey: 'displayMenu.items.stationComments', descriptionKey: 'displayMenu.descriptions.stationComments', entity: 'station', symbol: 'comment' },
  { key: 'showShotComments', labelKey: 'displayMenu.items.shotComments', descriptionKey: 'displayMenu.descriptions.shotComments', disabledWhen: 'showShots', entity: 'shot', symbol: 'comment' },
  { key: 'showShotData', labelKey: 'displayMenu.items.shotData', descriptionKey: 'displayMenu.descriptions.shotData', disabledWhen: 'showShots', entity: 'shot', symbol: 'data' },
];

type ColorMode = 'section' | 'depth' | 'distance' | 'issues';

/**
 * A pill toggle. When `entityColored` is set, the pill carries its element's
 * color (`--o` = `var(--sh-<entity>)`, the same setting-wired palette the
 * data-table/legend chips use): off shows just a faint entity-tinted outline,
 * on fills with the full element color (with `onColor` — a contrast color — for
 * the label + glyph). Otherwise it fills with the theme accent. Dimmed when
 * disabled.
 */
function Pill({
  label,
  active,
  disabled,
  onClick,
  testId,
  title,
  entity,
  entityColored,
  onColor,
  icon,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId: string;
  title?: string;
  entity?: BlobEntity | undefined;
  /** Apply the element-colored outline/fill (true only once colors are enabled). */
  entityColored?: boolean;
  /** Contrast color for the filled (on) state's label + glyph. */
  onColor?: string | undefined;
  icon?: ReactNode;
}) {
  const base = 'px-3 py-1 text-xs rounded-full inline-flex items-center gap-1.5 transition-colors';
  const className = entity && entityColored
    ? `${base} sh-epill ${active ? 'sh-epill--on' : ''} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`
    : `${base} border ${
        disabled
          ? 'opacity-50 cursor-not-allowed bg-background text-text-secondary sh-apill'
          : active
            ? 'bg-accent text-accent-on border-accent'
            : 'bg-background text-text-primary hover:bg-background-50 sh-apill'
      }`;
  const style = entity && entityColored
    ? ({ '--o': `var(${syntacticVarName(entity)})`, '--pill-oncolor': onColor ?? '#ffffff' } as CSSProperties)
    : undefined;
  return (
    <button
      type="button"
      onClick={() => { if (!disabled) onClick(); }}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      data-testid={testId}
      className={className}
      style={style}
    >
      {icon}
      {label}
    </button>
  );
}

/** A labelled category block (optional leading icon) with its pills wrapping below. */
function Category({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="px-0.5 pb-1.5 text-xs font-medium text-text-secondary uppercase tracking-wide flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

export default function DisplayMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const openedByOnboardingRef = useRef(false);
  const { t } = useTranslation();

  const {
    showDepthGradient,
    showDistanceGradient,
    showIssueSeverity,
    gridSpacing,
    geometryMode,
    syntacticLevel,
    toggleDisplay,
    toggleDistanceGradient,
    setIssueSeverity,
    setGridSpacing,
    setGeometryMode,
  } = useUIStore(useShallow((s) => ({
    showDepthGradient: s.showDepthGradient,
    showDistanceGradient: s.showDistanceGradient,
    showIssueSeverity: s.showIssueSeverity,
    gridSpacing: s.gridSpacing,
    geometryMode: s.geometryMode,
    syntacticLevel: s.syntacticLevel,
    toggleDisplay: s.toggleDisplay,
    toggleDistanceGradient: s.toggleDistanceGradient,
    setIssueSeverity: s.setIssueSeverity,
    setGridSpacing: s.setGridSpacing,
    setGeometryMode: s.setGeometryMode,
  })));

  // The element-toggle booleans, read as a keyed map so a pill can look itself
  // up by `item.key` (and its `disabledWhen` dependency) — this IS the source,
  // not a hand-maintained copy of separately destructured values.
  const toggleValues = useUIStore(
    useShallow(
      (s): Record<ToggleItem['key'], boolean> => ({
        showStations: s.showStations,
        showShots: s.showShots,
        showReferenceShots: s.showReferenceShots,
        showZeroDatum: s.showZeroDatum,
        showSectionNames: s.showSectionNames,
        showStationLabels: s.showStationLabels,
        showStationComments: s.showStationComments,
        showShotComments: s.showShotComments,
        showShotData: s.showShotData,
        showGrid: s.showGrid,
        showSatellite: s.showSatellite,
      }),
    ),
  );

  // The closure-adjusted view only differs from measured when the project has at
  // least one closure eligible for the solve (Batch / LeastSquaresWeighted);
  // otherwise the option is disabled (it would render identical geometry).
  const hasClosures = useProjectStore((s) => hasEligibleClosures(s.project?.loop_closures ?? []));

  // Coloring is single-select: exactly one of the (already mutually-exclusive)
  // overlays, or 'section' = none of them (the default per-section coloring).
  const colorMode: ColorMode = showIssueSeverity
    ? 'issues'
    : showDistanceGradient
      ? 'distance'
      : showDepthGradient
        ? 'depth'
        : 'section';

  const selectColorMode = (mode: ColorMode) => {
    if (mode === colorMode) return;
    setSource('display-menu');
    if (mode === 'depth') {
      if (!showDepthGradient) toggleDisplay('showDepthGradient'); // turns off the others
    } else if (mode === 'distance') {
      if (!showDistanceGradient) toggleDistanceGradient(); // turns off the others
    } else if (mode === 'issues') {
      setIssueSeverity(true); // turns off the others
    } else {
      // 'section' — turn off whichever single mode is currently on.
      if (showDepthGradient) toggleDisplay('showDepthGradient');
      else if (showDistanceGradient) toggleDistanceGradient();
      else if (showIssueSeverity) setIssueSeverity(false);
    }
  };

  // Element icons appear at the 'icons' level; the element-color outline/fill
  // kicks in as soon as colors are on ('toolbar_only'+), like the rest of the chrome.
  const showIcons = syntacticLevelAtLeast(syntacticLevel, 'icons');
  const colorsOn = syntacticLevelAtLeast(syntacticLevel, 'toolbar_only');

  const entitySymbolFor = (item: ToggleItem): ReactNode => {
    if (!item.entity || !showIcons) return undefined;
    switch (item.symbol) {
      case 'reference': return <EntityReferenceSymbol entity={item.entity} size={14} />;
      case 'datum': return <EntityDatumSymbol entity={item.entity} size={14} />;
      case 'comment': return <EntityCommentSymbol entity={item.entity} size={14} />;
      case 'data': return <EntityDataSymbol entity={item.entity} size={14} />;
      case 'label': return <EntityLabelSymbol entity={item.entity} size={14} />;
      default: return <EntitySymbol entity={item.entity} size={14} />;
    }
  };

  const renderTogglePill = (item: ToggleItem) => {
    const disabled = item.disabledWhen ? !toggleValues[item.disabledWhen] : false;
    const active = toggleValues[item.key];
    const entityColored = !!item.entity && colorsOn;
    // Contrast color for the filled (on) state, derived from the resolved
    // (possibly user-overridden) element color so the label + glyph stay legible.
    // Read live (not cached): the --sh-<entity> vars change on a preset / per-
    // element color override without changing syntacticLevel, so a cache keyed on
    // the level would serve a stale (possibly illegible) color. The cost is one
    // getComputedStyle per on-pill on an already-open menu — negligible.
    const onColor = entityColored && active && item.entity
      ? getContrastColor(getThemeColor(syntacticVarName(item.entity)))
      : undefined;
    return (
      <Pill
        key={item.key}
        label={t(item.labelKey)}
        title={item.descriptionKey ? t(item.descriptionKey) : ''}
        active={active}
        disabled={disabled}
        onClick={() => { setSource('display-menu'); toggleDisplay(item.key); }}
        testId={`display-toggle-${item.key}`}
        entity={item.entity}
        entityColored={entityColored}
        onColor={onColor}
        icon={entitySymbolFor(item)}
      />
    );
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  // Auto-open display menu during onboarding "display options" steps.
  useEffect(() => {
    const isDisplayOptionsStepActive = (): boolean => {
      const overlay = document.querySelector('[data-testid="onboarding-overlay"]');
      if (!overlay) {
        return false;
      }
      const flowId = overlay.getAttribute('data-onboarding-flow-id');
      const stepId = overlay.getAttribute('data-onboarding-step-id');
      return (
        stepId === 'display-options' &&
        (flowId === 'placement-mode-map' || flowId === 'single-view-basics')
      );
    };

    const syncOpenState = () => {
      if (isDisplayOptionsStepActive()) {
        setIsOpen((current) => {
          if (!current) {
            openedByOnboardingRef.current = true;
            return true;
          }
          return current;
        });
        return;
      }

      if (openedByOnboardingRef.current) {
        openedByOnboardingRef.current = false;
        setIsOpen(false);
      }
    };

    syncOpenState();

    if (typeof MutationObserver === 'undefined') {
      return;
    }

    const observer = new MutationObserver(syncOpenState);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-onboarding-flow-id', 'data-onboarding-step-id'],
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={`
          px-3 py-1.5 text-sm rounded transition-colors
          ${isOpen
            ? 'bg-accent text-accent-on'
            : 'bg-background hover:bg-background-80 text-text-primary'
          }
        `}
        title={t('displayMenu.title')}
        data-testid="display-menu-button"
        aria-expanded={isOpen}
      >
        <span className="flex items-center gap-1">
          <EyeIcon size={18} />
          <span>{t('displayMenu.button')}</span>
          <span className="text-xs">
            {isOpen ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}
          </span>
        </span>
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full mt-1 w-[30rem] overflow-y-auto overscroll-contain bg-panel border border-border rounded-lg shadow-lg z-50 p-3"
          style={{ maxHeight: 'calc(100vh - 6rem)' }}
          data-testid="display-menu"
        >
          <div className="grid grid-cols-2 gap-x-5 gap-y-4">
            {/* Row 1: Color | Overlays */}
            <Category label={t('displayMenu.groups.color')} icon={showIcons ? <SlidersIcon size={14} /> : undefined}>
              <Pill label={t('displayMenu.items.section')} active={colorMode === 'section'} onClick={() => selectColorMode('section')} testId="display-color-section" />
              <Pill label={t('displayMenu.items.depthGradient')} title={t('displayMenu.descriptions.depthGradient')} active={colorMode === 'depth'} onClick={() => selectColorMode('depth')} testId="display-toggle-showDepthGradient" />
              <Pill label={t('displayMenu.items.distanceGradient')} title={t('displayMenu.descriptions.distanceGradient')} active={colorMode === 'distance'} onClick={() => selectColorMode('distance')} testId="display-toggle-showDistanceGradient" />
              <Pill label={t('displayMenu.items.issueSeverity')} title={t('displayMenu.descriptions.issueSeverity')} active={colorMode === 'issues'} onClick={() => selectColorMode('issues')} testId="display-toggle-showIssueSeverity" />
            </Category>

            <Category label={t('displayMenu.groups.overlays')} icon={showIcons ? <LayersIcon size={14} /> : undefined}>
              {OVERLAYS.map(renderTogglePill)}
              {toggleValues.showGrid && (
                <div className="basis-full flex items-center gap-2 pt-1">
                  <span className="text-xs text-text-secondary">{t('displayMenu.spacing.label')}:</span>
                  <select
                    value={gridSpacing}
                    onChange={(e) => setGridSpacing(Number(e.target.value))}
                    className="px-2 py-1 text-xs bg-background border border-border rounded text-text-primary"
                    data-testid="grid-spacing-select"
                  >
                    {GRID_SPACING_OPTIONS.map((spacing) => (
                      <option key={spacing} value={spacing}>
                        {formatNumber(spacing)}{t('common.units.meters')}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </Category>

            {/* Row 2: Map Elements (full width) */}
            <div className="col-span-2">
              <Category label={t('displayMenu.groups.mapElements')} icon={showIcons ? <MapIcon size={14} /> : undefined}>
                {MAP_ELEMENTS.map(renderTogglePill)}
              </Category>
            </div>

            {/* Row 3: Comments & Labels (full width) */}
            <div className="col-span-2">
              <Category label={t('displayMenu.groups.commentsLabels')} icon={showIcons ? <MessageIcon size={14} /> : undefined}>
                {COMMENTS_LABELS.map(renderTogglePill)}
              </Category>
            </div>

            {/* Row 4: Geometry (single-select), full width */}
            <div className="col-span-2 border-t border-border pt-3">
              <Category label={t('displayMenu.geometry.groupLabel')} icon={showIcons ? <RulerIcon size={14} /> : undefined}>
                <Pill
                  label={t('displayMenu.geometry.measured')}
                  active={geometryMode === 'measured'}
                  onClick={() => setGeometryMode('measured', 'display-menu')}
                  testId="geometry-mode-measured"
                />
                <Pill
                  label={t('displayMenu.geometry.closureAdjusted')}
                  active={geometryMode === 'closureAdjusted'}
                  disabled={!hasClosures}
                  title={!hasClosures ? t('displayMenu.geometry.noClosures') : ''}
                  onClick={() => setGeometryMode('closureAdjusted', 'display-menu')}
                  testId="geometry-mode-closureAdjusted"
                />
              </Category>
              <p className="mt-1.5 text-xs text-text-secondary">
                {geometryMode === 'closureAdjusted'
                  ? t('displayMenu.geometry.closureAdjustedDescription')
                  : t('displayMenu.geometry.measuredDescription')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
