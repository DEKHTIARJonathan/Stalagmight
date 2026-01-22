import { useRef, useEffect, useId } from 'react';

/**
 * Category identifiers for settings sidebar navigation.
 */
export type SettingsCategory =
  | 'general'
  | 'units'
  | 'display'
  | 'map'
  | 'validation'
  | 'export'
  | 'shortcuts'
  | 'cache'
  | 'advanced';

/**
 * Category configuration with display labels.
 */
interface CategoryConfig {
  id: SettingsCategory;
  label: string;
}

const CATEGORIES: CategoryConfig[] = [
  { id: 'general', label: 'General' },
  { id: 'units', label: 'Units' },
  { id: 'display', label: 'Display' },
  { id: 'map', label: 'Map' },
  { id: 'validation', label: 'Validation' },
  { id: 'export', label: 'Export' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'cache', label: 'Cache' },
  { id: 'advanced', label: 'Advanced' },
];

interface SettingsSidebarProps {
  /** Currently active (selected) category */
  activeCategory: SettingsCategory;
  /** Callback when a category is activated (via Enter key or click) */
  onCategoryChange: (category: SettingsCategory) => void;
  /** Currently focused category index for roving tabindex */
  focusedIndex: number;
  /** Callback when focused index changes (via arrow keys) */
  onFocusChange: (index: number) => void;
  /** Map of category IDs to error state (true if category has validation errors) */
  categoryErrors?: Partial<Record<SettingsCategory, boolean>>;
  /** Base ID for panel aria-controls (generated if not provided) */
  panelIdBase?: string;
}

/**
 * Settings sidebar navigation with vertical tab pattern.
 *
 * Implements WAI-ARIA tab pattern with manual activation:
 * - Arrow keys move focus (focusedIndex) without changing selection
 * - Enter key activates the focused category (sets activeCategory)
 * - Uses roving tabindex (focused tab has tabindex=0, others have -1)
 */
export function SettingsSidebar({
  activeCategory,
  onCategoryChange,
  focusedIndex,
  onFocusChange,
  categoryErrors = {},
  panelIdBase,
}: SettingsSidebarProps) {
  const generatedIdBase = useId();
  const idBase = panelIdBase ?? generatedIdBase;
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Get the panel ID for a category (used in aria-controls)
  const getPanelId = (category: SettingsCategory) => `${idBase}-panel-${category}`;

  // Focus the element when focusedIndex changes
  useEffect(() => {
    if (focusedIndex >= 0 && focusedIndex < CATEGORIES.length) {
      tabRefs.current[focusedIndex]?.focus();
    }
  }, [focusedIndex]);

  const handleKeyDown = (event: React.KeyboardEvent, currentIndex: number) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        if (currentIndex < CATEGORIES.length - 1) {
          onFocusChange(currentIndex + 1);
        }
        break;

      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        if (currentIndex > 0) {
          onFocusChange(currentIndex - 1);
        }
        break;

      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        onFocusChange(0);
        break;

      case 'End':
        event.preventDefault();
        event.stopPropagation();
        onFocusChange(CATEGORIES.length - 1);
        break;

      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        {
          const category = CATEGORIES[currentIndex];
          if (category) {
            onCategoryChange(category.id);
          }
        }
        break;
    }
  };

  const handleClick = (category: SettingsCategory, index: number) => {
    onFocusChange(index);
    onCategoryChange(category);
  };

  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label="Settings categories"
      className="w-[150px] flex-shrink-0 border-r border-border bg-panel"
      data-testid="settings-sidebar"
    >
      {CATEGORIES.map((category, index) => {
        const isActive = activeCategory === category.id;
        const isFocused = focusedIndex === index;
        const hasError = categoryErrors[category.id] === true;
        const isAdvanced = category.id === 'advanced';

        return (
          <div key={category.id}>
            {/* Visual separator before Advanced */}
            {isAdvanced && (
              <div className="mx-3 my-2 border-t border-border" aria-hidden="true" />
            )}
            <div
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              role="tab"
              aria-selected={isActive}
              aria-controls={getPanelId(category.id)}
              tabIndex={isFocused ? 0 : -1}
              data-testid={`settings-sidebar-${category.id}`}
              className={`
                relative px-4 py-2 text-sm cursor-pointer select-none
                transition-colors outline-none
                ${isActive ? 'bg-accent/20 text-accent font-medium' : 'text-text-primary hover:bg-accent/10'}
                ${isFocused ? 'ring-2 ring-inset ring-accent' : ''}
              `}
              onClick={() => handleClick(category.id, index)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              onFocus={() => onFocusChange(index)}
            >
              <span className="flex items-center gap-2">
                {category.label}
                {/* Error indicator (red dot) */}
                {hasError && (
                  <span
                    className="w-2 h-2 rounded-full bg-error flex-shrink-0"
                    aria-label="Has validation errors"
                    data-testid={`settings-sidebar-error-${category.id}`}
                  />
                )}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { CATEGORIES };
