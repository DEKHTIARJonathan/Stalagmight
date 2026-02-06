import { type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/projectStore';
import { formatDate as formatDateIntl, formatFixed, formatNumber } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';

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
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
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
      return formatDateInternal(dateStr);
    } catch {
      return dateStr;
    }
  };

  const formatDateInternal = (dateStr: string) => {
    const date = new Date(dateStr);
    return formatDateIntl(date, undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatLength = (meters: number) => {
    if (meters >= 1000) {
      return `${formatFixed(meters / 1000, undefined, precision.length)} ${t('common.units.kilometers')}`;
    }
    return `${formatFixed(meters, undefined, precision.length)} ${t('common.units.meters')}`;
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
          <span className="text-text-secondary">{t('globalView.systemCard.sections')}:</span>{' '}
          <span>{formatNumber(sectionCount)}</span>
        </div>
        <div>
          <span className="text-text-secondary">{t('globalView.systemCard.length')}:</span>{' '}
          <span>{formatLength(totalLength)}</span>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-border text-xs text-text-secondary">
        {t('globalView.systemCard.modified', { date: formatDate(modifiedAt) })}
      </div>
    </div>
  );
}
