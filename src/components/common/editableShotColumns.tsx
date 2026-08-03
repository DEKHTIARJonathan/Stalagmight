/**
 * GridColumn factory for the editable-shot grid behind `ShotTableEditor`.
 *
 * The rows here are `EditableShot` - a shot that has not been committed yet, so
 * it carries `isNew` / `isDeleted` / `tempId` on top of the real fields. That is
 * why this cannot just reuse `dataTableShotColumns`: those read a committed
 * `Shot` and take their warnings from the project's warning set, while these
 * derive warnings locally from the validation thresholds.
 *
 * Frozen policy matches the data table's: azimuth/length/depth are
 * network-adjusted and locked on a frozen shot; LRUD and comment stay editable.
 */
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type { GridColumn } from './SpreadsheetGrid/types';
import { AlertCircleIcon, AlertTriangleIcon, CloseIcon } from './icons';
import { formatFixed } from '../../i18n/format';
import { getAzimuthAverage } from '../../utils/shotTable';
import {
  SHOT_KIND_CLASS,
  SHOT_KIND_LABEL_KEY,
  nextShotKind,
  shotKindGlyph,
} from '../../utils/shotKind';
import type { ShotKind } from '../../types/ipc/ShotKind';
import type { EditableShot } from './editableShot';

/** Virtual column key for the displayed average azimuth (not a real field). */
export const EDITABLE_AZIMUTH_AVG_KEY = '_azimuth_avg';
/** Virtual column key for the per-row warning indicator. */
export const EDITABLE_WARNINGS_KEY = '_warnings';
/** Virtual column key for the per-row delete button. */
export const EDITABLE_DELETE_KEY = '_delete';

/** Columns whose edits touch the adjusted centerline -> locked on a frozen shot. */
const FROZEN_LOCKED = new Set<string>([
  'length',
  EDITABLE_AZIMUTH_AVG_KEY,
  'depth_in',
  'depth_out',
]);

export interface EditableShotColumnContext {
  t: TFunction;
  precision: { length: number; azimuth: number; depth: number };
  readOnly: boolean;
  /** Blocking errors per VISIBLE row index (length/azimuth validity). */
  errorsAt: (visibleIndex: number) => string[];
  /** Threshold warnings per VISIBLE row index (azimuth/pitch discrepancy). */
  warningsAt: (visibleIndex: number) => string[];
  /** Whether the shot at this VISIBLE row index is frozen. */
  isFrozenAt: (visibleIndex: number) => boolean;
  /** Delete the shot at this VISIBLE row index. These tables are short enough
   *  that a visible per-row control beats making the context menu the only way
   *  out - and the hosts' tests have always driven deletion through it. */
  onDeleteAt: (visibleIndex: number) => void;
  /** Advance the shot's kind around Normal -> Jump -> Reference; `-1` walks it
   *  backwards (shift-click). */
  onCycleKindAt: (visibleIndex: number, direction: 1 | -1) => void;
  /** The trailing blank row, which is an invitation rather than a shot: it gets
   *  no delete control and no kind glyph until something is typed into it. */
  isPhantomAt: (visibleIndex: number) => boolean;
}

const fixed = (precision: number) => (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? formatFixed(value, undefined, precision)
    : '';

export function buildEditableShotColumns(
  ctx: EditableShotColumnContext
): GridColumn<EditableShot>[] {
  const {
    t,
    precision,
    readOnly,
    errorsAt,
    warningsAt,
    isFrozenAt,
    onDeleteAt,
    onCycleKindAt,
    isPhantomAt,
  } = ctx;

  const editableUnlessFrozen =
    (key: string) =>
    (_row: EditableShot, rowIndex: number): boolean => {
      if (readOnly) return false;
      return !(FROZEN_LOCKED.has(key) && isFrozenAt(rowIndex));
    };

  const numberCol = (
    key: 'length' | 'depth_in' | 'depth_out',
    header: string,
    width: number,
    prec: number
  ): GridColumn<EditableShot> => ({
    key,
    header,
    width,
    align: 'right',
    kind: 'number',
    getValue: (r) => r[key],
    format: fixed(prec),
    editable: true,
    isEditable: editableUnlessFrozen(key),
  });

  const lrudCol = (
    key: 'left' | 'right' | 'up' | 'down',
    header: string
  ): GridColumn<EditableShot> => ({
    key,
    header,
    width: 50,
    align: 'right',
    kind: 'number-nullable',
    getValue: (r) => r[key],
    format: fixed(precision.length),
    editable: true,
    isEditable: editableUnlessFrozen(key), // not frozen-locked
    validate: (v) =>
      typeof v === 'number' && v < 0 ? t('dataTable.validation.negativeLrud') : null,
  });

  return [
    {
      key: EDITABLE_WARNINGS_KEY,
      header: '',
      width: 30,
      align: 'center',
      getValue: () => '',
      render: (_shot, index): ReactNode => {
        const errors = errorsAt(index);
        const warnings = warningsAt(index);
        if (errors.length === 0 && warnings.length === 0) return null;
        const hasErrors = errors.length > 0;
        // The data table's indicator, icon for icon: a triangle for a warning, a
        // filled circle for an error, tinted by severity, with the messages in
        // the tooltip. The old table's "!" badge was its own idiom.
        return (
          <span
            data-testid={`shot-warning-${index}`}
            className={hasErrors ? 'text-error' : 'text-warning'}
            title={[...errors, ...warnings].join('\n')}
            aria-label={hasErrors ? t('shotTable.warnings.error') : t('shotTable.warnings.warning')}
          >
            {hasErrors ? <AlertCircleIcon size={14} /> : <AlertTriangleIcon size={14} />}
          </span>
        );
      },
    },
    numberCol('length', t('shotTable.columns.length'), 100, precision.length),
    {
      key: EDITABLE_AZIMUTH_AVG_KEY,
      header: t('shotTable.columns.azimuth'),
      width: 70,
      align: 'right',
      kind: 'number',
      // The editor has always shown ONE azimuth: the average of the two legs,
      // with a commit fanning back out to both (applyAzimuthEdit).
      getValue: (r) => getAzimuthAverage(r.azimuth_in, r.azimuth_out),
      format: fixed(precision.azimuth),
      editable: true,
      isEditable: editableUnlessFrozen(EDITABLE_AZIMUTH_AVG_KEY),
      validate: (v) =>
        typeof v === 'number' && (v < 0 || v >= 360)
          ? t('dataTable.validation.azimuthRange')
          : null,
    },
    numberCol('depth_in', t('shotTable.columns.depthIn'), 80, precision.depth),
    numberCol('depth_out', t('shotTable.columns.depthOut'), 95, precision.depth),
    lrudCol('left', t('shotTable.columns.leftShort')),
    lrudCol('right', t('shotTable.columns.rightShort')),
    lrudCol('up', t('shotTable.columns.upShort')),
    lrudCol('down', t('shotTable.columns.downShort')),
    {
      key: 'kind',
      header: t('dataTable.columns.referenceShort'),
      width: 40,
      align: 'center',
      kind: 'text',
      getValue: (r) => r.kind,
      format: (v) => shotKindGlyph(v as ShotKind),
      editable: true,
      isEditable: () => !readOnly,
      // A three-state button, so no cell editor - same as the other two grids.
      noInlineEdit: true,
      parse: (raw) => {
        const v = raw.trim().toLowerCase();
        if (v === '' || v === 'n' || v === 'normal' || v === 'permanent') return 'Normal';
        if (v === 'j' || v === 'jump') return 'Jump';
        if (v === 'r' || v === 'ref' || v === 'reference') return 'Reference';
        return undefined;
      },
      render: (shot, index): ReactNode => {
        if (isPhantomAt(index)) return null;
        const glyph = shotKindGlyph(shot.kind);
        return (
          <span
            data-testid="shot-kind-cell"
            data-kind={shot.kind}
            role={readOnly ? undefined : 'button'}
            tabIndex={readOnly ? undefined : -1}
            aria-label={t(SHOT_KIND_LABEL_KEY[shot.kind])}
            className={`group flex h-full w-full items-center justify-center font-semibold ${
              SHOT_KIND_CLASS[shot.kind]
            } ${readOnly ? 'cursor-default' : 'cursor-pointer'}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!readOnly) onCycleKindAt(index, e.shiftKey ? -1 : 1);
            }}
            title={t('dataTable.columns.kindCycleHint', {
              current: t(SHOT_KIND_LABEL_KEY[shot.kind]),
              next: t(SHOT_KIND_LABEL_KEY[nextShotKind(shot.kind, 1)]),
            })}
          >
            {glyph === '' ? <span className="opacity-0 group-hover:opacity-40">J</span> : glyph}
          </span>
        );
      },
    },
    {
      key: 'comment',
      header: t('shotTable.columns.comment'),
      width: 140,
      grow: true,
      kind: 'text',
      multiline: true,
      getValue: (r) => r.comment ?? '',
      editable: !readOnly,
      parse: (raw) => (raw.trim() === '' ? null : raw),
    },
    ...(readOnly
      ? []
      : [
          {
            key: EDITABLE_DELETE_KEY,
            header: '',
            width: 30,
            align: 'center' as const,
            getValue: () => '',
            render: (_shot: EditableShot, index: number): ReactNode =>
              isPhantomAt(index) ? null : (
              <button
                type="button"
                data-testid={`shot-delete-${index}`}
                aria-label={t('shotTable.actions.delete')}
                title={t('shotTable.actions.delete')}
                className="text-error hover:text-error-80"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteAt(index);
                }}
              >
                <CloseIcon size={12} />
              </button>
            ),
          },
        ]),
  ];
}
