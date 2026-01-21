import { type MouseEvent } from 'react';
import { useProjectStore } from '../../store/projectStore';

interface SystemCardProps {
  name: string;
  location: string | null;
  filePath: string;
  modifiedAt: string;
  sectionCount: number;
  totalLength: number;
  isSelected?: boolean;
  /** Called when the card is clicked. Receives true if Ctrl/Cmd was held. */
  onSelect?: (ctrlKey: boolean) => void;
  /** Called on right-click to show context menu */
  onContextMenu?: (e: MouseEvent) => void;
}

export default function SystemCard({
  name,
  location,
  filePath,
  modifiedAt,
  sectionCount,
  totalLength,
  isSelected,
  onSelect,
  onContextMenu,
}: SystemCardProps) {
  const { loadProject } = useProjectStore();

  const handleClick = (e: MouseEvent) => {
    // Single click selects the card
    // Pass ctrlKey (or metaKey for Mac) to support multi-select
    if (onSelect) {
      onSelect(e.ctrlKey || e.metaKey);
    }
  };

  const handleDoubleClick = async () => {
    // Double click opens the project via store.loadProject
    // loadProject handles view switching internally
    await loadProject(filePath);
  };

  const handleContextMenu = (e: MouseEvent) => {
    if (onContextMenu) {
      onContextMenu(e);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  const formatLength = (meters: number) => {
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(1)} km`;
    }
    return `${meters.toFixed(0)} m`;
  };

  return (
    <div
      className={`
        bg-panel border rounded-lg p-4
        cursor-pointer transition-colors
        ${isSelected
          ? 'border-accent ring-1 ring-accent'
          : 'border-border hover:border-accent'
        }
      `}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      data-testid={`system-card-${filePath}`}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick(e as unknown as MouseEvent);
        }
      }}
    >
      <h3 className="text-lg font-medium mb-1">{name}</h3>
      {location && (
        <p className="text-sm text-text-secondary mb-3">{location}</p>
      )}

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-text-secondary">Sections:</span>{' '}
          <span>{sectionCount}</span>
        </div>
        <div>
          <span className="text-text-secondary">Length:</span>{' '}
          <span>{formatLength(totalLength)}</span>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-border text-xs text-text-secondary">
        Modified: {formatDate(modifiedAt)}
      </div>
    </div>
  );
}
