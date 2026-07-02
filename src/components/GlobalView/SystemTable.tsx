import { type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatDate as formatDateIntl,
  formatNumber,
  formatRelativeTime,
} from '../../i18n/format';
import { ElidedPath, Tooltip, ChevronUpIcon, ChevronDownIcon } from '../common';
import { useProjectStatFormatters } from './useProjectStatFormatters';
import type { RecentListItem } from './recentListItems';
import type { RecentSortField, RecentSortDirection } from './useRecentSort';
import { SpeleoRecentInfo, resolveSpeleoLock } from './SpeleoLockBadge';

interface SystemTableProps {
  items: RecentListItem[];
  selectedProjectId: string | null;
  multiSelectedIds: Set<string>;
  sortField: RecentSortField;
  sortDirection: RecentSortDirection;
  /** SpeleoDB lock state per project id, from the login/app-open scan (#201). */
  remoteLocks: Record<string, string | null>;
  /** SpeleoDB project name per project id, from the same scan (#201). */
  remoteProjects: Record<string, string>;
  /** Current user's email, to tell our own held lock from another's (#201). */
  myEmail: string | null;
  /** Toggle/apply sorting when a sortable column header is clicked. */
  onSort: (field: RecentSortField) => void;
  onSelect: (filePath: string, ctrlKey: boolean) => void;
  onOpen: (filePath: string) => void;
  onContextMenu: (e: MouseEvent, filePath: string) => void;
  onRemoveMissing: (filePath: string) => void;
}

interface ColumnDef {
  key: string;
  /** Sort field this column maps to, or undefined if it isn't sortable. */
  field?: RecentSortField;
  align: 'left' | 'right';
}

const COLUMNS: ColumnDef[] = [
  { key: 'name', field: 'name', align: 'left' },
  { key: 'path', align: 'left' },
  { key: 'sections', field: 'sections', align: 'right' },
  { key: 'length', field: 'length', align: 'right' },
  { key: 'edited', field: 'last_edited', align: 'left' },
];

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
  sortField,
  sortDirection,
  remoteLocks,
  remoteProjects,
  myEmail,
  onSort,
  onSelect,
  onOpen,
  onContextMenu,
  onRemoveMissing,
}: SystemTableProps) {
  const { t } = useTranslation();
  const { formatLength } = useProjectStatFormatters();

  const headerClass = 'text-xs font-medium text-text-secondary px-3 py-2 sticky top-0 bg-background z-10';
  const cellClass = 'px-3 py-2 text-sm';

  const renderHeader = (col: ColumnDef) => {
    const label = t(`globalView.recent.columns.${col.key}`);
    const alignClass = col.align === 'right' ? 'text-right' : 'text-left';
    const isActive = col.field !== undefined && sortField === col.field;
    const ariaSort = isActive ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined;

    if (!col.field) {
      return (
        <th key={col.key} className={`${headerClass} ${alignClass}`}>{label}</th>
      );
    }

    const field = col.field;
    return (
      <th key={col.key} className={`${headerClass} ${alignClass}`} aria-sort={ariaSort}>
        <button
          type="button"
          onClick={() => onSort(field)}
          className={`inline-flex items-center gap-1 hover:text-text ${
            isActive ? 'text-text' : ''
          }`}
          aria-label={t('globalView.recent.sortByColumn', { column: label })}
          data-testid={`recent-col-${col.key}`}
        >
          <span>{label}</span>
          {isActive &&
            (sortDirection === 'asc' ? (
              <ChevronUpIcon size={14} />
            ) : (
              <ChevronDownIcon size={14} />
            ))}
        </button>
      </th>
    );
  };

  return (
    <table className="w-full border-collapse" data-testid="globalview-list-table">
      <thead>
        <tr className="border-b border-border">
          {COLUMNS.map(renderHeader)}
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
          const lock = resolveSpeleoLock(project, remoteLocks, myEmail, remoteProjects);
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
                <span>{project.name}</span>
                {project.location && (
                  <span className="text-text-secondary"> · {project.location}</span>
                )}
              </td>
              <td className={cellClass}>
                {/* SpeleoDB projects show the mark + lock state instead of the local
                    path (irrelevant for a linked project, #201); local ones show it. */}
                {lock.isRemote ? (
                  <SpeleoRecentInfo info={lock} name={project.name} />
                ) : (
                  <ElidedPath path={item.filePath} className="text-xs text-text-tertiary" />
                )}
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
