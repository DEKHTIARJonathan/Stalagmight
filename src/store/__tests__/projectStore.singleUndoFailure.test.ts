/**
 * [#576 NF-W2S-2] A failed SINGLE undo/redo marks the frontend dirty right away.
 *
 * The backend marks the SpeleoDB copy un-pushed for every undo/redo failure past
 * its empty-stack check (#576 A18(a)): the step reports its failure only after
 * running its inverse, which mutates as it goes. The frontend mirrored that for
 * the multi-step jumps (`undo_to`/`redo_to`) but not for single steps, so its
 * two dirty bits stayed clean until the next status poll - long enough for the
 * quit guard and the push prompt to read "nothing to save / nothing to push".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';
import { useSpeleoStore } from '../speleoStore';
import { useUIStore } from '../uiStore';
import { projectStateEnvelope } from '../../test/projectStateEnvelope';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
}));

/** Undo and redo fail with `error`; every refresh round trip answers an empty project. */
function failWith(error: string) {
  invokeIpcMock.mockImplementation(async (command: string) => {
    switch (command) {
      case 'undo':
      case 'redo':
        return { success: false, warnings: [], error, section_ids: [] };
      case 'get_project_state_binary':
        return projectStateEnvelope({
          project: {
            name: 'CaveA',
            location: null,
            created_at: '2026-01-01T00:00:00Z',
            modified_at: '2026-01-01T00:00:01Z',
            sections: [],
            station_merges: [],
            zero_datums: [],
            loop_closures: [],
            file_path: '/tmp/cavea.stalx',
            next_section_id: 1,
            section_offsets: {},
            imported_file_hashes: [],
            imported_section_hashes: [],
          },
          stations: [],
          stats: null,
          frozen_shots: [],
        });
      case 'can_undo':
      case 'can_redo':
        return false;
      case 'get_project_warnings':
        return [];
      case 'check_project_integrity':
        return { messages: [], save_blocked: false };
      default:
        return undefined;
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ showToast: vi.fn() });
  useSpeleoStore.getState().setLinkOnOpen({ permission: 'ADMIN' });
  useProjectStore.setState({ isDirty: false, project: null });
});

describe('a failed single undo/redo (#576 NF-W2S-2)', () => {
  it.each(['undo', 'redo'] as const)(
    'marks both dirty bits when the %s step failed after it started',
    async (verb) => {
      failWith('Failed to parse undo data');
      expect(useSpeleoStore.getState().link?.hasUnpushedEdits).toBe(false);

      const result = await useProjectStore.getState()[verb]();

      expect(result.success).toBe(false);
      expect(useProjectStore.getState().isDirty).toBe(true);
      expect(useSpeleoStore.getState().link?.hasUnpushedEdits).toBe(true);
    },
  );

  it.each([
    'Nothing to undo',
    'Nothing to redo',
    'Undo is unavailable after an internal error. Save your work and restart Stalagmight.',
    'EDIT_DISABLED: Undo is disabled: this SpeleoDB project is open read-only. Acquire the lock to edit.',
    'EDIT_DISABLED: WORKSPACE_READ_ONLY: Undo is disabled: the Plan workspace is read-only. Switch to Survey to edit.',
  ])('marks nothing on a refusal that ran no step: %s', async (error) => {
    failWith(error);

    await useProjectStore.getState().undo();

    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(useSpeleoStore.getState().link?.hasUnpushedEdits).toBe(false);
  });
});
