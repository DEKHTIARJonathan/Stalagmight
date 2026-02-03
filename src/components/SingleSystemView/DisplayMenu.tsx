import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore, type DisplayToggleKey } from '../../store/uiStore';
import { GRID_SPACING_OPTIONS } from '../Map/GridOverlay';
import { formatNumber } from '../../i18n/format';

interface DisplayOption {
  key: DisplayToggleKey;
  labelKey: string;
  descriptionKey?: string;
  disabledWhen?: DisplayToggleKey;
}

const displayOptions: { groupKey: string; items: DisplayOption[] }[] = [
  {
    groupKey: 'displayMenu.groups.mapElements',
    items: [
      { key: 'showStations', labelKey: 'displayMenu.items.stations', descriptionKey: 'displayMenu.descriptions.stations' },
      { key: 'showSectionNames', labelKey: 'displayMenu.items.sectionNames', descriptionKey: 'displayMenu.descriptions.sectionNames' },
      { key: 'showStationLabels', labelKey: 'displayMenu.items.stationLabels', descriptionKey: 'displayMenu.descriptions.stationLabels' },
      { key: 'showShots', labelKey: 'displayMenu.items.shots', descriptionKey: 'displayMenu.descriptions.shots' },
      { key: 'showVirtualShots', labelKey: 'displayMenu.items.virtualShots', descriptionKey: 'displayMenu.descriptions.virtualShots', disabledWhen: 'showShots' },
      { key: 'showShotData', labelKey: 'displayMenu.items.shotData', descriptionKey: 'displayMenu.descriptions.shotData', disabledWhen: 'showShots' },
      { key: 'showZeroDatum', labelKey: 'displayMenu.items.zeroDatum', descriptionKey: 'displayMenu.descriptions.zeroDatum' },
    ],
  },
  {
    groupKey: 'displayMenu.groups.overlays',
    items: [
      { key: 'showGrid', labelKey: 'displayMenu.items.grid', descriptionKey: 'displayMenu.descriptions.grid' },
      { key: 'showScaleBar', labelKey: 'displayMenu.items.scaleBar', descriptionKey: 'displayMenu.descriptions.scaleBar' },
      { key: 'showSatellite', labelKey: 'displayMenu.items.satellite', descriptionKey: 'displayMenu.descriptions.satellite' },
      { key: 'showDepthGradient', labelKey: 'displayMenu.items.depthGradient', descriptionKey: 'displayMenu.descriptions.depthGradient' },
    ],
  },
  {
    groupKey: 'displayMenu.groups.developer',
    items: [
      { key: 'showDevStats', labelKey: 'displayMenu.items.devStats', descriptionKey: 'displayMenu.descriptions.devStats' },
    ],
  },
];

export default function DisplayMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { t } = useTranslation();

  const {
    showStations,
    showShots,
    showSectionNames,
    showStationLabels,
    showShotData,
    showVirtualShots,
    showZeroDatum,
    showGrid,
    showScaleBar,
    showSatellite,
    showDepthGradient,
    showDevStats,
    gridSpacing,
    toggleDisplay,
    setGridSpacing,
  } = useUIStore();

  const toggleValues: Record<DisplayToggleKey, boolean> = {
    showStations,
    showShots,
    showSectionNames,
    showStationLabels,
    showShotData,
    showVirtualShots,
    showZeroDatum,
    showGrid,
    showScaleBar,
    showSatellite,
    showDepthGradient,
    showDevStats,
  };

  const isDisabled = (item: DisplayOption) =>
    item.disabledWhen ? !toggleValues[item.disabledWhen] : false;

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
          <span>👁</span>
          <span>{t('displayMenu.button')}</span>
          <span className="text-xs">{isOpen ? '▲' : '▼'}</span>
        </span>
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full mt-1 w-64 bg-panel border border-border rounded-lg shadow-lg z-50"
          data-testid="display-menu"
        >
          {displayOptions.map((group, groupIndex) => (
            <div key={group.groupKey}>
              {groupIndex > 0 && <div className="border-t border-border" />}
              <div className="px-3 py-2 text-xs font-medium text-text-secondary uppercase tracking-wide">
                {t(group.groupKey)}
              </div>
              <div className="pb-1">
                {group.items.map((item) => {
                  const disabled = isDisabled(item);
                  return (
                  <div key={item.key}>
                    <button
                      onClick={() => !disabled && toggleDisplay(item.key)}
                      disabled={disabled}
                      aria-disabled={disabled || undefined}
                      className={`
                        w-full px-3 py-2 flex items-center justify-between transition-colors
                        ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-background-50'}
                      `}
                      data-testid={`display-toggle-${item.key}`}
                    >
                      <div className="flex flex-col items-start">
                        <span className="text-sm">{t(item.labelKey)}</span>
                        {item.descriptionKey && (
                          <span className="text-xs text-text-secondary">{t(item.descriptionKey)}</span>
                        )}
                      </div>
                      <div
                        className={`
                          w-5 h-5 rounded flex items-center justify-center text-xs
                          ${toggleValues[item.key]
                            ? 'bg-accent text-accent-on'
                            : 'bg-background border border-border text-transparent'
                          }
                        `}
                      >
                        ✓
                      </div>
                    </button>
                    {/* Grid spacing options - shown when grid is enabled */}
                    {item.key === 'showGrid' && showGrid && (
                      <div className="px-3 py-2 pl-6 bg-background-30">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-text-secondary">{t('displayMenu.spacing.label')}:</span>
                          <select
                            value={gridSpacing}
                            onChange={(e) => setGridSpacing(Number(e.target.value))}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 px-2 py-1 text-xs bg-background border border-border rounded text-text-primary"
                            data-testid="grid-spacing-select"
                          >
                            {GRID_SPACING_OPTIONS.map((spacing) => (
                              <option key={spacing} value={spacing}>
                                {formatNumber(spacing)}{t('common.units.meters')}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
