import { useState, useRef, useEffect } from 'react';
import { useUIStore, type DisplayToggleKey } from '../../store/uiStore';
import { GRID_SPACING_OPTIONS } from '../Map/GridOverlay';

interface DisplayOption {
  key: DisplayToggleKey;
  label: string;
  description?: string;
}

const displayOptions: { group: string; items: DisplayOption[] }[] = [
  {
    group: 'Map Elements',
    items: [
      { key: 'showStations', label: 'Stations', description: 'Show station markers' },
      { key: 'showSectionNames', label: 'Section Names', description: 'Show labels for sections' },
      { key: 'showStationLabels', label: 'Station Labels', description: 'Show station index numbers' },
      { key: 'showShotData', label: 'Shot Data', description: 'Show azimuth, length, depth labels' },
      { key: 'showVirtualShots', label: 'Virtual Shots', description: 'Show dashed virtual connections' },
      { key: 'showZeroDatum', label: 'Zero Datum', description: 'Highlight entrance markers' },
    ],
  },
  {
    group: 'Overlays',
    items: [
      { key: 'showGrid', label: 'Grid', description: 'Show coordinate grid' },
      { key: 'showScaleBar', label: 'Scale Bar', description: 'Show distance scale' },
      { key: 'showSatellite', label: 'Satellite', description: 'Show satellite imagery' },
      { key: 'showDepthGradient', label: 'Depth Gradient', description: 'Color by depth' },
    ],
  },
];

export default function DisplayMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const {
    showStations,
    showSectionNames,
    showStationLabels,
    showShotData,
    showVirtualShots,
    showZeroDatum,
    showGrid,
    showScaleBar,
    showSatellite,
    showDepthGradient,
    gridSpacing,
    toggleDisplay,
    setGridSpacing,
  } = useUIStore();

  const toggleValues: Record<DisplayToggleKey, boolean> = {
    showStations,
    showSectionNames,
    showStationLabels,
    showShotData,
    showVirtualShots,
    showZeroDatum,
    showGrid,
    showScaleBar,
    showSatellite,
    showDepthGradient,
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

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={`
          px-3 py-1.5 text-sm rounded transition-colors
          ${isOpen
            ? 'bg-accent text-white'
            : 'bg-background hover:bg-background/80 text-text-primary'
          }
        `}
        title="Display Options"
        data-testid="display-menu-button"
        aria-expanded={isOpen}
      >
        <span className="flex items-center gap-1">
          <span>👁</span>
          <span>Display</span>
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
            <div key={group.group}>
              {groupIndex > 0 && <div className="border-t border-border" />}
              <div className="px-3 py-2 text-xs font-medium text-text-secondary uppercase tracking-wide">
                {group.group}
              </div>
              <div className="pb-1">
                {group.items.map((item) => (
                  <div key={item.key}>
                    <button
                      onClick={() => toggleDisplay(item.key)}
                      className="w-full px-3 py-2 flex items-center justify-between hover:bg-background/50 transition-colors"
                      data-testid={`display-toggle-${item.key}`}
                    >
                      <div className="flex flex-col items-start">
                        <span className="text-sm">{item.label}</span>
                        {item.description && (
                          <span className="text-xs text-text-secondary">{item.description}</span>
                        )}
                      </div>
                      <div
                        className={`
                          w-5 h-5 rounded flex items-center justify-center text-xs
                          ${toggleValues[item.key]
                            ? 'bg-accent text-white'
                            : 'bg-background border border-border text-transparent'
                          }
                        `}
                      >
                        ✓
                      </div>
                    </button>
                    {/* Grid spacing options - shown when grid is enabled */}
                    {item.key === 'showGrid' && showGrid && (
                      <div className="px-3 py-2 pl-6 bg-background/30">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-text-secondary">Spacing:</span>
                          <select
                            value={gridSpacing}
                            onChange={(e) => setGridSpacing(Number(e.target.value))}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 px-2 py-1 text-xs bg-background border border-border rounded text-text-primary"
                            data-testid="grid-spacing-select"
                          >
                            {GRID_SPACING_OPTIONS.map((spacing) => (
                              <option key={spacing} value={spacing}>
                                {spacing}m
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
