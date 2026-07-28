/**
 * The station-index domains the zero-datum import has to agree on (#24).
 *
 * `ZeroDatumConfigDialog` writes ONE `stationIndex` from two pickers, and used
 * to feed it to a third consumer, each in a different index space:
 *   - the dropdown counts surviving editable rows (`survivors + 1` options);
 *   - `SectionPreview` numbers the dots it draws, i.e. the section's
 *     `shot_type === 'Standard'` shots, from 0;
 *   - `adjustStationForDeletedShots` maps from the `EditableShot.id` space,
 *     which is a position in the `isImportableDmpShot`-filtered file order.
 *
 * Those three coincide only for a section with no non-Standard shots, no
 * length-1 shots and no deletions. This file pins the first two back together:
 * the preview is now built with `editableShotsToDmpSection`, so the dots it
 * draws are exactly the dialog's stations.
 *
 * `.tsx` so vitest runs it under jsdom - `SectionPreview` imports maplibre-gl at
 * module load, which the node tier cannot execute.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ default: {} }));

import { computeStationsFromDmpShots } from '../../components/Dialogs/SectionPreview';
import { convertToEditableShots } from '../../hooks/useImportState';
import { editableShotsToDmpSection } from '../shotConversion';
import type { DmpSection, DmpShot } from '../../types/commands';
import type { EditableShot } from '../../components/common/ShotTableEditor';

function standardShot(length: number): DmpShot {
  return {
    shot_type: 'Standard',
    heading_in: 10,
    heading_out: 10,
    length,
    depth_in: 0,
    depth_out: 0,
    pitch_in: 0,
    pitch_out: 0,
    left: 0,
    right: 0,
    up: 0,
    down: 0,
    temperature: 0,
    hour: 0,
    minute: 0,
    second: 0,
    marker_index: 0,
  };
}

function section(shots: DmpShot[]): DmpSection {
  return {
    version: 1,
    name: 'Anchor',
    direction: 'in',
    date: '2026-01-01',
    shots,
    content_hash: 'hash-anchor',
  };
}

/** The dialog's `stationCount`: one station per surviving shot, plus the far end. */
function dialogStationCount(shots: EditableShot[]): number {
  return shots.filter((s) => !s.isDeleted).length + 1;
}

/** The dots `SectionPreview` actually draws for a section. */
function clickableDots(preview: DmpSection): number {
  return computeStationsFromDmpShots(preview.shots.filter((s) => s.shot_type === 'Standard')).length;
}

describe('zero-datum station domains', () => {
  it('a length-1 shot desynchronises the raw preview from the shot table, with nothing deleted', () => {
    // A plain DMP section: four Standard shots, one of them the length-1 filler
    // the importer skips by default.
    const raw = section([standardShot(5), standardShot(1), standardShot(5), standardShot(5)]);
    const editable = convertToEditableShots(raw.shots);

    expect(editable).toHaveLength(3);
    expect(dialogStationCount(editable)).toBe(4);

    // What the preview used to draw: the raw section, five clickable dots for a
    // dialog that only offers four stations. Clicking the last dot committed a
    // station the dropdown cannot even name.
    expect(clickableDots(raw)).toBe(5);

    // What it draws now.
    expect(clickableDots(editableShotsToDmpSection(raw, editable))).toBe(dialogStationCount(editable));
  });

  it('a deletion keeps the dots and the dropdown in step', () => {
    const raw = section([standardShot(5), standardShot(5), standardShot(5)]);
    const editable = convertToEditableShots(raw.shots);
    const afterDelete = editable.map((s, i) => (i === 0 ? { ...s, isDeleted: true } : s));

    expect(dialogStationCount(afterDelete)).toBe(3);
    expect(clickableDots(raw)).toBe(4);
    expect(clickableDots(editableShotsToDmpSection(raw, afterDelete))).toBe(3);
  });

  it('emits every surviving row as Standard so the preview filter cannot drop one', () => {
    const raw = section([standardShot(5), standardShot(5)]);
    const editable = convertToEditableShots(raw.shots);
    // A row the user re-typed to length 1 must still be drawn and still be
    // sent: `isImportableDmpShot` is an import-time default, not a live filter.
    const edited = editable.map((s, i) => (i === 0 ? { ...s, length: 1 } : s));

    const preview = editableShotsToDmpSection(raw, edited);
    expect(preview.shots.every((s) => s.shot_type === 'Standard')).toBe(true);
    expect(clickableDots(preview)).toBe(dialogStationCount(edited));
  });

  it('carries the raw section identity through, only rewriting the geometry', () => {
    const raw = section([standardShot(5), standardShot(5)]);
    const preview = editableShotsToDmpSection(raw, convertToEditableShots(raw.shots));
    expect(preview.name).toBe(raw.name);
    expect(preview.content_hash).toBe(raw.content_hash);
    expect(preview.direction).toBe(raw.direction);
  });
});
