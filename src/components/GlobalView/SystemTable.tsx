import { type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatDate as formatDateIntl,
  formatNumber,
  formatRelativeTime,
} from '../../i18n/format';
import { ElidedPath, Tooltip } from '../common';
import { useProjectStatFormatters } from './useProjectStatFormatters';
import type { RecentListItem } from './recentListItems';

interface SystemTableProps {
  items: RecentListItem[];
  selectedProjectId: string | null;
  multiSelectedIds: Set<string>;
  onSelect: (filePath: string, ctrlKey: boolean) => void;
  onOpen: (filePath: string) => void;
  onContextMenu: (e: MouseEvent, filePath: string) => void;
  onRemoveMissing: (filePath: string) => void;
}

function relative(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return dateStr;
    return formatRelativeTime(date);
  } catch {
    return dateStr;
  }
}

function absolute(dateStr: string): string {
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
}

/**
 * Compact, single-row-per-project view of the recent-projects list. Mirrors the
 * card grid's interactions (click to select, Ctrl/Cmd-click to multi-select,
 * double-click to open, right-click for the context menu) and renders missing
 * projects as de-emphasized rows with a remove action.
 */
export function SystemTable({
  items,
  selectedProjectId,
  multiSelectedIds,
  onSelect,
  onOpen,
  onContextMenu,
  onRemoveMissing,
}: SystemTableProps) {
  const { t } = useTranslation();
  const { formatLength } = useProjectStatFormatters();

  const headerClass = 'text-left text-xs font-medium text-text-secondary px-3 py-2 sticky top-0 bg-background z-10';
  const cellClass = 'px-3 py-2 text-sm';

  return (
    <table className="w-full border-collapse" data-testid="globalview-list-table">
      <thead>
        <tr className="border-b border-border">
          <th className={headerClass}>{t('globalView.recent.columns.name')}</th>
          <th className={headerClass}>{t('globalView.recent.columns.path')}</th>
          <th className={`${headerClass} text-right`}>{t('globalView.recent.columns.sections')}</th>
          <th className={`${headerClass} text-right`}>{t('globalView.recent.columns.length')}</th>
          <th className={headerClass}>{t('globalView.recent.columns.edited')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          if (item.kind === 'missing') {
            return (
              <tr
                key={item.filePath}
                className="border-b border-border opacity-70"
                data-testid={`system-row-missing-${item.filePath}`}
                data-missing="true"
              >
                <td className={`${cellClass} text-text-secondary line-through decoration-1`}>{item.name}</td>
                <td className={cellClass}>
                  <ElidedPath path={item.filePath} className="text-xs text-text-tertiary" />
                </td>
                <td className={`${cellClass} text-warning text-right`} colSpan={2}>
                  {t('globalView.recent.missing.notFound')}
                </td>
                <td className={cellClass}>
                  <button
                    type="button"
                    onClick={() => onRemoveMissing(item.filePath)}
                    className="text-xs text-text-secondary hover:text-danger underline"
                    data-testid={`system-row-missing-remove-${item.filePath}`}
                  >
                    {t('globalView.recent.missing.remove')}
                  </button>
                </td>
              </tr>
            );
          }

          const { project } = item;
          const isSelected =
            multiSelectedIds.has(item.filePath) || selectedProjectId === item.filePath;

          return (
            <tr
              key={item.filePath}
              className={`border-b border-border cursor-pointer transition-colors ${
                isSelected ? 'bg-accent-10' : 'hover:bg-panel'
              }`}
              data-testid={`system-row-${item.filePath}`}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              onClick={(e) => onSelect(item.filePath, e.ctrlKey || e.metaKey)}
              onDoubleClick={() => onOpen(item.filePath)}
              onContextMenu={(e) => onContextMenu(e, item.filePath)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(item.filePath, e.ctrlKey || e.metaKey);
                }
              }}
            >
              <td className={`${cellClass} font-medium`}>
                {project.name}
                {project.location && (
                  <span className="text-text-secondary"> · {project.location}</span>
                )}
              </td>
              <td className={cellClass}>
                <ElidedPath path={item.filePath} className="text-xs text-text-tertiary" />
              </td>
              <td className={`${cellClass} text-right tabular-nums`}>{formatNumber(project.section_count)}</td>
              <td className={`${cellClass} text-right tabular-nums`}>{formatLength(project.total_length)}</td>
              <td className={`${cellClass} text-text-secondary`}>
                <Tooltip content={absolute(project.modified_at)}>
                  <span data-testid={`system-row-modified-${item.filePath}`}>{relative(project.modified_at)}</span>
                </Tooltip>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default SystemTable;
