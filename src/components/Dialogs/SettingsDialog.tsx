import { useState, useEffect, useCallback, useRef, useMemo, useId } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import {
  SettingsSidebar,
  CATEGORIES,
  getTabId,
  getPanelId,
  type SettingsCategory,
} from './SettingsSidebar';
import { GeneralSettings } from './settings/GeneralSettings';
import { UnitsSettings } from './settings/UnitsSettings';
import { DisplaySettings } from './settings/DisplaySettings';
import { MapSettings } from './settings/MapSettings';
import { ValidationSettings } from './settings/ValidationSettings';
import { ExportSettings } from './settings/ExportSettings';
import { ShortcutsSettings } from './settings/ShortcutsSettings';
import { CacheSettings } from './settings/CacheSettings';
import { AdvancedSettings } from './settings/AdvancedSettings';
import type { Config } from '../../types/config';
import { defaultConfig } from '../../types/config';

/**
 * Deep comparison of two config objects to detect changed field paths.
 */
function getChangedFields(originalConfig: Config, currentConfig: Config): Set<string> {
  const changed = new Set<string>();

  function compare(original: unknown, current: unknown, path: string) {
    if (original === current) return;

    if (
      typeof original !== 'object' ||
      typeof current !== 'object' ||
      original === null ||
      current === null
    ) {
      changed.add(path);
      return;
    }

    if (Array.isArray(original) && Array.isArray(current)) {
      if (JSON.stringify(original) !== JSON.stringify(current)) {
        changed.add(path);
      }
      return;
    }

    const origObj = original as Record<string, unknown>;
    const currObj = current as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(origObj), ...Object.keys(currObj)]);

    for (const key of allKeys) {
      compare(origObj[key], currObj[key], path ? `${path}.${key}` : key);
    }
  }

  compare(originalConfig, currentConfig, '');
  return changed;
}

/**
 * Get category-specific defaults from defaultConfig.
 */
function getCategoryDefaults(category: SettingsCategory): Partial<Config> {
  switch (category) {
    case 'general':
      return { general: { ...defaultConfig.general } };
    case 'units':
      return { units: { ...defaultConfig.units } };
    case 'display':
      return {
        display: { ...defaultConfig.display, depth_gradient: { ...defaultConfig.display.depth_gradient } },
        section_colors: { palette: [...defaultConfig.section_colors.palette] },
      };
    case 'map':
      return {
        map: {
          ...defaultConfig.map,
          satellite_gps_origin: { ...defaultConfig.map.satellite_gps_origin },
          controls: { ...defaultConfig.map.controls },
          station: { ...defaultConfig.map.station },
          shot: { ...defaultConfig.map.shot },
          snap: { ...defaultConfig.map.snap },
          animation: { ...defaultConfig.map.animation },
        },
      };
    case 'validation':
      return { validation: { ...defaultConfig.validation } };
    case 'export':
      return { export: { ...defaultConfig.export } };
    case 'shortcuts':
      return { shortcuts: { ...defaultConfig.shortcuts } };
    case 'cache':
      return { cache: { ...defaultConfig.cache } };
    case 'advanced':
      return {
        debug: { map: { ...defaultConfig.debug.map } },
        logging: { ...defaultConfig.logging },
        panels: { ...defaultConfig.panels },
      };
    default:
      return {};
  }
}

/**
 * Get the label for a settings category.
 */
function getCategoryLabel(category: SettingsCategory): string {
  const cat = CATEGORIES.find((c) => c.id === category);
  return cat?.label ?? category;
}

/**
 * Deep merge two config objects.
 */
function mergeConfig(base: Config, updates: Partial<Config>): Config {
  // Spread to create a mutable copy
  const result: Config = {
    general: { ...base.general },
    units: { ...base.units },
    display: { ...base.display, depth_gradient: { ...base.display.depth_gradient } },
    section_colors: { palette: [...base.section_colors.palette] },
    map: {
      ...base.map,
      satellite_gps_origin: { ...base.map.satellite_gps_origin },
      controls: { ...base.map.controls },
      station: { ...base.map.station },
      shot: { ...base.map.shot },
      snap: { ...base.map.snap },
      animation: { ...base.map.animation },
    },
    validation: { ...base.validation },
    export: { ...base.export },
    logging: { ...base.logging },
    shortcuts: { ...base.shortcuts },
    panels: { ...base.panels },
    cache: { ...base.cache },
    debug: { map: { ...base.debug.map } },
  };

  // Apply updates with deep merge for each key
  if (updates.general) {
    result.general = { ...result.general, ...updates.general };
  }
  if (updates.units) {
    result.units = { ...result.units, ...updates.units };
  }
  if (updates.display) {
    result.display = {
      ...result.display,
      ...updates.display,
      depth_gradient: updates.display.depth_gradient
        ? { ...result.display.depth_gradient, ...updates.display.depth_gradient }
        : result.display.depth_gradient,
    };
  }
  if (updates.section_colors) {
    result.section_colors = { ...result.section_colors, ...updates.section_colors };
  }
  if (updates.map) {
    result.map = {
      ...result.map,
      ...updates.map,
      satellite_gps_origin: updates.map.satellite_gps_origin
        ? { ...result.map.satellite_gps_origin, ...updates.map.satellite_gps_origin }
        : result.map.satellite_gps_origin,
      controls: updates.map.controls
        ? { ...result.map.controls, ...updates.map.controls }
        : result.map.controls,
      station: updates.map.station
        ? { ...result.map.station, ...updates.map.station }
        : result.map.station,
      shot: updates.map.shot
        ? { ...result.map.shot, ...updates.map.shot }
        : result.map.shot,
      snap: updates.map.snap
        ? { ...result.map.snap, ...updates.map.snap }
        : result.map.snap,
      animation: updates.map.animation
        ? { ...result.map.animation, ...updates.map.animation }
        : result.map.animation,
    };
  }
  if (updates.validation) {
    result.validation = { ...result.validation, ...updates.validation };
  }
  if (updates.export) {
    result.export = { ...result.export, ...updates.export };
  }
  if (updates.logging) {
    result.logging = { ...result.logging, ...updates.logging };
  }
  if (updates.shortcuts) {
    result.shortcuts = { ...result.shortcuts, ...updates.shortcuts };
  }
  if (updates.panels) {
    result.panels = { ...result.panels, ...updates.panels };
  }
  if (updates.cache) {
    result.cache = { ...result.cache, ...updates.cache };
  }
  if (updates.debug) {
    result.debug = {
      ...result.debug,
      map: updates.debug.map
        ? { ...result.debug.map, ...updates.debug.map }
        : result.debug.map,
    };
  }

  return result;
}

export default function SettingsDialog() {
  const { closeDialog } = useUIStore();
  const { config, updateConfig } = useProjectStore();

  // Panel ID base for ARIA associations
  const panelIdBase = useId();

  // Active (selected) category
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('general');
  // Focused category index for roving tabindex
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Local config copy for editing
  const [localConfig, setLocalConfig] = useState<Config | null>(config);
  // Reference to original config for change detection
  const originalConfigRef = useRef<Config | null>(config);

  // Category error states
  const [categoryErrors, setCategoryErrors] = useState<Partial<Record<SettingsCategory, boolean>>>({});

  // Custom unsaved changes dialog state
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  // Reset confirmation dialog state
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Track if component is mounted
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Initialize local config from store
  useEffect(() => {
    if (config && !localConfig) {
      setLocalConfig(config);
      originalConfigRef.current = config;
    }
  }, [config, localConfig]);

  // Compute changed fields from original config
  const changedFields = useMemo(() => {
    if (!localConfig || !originalConfigRef.current) return new Set<string>();
    return getChangedFields(originalConfigRef.current, localConfig);
  }, [localConfig]);

  // Derive isDirty from changedFields
  const isDirty = changedFields.size > 0;

  // Handle config changes from category components
  const handleConfigChange = useCallback((updates: Partial<Config>) => {
    setLocalConfig((prev) => {
      if (!prev) return prev;
      return mergeConfig(prev, updates);
    });
  }, []);

  // Handle validation error reports from categories
  const handleValidationError = useCallback((category: SettingsCategory, hasError: boolean) => {
    setCategoryErrors((prev) => {
      if (prev[category] === hasError) return prev;
      return { ...prev, [category]: hasError };
    });
  }, []);

  // Check if any category has errors
  const hasAnyError = useMemo(() => {
    return Object.values(categoryErrors).some((hasError) => hasError);
  }, [categoryErrors]);

  // Handle category change from sidebar
  const handleCategoryChange = useCallback((category: SettingsCategory) => {
    setActiveCategory(category);
    // Also update focused index to match
    const index = CATEGORIES.findIndex((c) => c.id === category);
    if (index >= 0) {
      setFocusedIndex(index);
    }
  }, []);

  // Handle focus change from sidebar
  const handleFocusChange = useCallback((index: number) => {
    setFocusedIndex(index);
  }, []);

  // Save settings
  const handleSave = useCallback(async () => {
    if (!localConfig || !isDirty || hasAnyError) return;

    const result = await updateConfig(localConfig);
    if (result.success) {
      closeDialog();
    }
  }, [localConfig, isDirty, hasAnyError, updateConfig, closeDialog]);

  // Request close - show custom dialog if dirty
  const handleRequestClose = useCallback(() => {
    if (isDirty) {
      setShowUnsavedDialog(true);
    } else {
      closeDialog();
    }
  }, [isDirty, closeDialog]);

  // Handle custom unsaved dialog - Save
  const handleSaveAndClose = useCallback(async () => {
    if (!localConfig) return;

    const result = await updateConfig(localConfig);
    if (result.success) {
      setShowUnsavedDialog(false);
      closeDialog();
    }
  }, [localConfig, updateConfig, closeDialog]);

  // Handle custom unsaved dialog - Discard
  const handleDiscardAndClose = useCallback(() => {
    setShowUnsavedDialog(false);
    closeDialog();
  }, [closeDialog]);

  // Handle custom unsaved dialog - Cancel (stay in dialog)
  const handleCancelClose = useCallback(() => {
    setShowUnsavedDialog(false);
  }, []);

  // Reset to defaults for current category
  const handleResetToDefaults = useCallback(() => {
    setShowResetConfirm(true);
  }, []);

  // Confirm reset to defaults
  const handleConfirmReset = useCallback(() => {
    if (!localConfig) return;

    const defaults = getCategoryDefaults(activeCategory);
    setLocalConfig(mergeConfig(localConfig, defaults));
    setShowResetConfirm(false);
  }, [localConfig, activeCategory]);

  // Cancel reset
  const handleCancelReset = useCallback(() => {
    setShowResetConfirm(false);
  }, []);

  // Show loading state if config hasn't loaded yet
  if (!localConfig) {
    return (
      <DialogWrapper
        title="Settings"
        onClose={closeDialog}
        size="4xl"
        closeOnBackdropClick={false}
        data-testid="settings-dialog"
      >
        <div className="min-h-[500px] flex items-center justify-center">
          <p className="text-text-secondary">Loading configuration...</p>
        </div>
      </DialogWrapper>
    );
  }

  // Render the active category content
  const renderCategoryContent = () => {
    const commonProps = {
      config: localConfig,
      onChange: handleConfigChange,
      changedFields,
      onValidationError: handleValidationError,
      panelIdBase,
    };

    switch (activeCategory) {
      case 'general':
        return <GeneralSettings {...commonProps} />;
      case 'units':
        return <UnitsSettings {...commonProps} />;
      case 'display':
        return <DisplaySettings {...commonProps} />;
      case 'map':
        return <MapSettings {...commonProps} />;
      case 'validation':
        return <ValidationSettings {...commonProps} />;
      case 'export':
        return <ExportSettings {...commonProps} />;
      case 'shortcuts':
        return <ShortcutsSettings {...commonProps} />;
      case 'cache':
        return <CacheSettings {...commonProps} />;
      case 'advanced':
        return <AdvancedSettings {...commonProps} />;
      default:
        return null;
    }
  };

  return (
    <>
      <DialogWrapper
        title="Settings"
        onClose={handleRequestClose}
        isDirty={false} // We handle dirty state with custom dialog
        size="4xl"
        closeOnBackdropClick={false}
        maxHeight="max-h-[90vh]"
        data-testid="settings-dialog"
      >
        {({ requestClose }) => (
          <div className="flex flex-col min-h-[500px] -m-4">
            {/* Main content area with sidebar and content */}
            <div className="flex flex-1 overflow-hidden">
              {/* Sidebar */}
              <SettingsSidebar
                activeCategory={activeCategory}
                onCategoryChange={handleCategoryChange}
                focusedIndex={focusedIndex}
                onFocusChange={handleFocusChange}
                categoryErrors={categoryErrors}
                panelIdBase={panelIdBase}
              />

              {/* Content area */}
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Content header with Reset to Defaults */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-panel/50">
                  <span className="text-sm text-text-secondary">
                    {getCategoryLabel(activeCategory)} Settings
                  </span>
                  <Button
                    variant="secondary"
                    onClick={handleResetToDefaults}
                    data-testid="reset-category-defaults"
                  >
                    Reset to Defaults
                  </Button>
                </div>

                {/* Scrollable content */}
                <div
                  className="flex-1 overflow-auto p-4"
                  role="region"
                  aria-label={`${getCategoryLabel(activeCategory)} settings`}
                  id={getPanelId(panelIdBase, activeCategory)}
                  aria-labelledby={getTabId(panelIdBase, activeCategory)}
                >
                  {renderCategoryContent()}
                </div>
              </div>
            </div>

            {/* Footer with Save/Cancel */}
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-border bg-panel">
              <Button onClick={requestClose} data-testid="settings-cancel-button">
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={!isDirty || hasAnyError}
                data-testid="settings-save-button"
              >
                Save
              </Button>
            </div>
          </div>
        )}
      </DialogWrapper>

      {/* Custom unsaved changes dialog */}
      {showUnsavedDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={handleCancelClose} />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="unsaved-changes-title"
            className="relative bg-panel border border-border rounded-lg shadow-xl max-w-sm w-full mx-4"
            data-testid="unsaved-changes-dialog"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h2 id="unsaved-changes-title" className="text-lg font-medium">
                Unsaved Changes
              </h2>
            </div>
            <div className="p-4 space-y-4">
              <p>You have unsaved changes. What would you like to do?</p>
              <p className="text-sm text-text-secondary">
                Your changes will be lost if you discard them.
              </p>
              <div className="flex justify-end gap-2 pt-4 border-t border-border">
                <Button onClick={handleCancelClose} data-testid="unsaved-cancel">
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={handleDiscardAndClose}
                  data-testid="unsaved-discard"
                >
                  Discard Changes
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSaveAndClose}
                  disabled={hasAnyError}
                  data-testid="unsaved-save"
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reset to defaults confirmation dialog */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={handleCancelReset} />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reset-confirm-title"
            className="relative bg-panel border border-border rounded-lg shadow-xl max-w-sm w-full mx-4"
            data-testid="reset-confirm-dialog"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h2 id="reset-confirm-title" className="text-lg font-medium">
                Reset to Defaults
              </h2>
            </div>
            <div className="p-4 space-y-4">
              <p>
                Reset all {getCategoryLabel(activeCategory)} settings to their default values?
              </p>
              <p className="text-sm text-text-secondary">
                This will only affect the current category. Changes are not saved until you click
                Save.
              </p>
              <div className="flex justify-end gap-2 pt-4 border-t border-border">
                <Button onClick={handleCancelReset} data-testid="reset-cancel">
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={handleConfirmReset}
                  data-testid="reset-confirm"
                >
                  Reset
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
