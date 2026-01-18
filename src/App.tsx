import { useEffect, useCallback, useState, useMemo } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
import { useProjectStore } from './store/projectStore';
import { useUIStore } from './store/uiStore';
import { useBeforeUnload } from './hooks/useBeforeUnload';
import GlobalView from './components/GlobalView/GlobalView';
import SingleSystemView from './components/SingleSystemView/SingleSystemView';
import { ImportDialog, ExportDialog, NewProjectDialog, NewProjectForImportDialog, DmpSelectionDialog, DmpSectionConfigDialog, ConfirmDialog, MergeDialog, MergeProjectsDialog, DrawShotDialog, EditSectionDialog, EditShotDialog, EditStationDialog, UnsavedChangesDialog, ErrorDialog, OverwriteConfirmDialog, SectionAdjustDialog, DuplicateImportDialog } from './components/Dialogs';
import { ContextMenu } from './components/common';
import type { ImportedSectionConfig } from './components/Dialogs/DmpSectionConfigDialog';
import type { SectionData, ShotData } from './types/project';

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
  const { project, stations, loadConfig, config, isDirty, createSection, setZeroDatum, mergeStations, moveSection, importDmp } = useProjectStore();
  const { view, activeDialog, dialogData, closeDialog, openDialog, initPanelSizes, setImportContext, hasImportedDmpPath, addImportedDmpPath } = useUIStore();

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
   * Handle importing sections from the DMP Section Config Dialog.
   * Processes each section based on its placement type.
   */
  const handleImportSections = useCallback(async (sections: ImportedSectionConfig[]) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const sectionConfig of sections) {
      const sectionData: SectionData = {
        name: sectionConfig.name,
        surveyor: sectionConfig.surveyor,
        date: sectionConfig.date,
        color: sectionConfig.color,
        direction: sectionConfig.direction,
        shots: sectionConfig.shots.map(editableShotToShotData),
      };

      // Create the section
      const createResult = await createSection(sectionData);

      if (!createResult.success) {
        errors.push(`Failed to create section "${sectionConfig.name}": ${createResult.error}`);
        continue;
      }

      const sectionId = createResult.section_id;
      if (sectionId === undefined) {
        errors.push(`Section "${sectionConfig.name}" created but no ID returned`);
        continue;
      }

      // Handle placement-specific operations
      const placement = sectionConfig.placement;

      if (placement.type === 'origin') {
        // Place at 0,0 - nothing else to do, section is already at origin
        continue;
      }

      if (placement.type === 'zeroDatum') {
        // Set zero datum on the specified station
        const zeroDatumResult = await setZeroDatum(
          { section_id: sectionId, station_index: placement.stationIndex },
          placement.coordinates
        );

        if (!zeroDatumResult.success) {
          warnings.push(
            `Section "${sectionConfig.name}" created but failed to set zero datum: ${zeroDatumResult.error}`
          );
        }
        continue;
      }

      if (placement.type === 'fromExisting') {
        // Merge stations
        const importRef = {
          section_id: sectionId,
          station_index: placement.importStation,
        };

        const mergeResult = await mergeStations(
          importRef,
          placement.existingStation,
          'KeepRaw'
        );

        if (!mergeResult.success) {
          warnings.push(
            `Section "${sectionConfig.name}" created but failed to merge stations: ${mergeResult.error}`
          );
        }
        continue;
      }

      if (placement.type === 'manual') {
        // Manual placement - calculate and apply offset
        if (placement.position) {
          // Calculate station positions to determine offset
          const stationPositions = calculateStationPositions(sectionConfig.shots);
          const alignIndex = placement.alignStation === 'first' ? 0 : stationPositions.length - 1;
          const alignPos = stationPositions[alignIndex];

          if (alignPos) {
            // Calculate offset needed to move align station to target position
            const offset = {
              x: placement.position.x - alignPos.x,
              y: placement.position.y - alignPos.y,
              z: placement.position.z ?? 0,
            };

            const moveResult = await moveSection(sectionId, offset);

            if (!moveResult.success) {
              warnings.push(
                `Section "${sectionConfig.name}" created but failed to apply offset: ${moveResult.error}`
              );
            }
          }
        }

        // If snapped to station, also merge
        if (placement.snappedToStation) {
          const snapIndex = placement.alignStation === 'first' ? 0 : sectionConfig.shots.length;
          const importRef = {
            section_id: sectionId,
            station_index: snapIndex,
          };

          const mergeResult = await mergeStations(
            importRef,
            placement.snappedToStation,
            'KeepRaw'
          );

          if (!mergeResult.success) {
            warnings.push(
              `Section "${sectionConfig.name}" failed to snap to station: ${mergeResult.error}`
            );
          }
        }
        continue;
      }
    }

    // Close the dialog first
    closeDialog();

    // Show errors if any occurred
    if (errors.length > 0) {
      openDialog('error', {
        title: 'Import Errors',
        message: errors.join('\n'),
      });
    } else if (warnings.length > 0) {
      // Show warnings as a non-blocking notification (using error dialog for now)
      openDialog('error', {
        title: 'Import Warnings',
        message: warnings.join('\n'),
      });
    }
  }, [createSection, setZeroDatum, mergeStations, moveSection, closeDialog, openDialog]);

  useEffect(() => {
    // Load config on startup
    loadConfig();
  }, [loadConfig]);

  // Initialize panel sizes from config
  useEffect(() => {
    if (config?.panels) {
      initPanelSizes(config.panels);
    }
  }, [config, initPanelSizes]);

  // Update window title based on project state
  useEffect(() => {
    const updateTitle = async () => {
      let title = 'CaveChef';
      if (project) {
        if (project.file_path) {
          // Extract filename from path
          const filename = project.file_path.split(/[/\\]/).pop() ?? project.file_path;
          title = `CaveChef - ${filename}`;
        } else {
          title = `CaveChef - ${project.name} (unsaved)`;
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
      // Check for duplicate import
      if (hasImportedDmpPath(filePath)) {
        // Show confirmation dialog for duplicate import
        openDialog('confirm-duplicate-import', {
          filePath,
        });
        return;
      }

      // Existing project: parse DMP and open Step 1 (selection) directly
      setImportContext('existing-project');

      try {
        const dmpFile = await importDmp(filePath);
        if (dmpFile) {
          // Track this file as imported
          addImportedDmpPath(filePath);
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
          // Track this file as imported
          addImportedDmpPath(filePath);
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
  }, [importDmp, openDialog, setImportContext, hasImportedDmpPath, addImportedDmpPath]);

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
          className="absolute inset-0 z-50 bg-accent/20 border-4 border-dashed border-accent flex items-center justify-center pointer-events-none"
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
          selectionConfig={dialogData.selectionConfig as import('./components/Dialogs/DmpSelectionDialog').DmpSelectionConfig}
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
          onImport={handleImportSections}
        />
      ) : null}
      {activeDialog === 'confirm-delete' && <ConfirmDialog />}
      {activeDialog === 'merge' && <MergeDialog />}
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
      {activeDialog === 'confirm-duplicate-import' && <DuplicateImportDialog />}
    </div>
  );
}

export default App;
