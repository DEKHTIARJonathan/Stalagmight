import { useEffect, useRef } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import type { StationRef, SectionId, ShotId } from '../../types/project';

interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

export default function ContextMenu() {
  const { closeDialog, dialogData, openDialog, setActiveTool, setSelection, setMergeStationA } = useUIStore();
  const { project, setShotVirtual } = useProjectStore();

  const menuRef = useRef<HTMLDivElement>(null);

  const target = dialogData.target as
    | { type: 'station'; ref: StationRef }
    | { type: 'shot'; sectionId: SectionId; shotId: ShotId }
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

  // Get shot data for toggle virtual
  const shot = target?.type === 'shot'
    ? project?.sections
        .find((s) => s.id === target.sectionId)
        ?.shots.find((sh) => sh.id === target.shotId)
    : null;


  const buildMenuItems = (): ContextMenuItem[] => {
    if (!target) return [];

    if (target.type === 'station') {
      return [
        {
          label: 'Edit Station',
          action: () => {
            setSelection({ type: 'station', stationRef: target.ref });
            closeDialog();
          },
        },
        {
          label: 'Merge With...',
          action: () => {
            setActiveTool('merge');
            setMergeStationA(target.ref);
            closeDialog();
          },
        },
        { label: '', action: () => {}, separator: true },
        {
          label: 'Set Zero Datum',
          action: () => {
            openDialog('set-zero-datum', { stationRef: target.ref });
          },
        },
        { label: '', action: () => {}, separator: true },
        {
          label: 'Delete Station',
          action: () => {
            openDialog('confirm-delete', { type: 'station', stationRef: target.ref });
          },
          danger: true,
        },
      ];
    }

    if (target.type === 'shot') {
      return [
        {
          label: 'Edit Shot',
          action: () => {
            setSelection({ type: 'shot', sectionId: target.sectionId, shotId: target.shotId });
            closeDialog();
          },
        },
        {
          label: shot?.is_virtual ? 'Mark as Real' : 'Mark as Virtual',
          action: async () => {
            await setShotVirtual(target.sectionId, target.shotId, !shot?.is_virtual);
            closeDialog();
          },
        },
        {
          label: 'Insert Shot After',
          action: () => {
            // Find the station after this shot
            const section = project?.sections.find((s) => s.id === target.sectionId);
            const shotIndex = section?.shots.findIndex((sh) => sh.id === target.shotId);
            if (shotIndex !== undefined && shotIndex >= 0) {
              openDialog('draw-shot', {
                fromStation: {
                  section_id: target.sectionId,
                  station_index: shotIndex + 1,
                },
              });
            }
          },
        },
        { label: '', action: () => {}, separator: true },
        {
          label: 'Delete Shot',
          action: () => {
            openDialog('confirm-delete', { type: 'shot', sectionId: target.sectionId, shotId: target.shotId });
          },
          danger: true,
        },
      ];
    }

    return [];
  };

  const items = buildMenuItems();

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
              onClick={item.action}
              disabled={item.disabled}
              className={`
                w-full px-3 py-2 text-left text-sm
                ${item.disabled ? 'text-text-secondary cursor-not-allowed' : 'hover:bg-accent/10'}
                ${item.danger && !item.disabled ? 'text-error hover:bg-error/10' : ''}
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
