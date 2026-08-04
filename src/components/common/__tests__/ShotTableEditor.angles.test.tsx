/**
 * Editing the displayed average must OFFSET both legs, not flatten them.
 *
 * The editor used to set azimuth_in and azimuth_out to the typed value outright.
 * That was invisible while the average was the only azimuth column on screen -
 * and it silently destroyed the reciprocal spread, which is the whole reason a
 * shot has two legs. Now that the eye menu can show the legs beside the average,
 * a flatten would be plainly wrong on screen, so this pins the data table's rule:
 * both legs move by (new mean - old mean).
 *
 * `.tsx` so vitest runs it under jsdom. The grid is virtualized and jsdom gives
 * the virtualizer no layout to measure, so without this mock it renders zero rows
 * and every cell query fails - the same shim the grid's own component tests use.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: 33 + index * 33,
        size: 33,
      })),
    getTotalSize: () => count * 33,
    scrollToIndex: () => {},
  }),
}));

import { render, screen, fireEvent } from '@testing-library/react';
import { ShotTableEditor } from '../ShotTableEditor';
import type { EditableShot } from '../editableShot';

const shot = (over: Partial<EditableShot> = {}): EditableShot => ({
  id: 1,
  length: 10,
  // Mean 100, legs 20 apart. A flatten would put both at the typed value; an
  // offset keeps them 20 apart around the new mean.
  azimuth_in: 90,
  azimuth_out: 110,
  depth_in: -1,
  depth_out: -2,
  pitch_in: 4,
  pitch_out: 6,
  left: null,
  right: null,
  up: null,
  down: null,
  comment: null,
  kind: 'Normal',
  ...over,
});

beforeAll(() => {
  // jsdom has no ResizeObserver; the editor measures its grid box with one.
  if (typeof ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

/** Type a value into a cell and commit it with Enter. */
function editCell(testId: string, value: string) {
  const cell = screen.getByTestId(testId);
  fireEvent.doubleClick(cell);
  const editor = screen.getByTestId('shot-editor-cell-editor');
  fireEvent.change(editor, { target: { value } });
  fireEvent.keyDown(editor, { key: 'Enter' });
}

describe('ShotTableEditor averaged-angle edits', () => {
  it('offsets both azimuth legs by the delta, preserving their spread', () => {
    const onShotChange = vi.fn();
    render(
      <ShotTableEditor
        shots={[shot()]}
        onShotChange={onShotChange}
        onAddShot={vi.fn()}
        onDeleteShot={vi.fn()}
      />
    );
    editCell('shot-cell-0-_azimuth_avg', '200');

    const written = Object.fromEntries(
      onShotChange.mock.calls.map(([, field, value]) => [field, value])
    );
    // Mean was 100, so +100 to each leg - NOT both set to 200.
    expect(written.azimuth_in).toBeCloseTo(190);
    expect(written.azimuth_out).toBeCloseTo(210);
  });

  it('offsets both inclination legs the same way', () => {
    const onShotChange = vi.fn();
    render(
      <ShotTableEditor
        shots={[shot()]}
        onShotChange={onShotChange}
        onAddShot={vi.fn()}
        onDeleteShot={vi.fn()}
      />
    );
    // The inclination average ships hidden, so reveal it the way a user would.
    fireEvent.click(screen.getByTestId('shot-editor-columns-menu'));
    fireEvent.click(screen.getByTestId('shot-editor-col-inclination-avg'));
    editCell('shot-cell-0-_pitch_avg', '15');

    const written = Object.fromEntries(
      onShotChange.mock.calls.map(([, field, value]) => [field, value])
    );
    // Mean was 5, so +10 to each leg.
    expect(written.pitch_in).toBeCloseTo(14);
    expect(written.pitch_out).toBeCloseTo(16);
  });

  it('opens with the legs and the inclination family hidden', () => {
    render(
      <ShotTableEditor
        shots={[shot()]}
        onShotChange={vi.fn()}
        onAddShot={vi.fn()}
        onDeleteShot={vi.fn()}
      />
    );
    expect(screen.getByTestId('shot-cell-0-_azimuth_avg')).toBeInTheDocument();
    for (const key of ['azimuth_in', 'azimuth_out', '_pitch_avg', 'pitch_in', 'pitch_out']) {
      expect(screen.queryByTestId(`shot-cell-0-${key}`)).toBeNull();
    }
  });
});
