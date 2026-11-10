import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Section } from '../../types/project';

const mocks = vi.hoisted(() => ({
  grid: null as any,
  blocked: false,
  store: {
    isDirty: false,
    warnings: [],
    isShotFrozen: vi.fn(() => false),
    setShotKind: vi.fn(),
    executeBatch: vi.fn(),
    createShot: vi.fn(),
    createSection: vi.fn(),
    updateSection: vi.fn(),
    refreshProjectState: vi.fn(),
    markDirty: vi.fn(),
  },
  ui: { selection: null, setSelection: vi.fn(), dataWorkspaceDraft: null as null | { data: Record<string, unknown>; sectionId: number | null } },
}));
vi.mock('../../store/projectStore', () => ({ useProjectStore: () => mocks.store }));
vi.mock('../../store/uiStore', () => ({
  useUIStore: Object.assign((selector: any) => selector(mocks.ui), { getState: () => mocks.ui, setState: (patch: any) => Object.assign(mocks.ui, patch) }),
}));
vi.mock('../../hooks/useEditingBlocked', () => ({
  useEditingBlocked: () => mocks.blocked,
  isEditingBlockedNow: () => mocks.blocked,
}));
vi.mock('../../hooks/useDecimalPrecision', () => ({ useDecimalPrecision: () => ({ length: 2, azimuth: 2, depth: 2, inclination: 2 }) }));
vi.mock('react-i18next', async importOriginal => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../utils/ipc', () => ({ invokeIpc: vi.fn(async () => []), getErrorMessage: (error: unknown) => String(error) }));
vi.mock('./RawTableView', () => ({ default: () => null }));
vi.mock('../common/Select', () => ({ Select: (props: any) => <select data-testid={props['data-testid']} value={props.value} disabled={props.disabled} onChange={event => props.onChange(event.target.value)}>
  <option value="">Choose</option>{props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }));
vi.mock('../common/SpreadsheetGrid', () => ({ SpreadsheetGrid: (props: any) => {
  mocks.grid = props;
  return <div>{props.rows.map((row: any, index: number) => <div key={index}>{props.columns.map((column: any) => <span key={column.key}>{column.render?.(row, index)}</span>)}</div>)}</div>;
} }));
import { ProjectDataTable } from './ProjectDataTable';

const sections = [1, 2].map(id => ({
  id, name: `Section ${id}`, shots: [{
    id: id * 100000, uuid: `shot-${id}`, kind: 'Normal', length: 10,
    azimuth_in: 90, azimuth_out: 90, depth_in: 0, depth_out: 1,
    pitch_in: null, pitch_out: null, left: null, right: null, up: null, down: null,
    comment: null, marker_index: null, temperature: null,
  }],
})) as Section[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.blocked = false;
  mocks.ui.dataWorkspaceDraft = null;
  for (const command of [mocks.store.setShotKind, mocks.store.executeBatch, mocks.store.createShot, mocks.store.updateSection]) {
    command.mockResolvedValue({ success: true });
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ProjectDataTable command routing', () => {
  it('keyboard kind activation uses the activated row section and supports reverse cycling', async () => {
    render(<ProjectDataTable sections={sections} />);
    const grid = mocks.grid;
    await act(async () => grid.columns.find((column: any) => column.key === 'kind').activate(grid.rows[1], 1, -1));
    expect(mocks.store.setShotKind).toHaveBeenCalledWith(2, 200000, 'Reference');
  });

  it('creates a complete draft when its section is selected last', async () => {
    render(<ProjectDataTable sections={sections} />);
    for (const [colKey, value] of [['length', 10], ['azimuth_in', 90], ['azimuth_out', 90], ['depth_in', 0], ['depth_out', 1]]) {
      await act(async () => mocks.grid.onEdit(2, colKey, value));
    }
    expect(mocks.store.createShot).not.toHaveBeenCalled();
    await act(async () => fireEvent.change(screen.getByTestId('data-section--1'), { target: { value: '2' } }));
    expect(mocks.store.createShot).toHaveBeenCalledOnce();
    expect(mocks.store.createShot).toHaveBeenCalledWith(2, expect.objectContaining({ length: 10, azimuth_in: 90, depth_out: 1 }));
  });

  it('surfaces rejected measurement edits and rechecks the imperative read-only gate', async () => {
    mocks.store.executeBatch.mockResolvedValueOnce({ success: false, error: 'Locked shot' });
    render(<ProjectDataTable sections={sections} />);
    await act(async () => mocks.grid.onEdit(1, 'length', 20));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Locked shot'));
    mocks.blocked = true;
    await act(async () => mocks.grid.onEdit(1, 'length', 30));
    expect(mocks.store.executeBatch).toHaveBeenCalledOnce();
  });
  it('applies every section metadata edit in a multi-row paste', async () => {
    render(<ProjectDataTable sections={sections} />);
    fireEvent.change(screen.getByTestId('project-data-view'), { target: { value: 'sections' } });
    await act(async () => mocks.grid.onBatchEdit([
      { row: 0, colKey: 'name', value: '' },
      { row: 1, colKey: 'surveyor', value: 'Survey team' },
    ]));
    expect(mocks.store.updateSection).toHaveBeenCalledTimes(2);
    expect(mocks.store.updateSection).toHaveBeenNthCalledWith(1, 1, { name: null });
    expect(mocks.store.updateSection).toHaveBeenNthCalledWith(2, 2, { surveyor: 'Survey team' });
  });

  it('preserves incomplete draft values and section across workspace remounts', async () => {
    const first = render(<ProjectDataTable sections={sections} />);
    await act(async () => mocks.grid.onEdit(2, 'length', 12));
    await act(async () => fireEvent.change(screen.getByTestId('data-section--1'), { target: { value: '2' } }));
    first.unmount();
    render(<ProjectDataTable sections={sections} />);
    expect(mocks.grid.rows[2].length).toBe(12);
    expect(screen.getByTestId('data-section--1')).toHaveValue('2');
    expect(mocks.store.createShot).not.toHaveBeenCalled();
  });

});
