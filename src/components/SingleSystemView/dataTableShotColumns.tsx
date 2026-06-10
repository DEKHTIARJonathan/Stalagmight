/**
 * GridColumn<Shot> factory for the data-table shots view (issue #61).
 *
 * Mirrors the previous EditableTable columns (order, widths, formatting) but as
 * SpreadsheetGrid column configs with parse/validate/kind/isEditable. Frozen-shot
 * policy: azimuth/length/depth are network-adjusted and locked on a frozen shot;
 * LRUD + comment stay editable (they don't touch the centerline geometry, and the
 * Rust `update_shot` permits them on frozen shots). The whole view is read-only in
 * the closure-adjusted geometry mode (`geometryReadOnly`).
 */
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type { Shot } from '../../types/project';
import type { GridColumn } from '../common/SpreadsheetGrid/types';
import { AlertCircleIcon, AlertTriangleIcon, DotIcon, LockIcon } from '../common/icons';
import { circularMeanDegrees } from '../../utils/angles';
import { formatFixed } from '../../i18n/format';
import type { ProjectWarning } from '../../types/commands';
import { AZIMUTH_AVG_KEY } from './dataTableEdits';

/** Columns whose edits touch the adjusted centerline geometry → locked on a frozen
 *  shot (matches the Rust `ShotUpdates::touches_geometry` set, minus LRUD). */
const FROZEN_LOCKED = new Set<string>(['length', AZIMUTH_AVG_KEY, 'depth_in', 'depth_out']);

export interface ShotColumnContext {
  t: TFunction;
  precision: { length: number; azimuth: number; depth: number };
  sectionId: number | null;
  geometryReadOnly: boolean;
  isShotFrozen: (sectionId: number, shotIndex: number) => boolean;
  getShotWarnings: (sectionId: number, shotId: number) => ProjectWarning[];
  /** Toggle a shot's reference flag (the inline dot control). */
  onToggleReference: (shot: Shot) => void;
}

const fixed = (precision: number) => (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? formatFixed(value, undefined, precision) : '';

export function buildShotColumns(ctx: ShotColumnContext): GridColumn<Shot>[] {
  const { t, precision, sectionId, geometryReadOnly, isShotFrozen, getShotWarnings } = ctx;

  // Editable iff the view is writable AND (non-geometry, or a non-frozen shot).
  const editableUnlessFrozenGeometry =
    (key: string) =>
    (_row: Shot, rowIndex: number): boolean => {
      if (geometryReadOnly) return false;
      if (FROZEN_LOCKED.has(key) && sectionId !== null) return !isShotFrozen(sectionId, rowIndex);
      return true;
    };

  const numberCol = (
    key: 'length' | 'depth_in' | 'depth_out',
    header: string,
    width: number,
    prec: number,
    validate?: (v: unknown) => string | null,
  ): GridColumn<Shot> => ({
    key,
    header,
    width,
    align: 'right',
    kind: 'number',
    getValue: (r) => r[key],
    format: fixed(prec),
    editable: true,
    isEditable: editableUnlessFrozenGeometry(key),
    ...(validate ? { validate } : {}),
  });

  const lrudCol = (key: 'left' | 'right' | 'up' | 'down', header: string): GridColumn<Shot> => ({
    key,
    header,
    width: 50,
    align: 'right',
    kind: 'number-nullable',
    getValue: (r) => r[key],
    format: fixed(precision.length),
    editable: true,
    isEditable: editableUnlessFrozenGeometry(key), // not in FROZEN_LOCKED → editable on frozen
    validate: (v) => (typeof v === 'number' && v < 0 ? t('dataTable.validation.negativeLrud') : null),
  });

  return [
    {
      key: '_warnings',
      header: t('dataTable.columns.warningsShort'),
      width: 30,
      align: 'center',
      getValue: () => '',
      render: (shot, index): ReactNode => {
        if (sectionId === null) return null;
        const frozen = isShotFrozen(sectionId, index);
        const shotWarnings = getShotWarnings(sectionId, shot.id).filter((w) => !w.isResolved);
        if (shotWarnings.length === 0 && !frozen) return null;
        const hasError = shotWarnings.some((w) => w.severity === 'error');
        const tooltip = [
          ...(frozen ? [t('dataTable.frozen')] : []),
          ...shotWarnings.map((w) => w.message),
        ].join('\n');
        return (
          <span
            data-testid={frozen ? `frozen-${sectionId}-${shot.id}` : `warning-${sectionId}-${shot.id}`}
            className={hasError ? 'text-error' : frozen && shotWarnings.length === 0 ? 'text-text-secondary' : 'text-warning'}
            title={tooltip}
          >
            {frozen && shotWarnings.length === 0 ? (
              <LockIcon size={13} />
            ) : hasError ? (
              <AlertCircleIcon size={14} />
            ) : (
              <AlertTriangleIcon size={14} />
            )}
          </span>
        );
      },
    },
    numberCol('length', t('dataTable.columns.length', { unit: t('common.units.meters') }), 100, precision.length, (v) =>
      typeof v === 'number' && v <= 0 ? t('dataTable.validation.nonPositiveLength') : null,
    ),
    {
      key: AZIMUTH_AVG_KEY,
      header: t('dataTable.columns.azimuthShort'),
      width: 70,
      align: 'right',
      kind: 'number',
      getValue: (r) => circularMeanDegrees(r.azimuth_in, r.azimuth_out),
      format: fixed(precision.azimuth),
      editable: true,
      isEditable: editableUnlessFrozenGeometry(AZIMUTH_AVG_KEY),
      validate: (v) => (typeof v === 'number' && (v < 0 || v >= 360) ? t('dataTable.validation.azimuthRange') : null),
    },
    numberCol('depth_in', t('dataTable.columns.depthIn'), 80, precision.depth),
    numberCol('depth_out', t('dataTable.columns.depthOut'), 95, precision.depth),
    lrudCol('left', t('dataTable.columns.leftShort')),
    lrudCol('right', t('dataTable.columns.rightShort')),
    lrudCol('up', t('dataTable.columns.upShort')),
    lrudCol('down', t('dataTable.columns.downShort')),
    {
      key: 'is_reference',
      header: t('dataTable.columns.referenceShort'),
      width: 40,
      align: 'center',
      getValue: (r) => r.is_reference,
      render: (shot): ReactNode => (
        <span
          className={`flex items-center justify-center ${geometryReadOnly ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!geometryReadOnly) ctx.onToggleReference(shot);
          }}
          title={shot.is_reference ? t('detailPanel.shot.markPermanent') : t('detailPanel.shot.markReference')}
        >
          {shot.is_reference ? (
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
      key: 'comment',
      header: t('dataTable.columns.comment'),
      width: 240,
      kind: 'text',
      getValue: (r) => r.comment ?? '',
      editable: true,
      isEditable: editableUnlessFrozenGeometry('comment'), // not locked on frozen
      parse: (raw) => (raw.trim() === '' ? null : raw), // empty/whitespace clears to null
    },
  ];
}
