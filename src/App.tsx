import { useEffect, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useProjectStore } from './store/projectStore';
import { useUIStore } from './store/uiStore';
import GlobalView from './components/GlobalView/GlobalView';
import SingleSystemView from './components/SingleSystemView/SingleSystemView';
import { ImportDialog, ExportDialog, NewProjectDialog, DmpImportDialog, DmpSelectionDialog, DmpSectionConfigDialog, ConfirmDialog, MergeDialog, MergeProjectsDialog, DrawShotDialog, EditSectionDialog, EditShotDialog, EditStationDialog, UnsavedChangesDialog, ErrorDialog, OverwriteConfirmDialog, SectionAdjustDialog } from './components/Dialogs';
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
  const { project, stations, loadConfig, config, isDirty, createSection, setZeroDatum, mergeStations, moveSection } = useProjectStore();
  const { view, activeDialog, dialogData, closeDialog, openDialog, initPanelSizes } = useUIStore();

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

  return (
    <div className="h-full bg-background text-text-primary flex flex-col">
      {view === 'global' || !project ? (
        <GlobalView />
      ) : (
        <SingleSystemView />
      )}

      {/* Dialogs */}
      {activeDialog === 'import' && <ImportDialog />}
      {activeDialog === 'export' && <ExportDialog />}
      {activeDialog === 'new-project' && <NewProjectDialog />}
      {activeDialog === 'import-dmp' && <DmpImportDialog />}
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
    </div>
  );
}

export default App;
