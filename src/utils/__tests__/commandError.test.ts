/**
 * [#576 C4, A6] The one IPC failure envelope, in `invokeIpc`.
 *
 * Every fallible command rejects with the backend's `CommandError` (`{ code,
 * message, ...payload }`). `invokeIpc` re-throws it as an `IpcCommandError`, so the
 * message keeps reaching every surface the old string rejection reached
 * (`getErrorMessage`, `String(e)`, `${e}`, `instanceof Error`), while routing reads
 * the code.
 *
 * The real `invokeIpc` runs here; only Tauri's `invoke` is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getErrorMessage, invokeIpc } from '../ipc';
import { IpcCommandError, commandErrorOf, errorCode, toIpcError } from '../commandError';
import { refusedBy, refusedLocally } from '../../store/commandResult';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
});

describe('IpcCommandError (#576 C4)', () => {
  it('is an Error whose message, toString and template string are the display message', () => {
    const e = new IpcCommandError({ code: 'EDIT_DISABLED', message: 'Move station is disabled.' });

    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(IpcCommandError);
    expect(e.name).toBe('IpcCommandError');
    expect(e.code).toBe('EDIT_DISABLED');
    expect(e.message).toBe('Move station is disabled.');
    expect(e.toString()).toBe('Move station is disabled.');
    expect(String(e)).toBe('Move station is disabled.');
    expect(`${e}`).toBe('Move station is disabled.');
    expect(getErrorMessage(e)).toBe('Move station is disabled.');
  });

  it('carries every payload field under its wire name, and leaves an omitted one absent', () => {
    const e = new IpcCommandError({
      code: 'HISTORY_STEP_FAILED',
      message: 'Undo failed at step 2 of 3: boom',
      history_step: { failed_step: 2, total_steps: 3 },
      reversed_sections: [{ section_id: 4, shot_count: 7 }],
      remote_link: { has_unpushed_edits: true, unwound: false },
    });

    expect(e.history_step).toEqual({ failed_step: 2, total_steps: 3 });
    expect(e.reversed_sections).toEqual([{ section_id: 4, shot_count: 7 }]);
    expect(e.remote_link).toEqual({ has_unpushed_edits: true, unwound: false });
    expect('details' in e).toBe(false);
    expect('session_closed' in e).toBe(false);
  });
});

describe('the structural readers', () => {
  it('read the code off an IpcCommandError, a plain CommandError object and a refused outcome', () => {
    const plain = { code: 'FS_PERMISSION_DENIED', message: 'denied' } as const;

    expect(errorCode(new IpcCommandError(plain))).toBe('FS_PERMISSION_DENIED');
    expect(errorCode(plain)).toBe('FS_PERMISSION_DENIED');
    expect(errorCode(refusedBy(plain))).toBe('FS_PERMISSION_DENIED');
    expect(commandErrorOf(plain)).toBe(plain);
  });

  it('find no code on anything else', () => {
    expect(errorCode('EDIT_DISABLED: a plain-string rejection')).toBeNull();
    expect(errorCode(new Error('EDIT_DISABLED: an Error'))).toBeNull();
    expect(errorCode({ message: 'no code' })).toBeNull();
    expect(errorCode({ code: 42, message: 'not a string code' })).toBeNull();
    expect(errorCode(refusedLocally('The project changed before this action could run.'))).toBeNull();
    expect(errorCode(null)).toBeNull();
    expect(errorCode(undefined)).toBeNull();
    expect(commandErrorOf('a string')).toBeNull();
  });

  it('wrap only a CommandError-shaped rejection, once', () => {
    const wrapped = toIpcError({ code: 'FAILED', message: 'x' });
    expect(wrapped).toBeInstanceOf(IpcCommandError);
    expect(toIpcError(wrapped)).toBe(wrapped);
    expect(toIpcError('invalid args `sectionId` for command `delete_section`')).toBe(
      'invalid args `sectionId` for command `delete_section`',
    );
    const transport = new Error('transport down');
    expect(toIpcError(transport)).toBe(transport);
  });
});

describe('invokeIpc and a rejection', () => {
  it('re-throws a CommandError rejection as an IpcCommandError with its code and message', async () => {
    invokeMock.mockRejectedValue({ code: 'WORKSPACE_READ_ONLY', message: 'Move station is disabled: Plan.' });

    const caught = await invokeIpc('delete_section', { sectionId: 1 }).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(IpcCommandError);
    expect(errorCode(caught)).toBe('WORKSPACE_READ_ONLY');
    expect(getErrorMessage(caught)).toBe('Move station is disabled: Plan.');
  });

  it("leaves a plain-string rejection (Tauri's own argument errors) a string", async () => {
    invokeMock.mockRejectedValue('invalid args `sectionId` for command `delete_section`');

    const caught = await invokeIpc('delete_section', { sectionId: 1 }).catch((e: unknown) => e);

    expect(caught).toBe('invalid args `sectionId` for command `delete_section`');
  });
});
