import { type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/projectStore';
import {
  formatDate as formatDateIntl,
  formatNumber,
  formatRelativeTime,
} from '../../i18n/format';
import { ElidedPath, Tooltip } from '../common';
import { setProjectActionSource } from '../../utils/telemetry';
import { useProjectStatFormatters } from './useProjectStatFormatters';
import { SpeleoRecentInfo, type SpeleoLockInfo } from './SpeleoLockBadge';

interface SystemCardProps {
  name: string;
  location: string | null;
  filePath: string;
  modifiedAt: string;
  sectionCount: number;
  totalLength: number;
  isSelected?: boolean;
  /** SpeleoDB lock state for this entry (#201); a local project renders no badge. */
  speleoLock?: SpeleoLockInfo;
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
  speleoLock,
  onSelect,
  onContextMenu,
}: SystemCardProps) {
  const { t } = useTranslation();
  const { formatLength } = useProjectStatFormatters();
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
    setProjectActionSource('recent-list');
    await loadProject(filePath);
  };

  const handleContextMenu = (e: MouseEvent) => {
    if (onContextMenu) {
      onContextMenu(e);
    }
  };

  // Relative "edited" label (e.g. "2 hours ago"); the exact timestamp is shown
  // in the tooltip below. Falls back to the raw string if the date is invalid.
  const relativeModified = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      if (Number.isNaN(date.getTime())) return dateStr;
      return formatRelativeTime(date);
    } catch {
      return dateStr;
    }
  };

  const absoluteModified = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      if (Number.isNaN(date.getTime())) return dateStr;
      return formatDateIntl(date, undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
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
        <p className="text-sm text-text-secondary mb-1">{location}</p>
      )}
      {/* SpeleoDB projects show the mark + lock state instead of the local path
          (irrelevant for a linked project, #201); local ones show the path. */}
      {speleoLock?.isRemote ? (
        <div className="mb-3" data-testid="system-card-path">
          <SpeleoRecentInfo info={speleoLock} />
        </div>
      ) : (
        <ElidedPath
          path={filePath}
          className="text-xs text-text-tertiary mb-3"
          data-testid="system-card-path"
        />
      )}

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-text-secondary">{t('globalView.systemCard.sections')}:</span>{' '}
          <span>{formatNumber(sectionCount)}</span>
        </div>
        <div>
          <span className="text-text-secondary">{t('globalView.systemCard.length')}:</span>{' '}
          <span>{formatLength(totalLength)}</span>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-border text-xs text-text-secondary">
        <Tooltip content={absoluteModified(modifiedAt)}>
          <span data-testid="system-card-modified">
            {t('globalView.systemCard.modified', { relative: relativeModified(modifiedAt) })}
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
