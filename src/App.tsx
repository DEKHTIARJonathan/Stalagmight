import { useEffect, useCallback, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
import { useProjectStore } from './store/projectStore';
import { useUIStore } from './store/uiStore';
import { useBeforeUnload, useLoadingProgress, useTheme } from './hooks';
import i18n from './i18n';
import GlobalView from './components/GlobalView/GlobalView';
import SingleSystemView from './components/SingleSystemView/SingleSystemView';
import { ImportDialog, ExportDialog, NewProjectDialog, NewProjectForImportDialog, DmpSelectionDialog, DmpSectionConfigDialog, ConfirmDialog, DeleteShotChoiceDialog, MergeDialog, ClosureDialog, AdjustClosuresDialog, MergeProjectsDialog, DrawShotDialog, EditSectionDialog, EditShotDialog, EditStationDialog, UnsavedChangesDialog, ErrorDialog, OverwriteConfirmDialog, SectionAdjustDialog, SettingsDialog, SplitSectionDialog } from './components/Dialogs';
import { ContextMenu } from './components/common';
import type { ImportedSectionConfig } from './components/Dialogs/DmpSectionConfigDialog';
import type { DmpSelectionConfig } from './components/Dialogs/DmpSelectionDialog';
import type { ShotData } from './types/project';
import type { ImportSectionConfig as BackendImportSectionConfig, ImportPlacement } from './types/commands';

/**
 * Convert an EditableShot to a ShotData for the backend.
 */
function editableShotToShotData(shot: ImportedSectionConfig['shots'][0]): ShotData {
  return {
    azimuth_in: shot.azimuth_in,
    azimuth_out: shot.azimuth_out,
    length: shot.length,
    depth_in: shot.depth_in,
    depth_out: shot.depth_out,
    pitch_in: shot.pitch_in,
    pitch_out: shot.pitch_out,
    left: shot.left,
    right: shot.right,
    up: shot.up,
    down: shot.down,
    comment: shot.comment,
    is_virtual: shot.is_virtual ?? false,
  };
}

/**
 * Calculate station positions for a section based on shots.
 * Returns positions in local coordinates (station 0 at origin).
 */
function calculateStationPositions(shots: ImportedSectionConfig['shots']): Array<{ x: number; y: number }> {
  const positions: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];

  let x = 0;
  let y = 0;

  for (const shot of shots) {
    // Calculate heading from azimuth_in and azimuth_out average
    const heading = (shot.azimuth_in + shot.azimuth_out) / 2;
    // Convert heading to radians (heading is in degrees, 0 = north)
    const radians = ((90 - heading) * Math.PI) / 180;
    // Calculate dx, dy
    const dx = shot.length * Math.cos(radians);
    const dy = shot.length * Math.sin(radians);
    x += dx;
    y += dy;
    positions.push({ x, y });
  }

  return positions;
}

function App() {
  const { project, stations, loadConfig, config, isDirty, importDmp, importSections } = useProjectStore();
  const { view, setView, activeDialog, dialogData, closeDialog, openDialog, initPanelSizes, setImportContext, triggerFitToBounds, toast, selectionAnnouncement } = useUIStore();

  // Apply theme from config (resolves auto mode, sets data-theme attribute)
  useTheme();

  // Listen for loading progress events from backend
  useLoadingProgress();

  // Track whether we're hovering with a valid DMP file
  const [isDraggingDmp, setIsDraggingDmp] = useState(false);

  // Determine if import dialog is open and has placed sections
  // This is used to show a confirmation when closing the app
  const isImportInProgress = useMemo(() => {
    // Check if we're in the DMP section config dialog
    if (activeDialog === 'dmp-section-config') {
      // Check if there are placed sections in the saved state
      const savedPlacedSections = dialogData.savedPlacedSections as number[] | undefined;
      if (savedPlacedSections && savedPlacedSections.length > 0) {
        return true;
      }
      // Also check the selectionConfig which indicates sections are being configured
      if (dialogData.selectionConfig) {
        return true;
      }
    }
    // Also block during DMP selection if we have a parsed file
    if (activeDialog === 'dmp-selection' && dialogData.dmpFile) {
      return true;
    }
    // Block during new project for import dialog
    if (activeDialog === 'new-project-for-import' && dialogData.dmpFile) {
      return true;
    }
    return false;
  }, [activeDialog, dialogData]);

  // Show confirmation dialog when closing the app during import
  useBeforeUnload(
    isImportInProgress,
    'Import is in progress. Discard all import data and close?'
  );

  /**
   * Convert frontend section configs to backend ImportSectionConfig format
   * and import all sections as a single atomic operation.
   */
  const handleImportSections = useCallback(async (sections: ImportedSectionConfig[], fileHash?: string | null): Promise<boolean> => {
    // Convert each section to the backend format
    const backendSections: BackendImportSectionConfig[] = sections.map((sectionConfig) => {
      const shots: ShotData[] = sectionConfig.shots.map(editableShotToShotData);
      const placement = sectionConfig.placement;

      let backendPlacement: ImportPlacement;

      if (placement.type === 'origin') {
        backendPlacement = { type: 'origin' };
      } else if (placement.type === 'zeroDatum') {
        backendPlacement = {
          type: 'zero_datum',
          coordinates: placement.coordinates,
          station_index: placement.stationIndex,
        };
      } else if (placement.type === 'fromExisting') {
        backendPlacement = {
          type: 'from_existing',
          import_station: placement.importStation,
          existing_station: placement.existingStation,
        };
      } else if (placement.type === 'fromImporting') {
        backendPlacement = {
          type: 'from_importing',
          import_station: placement.importStation,
          target_section_index: placement.targetSectionIndex,
          target_station_index: placement.targetStationIndex,
        };
      } else if (placement.type === 'manual' && placement.snappedToStation) {
        // Manual with snap → manualSnap variant
        const snapIndex = Math.max(0, Math.min(placement.alignStationIndex, sectionConfig.shots.length));
        backendPlacement = {
          type: 'manual_snap',
          align_station_index: snapIndex,
          snapped_to_station: placement.snappedToStation,
        };
      } else {
        // Manual without snap → compute offset
        const alignIdx = placement.type === 'manual' ? placement.alignStationIndex : 0;
        if (placement.type === 'manual' && placement.position) {
          const stationPositions = calculateStationPositions(sectionConfig.shots);
          const clampedIdx = Math.max(0, Math.min(alignIdx, stationPositions.length - 1));
          const alignPos = stationPositions[clampedIdx];
          if (alignPos) {
            backendPlacement = {
              type: 'manual',
              align_station_index: alignIdx,
              offset: {
                x: placement.position.x - alignPos.x,
                y: placement.position.y - alignPos.y,
                z: placement.position.z ?? 0,
              },
            };
          } else {
            backendPlacement = { type: 'manual', align_station_index: alignIdx };
          }
        } else {
          backendPlacement = { type: 'manual', align_station_index: alignIdx };
        }
      }

      return {
        section_index: sectionConfig.sectionIndex,
        name: sectionConfig.name,
        surveyor: sectionConfig.surveyor,
        date: sectionConfig.date,
        color: sectionConfig.color,
        direction: sectionConfig.direction,
        quality: sectionConfig.quality ?? 1.0,
        shots,
        placement: backendPlacement,
      };
    });

    // Single backend call — all sections + file hash in one atomic undo unit
    const result = await importSections(backendSections, fileHash);

    // Close the dialog and switch to single view
    closeDialog();
    setView('single');

    // Fit map to show all stations including newly imported ones
    triggerFitToBounds();

    if (!result.success) {
      openDialog('error', {
        title: 'Import Errors',
        message: result.error ?? 'Unknown error during import',
      });
      return false;
    }

    return true;
  }, [importSections, closeDialog, openDialog, setView, triggerFitToBounds]);

  useEffect(() => {
    // Load config on startup
    loadConfig();
  }, [loadConfig]);

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
          const filename = project.file_path.split(/[/\\]/).pop() ?? project.file_path;
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
   * Handle file drop events for DMP file import.
   * - From home screen (no project): Creates new project, then opens import dialog
   * - From existing project: Opens import dialog directly
   */
  const handleDmpFileDrop = useCallback(async (filePath: string) => {
    // Determine context: are we creating a new project or adding to existing?
    const currentProject = useProjectStore.getState().project;

    if (currentProject) {
      // Existing project: parse DMP and open Step 1 (selection) directly
      setImportContext('existing-project');

      try {
        const dmpFile = await importDmp(filePath);
        if (dmpFile) {
          openDialog('dmp-selection', {
            dmpFile,
            filePath,
          });
        }
      } catch (e) {
        openDialog('error', {
          title: 'Import Failed',
          message: e instanceof Error ? e.message : 'Failed to parse DMP file',
        });
      }
    } else {
      // No project: parse DMP first, then show NewProjectDialog for import
      setImportContext('new-project');

      try {
        const dmpFile = await importDmp(filePath);
        if (dmpFile) {
          // Extract filename for default project name
          const fileName = filePath.split(/[/\\]/).pop()?.replace(/\.dmp$/i, '') ?? 'Imported';
          openDialog('new-project-for-import', {
            dmpFile,
            filePath,
            defaultName: fileName,
          });
        }
      } catch (e) {
        openDialog('error', {
          title: 'Import Failed',
          message: e instanceof Error ? e.message : 'Failed to parse DMP file',
        });
      }
    }
  }, [importDmp, openDialog, setImportContext]);

  // Set up drag-drop event listener for DMP files
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupDragDrop = async () => {
      try {
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent((event) => {
          const payload = event.payload as DragDropEvent;

          if (payload.type === 'enter') {
            // User started hovering with files - check if any is a DMP file
            const hasDmpFile = payload.paths?.some((path: string) =>
              path.toLowerCase().endsWith('.dmp')
            );
            setIsDraggingDmp(hasDmpFile ?? false);
          } else if (payload.type === 'drop') {
            setIsDraggingDmp(false);
            // Find the first DMP file in the dropped paths
            const dmpPath = payload.paths?.find((path: string) =>
              path.toLowerCase().endsWith('.dmp')
            );
            if (dmpPath) {
              handleDmpFileDrop(dmpPath);
            }
          } else if (payload.type === 'leave') {
            setIsDraggingDmp(false);
          }
          // 'over' events just update position, we don't need to handle them
        });
      } catch (e) {
        // Drag-drop not available (dev mode without Tauri)
        console.warn('Drag-drop not available:', e);
      }
    };

    setupDragDrop();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleDmpFileDrop]);

  return (
    <div className="h-full bg-background text-text-primary flex flex-col relative">
      {/* Drop indicator overlay */}
      {isDraggingDmp && (
        <div
          className="absolute inset-0 z-50 bg-accent-20 border-4 border-dashed border-accent flex items-center justify-center pointer-events-none"
          data-testid="dmp-drop-indicator"
        >
          <div className="bg-panel p-6 rounded-lg shadow-xl text-center">
            <div className="text-4xl mb-2">📥</div>
            <div className="text-lg font-semibold">Drop DMP file to import</div>
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
          onContinue={(config) => {
            // Proceed to Step 2
            openDialog('dmp-section-config', {
              dmpFile: dialogData.dmpFile,
              filePath: dialogData.filePath,
              selectionConfig: config,
            });
          }}
        />
      ) : null}
      {activeDialog === 'dmp-section-config' && dialogData.dmpFile && dialogData.selectionConfig ? (
        <DmpSectionConfigDialog
          dmpFile={dialogData.dmpFile as import('./types/commands').DmpFile}
          selectionConfig={dialogData.selectionConfig as DmpSelectionConfig}
          project={project}
          stations={stations}
          onCancel={closeDialog}
          onBack={() => {
            // Go back to Step 1
            openDialog('dmp-selection', {
              dmpFile: dialogData.dmpFile,
              filePath: dialogData.filePath,
            });
          }}
          onImport={async (sections) => {
            // Capture hash before handleImportSections closes dialog (clears dialogData)
            const hash = (dialogData.selectionConfig as DmpSelectionConfig)?.fileHash;
            await handleImportSections(sections, hash);
          }}
        />
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
      {activeDialog === 'unsaved-changes' && <UnsavedChangesDialog />}
      {activeDialog === 'error' && <ErrorDialog />}
      {activeDialog === 'confirm-overwrite' && <OverwriteConfirmDialog />}
      {activeDialog === 'context-menu' && <ContextMenu />}
      {activeDialog === 'section-adjust' && <SectionAdjustDialog />}
      {activeDialog === 'settings' && <SettingsDialog />}
      {activeDialog === 'split-section' && <SplitSectionDialog />}

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
