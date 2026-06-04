import { useEffect, useRef } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useShallow } from 'zustand/react/shallow';
import { useProjectStore } from '../../store/projectStore';
import type { StationRef, SectionId, ShotId } from '../../types/project';
import { getDeleteShotDialog } from '../../utils/contextMenuHelpers';
import { setSource, trackContextMenuAction, trackDialogComplete } from '../../utils/telemetry';

interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

export default function ContextMenu() {
  const { closeDialog, dialogData, openDialog, setActiveTool, setMergeStationA, triggerZoomToSection, geometryMode } = useUIStore(useShallow((s) => ({
    closeDialog: s.closeDialog,
    dialogData: s.dialogData,
    openDialog: s.openDialog,
    setActiveTool: s.setActiveTool,
    setMergeStationA: s.setMergeStationA,
    triggerZoomToSection: s.triggerZoomToSection,
    geometryMode: s.geometryMode,
  })));
  const { project, stations, setShotReference, unmergeStations, unmergeStationPair, removeLoopClosure } = useProjectStore();

  const menuRef = useRef<HTMLDivElement>(null);

  const target = dialogData.target as
    | { type: 'station'; ref: StationRef }
    | { type: 'shot'; sectionId: SectionId; shotId: ShotId }
    | { type: 'section'; sectionId: SectionId }
    | { type: 'datatable-shot'; sectionId: SectionId; shotId: ShotId; isFirst: boolean; isLast: boolean; totalShots: number; sectionName: string }
    | null;
  const position = dialogData.position as { x: number; y: number } | undefined;

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeDialog();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDialog();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [closeDialog]);

  // Get shot data for toggle reference
  const shot = target?.type === 'shot'
    ? project?.sections
        .find((s) => s.id === target.sectionId)
        ?.shots.find((sh) => sh.id === target.shotId)
    : null;

  const sameStationRef = (a: StationRef, b: StationRef): boolean => (
    a.section_id === b.section_id && a.station_index === b.station_index
  );


  const buildMenuItems = (): ContextMenuItem[] => {
    if (!target) return [];

    if (target.type === 'station') {
      const sectionId = target.ref.section_id;
      const stationSection = project?.sections.find((s) => s.id === sectionId);
      const currentStation = stations.find((station) => sameStationRef(station.station_ref, target.ref));
      const mergedStations = currentStation?.merged_with ?? [];
      const directClosures = (() => {
        const deduped = new Map<string, { closureId: bigint; stationRef: StationRef }>();
        for (const closure of currentStation?.closures_with ?? []) {
          if (closure.is_transitive) continue;
          const key = closure.closure_id.toString();
          if (!deduped.has(key)) {
            deduped.set(key, {
              closureId: closure.closure_id,
              stationRef: closure.station_ref,
            });
          }
        }
        return Array.from(deduped.values());
      })();
      const totalShots = stationSection?.shots.length ?? 0;
      const isFirstStation = target.ref.station_index === 0;
      const isLastStation = target.ref.station_index === totalShots;

      // Get geometry from neighbor shot for add-shot defaults
      const neighborShot = isFirstStation
        ? stationSection?.shots[0]
        : isLastStation
          ? stationSection?.shots[totalShots - 1]
          : undefined;
      const stationSourceGeometry = neighborShot ? {
        azimuth_in: neighborShot.azimuth_in,
        azimuth_out: neighborShot.azimuth_out,
        depth_in: neighborShot.depth_in,
        depth_out: neighborShot.depth_out,
        pitch_in: neighborShot.pitch_in,
        pitch_out: neighborShot.pitch_out,
      } : undefined;

      const items: ContextMenuItem[] = [
        {
          label: 'Edit Station',
          action: () => {
            openDialog('edit-station', { stationRef: target.ref });
          },
        },
        {
          label: 'Merge With...',
          action: () => {
            setActiveTool('merge');
            setMergeStationA(target.ref);
            trackDialogComplete('context-menu');
            closeDialog();
          },
        },
      ];

      if (mergedStations.length > 0) {
        items.push({
          label: 'Unmerge Stations',
          action: () => {
            if (mergedStations.length === 1) {
              const mergeTarget = mergedStations[0]!;
              const isDirectMerge = project?.station_merges.some((merge) => {
                const direct = sameStationRef(merge.station_a, target.ref) && sameStationRef(merge.station_b, mergeTarget);
                const reverse = sameStationRef(merge.station_a, mergeTarget) && sameStationRef(merge.station_b, target.ref);
                return direct || reverse;
              }) ?? false;
              trackContextMenuAction('unmerge', 'context-menu');
              trackDialogComplete('context-menu');
              closeDialog();
              void (isDirectMerge
                ? unmergeStationPair(target.ref, mergeTarget)
                : unmergeStations(target.ref));
              return;
            }

            openDialog('unmerge-stations', {
              stationRef: target.ref,
              mergedStations,
            });
          },
        });
      }

      if (directClosures.length > 0) {
        items.push({
          label: 'Remove Closure',
          action: () => {
            if (directClosures.length === 1) {
              trackContextMenuAction('remove-closure', 'context-menu');
              trackDialogComplete('context-menu');
              closeDialog();
              void removeLoopClosure(directClosures[0]!.closureId);
              return;
            }

            openDialog('remove-closure', {
              anchorStation: target.ref,
              closures: directClosures,
            });
          },
        });
      }

      // "Add Shot Before" - only for station 0 (first station)
      // For empty sections, prependMode is set but azimuth reversal will be skipped
      // in DrawShotDialog since there's no reference shot (section.shots.length === 0)
      if (isFirstStation) {
        items.push({
          label: 'Add Shot Before',
          action: () => {
            openDialog('draw-shot', {
              fromStation: {
                section_id: sectionId,
                station_index: 0,
              },
              prependMode: true,
              allowZeroLength: true,
              sourceGeometry: stationSourceGeometry,
            });
          },
        });
      }

      // "Add Shot After" - only for last station
      if (isLastStation) {
        items.push({
          label: 'Add Shot After',
          action: () => {
            openDialog('draw-shot', {
              fromStation: {
                section_id: sectionId,
                station_index: totalShots,
              },
              appendMode: true,
              allowZeroLength: true,
              sourceGeometry: stationSourceGeometry,
            });
          },
        });
      }

      items.push({ label: '', action: () => {}, separator: true });
      items.push({
        label: 'Set Zero Datum',
        action: () => {
          openDialog('edit-station', {
            stationRef: target.ref,
            forceEnableZeroDatum: true,
            focusGpsInput: true,
          });
        },
      });
      items.push({ label: '', action: () => {}, separator: true });
      items.push({
        label: 'Edit Section',
        action: () => {
          openDialog('edit-section', { sectionId });
        },
      });
      items.push({
        label: 'Delete Section',
        action: () => {
          openDialog('confirm-delete', { type: 'section', sectionId });
        },
        danger: true,
      });
      items.push({ label: '', action: () => {}, separator: true });
      items.push({
        label: 'Delete Station',
        action: () => {
          openDialog('confirm-delete', { type: 'station', stationRef: target.ref });
        },
        danger: true,
      });

      return items;
    }

    if (target.type === 'shot') {
      const section = project?.sections.find((s) => s.id === target.sectionId);
      const shotIndex = section?.shots.findIndex((sh) => sh.id === target.shotId) ?? -1;
      const totalShots = section?.shots.length ?? 0;
      const isFirst = shotIndex === 0 && totalShots > 0;
      const isLast = shotIndex >= 0 && shotIndex === totalShots - 1;
      const sourceShot = shotIndex >= 0 ? section?.shots[shotIndex] : undefined;
      const sourceGeometry = sourceShot ? {
        azimuth_in: sourceShot.azimuth_in,
        azimuth_out: sourceShot.azimuth_out,
        depth_in: sourceShot.depth_in,
        depth_out: sourceShot.depth_out,
        pitch_in: sourceShot.pitch_in,
        pitch_out: sourceShot.pitch_out,
      } : undefined;

      const items: ContextMenuItem[] = [
        {
          label: 'Edit Shot',
          action: () => {
            openDialog('edit-shot', { sectionId: target.sectionId, shotId: target.shotId });
          },
        },
        {
          label: shot?.is_reference ? 'Mark as Permanent' : 'Mark as Jump/Reference',
          action: async () => {
            trackContextMenuAction('toggle-reference', 'context-menu');
            await setShotReference(target.sectionId, target.shotId, !shot?.is_reference);
            trackDialogComplete('context-menu');
            closeDialog();
          },
        },
      ];

      // "Add Shot Before" - only for first shot (prepend mode)
      if (isFirst) {
        items.push({
          label: 'Add Shot Before',
          action: () => {
            openDialog('draw-shot', {
              fromStation: {
                section_id: target.sectionId,
                station_index: 0,
              },
              prependMode: true,
              allowZeroLength: true,
              sourceGeometry,
            });
          },
        });
      }

      // "Add Shot After" - only for last shot
      if (isLast) {
        items.push({
          label: 'Add Shot After',
          action: () => {
            openDialog('draw-shot', {
              fromStation: {
                section_id: target.sectionId,
                station_index: totalShots,
              },
              appendMode: true,
              allowZeroLength: true,
              sourceGeometry,
            });
          },
        });
      }

      items.push({ label: '', action: () => {}, separator: true });
      items.push({
        label: 'Edit Section',
        action: () => {
          openDialog('edit-section', { sectionId: target.sectionId });
        },
      });
      items.push({
        label: 'Delete Section',
        action: () => {
          openDialog('confirm-delete', { type: 'section', sectionId: target.sectionId });
        },
        danger: true,
      });
      items.push({ label: '', action: () => {}, separator: true });
      // Position-aware Delete Shot using shared helper.
      // Disabled when section/shot lookup fails (stale target).
      const canDelete = shotIndex >= 0 && totalShots > 0;
      items.push({
        label: 'Delete Shot',
        action: () => {
          if (!canDelete) return;
          const { dialog, data } = getDeleteShotDialog(
            target.sectionId,
            target.shotId,
            isFirst,
            isLast,
            totalShots,
            section?.name ?? `Section ${target.sectionId}`,
          );
          openDialog(dialog, data);
        },
        danger: true,
        disabled: !canDelete,
      });

      return items;
    }

    if (target.type === 'section') {
      return [
        {
          label: 'Edit Section',
          action: () => {
            openDialog('edit-section', { sectionId: target.sectionId });
          },
        },
        {
          label: 'Adjust Position...',
          action: () => {
            openDialog('section-adjust', { sectionId: target.sectionId });
          },
        },
        {
          label: 'Zoom to Section',
          action: () => {
            triggerZoomToSection(target.sectionId);
            trackDialogComplete('context-menu');
            closeDialog();
          },
        },
        { label: '', action: () => {}, separator: true },
        {
          label: 'Delete Section',
          action: () => {
            openDialog('confirm-delete', { type: 'section', sectionId: target.sectionId });
          },
          danger: true,
        },
      ];
    }

    if (target.type === 'datatable-shot') {
      const items: ContextMenuItem[] = [];

      // Look up the source shot for geometry copying
      const sourceSection = project?.sections.find((s) => s.id === target.sectionId);
      const sourceShot = sourceSection?.shots.find((sh) => sh.id === target.shotId);
      // Copy geometry only (azimuth, depth, pitch) — not temperature/marker_index
      const sourceGeometry = sourceShot ? {
        azimuth_in: sourceShot.azimuth_in,
        azimuth_out: sourceShot.azimuth_out,
        depth_in: sourceShot.depth_in,
        depth_out: sourceShot.depth_out,
        pitch_in: sourceShot.pitch_in,
        pitch_out: sourceShot.pitch_out,
      } : undefined;

      // "Add Shot Before" - only for first shot (prepend mode)
      if (target.isFirst) {
        items.push({
          label: 'Add Shot Before',
          action: () => {
            openDialog('draw-shot', {
              fromStation: {
                section_id: target.sectionId,
                station_index: 0,
              },
              prependMode: true,
              allowZeroLength: true,
              sourceGeometry,
            });
          },
        });
      }

      // "Add Shot After" - only for last shot
      if (target.isLast) {
        items.push({
          label: 'Add Shot After',
          action: () => {
            openDialog('draw-shot', {
              fromStation: {
                section_id: target.sectionId,
                station_index: target.totalShots,
              },
              appendMode: true,
              allowZeroLength: true,
              sourceGeometry,
            });
          },
        });
      }

      // Separator before delete (only if there are add items above)
      if (items.length > 0) {
        items.push({ label: '', action: () => {}, separator: true });
      }

      // "Delete Shot" - position-aware using shared helper
      items.push({
        label: 'Delete Shot',
        action: () => {
          const { dialog, data } = getDeleteShotDialog(
            target.sectionId,
            target.shotId,
            target.isFirst,
            target.isLast,
            target.totalShots,
            target.sectionName,
          );
          openDialog(dialog, data);
        },
        danger: true,
      });

      return items;
    }

    return [];
  };

  // The closure-adjusted view is read-only: disable every mutation item (all of
  // them except read-only navigation like "Zoom to Section"). Edits are made in
  // the measured view.
  const geometryReadOnly = geometryMode === 'closureAdjusted';
  const READ_ONLY_SAFE_LABELS = new Set(['Zoom to Section']);
  const items = buildMenuItems().map((item) =>
    geometryReadOnly && !item.separator && !READ_ONLY_SAFE_LABELS.has(item.label)
      ? { ...item, disabled: true }
      : item
  );

  if (!target || !position || items.length === 0) {
    return null;
  }

  // Adjust position to stay within viewport
  const adjustedPosition = {
    x: Math.min(position.x, window.innerWidth - 200),
    y: Math.min(position.y, window.innerHeight - items.length * 36 - 20),
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0" onClick={closeDialog} />
      <div
        ref={menuRef}
        className="absolute bg-panel border border-border rounded-lg shadow-xl py-1 min-w-[180px]"
        style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
      >
        {items.map((item, index) => {
          if (item.separator) {
            return <div key={index} className="border-t border-border my-1" />;
          }

          return (
            <button
              key={index}
              onClick={() => { setSource('context-menu'); item.action(); }}
              disabled={item.disabled}
              className={`
                w-full px-3 py-2 text-left text-sm
                ${item.disabled ? 'text-text-secondary cursor-not-allowed' : 'hover:bg-accent-10'}
                ${item.danger && !item.disabled ? 'text-error hover:bg-error-10' : ''}
              `}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
