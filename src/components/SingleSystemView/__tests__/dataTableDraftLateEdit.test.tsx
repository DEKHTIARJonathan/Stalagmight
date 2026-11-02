/**
 * #576 D39(f): a value typed into a new data-table row while that row is being
 * saved as a shot reaches the shot.
 *
 * The draft auto-commit took its create_shot payload the moment the row's
 * required fields were present and, when the create resolved, removed the draft
 * - with whatever the user had typed into it in the meantime (Left, just after
 * the Depth Out that completed the row). The cells stay editable while the create
 * is in flight, and on a large survey that round trip is long. Decided ("Forward
 * as follow-up edit"): the fields that changed since the payload are applied to
 * the created shot with one update_shot once the create lands; the created shot
 * is the one `CommandResult.shot_id` names.
 *
 * Full-component tier, as dataTableDraftSaveFailure.test.tsx: the real DataTable
 * and grid, `createShot` / `updateShot` replaced on the project store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 33, size: 33 })),
    getTotalSize: () => count * 33,
    scrollToIndex: vi.fn(),
  }),
}));

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', () => ({ invokeIpc: invokeIpcMock }));

import DataTable from '../DataTable';
import { AZIMUTH_AVG_KEY } from '../dataTableEdits';
import { useProjectStore } from '../../../store/projectStore';
import { useUIStore } from '../../../store/uiStore';
import { useSpeleoStore } from '../../../store/speleoStore';
import { defaultConfig } from '../../../types/config';
import type { Config } from '../../../types/config';
import type { CommandResult } from '../../../types/commands';
import type { Section, Shot } from '../../../types/project';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const shot = (id: number, length: number): Shot => ({
  id,
  azimuth_in: 10,
  azimuth_out: 10,
  length,
  depth_in: 0,
  depth_out: 1,
  pitch_in: null,
  pitch_out: null,
  left: null,
  right: null,
  up: null,
  down: null,
  comment: null,
  kind: 'Normal',
  marker_index: null,
  temperature: null,
});

const section: Section = {
  id: 1,
  name: 'CaveA',
  surveyor: null,
  date: null,
  color: '#3388ff',
  direction: 'in',
  quality: 0,
  shots: [shot(1, 10), shot(2, 20), shot(3, 30)],
  next_shot_id: 4,
  reverse_parity: false,
  gauge_shot_uuid: null,
  gauge_neighbour_uuid: null,
};

const created = (shotId: number): CommandResult => ({
  success: true,
  warnings: [],
  error: null,
  section_ids: [],
  shot_id: shotId,
});

/** The end draft sits below the three shots. */
const DRAFT_ROW = 3;

function typeCell(row: number, colKey: string, value: string) {
  fireEvent.doubleClick(screen.getByTestId(`grid-cell-${row}-${colKey}`));
  const editor = screen.getByTestId('grid-cell-editor');
  fireEvent.change(editor, { target: { value } });
  fireEvent.keyDown(editor, { key: 'Enter' });
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

/** Fill the draft's four required fields; the last one completes it and starts the create. */
async function completeDraft() {
  typeCell(DRAFT_ROW, 'length', '5');
  typeCell(DRAFT_ROW, AZIMUTH_AVG_KEY, '100');
  typeCell(DRAFT_ROW, 'depth_in', '1');
  typeCell(DRAFT_ROW, 'depth_out', '2');
  await settle();
}

let createShot: ReturnType<typeof vi.fn>;
let updateShot: ReturnType<typeof vi.fn>;
let resolveCreate: (result: CommandResult) => void;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  invokeIpcMock.mockReset();
  invokeIpcMock.mockImplementation((command: string) =>
    Promise.resolve(command === 'get_config' ? structuredClone(defaultConfig) : undefined)
  );
  // A create that is still in flight until the test resolves it.
  createShot = vi.fn(
    () =>
      new Promise<CommandResult>((resolve) => {
        resolveCreate = resolve;
      })
  );
  updateShot = vi.fn(() => Promise.resolve(created(0)));
  useProjectStore.setState({ config: structuredClone(defaultConfig) as Config, createShot, updateShot });
  useUIStore.setState({ toasts: [], selection: null });
  useSpeleoStore.setState({ projectLinkKind: 'local', link: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DataTable draft row edited while its create is in flight (D39(f))', () => {
  it('applies a value typed during the create to the created shot with one update', async () => {
    render(<DataTable sections={[section]} />);
    await completeDraft();
    expect(createShot).toHaveBeenCalledTimes(1);
    expect(createShot.mock.calls[0]?.[1]).toMatchObject({ length: 5, left: null });

    // Left, typed while create_shot is still on the wire.
    typeCell(DRAFT_ROW, 'left', '2.5');
    await act(async () => resolveCreate(created(4)));
    await settle();

    expect(updateShot, 'the late Left value never reached the created shot').toHaveBeenCalledTimes(1);
    expect(updateShot).toHaveBeenCalledWith(1, 4, { left: 2.5 });
  });

  it('sends only what changed since the create was sent - a corrected length and a new comment', async () => {
    render(<DataTable sections={[section]} />);
    await completeDraft();
    typeCell(DRAFT_ROW, 'length', '6');
    typeCell(DRAFT_ROW, 'comment', 'sump');
    await act(async () => resolveCreate(created(4)));
    await settle();

    expect(updateShot).toHaveBeenCalledWith(1, 4, { length: 6, comment: 'sump' });
  });

  it('sends no follow-up when nothing was typed during the create', async () => {
    render(<DataTable sections={[section]} />);
    await completeDraft();
    await act(async () => resolveCreate(created(4)));
    await settle();

    expect(updateShot).not.toHaveBeenCalled();
  });
});
