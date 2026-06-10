/**
 * GridColumn<Station> factory for the data-table stations view (issue #61).
 *
 * Mirrors the previous EditableTable columns (order, widths, formatting) as
 * SpreadsheetGrid column configs. Stations are derived from shots, so X/Y/Depth
 * are read-only; only the comment is editable (and never in the read-only
 * closure-adjusted geometry mode). The index pill moved to the row gutter. The
 * GPS (zero-datum) cell is a click target that opens the Edit Station dialog.
 */
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type { Station } from '../../types/project';
import type { GridColumn } from '../common/SpreadsheetGrid/types';
import { DotIcon, LinkIcon } from '../common/icons';
import { formatFixed } from '../../i18n/format';

export interface StationColumnContext {
  t: TFunction;
  precision: { coordinates: number; depth: number };
  geometryReadOnly: boolean;
  /** Click on the GPS (zero-datum) cell — opens the Edit Station dialog in
   *  the mode matching the station's zero-datum state. */
  onGpsCellClick: (station: Station) => void;
}

const fixed = (precision: number) => (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? formatFixed(value, undefined, precision) : '';

export function buildStationColumns(ctx: StationColumnContext): GridColumn<Station>[] {
  const { t, precision, geometryReadOnly } = ctx;

  const coordCol = (key: '_x' | '_y' | '_depth', header: string, prec: number): GridColumn<Station> => ({
    key,
    header,
    width: 90,
    align: 'right',
    getValue: (r) => (key === '_x' ? r.coordinates.x : key === '_y' ? r.coordinates.y : r.coordinates.z),
    format: fixed(prec),
  });

  return [
    coordCol('_x', t('dataTable.stationColumns.x'), precision.coordinates),
    coordCol('_y', t('dataTable.stationColumns.y'), precision.coordinates),
    coordCol('_depth', t('dataTable.stationColumns.depth'), precision.depth),
    {
      key: '_zeroDatum',
      header: t('dataTable.stationColumns.zeroDatum'),
      width: 40,
      align: 'center',
      getValue: (r) => r.is_zero_datum,
      format: (v) => (v ? 'true' : 'false'),
      // The clickable dot follows the shots view's J/R pattern: the set state
      // renders a dot, the unset one a hover affordance; either opens the
      // Edit Station dialog (add-zero-datum or edit mode).
      render: (station): ReactNode => (
        <span
          className="flex cursor-pointer items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onGpsCellClick(station);
          }}
          title={t('dataTable.stationGps.edit')}
          data-testid={`station-gps-${station.station_ref.section_id}-${station.station_ref.station_index}`}
        >
          {station.is_zero_datum ? (
            <DotIcon size={20} />
          ) : (
            <span className="opacity-0 hover:opacity-30">
              <DotIcon size={20} />
            </span>
          )}
        </span>
      ),
    },
    {
      key: '_connections',
      header: t('dataTable.stationColumns.connections'),
      width: 60,
      align: 'center',
      getValue: (r) => (r.merged_with?.length ?? 0) + (r.closures_with?.length ?? 0) || '',
      render: (station): ReactNode => {
        const mergeCount = station.merged_with?.length ?? 0;
        const closureCount = station.closures_with?.length ?? 0;
        const total = mergeCount + closureCount;
        if (total === 0) return null;
        const tooltipParts: string[] = [];
        if (mergeCount > 0) {
          tooltipParts.push(`Merges: ${station.merged_with.map((m) => `${m.section_id}.${m.station_index}`).join(', ')}`);
        }
        if (closureCount > 0) {
          tooltipParts.push(`Closures: ${closureCount}`);
        }
        return (
          <span className="inline-flex items-center justify-center gap-1" title={tooltipParts.join('\n')}>
            <LinkIcon size={12} />{total}
          </span>
        );
      },
    },
    {
      key: 'comment',
      header: t('dataTable.stationColumns.comment'),
      width: 240,
      kind: 'text',
      getValue: (r) => r.comment ?? '',
      editable: !geometryReadOnly,
      parse: (raw) => (raw.trim() === '' ? null : raw), // empty/whitespace clears to null
    },
  ];
}
