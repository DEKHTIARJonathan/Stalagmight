/**
 * [#270 - bug 1] The OS window X must go through the app's OWN exit guard.
 *
 * The window X never reaches `quitApp`: it arrives as a `tauri://close-requested`
 * event, and this hook was the only listener. Its `shouldBlock` argument covered
 * an in-flight import and a dirty dive plan and nothing else, so closing via X
 * destroyed the window - discarding unsaved-to-disk work and unpushed SpeleoDB
 * edits with no prompt at all, while the menu Quit prompted for both.
 *
 * These lock the wiring: the guard runs on every close request, an opened dialog
 * aborts the close, and the quit that dialog then issues is not re-guarded (which
 * would loop forever, since a discard deliberately leaves the store dirty).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const listeners = vi.hoisted(() => [] as Array<() => Promise<void> | void>);
const unlisten = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, cb: () => Promise<void>) => {
    listeners.push(cb);
    return unlisten;
  }),
}));

const destroyMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ destroy: destroyMock, close: vi.fn(async () => {}) }),
}));

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: confirmMock }));

import { useBeforeUnload } from '../useBeforeUnload';
import { performQuit, resetQuitConfirmationForTests } from '../../utils/quit';

function Harness({
  shouldBlock,
  guard,
  onConfirm,
}: {
  shouldBlock: boolean;
  guard: () => boolean;
  onConfirm?: () => Promise<void>;
}) {
  useBeforeUnload(shouldBlock, 'discard?', onConfirm, guard);
  return null;
}

/** Fire the close-requested event the OS window X produces. */
async function pressWindowX(): Promise<void> {
  for (const cb of [...listeners]) await cb();
}

beforeEach(() => {
  listeners.length = 0;
  destroyMock.mockClear();
  confirmMock.mockClear();
  confirmMock.mockResolvedValue(true);
  resetQuitConfirmationForTests();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('useBeforeUnload - the in-app exit guard', () => {
  it('destroys the window when nothing needs guarding', async () => {
    const guard = vi.fn(() => false);
    render(<Harness shouldBlock={false} guard={guard} />);
    await flush();

    await pressWindowX();

    expect(guard).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('aborts the close when the guard opens a dialog', async () => {
    const guard = vi.fn(() => true);
    render(<Harness shouldBlock={false} guard={guard} />);
    await flush();

    await pressWindowX();

    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('skips the guard for a quit the user already confirmed in-app', async () => {
    // The guard still reports "dirty" - a discard leaves it that way on purpose.
    const guard = vi.fn(() => true);
    render(<Harness shouldBlock={false} guard={guard} />);
    await flush();

    performQuit(); // what the dialog's Quit button does
    await pressWindowX();

    expect(guard).not.toHaveBeenCalled();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('re-guards the next close request - the confirmation is one-shot', async () => {
    const guard = vi.fn(() => true);
    render(<Harness shouldBlock={false} guard={guard} />);
    await flush();

    performQuit();
    await pressWindowX();
    destroyMock.mockClear();

    // A second X (in a hypothetical still-running window) is guarded again.
    listeners.length = 0;
    render(<Harness shouldBlock={false} guard={guard} />);
    await flush();
    await pressWindowX();

    expect(guard).toHaveBeenCalledTimes(1);
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('runs the import/dive-plan confirm FIRST, then the guard', async () => {
    const guard = vi.fn(() => true);
    render(<Harness shouldBlock guard={guard} />);
    await flush();

    await pressWindowX();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('never reaches the guard when the import/dive-plan confirm is declined', async () => {
    confirmMock.mockResolvedValue(false);
    const guard = vi.fn(() => false);
    render(<Harness shouldBlock guard={guard} />);
    await flush();

    await pressWindowX();

    expect(guard).not.toHaveBeenCalled();
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('still prompts for a dirty dive plan on a confirmed in-app quit', async () => {
    // `preConfirmed` covers the PROJECT decision only; the dive plan is separate
    // in-memory work the same close would drop.
    const guard = vi.fn(() => false);
    render(<Harness shouldBlock guard={guard} />);
    await flush();

    performQuit();
    await pressWindowX();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * [#270] The tier-1 cleanup is destructive by contract ("e.g. delete placed
 * sections"), so it may only run once the close is actually going ahead. It used to
 * run inside the tier-1 confirmation, ABOVE the tier-2 guard - so a close the guard
 * then aborted had already performed the deletions: the user gets their prompt,
 * cancels, keeps working, and the sections are gone anyway.
 */
describe('useBeforeUnload - the tier-1 cleanup waits for the tier-2 guard', () => {
  it('does NOT run the cleanup when the guard aborts the close', async () => {
    const onConfirm = vi.fn(async () => {});
    const guard = vi.fn(() => true);
    render(<Harness shouldBlock guard={guard} onConfirm={onConfirm} />);
    await flush();

    await pressWindowX();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('runs the cleanup once the close survives every guard', async () => {
    const onConfirm = vi.fn(async () => {});
    const guard = vi.fn(() => false);
    render(<Harness shouldBlock guard={guard} onConfirm={onConfirm} />);
    await flush();

    await pressWindowX();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('does not run the cleanup when the tier-1 confirm itself is declined', async () => {
    confirmMock.mockResolvedValue(false);
    const onConfirm = vi.fn(async () => {});
    render(<Harness shouldBlock guard={() => false} onConfirm={onConfirm} />);
    await flush();

    await pressWindowX();

    expect(onConfirm).not.toHaveBeenCalled();
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('a throwing cleanup still lets the window close', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onConfirm = vi.fn(async () => {
      throw new Error('cleanup boom');
    });
    render(<Harness shouldBlock guard={() => false} onConfirm={onConfirm} />);
    await flush();

    await pressWindowX();

    expect(destroyMock).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
