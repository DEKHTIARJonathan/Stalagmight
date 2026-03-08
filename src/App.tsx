import { useEffect, useCallback, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
import { useProjectStore } from './store/projectStore';
import { useUIStore } from './store/uiStore';
import { invokeIpc, getErrorMessage } from './utils/ipc';
import { extractFilename } from './utils/path';
import { useBeforeUnload, useLoadingProgress, useTheme, useNetworkStatus } from './hooks';
import { useOnboarding } from './hooks/useOnboarding';
import i18n from './i18n';
import { setNumberFormatLocale, setDateFormatLocale } from './i18n/format';
import GlobalView from './components/GlobalView/GlobalView';
import SingleSystemView from './components/SingleSystemView/SingleSystemView';
import SplashScreen from './components/SplashScreen/SplashScreen';
import OnboardingOverlay from './components/Onboarding/OnboardingOverlay';
import { ImportDialog, ExportDialog, NewProjectDialog, NewProjectForImportDialog, DmpSelectionDialog, DmpNewImportDialog, ZeroDatumSelectionDialog, ZeroDatumConfigDialog, TmlImportDialog, GpxSelectionDialog, GpxPlacementDialog, ConfirmDialog, DeleteShotChoiceDialog, MergeDialog, ClosureDialog, AdjustClosuresDialog, MergeProjectsDialog, DrawShotDialog, EditSectionDialog, EditShotDialog, EditStationDialog, UnmergeStationsDialog, RemoveClosureDialog, UnsavedChangesDialog, ErrorDialog, OverwriteConfirmDialog, SectionAdjustDialog, SettingsDialog, SplitSectionDialog, CorruptionRecoveryDialog, DebugDialog, SwapCommentsDialog, OrphanPlacementDialog, KeyboardShortcutsDialog, TelemetryOptInDialog } from './components/Dialogs';
import { initTelemetry, flushTelemetry } from './utils/telemetry';
import { ContextMenu } from './components/common';
import type { DmpSelectionConfig } from './components/Dialogs/DmpSelectionDialog';
import type { ZeroDatumConfigResult } from './components/Dialogs/ZeroDatumConfigDialog';
import type { OrphanPlacementSuggestion } from './types/commands';

function App() {
  const { project, stations, recentProjects, loading, loadConfig, config, isDirty, importDmp, parseTml, parseGpx, setConfig } = useProjectStore();
  const {
    view,
    setView,
    activeDialog,
    dialogData,
    dmpImportWizardPhase,
    placementMode,
    closeDialog,
    openDialog,
    initPanelSizes,
    setImportContext,
    triggerFitToBounds,
    toast,
    selectionAnnouncement,
  } = useUIStore();

  // Apply theme from config (resolves auto mode, sets data-theme attribute)
  useTheme();

  // Listen for loading progress events from backend
  useLoadingProgress();

  // Event-driven network status orchestrator (tile transport events + offline polling)
  useNetworkStatus();

  // Splash screen state - visible until config loads, then fades out and unmounts
  const [showSplash, setShowSplash] = useState(true);
  const [splashMounted, setSplashMounted] = useState(true);

  // Track whether we're hovering with a valid import file (DMP/TML/TMLU)
  const [isDraggingImport, setIsDraggingImport] = useState(false);

  // Determine if import dialog is open and has placed sections
  // This is used to show a confirmation when closing the app
  const isImportInProgress = useMemo(() => {
    // Also block during DMP selection if we have a parsed file
    if (activeDialog === 'dmp-selection' && dialogData.dmpFile) {
      return true;
    }
    // Block during GPX selection/placement dialog
    if ((activeDialog === 'gpx-selection' || activeDialog === 'gpx-placement') && dialogData.gpxFile) {
      return true;
    }
    // Block during new project for import dialog
    if (activeDialog === 'new-project-for-import' && (dialogData.dmpFile || dialogData.tmlFile || dialogData.gpxFile)) {
      return true;
    }
    return false;
  }, [activeDialog, dialogData]);

  // Show confirmation dialog when closing the app during import
  useBeforeUnload(
    isImportInProgress,
    'Import is in progress. Discard all import data and close?'
  );

  useEffect(() => {
    // Load config on startup
    loadConfig();
    // Initialize telemetry (detects feature availability)
    void initTelemetry();

    // Flush telemetry on page unload (best-effort)
    const handleUnload = () => { void flushTelemetry(); };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [loadConfig]);

  // Hide splash once config has loaded (or immediately if splash is disabled)
  useEffect(() => {
    if (config != null) {
      if (!config.general.splash_screen) {
        // Splash disabled: skip animation, unmount immediately
        setShowSplash(false);
        setSplashMounted(false);
      } else {
        setShowSplash(false);
      }
    }
  }, [config]);

  // Sync i18n language with config locale setting
  useEffect(() => {
    const locale = config?.general?.locale;
    if (!locale) return;
    if (locale === 'system') {
      void i18n.changeLanguage();
      return;
    }
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale);
    }
  }, [config?.general?.locale]);

  // Sync number format locale with config
  useEffect(() => {
    setNumberFormatLocale(config?.general?.number_format ?? 'locale');
  }, [config?.general?.number_format]);

  // Sync date format locale with config
  useEffect(() => {
    setDateFormatLocale(config?.general?.date_format ?? 'locale');
  }, [config?.general?.date_format]);

  // Initialize panel sizes from config
  useEffect(() => {
    if (config?.panels) {
      initPanelSizes(config.panels);
    }
  }, [config, initPanelSizes]);

  // Update window title based on project state
  useEffect(() => {
    const updateTitle = async () => {
      let title = 'Stalagmight';
      if (project) {
        if (project.file_path) {
          // Extract filename from path
          const filename = extractFilename(project.file_path);
          title = `Stalagmight - ${filename}`;
        } else {
          title = `Stalagmight - ${project.name} (unsaved)`;
        }
        if (isDirty) {
          title = `${title} *`;
        }
      }
      try {
        await getCurrentWindow().setTitle(title);
      } catch (e) {
        // Fallback for dev mode or if Tauri API unavailable
        document.title = title;
      }
    };
    updateTitle();
  }, [project, project?.file_path, project?.name, isDirty]);

  /**
   * Handle file drop events for DMP/TML/TMLU file import.
   * - From home screen (no project): Creates new project, then opens import dialog
   * - From existing project: Opens import dialog directly
   */
  const handleImportFileDrop = useCallback(async (filePath: string) => {
    const lowerPath = filePath.toLowerCase();
    const isTml = lowerPath.endsWith('.tml') || lowerPath.endsWith('.tmlu');
    const isGpx = lowerPath.endsWith('.gpx');
    const currentProject = useProjectStore.getState().project;

    if (isGpx) {
      try {
        const gpxFile = await parseGpx(filePath);
        if (!gpxFile) return;

        if (currentProject) {
          openDialog('gpx-selection', { gpxFile, filePath });
        } else {
          const fileName = extractFilename(filePath, /\.gpx$/i) || 'Imported';
          openDialog('new-project-for-import', {
            gpxFile,
            filePath,
            defaultName: fileName,
            importType: 'gpx',
          });
        }
      } catch (e) {
        openDialog('error', {
          title: 'Import Failed',
          message: getErrorMessage(e, 'Failed to parse GPX file'),
        });
      }
    } else if (isTml) {
      try {
        const tmlFile = await parseTml(filePath);
        if (!tmlFile) return;

        if (currentProject) {
          openDialog('tml-import', { tmlFile, filePath });
        } else {
          const fileName = extractFilename(filePath, /\.tmlu?$/i) || 'Imported';
          openDialog('new-project-for-import', {
            tmlFile,
            filePath,
            defaultName: fileName,
            importType: 'tml',
          });
        }
      } catch (e) {
        openDialog('error', {
          title: 'Import Failed',
          message: getErrorMessage(e, 'Failed to parse TML file'),
        });
      }
    } else {
      // DMP file
      if (currentProject) {
        setImportContext('existing-project');

        try {
          const dmpFile = await importDmp(filePath);
          if (dmpFile) {
            openDialog('dmp-selection', { dmpFile, filePath });
          }
        } catch (e) {
          openDialog('error', {
            title: 'Import Failed',
            message: getErrorMessage(e, 'Failed to parse DMP file'),
          });
        }
      } else {
        setImportContext('new-project');

        try {
          const dmpFile = await importDmp(filePath);
          if (dmpFile) {
            const fileName = extractFilename(filePath, /\.dmp$/i) || 'Imported';
            openDialog('new-project-for-import', {
              dmpFile,
              filePath,
              defaultName: fileName,
            });
          }
        } catch (e) {
          openDialog('error', {
            title: 'Import Failed',
            message: getErrorMessage(e, 'Failed to parse DMP file'),
          });
        }
      }
    }
  }, [importDmp, parseTml, parseGpx, openDialog, setImportContext]);

  // Set up drag-drop event listener for importable files (DMP/TML/TMLU)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const importExts = ['.dmp', '.tml', '.tmlu', '.gpx'];

    const setupDragDrop = async () => {
      try {
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent((event) => {
          const payload = event.payload as DragDropEvent;

          if (payload.type === 'enter') {
            const hasImportFile = payload.paths?.some((path: string) =>
              importExts.some((ext) => path.toLowerCase().endsWith(ext))
            );
            setIsDraggingImport(hasImportFile ?? false);
          } else if (payload.type === 'drop') {
            setIsDraggingImport(false);
            const importPath = payload.paths?.find((path: string) =>
              importExts.some((ext) => path.toLowerCase().endsWith(ext))
            );
            if (importPath) {
              handleImportFileDrop(importPath);
            }
          } else if (payload.type === 'leave') {
            setIsDraggingImport(false);
          }
        });
      } catch (e) {
        console.warn('Drag-drop not available:', e);
      }
    };

    setupDragDrop();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleImportFileDrop]);

  const persistCompletedOnboardingFlows = useCallback((flowIds: string[]) => {
    const normalized = Array.from(
      new Set(flowIds.map((flowId) => flowId.trim()).filter((flowId) => flowId.length > 0))
    );
    const currentConfig = useProjectStore.getState().config;
    if (!currentConfig) {
      return;
    }

    const currentCompleted = currentConfig.general.onboarding_completed_flows ?? [];
    const unchanged =
      normalized.length === currentCompleted.length &&
      normalized.every((flowId, idx) => flowId === currentCompleted[idx]);
    if (unchanged) {
      return;
    }

    void useProjectStore.getState().updateConfig({
      ...currentConfig,
      general: {
        ...currentConfig.general,
        onboarding_completed_flows: normalized,
      },
    });
  }, []);

  const onboarding = useOnboarding({
    view,
    hasProject: project !== null,
    hasRecentProjects: recentProjects.length > 0,
    configRecentProjectsCount: config?.general?.recent_projects.length ?? null,
    activeDialog,
    dmpImportWizardPhase,
    placementModeActive: placementMode !== null,
    isDmpImportContext: Boolean(dialogData.dmpFile),
    loadingProject: loading.isLoading,
    splashVisible: splashMounted,
    configLoaded: config !== null,
  }, {
    enabled: config?.general?.onboarding_enabled ?? true,
    completedFlowIds: config?.general?.onboarding_completed_flows ?? [],
    onCompletedFlowIdsChange: persistCompletedOnboardingFlows,
  });

  const disableOnboardingGuides = useCallback(() => {
    const store = useProjectStore.getState();
    const currentConfig = store.config;
    if (!currentConfig) {
      return;
    }
    if (!currentConfig.general.onboarding_enabled) {
      return;
    }
    const nextConfig = {
      ...currentConfig,
      general: {
        ...currentConfig.general,
        onboarding_enabled: false,
      },
    };
    store.setConfig(nextConfig);
    void store.updateConfig(nextConfig);
  }, []);

  return (
    <div className="h-full bg-background text-text-primary flex flex-col relative">
      {/* Splash screen overlay */}
      {splashMounted && (
        <SplashScreen
          visible={showSplash}
          onTransitionEnd={() => setSplashMounted(false)}
        />
      )}

      {/* Drop indicator overlay */}
      {isDraggingImport && (
        <div
          className="absolute inset-0 z-50 bg-accent-20 border-4 border-dashed border-accent flex items-center justify-center pointer-events-none"
          data-testid="import-drop-indicator"
        >
          <div className="bg-panel p-6 rounded-lg shadow-xl text-center">
            <div className="text-4xl mb-2">📥</div>
            <div className="text-lg font-semibold">Drop file to import</div>
            <div className="text-sm text-text-secondary mt-1">
              {project ? 'Add sections to current project' : 'Create new project'}
            </div>
          </div>
        </div>
      )}

      {view === 'global' || !project ? (
        <GlobalView />
      ) : (
        <SingleSystemView />
      )}

      {/* Dialogs */}
      {activeDialog === 'import' && <ImportDialog />}
      {activeDialog === 'export' && <ExportDialog />}
      {activeDialog === 'new-project' && <NewProjectDialog />}
      {activeDialog === 'new-project-for-import' && <NewProjectForImportDialog />}
      {activeDialog === 'dmp-selection' && dialogData.dmpFile ? (
        <DmpSelectionDialog
          dmpFile={dialogData.dmpFile as import('./types/commands').DmpFile}
          filePath={dialogData.filePath as string}
          onCancel={closeDialog}
          onContinue={(selectionCfg) => {
            // Continue to the new workflow
            const hasZeroDatums = (project?.zero_datums?.length ?? 0) > 0;
            openDialog(hasZeroDatums ? 'dmp-import-new' : 'zero-datum-selection', {
              dmpFile: dialogData.dmpFile,
              filePath: dialogData.filePath,
              selectionConfig: selectionCfg,
            });
          }}
        />
      ) : null}
      {activeDialog === 'dmp-import-new' && dialogData.dmpFile && dialogData.selectionConfig ? (
        <DmpNewImportDialog
          dmpFile={dialogData.dmpFile as import('./types/commands').DmpFile}
          selectionConfig={dialogData.selectionConfig as DmpSelectionConfig}
          project={project}
          stations={stations}
          zeroDatumConfig={dialogData.zeroDatumConfig as ZeroDatumConfigResult | undefined}
          savedManualPlacingState={dialogData.savedManualPlacingState as import('./components/Dialogs/DmpNewImportDialog').SavedManualPlacingState | undefined}
          autoStartManualPlacement={Boolean(dialogData.autoStartManualPlacement)}
          onCancel={closeDialog}
          onBack={() => {
            if (dialogData.zeroDatumConfig) {
              // Came through zero datum flow — go back to zero datum config
              openDialog('zero-datum-config', {
                dmpFile: dialogData.dmpFile,
                filePath: dialogData.filePath,
                selectionConfig: dialogData.selectionConfig,
                zeroDatumSectionIndex: (dialogData.zeroDatumConfig as ZeroDatumConfigResult).sectionIndex,
              });
            } else {
              openDialog('dmp-selection', {
                dmpFile: dialogData.dmpFile,
                filePath: dialogData.filePath,
              });
            }
          }}
          onComplete={async (newSectionIds?: number[]) => {
            if (newSectionIds?.length) {
              try {
                const suggestions = await invokeIpc<OrphanPlacementSuggestion[]>(
                  'suggest_orphan_placements',
                  { newlyImportedSectionIds: newSectionIds },
                  { purpose: 'suggest orphan placements after DMP import' }
                );
                if (suggestions.length > 0) {
                  openDialog('orphan-placement', { suggestions });
                  return;
                }
              } catch {
                // Non-fatal: proceed without orphan detection
              }
            }
            closeDialog();
            setView('single');
            triggerFitToBounds();
          }}
        />
      ) : null}
      {activeDialog === 'zero-datum-selection' && dialogData.dmpFile && dialogData.selectionConfig ? (
        <ZeroDatumSelectionDialog
          dmpFile={dialogData.dmpFile as import('./types/commands').DmpFile}
          selectionConfig={dialogData.selectionConfig as DmpSelectionConfig}
          filePath={dialogData.filePath as string}
          onCancel={closeDialog}
          onBack={() => {
            openDialog('dmp-selection', {
              dmpFile: dialogData.dmpFile,
              filePath: dialogData.filePath,
            });
          }}
          onSkip={() => {
            openDialog('dmp-import-new', {
              dmpFile: dialogData.dmpFile,
              filePath: dialogData.filePath,
              selectionConfig: dialogData.selectionConfig,
            });
          }}
          onSelectSection={(sectionIndex) => {
            openDialog('zero-datum-config', {
              dmpFile: dialogData.dmpFile,
              filePath: dialogData.filePath,
              selectionConfig: dialogData.selectionConfig,
              zeroDatumSectionIndex: sectionIndex,
            });
          }}
        />
      ) : null}
      {activeDialog === 'zero-datum-config' && dialogData.dmpFile && dialogData.selectionConfig ? (
        <ZeroDatumConfigDialog
          dmpFile={dialogData.dmpFile as import('./types/commands').DmpFile}
          selectionConfig={dialogData.selectionConfig as DmpSelectionConfig}
          sectionIndex={dialogData.zeroDatumSectionIndex as number}
          filePath={dialogData.filePath as string}
          onCancel={closeDialog}
          onBack={() => {
            openDialog('zero-datum-selection', {
              dmpFile: dialogData.dmpFile,
              filePath: dialogData.filePath,
              selectionConfig: dialogData.selectionConfig,
            });
          }}
          onConfirm={(result) => {
            openDialog('dmp-import-new', {
              dmpFile: dialogData.dmpFile,
              filePath: dialogData.filePath,
              selectionConfig: dialogData.selectionConfig,
              zeroDatumConfig: result,
            });
          }}
        />
      ) : null}
      {activeDialog === 'tml-import' && dialogData.tmlFile ? (
        <TmlImportDialog
          tmlFile={dialogData.tmlFile as import('./types/commands').TmlFile}
          filePath={dialogData.filePath as string}
        />
      ) : null}
      {activeDialog === 'gpx-selection' && dialogData.gpxFile ? (
        <GpxSelectionDialog
          gpxFile={dialogData.gpxFile as import('./types/commands').GpxFile}
          filePath={dialogData.filePath as string}
        />
      ) : null}
      {activeDialog === 'gpx-placement' && dialogData.gpxFile ? (
        <GpxPlacementDialog />
      ) : null}
      {activeDialog === 'confirm-delete' && <ConfirmDialog />}
      {activeDialog === 'delete-shot-choice' && <DeleteShotChoiceDialog />}
      {activeDialog === 'merge' && <MergeDialog />}
      {activeDialog === 'closure' && <ClosureDialog />}
      {activeDialog === 'adjust-closures' && <AdjustClosuresDialog />}
      {activeDialog === 'merge-projects' && <MergeProjectsDialog />}
      {activeDialog === 'draw-shot' && <DrawShotDialog />}
      {activeDialog === 'edit-section' && <EditSectionDialog />}
      {activeDialog === 'edit-shot' && <EditShotDialog />}
      {activeDialog === 'edit-station' && <EditStationDialog />}
      {activeDialog === 'unmerge-stations' && <UnmergeStationsDialog />}
      {activeDialog === 'remove-closure' && <RemoveClosureDialog />}
      {activeDialog === 'unsaved-changes' && <UnsavedChangesDialog />}
      {activeDialog === 'error' && <ErrorDialog />}
      {activeDialog === 'confirm-overwrite' && <OverwriteConfirmDialog />}
      {activeDialog === 'context-menu' && <ContextMenu />}
      {activeDialog === 'section-adjust' && <SectionAdjustDialog />}
      {activeDialog === 'settings' && <SettingsDialog />}
      {activeDialog === 'split-section' && <SplitSectionDialog />}
      {activeDialog === 'corruption-recovery' && <CorruptionRecoveryDialog />}
      {activeDialog === 'debug' && <DebugDialog />}
      {activeDialog === 'swap-comments' && <SwapCommentsDialog />}
      {activeDialog === 'orphan-placement' && (
        <OrphanPlacementDialog
          suggestions={(dialogData.suggestions ?? []) as OrphanPlacementSuggestion[]}
        />
      )}
      {activeDialog === 'keyboard-shortcuts' && <KeyboardShortcutsDialog />}

      {onboarding.activeStep && (
        <OnboardingOverlay
          step={onboarding.activeStep}
          stepIndex={onboarding.stepIndex}
          stepCount={onboarding.stepCount}
          canGoBack={onboarding.canGoBack}
          onBack={onboarding.back}
          onNext={onboarding.next}
          onSkipCurrent={onboarding.skip}
          onSkipAll={disableOnboardingGuides}
        />
      )}

      {/* Telemetry opt-in (shown once on first launch when feature is available) */}
      {config && (
        <TelemetryOptInDialog config={config} onConfigChanged={setConfig} />
      )}

      {/* Toast notification (via Portal for z-index reliability) */}
      {toast && createPortal(
        <div className="fixed inset-0 pointer-events-none z-[99999]">
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
            <div
              className="bg-panel text-text-primary px-4 py-2 rounded-lg shadow-lg"
              role="status"
              aria-live="polite"
            >
              {toast.message}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ARIA live region for selection announcements (mounted permanently) */}
      <div
        id="selection-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {selectionAnnouncement}
      </div>
    </div>
  );
}

export default App;
