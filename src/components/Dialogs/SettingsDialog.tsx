import { useState, useEffect, useCallback, useRef, useMemo, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper, type FixedSize } from './DialogWrapper';
import { AlertDialog } from './AlertDialog';
import {
  SettingsSidebar,
  CATEGORIES,
  type SettingsCategory,
} from './SettingsSidebar';
import { GeneralSettings } from './settings/GeneralSettings';
import { UnitsSettings } from './settings/UnitsSettings';
import { GasSettings } from './settings/GasSettings';
import { DisplaySettings } from './settings/DisplaySettings';
import { MapSettings } from './settings/MapSettings';
import { ValidationSettings } from './settings/ValidationSettings';
import { ExportSettings } from './settings/ExportSettings';
import { ShortcutsSettings } from './settings/ShortcutsSettings';
import { CacheSettings } from './settings/CacheSettings';
import { AdvancedSettings } from './settings/AdvancedSettings';
import { AppearanceSettings } from './settings/AppearanceSettings';
import { SpeleoDbSettings } from './settings/SpeleoDbSettings';
import type { Config } from '../../types/config';
import {
  defaultConfig,
  getThemedDisplayDefaults,
  getThemedSectionColorDefaults,
} from '../../types/config';
import type { ResolvedTheme } from '../../store/uiStore';
import { trackDialogComplete } from '../../utils/telemetry';
import { isValidationConfigValid } from '../../utils/validation';

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
function getCategoryDefaults(category: SettingsCategory, resolvedTheme: ResolvedTheme = 'dark'): Partial<Config> {
  switch (category) {
    case 'general':
      return { general: { ...defaultConfig.general } };
    case 'units':
      return { units: { ...defaultConfig.units } };
    case 'gas':
      return { gas: { ...defaultConfig.gas } };
    case 'display':
      return {
        display: getThemedDisplayDefaults(resolvedTheme),
        section_colors: getThemedSectionColorDefaults(resolvedTheme),
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
    case 'speleodb':
      // Only the staged connection fields reset here; the live account session
      // (login/logout) is not part of the config and is unaffected by a reset.
      return { speleodb: { ...defaultConfig.speleodb } };
    case 'appearance':
      // Highlighting controls live in the Appearance tab, so resetting Appearance
      // also resets syntactic highlighting.
      return {
        appearance: { ...defaultConfig.appearance },
        syntactic_highlighting: {
          ...defaultConfig.syntactic_highlighting,
          overrides: {},
        },
      };
    case 'advanced':
      return {
        debug: { map: { ...defaultConfig.debug.map }, memory_probe: defaultConfig.debug.memory_probe },
        logging: { ...defaultConfig.logging },
        closure_adjustment: { ...defaultConfig.closure_adjustment },
        panels: { ...defaultConfig.panels },
      };
    default:
      return {};
  }
}

/**
 * Get the label for a settings category.
 */
function getCategoryLabel(category: SettingsCategory, t: TFunction): string {
  const cat = CATEGORIES.find((c) => c.id === category);
  return cat ? t(cat.labelKey) : category;
}

/**
 * Centralized validation for all categories.
 * Returns a map of category -> hasError.
 * Defensive: guards against undefined nested props.
 */
function validateAllCategories(config: Config): Partial<Record<SettingsCategory, boolean>> {
  const errors: Partial<Record<SettingsCategory, boolean>> = {};

  try {
    // Map validation - with defensive access
    const map = config?.map;
    const mapHasError = !!(
      map &&
      (map.zoom_min >= map.zoom_max ||
        map.zoom_default < map.zoom_min ||
        map.zoom_default > map.zoom_max ||
        map.zoom_step < 0.1 ||
        map.zoom_step > 5.0 ||
        (map.satellite_gps_origin?.latitude != null &&
          (map.satellite_gps_origin.latitude < -90 || map.satellite_gps_origin.latitude > 90)) ||
        (map.satellite_gps_origin?.longitude != null &&
          (map.satellite_gps_origin.longitude < -180 || map.satellite_gps_origin.longitude > 180)) ||
        (map.station?.radius != null && (map.station.radius < 1 || map.station.radius > 50)) ||
        (map.station?.hit_area != null &&
          map.station?.radius != null &&
          map.station.hit_area < map.station.radius) ||
        (map.shot?.width != null && (map.shot.width < 0.5 || map.shot.width > 20)) ||
        (map.shot?.hit_area != null && map.shot?.width != null && map.shot.hit_area < map.shot.width) ||
        (map.snap?.threshold != null && (map.snap.threshold < 1 || map.snap.threshold > 50)) ||
        (map.animation?.duration != null && (map.animation.duration < 0 || map.animation.duration > 2000)))
    );
    errors.map = mapHasError;

    // Validation category (shared rules, see utils/validation).
    errors.validation = config?.validation ? !isValidationConfigValid(config.validation) : false;

    // Export category
    const exp = config?.export;
    const exportHasError = !!(exp && (exp.default_dpi < 72 || exp.default_dpi > 1200));
    errors.export = exportHasError;

    // Only set errors for categories we actually validate
    // Don't set false for categories without centralized validation
    // to avoid masking component-reported errors
  } catch {
    // If any error occurs, return empty to not mask component errors
    return {};
  }

  return errors;
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
    closure_adjustment: { ...base.closure_adjustment },
    export: { ...base.export },
    logging: { ...base.logging },
    shortcuts: { ...base.shortcuts },
    panels: { ...base.panels },
    cache: { ...base.cache },
    debug: { map: { ...base.debug.map }, memory_probe: base.debug.memory_probe },
    global_view: { ...base.global_view },
    appearance: { ...base.appearance },
    import: { ...base.import },
    placement_suggestion: { ...(base.placement_suggestion ?? defaultConfig.placement_suggestion) },
    syntactic_highlighting: {
      ...(base.syntactic_highlighting ?? defaultConfig.syntactic_highlighting),
      overrides: { ...(base.syntactic_highlighting ?? defaultConfig.syntactic_highlighting).overrides },
    },
    gas: { ...(base.gas ?? defaultConfig.gas) },
    speleodb: { ...(base.speleodb ?? defaultConfig.speleodb) },
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
  if (updates.closure_adjustment) {
    result.closure_adjustment = { ...result.closure_adjustment, ...updates.closure_adjustment };
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
  if (updates.global_view) {
    result.global_view = { ...result.global_view, ...updates.global_view };
  }
  if (updates.appearance) {
    result.appearance = { ...result.appearance, ...updates.appearance };
  }
  if (updates.placement_suggestion) {
    result.placement_suggestion = { ...result.placement_suggestion, ...updates.placement_suggestion };
  }
  if (updates.syntactic_highlighting) {
    result.syntactic_highlighting = { ...result.syntactic_highlighting, ...updates.syntactic_highlighting };
  }
  if (updates.gas) {
    result.gas = { ...result.gas, ...updates.gas };
  }
  if (updates.speleodb) {
    result.speleodb = { ...result.speleodb, ...updates.speleodb };
  }

  return result;
}

export default function SettingsDialog() {
  const { t } = useTranslation();
  const { closeDialog } = useUIStore();
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);
  const setThemePreview = useUIStore((s) => s.setThemePreview);
  const setSyntacticHighlightPreview = useUIStore((s) => s.setSyntacticHighlightPreview);
  const { config, updateConfig } = useProjectStore();

  // Panel ID base for ARIA associations
  const panelIdBase = useId();

  // Active (selected) category — initialCategory from dialogData (e.g. from "Customize shortcuts" link)
  const dialogData = useUIStore((s) => s.dialogData);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(
    (dialogData?.initialCategory as SettingsCategory) || 'general'
  );
  // Focused category index for roving tabindex
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Local config copy for editing
  const [localConfig, setLocalConfig] = useState<Config | null>(config);
  // Reference to original config for change detection
  const originalConfigRef = useRef<Config | null>(config);

  // Category error states
  const [categoryErrors, setCategoryErrors] = useState<Partial<Record<SettingsCategory, boolean>>>({});

  // Fixed size for settings dialog — constant from first render through all category switches
  const settingsFixedSize: FixedSize = useMemo(() => ({
    width: 'min(800px, 95vw)',
    height: 'clamp(500px, 80vh, 800px)',
  }), []);

  // Ref for scrollable content area — used to reset scroll on category change
  const contentRef = useRef<HTMLDivElement>(null);

  // Custom unsaved changes dialog state
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  // Reset confirmation dialog state
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  // About dialog state
  const [showAbout, setShowAbout] = useState(false);

  // Initialize local config from store
  useEffect(() => {
    if (config && !localConfig) {
      setLocalConfig(config);
      originalConfigRef.current = config;
    }
  }, [config, localConfig]);

  // Live-preview theme changes: apply immediately on selection, revert on unmount/cancel
  useEffect(() => {
    if (localConfig) {
      setThemePreview(localConfig.appearance);
    }
    return () => setThemePreview(null);
  }, [localConfig?.appearance.theme, localConfig?.appearance.day_color_theme, localConfig?.appearance.night_color_theme, setThemePreview]);

  // Live-preview syntactic-highlighting changes (level / preset / per-color overrides)
  useEffect(() => {
    if (localConfig) {
      setSyntacticHighlightPreview(localConfig.syntactic_highlighting);
    }
    return () => setSyntacticHighlightPreview(null);
  }, [
    localConfig?.syntactic_highlighting.level,
    localConfig?.syntactic_highlighting.preset,
    localConfig?.syntactic_highlighting.overrides,
    setSyntacticHighlightPreview,
  ]);

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

  // Centralized validation for all categories - used for sidebar error dots
  const centralizedErrors = useMemo(() => {
    if (!localConfig) return {} as Partial<Record<SettingsCategory, boolean>>;
    return validateAllCategories(localConfig);
  }, [localConfig]);

  // Combined errors for sidebar display (centralized validation takes precedence)
  const combinedCategoryErrors = useMemo(() => {
    return { ...categoryErrors, ...centralizedErrors };
  }, [categoryErrors, centralizedErrors]);

  // Check if any category has errors
  const hasAnyError = useMemo(() => {
    return Object.values(combinedCategoryErrors).some((hasError) => hasError);
  }, [combinedCategoryErrors]);

  // Handle category change from sidebar
  const handleCategoryChange = useCallback((category: SettingsCategory) => {
    setActiveCategory(category);
    // Also update focused index to match
    const index = CATEGORIES.findIndex((c) => c.id === category);
    if (index >= 0) {
      setFocusedIndex(index);
    }
    // Reset scroll position to top on category switch
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
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
      trackDialogComplete('settings');
      closeDialog();
    }
  }, [localConfig, isDirty, hasAnyError, updateConfig, closeDialog]);

  // Request close - show custom dialog if dirty
  // Short-circuit if an overlay is already open to prevent Escape conflicts
  const handleRequestClose = useCallback(() => {
    // If an overlay is open, close it instead of the main dialog
    if (showAbout) {
      setShowAbout(false);
      return;
    }
    if (showResetConfirm) {
      setShowResetConfirm(false);
      return;
    }
    if (showUnsavedDialog) {
      setShowUnsavedDialog(false);
      return;
    }
    // Normal close logic
    if (isDirty) {
      setShowUnsavedDialog(true);
    } else {
      trackDialogComplete('settings');
      closeDialog();
    }
  }, [isDirty, closeDialog, showAbout, showResetConfirm, showUnsavedDialog]);

  // Handle custom unsaved dialog - Save
  const handleSaveAndClose = useCallback(async () => {
    if (!localConfig) return;

    const result = await updateConfig(localConfig);
    if (result.success) {
      setShowUnsavedDialog(false);
      trackDialogComplete('settings');
      closeDialog();
    }
  }, [localConfig, updateConfig, closeDialog]);

  // Handle custom unsaved dialog - Discard
  const handleDiscardAndClose = useCallback(() => {
    setShowUnsavedDialog(false);
    trackDialogComplete('settings');
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

    const defaults = getCategoryDefaults(activeCategory, resolvedTheme);
    setLocalConfig(mergeConfig(localConfig, defaults));
    setShowResetConfirm(false);
  }, [localConfig, activeCategory, resolvedTheme]);

  // Cancel reset
  const handleCancelReset = useCallback(() => {
    setShowResetConfirm(false);
  }, []);

  // Show loading state if config hasn't loaded yet
  if (!localConfig) {
    return (
      <DialogWrapper
        title={t('dialogs.settings.title')}
        onClose={closeDialog}
        size="4xl"
        closeOnBackdropClick={false}
        fixedSize={settingsFixedSize}
        overflow="hidden"
        bodyClassName="flex-1 flex items-center justify-center p-4"
        data-testid="settings-dialog"
      >
        <p className="text-text-secondary">{t('settings.loading')}</p>
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
      case 'gas':
        return <GasSettings {...commonProps} />;
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
      case 'speleodb':
        return <SpeleoDbSettings {...commonProps} />;
      case 'appearance':
        return <AppearanceSettings {...commonProps} />;
      case 'advanced':
        return <AdvancedSettings {...commonProps} />;
      default:
        return null;
    }
  };

  return (
    <>
      <DialogWrapper
        title={t('dialogs.settings.title')}
        onClose={handleRequestClose}
        isDirty={false} // We handle dirty state with custom dialog
        size="4xl"
        closeOnBackdropClick={false}
        maxHeight="max-h-[90vh]"
        overflow="hidden"
        fixedSize={settingsFixedSize}
        bodyClassName="flex-1 flex flex-col overflow-hidden"
        data-testid="settings-dialog"
      >
        {({ requestClose }) => (
          <div className="flex flex-col min-w-[min(500px,100%)] flex-1 min-h-0">
            {/* Main content area with sidebar and content */}
            <div className="flex flex-1 overflow-hidden">
              {/* Sidebar */}
              <SettingsSidebar
                activeCategory={activeCategory}
                onCategoryChange={handleCategoryChange}
                focusedIndex={focusedIndex}
                onFocusChange={handleFocusChange}
                categoryErrors={combinedCategoryErrors}
                panelIdBase={panelIdBase}
              />

              {/* Content area */}
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Content header with Reset to Defaults */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-panel-50">
                  <span className="text-sm text-text-secondary">
                    {t('settings.categoryHeader', { category: getCategoryLabel(activeCategory, t) })}
                  </span>
                  <Button
                    variant="secondary"
                    onClick={handleResetToDefaults}
                    data-testid="reset-category-defaults"
                  >
                    {t('settings.resetToDefaults')}
                  </Button>
                </div>

                {/* Scrollable content - tabpanel semantics owned by category components */}
                <div ref={contentRef} className="flex-1 overflow-auto min-h-0 p-4">
                  {renderCategoryContent()}
                </div>
              </div>
            </div>

            {/* Footer with About on left, Save/Cancel on right */}
            <div className="flex justify-between gap-2 px-4 py-3 border-t border-border bg-panel">
              <Button
                variant="secondary"
                onClick={() => setShowAbout(true)}
                data-testid="settings-about-button"
              >
                {t('dialogs.about.title')}
              </Button>
              <div className="flex gap-2">
                <Button onClick={requestClose} data-testid="settings-cancel-button">
                  {t('common.actions.cancel')}
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSave}
                  disabled={!isDirty || hasAnyError}
                  data-testid="settings-save-button"
                >
                  {t('common.actions.save')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogWrapper>

      <AlertDialog
        open={showUnsavedDialog}
        title={t('dialogs.unsaved.title')}
        onClose={handleCancelClose}
        data-testid="unsaved-changes-dialog"
        actions={
          <>
            <Button onClick={handleCancelClose} data-testid="unsaved-cancel">
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={handleDiscardAndClose}
              data-testid="unsaved-discard"
            >
              {t('dialogs.unsaved.discard')}
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveAndClose}
              disabled={hasAnyError}
              data-testid="unsaved-save"
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <>
          <p>{t('dialogs.unsaved.message')}</p>
          <p className="text-sm text-text-secondary">
            {t('dialogs.unsaved.note')}
          </p>
        </>
      </AlertDialog>

      <AlertDialog
        open={showResetConfirm}
        title={t('dialogs.resetDefaults.title')}
        onClose={handleCancelReset}
        data-testid="reset-confirm-dialog"
        actions={
          <>
            <Button onClick={handleCancelReset} data-testid="reset-cancel">
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={handleConfirmReset}
              data-testid="reset-confirm"
            >
              {t('common.actions.reset')}
            </Button>
          </>
        }
      >
        <>
          <p>
            {t('dialogs.resetDefaults.message', { category: getCategoryLabel(activeCategory, t) })}
          </p>
          <p className="text-sm text-text-secondary">
            {t('dialogs.resetDefaults.note', { action: t('common.actions.save') })}
          </p>
        </>
      </AlertDialog>

      <AlertDialog
        open={showAbout}
        title={t('dialogs.about.title')}
        onClose={() => setShowAbout(false)}
        data-testid="about-dialog"
        actions={
          <Button onClick={() => setShowAbout(false)} data-testid="about-close">
            {t('dialogs.about.close')}
          </Button>
        }
      >
        <div className="space-y-2">
          <p className="font-medium">{t('dialogs.about.version', { version: __APP_VERSION__ })}</p>
          <p className="text-sm text-text-secondary">{t('dialogs.about.description')}</p>
          <p>
            <a
              href="https://stalagmight.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-accent hover:underline"
              onClick={(e) => {
                e.preventDefault();
                window.open('https://stalagmight.com', '_blank');
              }}
            >
              {t('dialogs.about.website')}
            </a>
          </p>
        </div>
      </AlertDialog>
    </>
  );
}
