import { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
import { useProjectStore } from './store/projectStore';
import { useUIStore } from './store/uiStore';
import { useSpeleoStore } from './store/speleoStore';
import { useGasPlanStore, selectIsPlanDirty } from './store/gasPlanStore';
import { invokeIpc } from './utils/ipc';
import { extractFilename } from './utils/path';
import { routeOpenedFile } from './utils/openOrImport';
import { IMPORTABLE_EXTENSIONS } from './utils/fileDialogs';
import { useBeforeUnload, useLoadingProgress, useTheme, useSyntacticHighlighting, useNetworkStatus, useUiScale } from './hooks';
import { useOnboarding } from './hooks/useOnboarding';
import i18n from './i18n';
import { setNumberFormatLocale, setDateFormatLocale } from './i18n/format';
import GlobalView from './components/GlobalView/GlobalView';
import SingleSystemView from './components/SingleSystemView/SingleSystemView';
import SplashScreen from './components/SplashScreen/SplashScreen';
import OnboardingOverlay from './components/Onboarding/OnboardingOverlay';
import { ImportDialog, ExportDialog, NewProjectDialog, NewProjectForImportDialog, DmpSelectionDialog, DmpNewImportDialog, ZeroDatumSelectionDialog, ZeroDatumConfigDialog, TmlImportDialog, CompassImportDialog, WallsImportDialog, GpxSelectionDialog, GpxPlacementDialog, ConfirmDialog, DeleteShotChoiceDialog, BulkDeleteDialog, MergeDialog, ClosureDialog, MergeProjectsDialog, DrawShotDialog, EditSectionDialog, EditShotDialog, EditStationDialog, UnmergeStationsDialog, RemoveClosureDialog, UnsavedChangesDialog, ErrorDialog, SavePermissionDialog, OverwriteConfirmDialog, DeleteProjectDialog, SectionAdjustDialog, SettingsDialog, ProjectSettingsDialog, SplitSectionDialog, CorruptionRecoveryDialog, DebugDialog, SwapCommentsDialog, OrphanPlacementDialog, KeyboardShortcutsDialog, TelemetryOptInDialog, CollabReviewDialog, OpenFromSpeleoDbDialog, PublishToSpeleoDbDialog, SpeleoDoneDialog, SpeleoDivergenceDialog, SpeleoForceEditDialog, SpeleoRestoreDialog, SpeleoCloseDialog, SpeleoNoPermissionDialog, HeldLockResumeDialog } from './components/Dialogs';
import { initTelemetry, flushTelemetry, setProjectActionSource } from './utils/telemetry';
import { ContextMenu } from './components/common';
import { MemoryProbe } from './components/MemoryProbe/MemoryProbe';
import type { DmpSelectionConfig } from './components/Dialogs/DmpSelectionDialog';
import type { ZeroDatumConfigResult } from './components/Dialogs/ZeroDatumConfigDialog';
import type { OrphanPlacementSuggestion } from './types/commands';

function App() {
  const { project, stations, recentProjects, loading, loadConfig, config, isDirty, setConfig } = useProjectStore();
  const integrityIssues = useProjectStore((s) => s.integrityIssues);
  const integrityDismissed = useProjectStore((s) => s.integrityDismissed);
  const integritySaveBlocked = useProjectStore((s) => s.integritySaveBlocked);
  const checkProjectIntegrity = useProjectStore((s) => s.checkProjectIntegrity);
  const repairProjectIntegrity = useProjectStore((s) => s.repairProjectIntegrity);
  const dismissIntegrityIssues = useProjectStore((s) => s.dismissIntegrityIssues);
  const integrityDialogOpen = useProjectStore((s) => s.integrityDialogOpen);
  const openIntegrityDialog = useProjectStore((s) => s.openIntegrityDialog);
  const closeIntegrityDialog = useProjectStore((s) => s.closeIntegrityDialog);
  const [repairingIntegrity, setRepairingIntegrity] = useState(false);
  const {
    view,
    setView,
    activeDialog,
    dialogData,
    dmpImportWizardPhase,
    placementMode,
    closeDialog,
    openDialog,
    initPanels,
    triggerFitToBounds,
    toast,
    selectionAnnouncement,
  } = useUIStore();

  // #198/fix 3: whenever a SpeleoDB hand-off verb (start/update/push/done, from the
  // status button OR a close dialog) reports a divergence, surface the resolution
  // dialog from ONE place - so no entry point can leave the user on a crimson button
  // with no next step. App is the only always-mounted host (the status button
  // unmounts in Plan/Export). SpeleoDivergenceDialog clears `divergence` on
  // resolve/cancel.
  const speleoDivergence = useSpeleoStore((s) => s.divergence);
  useEffect(() => {
    // Fire only on the transition to a pending divergence - deps intentionally OMIT
    // `activeDialog`. Re-running on every active-dialog change let an unresolved
    // divergence re-open ON TOP of an unrelated dialog the user had since navigated
    // to (e.g. Settings), trapping them (N1). If they leave it unresolved the crimson
    // status button still routes them back. No re-open loop: `openDialog` doesn't
    // touch `divergence`, so this only runs when the divergence itself changes.
    if (speleoDivergence !== null) {
      openDialog('speleodb-divergence');
    }
  }, [speleoDivergence, openDialog]);

  // #201 (B1): the held-lock resume/release prompt is an INDEPENDENT overlay (see
  // `heldLockPromptOpen`), not the single `activeDialog` slot, so a login done from
  // inside another dialog (e.g. the Settings account panel) layers the prompt OVER
  // it instead of replacing it - the underlying dialog stays mounted and intact.
  // The store opens it only on prompt-worthy scans (login / first app-open with held
  // locks); routine badge refreshes never do.
  const heldLockPromptOpen = useSpeleoStore((s) => s.heldLockPromptOpen);

  // Apply theme from config (resolves auto mode, sets data-theme attribute)
  useTheme();

  // Apply syntactic-highlighting colors (sets --sh-* vars + data-sh-level)
  useSyntacticHighlighting();

  // Listen for loading progress events from backend
  useLoadingProgress();

  // Event-driven network status orchestrator (tile transport events + offline polling)
  useNetworkStatus();

  // Whole-UI zoom via Ctrl+= / Ctrl+- / Ctrl+0 (persisted)
  useUiScale();

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
    // Block during the DMP placing wizard — it holds un-finalized, in-memory
    // imported/placed sections that an OS window-close would otherwise drop (#110).
    if (activeDialog === 'dmp-import-new' && dialogData.dmpFile) {
      return true;
    }
    // Block during GPX selection/placement dialog
    if ((activeDialog === 'gpx-selection' || activeDialog === 'gpx-placement') && dialogData.gpxFile) {
      return true;
    }
    // Block during new project for import dialog
    if (activeDialog === 'new-project-for-import' && (dialogData.dmpFile || dialogData.tmlFile || dialogData.gpxFile || dialogData.compassFile || dialogData.wallsFile)) {
      return true;
    }
    return false;
  }, [activeDialog, dialogData]);

  // Guard the app close during an import, OR with unsaved dive-plan edits (#244).
  // selectIsPlanDirty is only true while a loaded plan has diverged inputs (leaving
  // Plan mode resets the gas store), so no appMode check is needed here.
  const planDirty = useGasPlanStore(selectIsPlanDirty);
  useBeforeUnload(
    isImportInProgress || planDirty,
    isImportInProgress
      ? 'Import is in progress. Discard all import data and close?'
      : 'You have unsaved changes to this dive plan. Discard and close?'
  );

  useEffect(() => {
    // Load config on startup
    loadConfig();

    // Flush telemetry on page unload (best-effort)
    const handleUnload = () => { void flushTelemetry(); };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [loadConfig]);

  // Initialize telemetry once config is loaded (only collects if user opted in)
  useEffect(() => {
    if (config != null) {
      void initTelemetry(config.general.telemetry_enabled);
    }
  }, [config?.general.telemetry_enabled]);

  // After a project loads, check its structural integrity so corruption already
  // on disk (older versions / external edits) surfaces a warn + repair banner (#17).
  useEffect(() => {
    if (project?.file_path && !loading.isLoading) {
      void checkProjectIntegrity();
    }
  }, [project?.file_path, loading.isLoading, checkProjectIntegrity]);

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

  // Initialize panel sizes from config ONCE at startup. Config reloads happen
  // live (saving any panel/view preference re-fetches it); re-initializing on
  // each would snap user-dragged panel sizes back to their persisted values.
  const panelSizesInitialized = useRef(false);
  useEffect(() => {
    if (config?.panels && !panelSizesInitialized.current) {
      panelSizesInitialized.current = true;
      initPanels(config.panels);
    }
  }, [config, initPanels]);

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
   * Handle file drop events for importable files (DMP/TML/TMLU/Compass/GPX).
   * Delegates to the shared open/import router (same as the toolbar Import button
   * and the Ctrl+I shortcut), which dispatches by extension and applies the
   * read-only/closure-adjusted and "close the current project first" guards.
   * The drag listener only forwards importable extensions (never `.stalx`), so
   * a drop never opens/replaces a project.
   */
  const handleImportFileDrop = useCallback(async (filePath: string) => {
    // Tag the entry point so the routed import command (import_sections /
    // create_project_full / execute*Import) is attributed to drag-drop, like the
    // toolbar / menu / keyboard paths all set their source. routeOpenedFile clears
    // it on every terminal/abandon path.
    setProjectActionSource('drag-drop');
    await routeOpenedFile(filePath, 'Import Failed');
  }, []);

  // Set up drag-drop event listener for importable files (DMP/TML/TMLU/Compass/GPX)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // Derived from the single source of truth so the drag-drop file detection
    // can't drift from the router's `isImportable` guard / the picker filters.
    // IMPORTABLE_EXTENSIONS has no leading dot; the path match expects one.
    const importExts = IMPORTABLE_EXTENSIONS.map((ext) => `.${ext}`);

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

  const handleRepairIntegrity = async () => {
    setRepairingIntegrity(true);
    try {
      const { fixed, remaining } = await repairProjectIntegrity();
      const message =
        remaining > 0
          ? `Fixed ${fixed} issue${fixed === 1 ? '' : 's'}; ${remaining} need${remaining === 1 ? 's' : ''} manual attention (recompute or remove drifted loop closures, fix non-finite shots). Save to keep the fix.`
          : `Repaired ${fixed} issue${fixed === 1 ? '' : 's'}. Save to keep the fix.`;
      useUIStore.getState().showToast(message, 'integrity-repair');
      // Close the dialog only when fully clean. Read the AUTHORITATIVE store state
      // (the same integrityIssues the banner and the dialog render-gate use) rather
      // than the point-in-time `remaining` — a command or undo that interleaved
      // during the repair's awaits could have changed the real issue set, and
      // repairProjectIntegrity awaits its post-repair checkProjectIntegrity before
      // resolving, so integrityIssues is already fresh here.
      if (useProjectStore.getState().integrityIssues.length === 0) {
        closeIntegrityDialog();
      }
    } catch {
      // repairProjectIntegrity re-throws on a real failure (e.g. the IPC rejected
      // during teardown) rather than reporting a fake no-op success. Surface it and
      // keep the dialog open — integrityIssues is untouched, so the banner/save-block
      // stay correct and the user can retry.
      useUIStore.getState().showToast('Repair failed — nothing was changed. Please try again.', 'integrity-repair');
    } finally {
      setRepairingIntegrity(false);
    }
  };

  return (
    <div className="h-full bg-background text-text-primary flex flex-col relative" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      {/* Integrity warning banner (corruption found on load/save) */}
      {integrityIssues.length > 0 && (integritySaveBlocked || !integrityDismissed) && !loading.isLoading && (
        <div
          className="bg-warning-10 border-b border-warning-20 px-4 py-2 flex items-center gap-3 text-sm"
          role="alert"
          data-testid="integrity-banner"
        >
          <span className="text-warning font-medium flex-1 min-w-0">
            This project has {integrityIssues.length} integrity{' '}
            {integrityIssues.length === 1 ? 'issue' : 'issues'} that may affect your survey.
            {integritySaveBlocked && ' Saving is paused until you repair them.'}
          </span>
          <button
            onClick={() => openIntegrityDialog()}
            className="px-3 py-1 rounded bg-accent text-white text-xs"
            data-testid="integrity-review-button"
          >
            Review &amp; Repair
          </button>
          {/* Dismiss is offered only for non-blocking (detect-only) issues. When
              saving is blocked, the banner stays so the Repair entry point can't
              be hidden on a project that can't be saved. */}
          {!integritySaveBlocked && (
            <button
              onClick={dismissIntegrityIssues}
              className="px-2 py-1 text-text-secondary hover:text-text text-xs"
              data-testid="integrity-dismiss-button"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Integrity details + repair dialog */}
      {integrityDialogOpen && integrityIssues.length > 0 && (
        <div
          className="fixed inset-0 z-[1000] bg-overlay flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="integrity-dialog-title"
          data-testid="integrity-dialog"
          onClick={() => !repairingIntegrity && closeIntegrityDialog()}
        >
          <div
            className="bg-panel border border-border rounded-lg shadow-xl w-full max-w-xl max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-border">
              <h2 id="integrity-dialog-title" className="font-medium text-text-primary">
                Project integrity ({integrityIssues.length}{' '}
                {integrityIssues.length === 1 ? 'issue' : 'issues'})
              </h2>
            </div>
            <div className="px-4 py-3 overflow-auto">
              <p className="text-sm text-text-secondary mb-3">
                The following problems were found in this project. Repairing drops invalid
                references and realigns drifted station merges; valid survey data is kept. Save the
                project afterwards to make the fix permanent.
              </p>
              <ul
                className="list-disc list-inside space-y-1 text-sm text-text-primary"
                data-testid="integrity-dialog-list"
              >
                {integrityIssues.map((issue, i) => (
                  <li key={i} className="break-words">{issue}</li>
                ))}
              </ul>
            </div>
            <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
              <button
                onClick={() => closeIntegrityDialog()}
                disabled={repairingIntegrity}
                className="px-3 py-1.5 rounded border border-border text-sm hover:bg-background disabled:opacity-50"
                data-testid="integrity-dialog-cancel"
              >
                Cancel
              </button>
              <button
                onClick={handleRepairIntegrity}
                disabled={repairingIntegrity}
                className="px-3 py-1.5 rounded bg-accent text-white text-sm disabled:opacity-50"
                data-testid="integrity-dialog-repair"
              >
                {repairingIntegrity ? 'Repairing…' : 'Repair'}
              </button>
            </div>
          </div>
        </div>
      )}

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

      <MemoryProbe />

      {/* Dialogs */}
      {activeDialog === 'import' && <ImportDialog />}
      {activeDialog === 'export' && <ExportDialog />}
      {activeDialog === 'new-project' && <NewProjectDialog />}
      {activeDialog === 'open-from-speleodb' && <OpenFromSpeleoDbDialog />}
      {activeDialog === 'publish-to-speleodb' && <PublishToSpeleoDbDialog />}
      {activeDialog === 'speleodb-done' && <SpeleoDoneDialog />}
      {activeDialog === 'speleodb-divergence' && <SpeleoDivergenceDialog />}
      {activeDialog === 'speleodb-force-edit' && <SpeleoForceEditDialog />}
      {activeDialog === 'speleodb-restore' && <SpeleoRestoreDialog />}
      {activeDialog === 'speleodb-close' && <SpeleoCloseDialog />}
      {activeDialog === 'speleodb-no-permission' && <SpeleoNoPermissionDialog />}
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
            // Persist the freshly-imported project before anything else (#92) —
            // including before handing off to orphan placement — so the import
            // can never be lost. If the save failed, an error/permission dialog is
            // now showing; leave it up instead of dismissing it via closeDialog.
            if (!(await useProjectStore.getState().saveAfterImport())) {
              return;
            }
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
      {activeDialog === 'compass-import' && dialogData.compassFile ? (
        <CompassImportDialog
          compassFile={dialogData.compassFile as import('./types/commands').CompassFile}
          filePath={dialogData.filePath as string}
        />
      ) : null}
      {activeDialog === 'walls-import' && dialogData.wallsFile ? (
        <WallsImportDialog
          wallsFile={dialogData.wallsFile as import('./types/commands').WallsFile}
          filePath={dialogData.filePath as string}
        />
      ) : null}
      {activeDialog === 'collab-review' && dialogData.changeSet ? (
        <CollabReviewDialog
          changeSet={dialogData.changeSet as import('./types/commands').CollabChangeSet}
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
      {activeDialog === 'bulk-delete' && <BulkDeleteDialog />}
      {activeDialog === 'merge' && <MergeDialog />}
      {activeDialog === 'closure' && <ClosureDialog />}
      {activeDialog === 'merge-projects' && <MergeProjectsDialog />}
      {activeDialog === 'draw-shot' && <DrawShotDialog />}
      {activeDialog === 'edit-section' && <EditSectionDialog />}
      {activeDialog === 'edit-shot' && <EditShotDialog />}
      {activeDialog === 'edit-station' && <EditStationDialog />}
      {activeDialog === 'unmerge-stations' && <UnmergeStationsDialog />}
      {activeDialog === 'remove-closure' && <RemoveClosureDialog />}
      {activeDialog === 'unsaved-changes' && <UnsavedChangesDialog />}
      {activeDialog === 'error' && <ErrorDialog />}
      {activeDialog === 'save-permission' && <SavePermissionDialog />}
      {activeDialog === 'confirm-overwrite' && <OverwriteConfirmDialog />}
      {activeDialog === 'delete-project' && <DeleteProjectDialog />}
      {activeDialog === 'context-menu' && <ContextMenu />}
      {activeDialog === 'section-adjust' && <SectionAdjustDialog />}
      {activeDialog === 'settings' && <SettingsDialog />}
      {activeDialog === 'project-settings' && <ProjectSettingsDialog />}
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

      {/* Telemetry opt-in (shown once on first launch when feature is available, deferred during onboarding) */}
      {config && !onboarding.activeStep && (
        <TelemetryOptInDialog config={config} onConfigChanged={setConfig} />
      )}

      {/* Held-lock resume/release prompt (#201): an INDEPENDENT top-layer overlay
          (rendered last so its portal sits above any open dialog), so a login done
          from inside another dialog - e.g. the Settings account panel - layers it
          OVER that dialog instead of replacing it, leaving Settings intact. */}
      {heldLockPromptOpen && <HeldLockResumeDialog />}

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
