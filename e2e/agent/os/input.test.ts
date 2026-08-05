/**
 * Tier 2 input, unit level. Every helper call, the osascript activate and the
 * clock are injected, so this suite never posts an event, never moves the
 * cursor and needs no TCC permission. The one thing it does NOT fake is
 * `requireGrant`, because the point of the grant test is that the real gate
 * runs first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'webdriverio';

import type { AgentSession } from '../sessionTypes';
import {
  contentOriginFromFrame,
  defaultOsDeps,
  ensureAppFrontmost,
  osClick,
  osKeys,
  resolveTargetPoint,
  type OsDeps,
} from './input';
import { GRANT_REQUIRED_MESSAGE, requireGrant } from './permissions';

const APP_PID = 4242;
const WINDOW_ID = 77;
/** 28pt of title bar: a 728pt frame over a 700pt content area. */
const FRAME = { x: 100, y: 50, w: 1000, h: 728 };
const PROBE = { cx: 400, cy: 300, innerWidth: 1000, innerHeight: 700 };

interface FakeOptions {
  /** Pid the helper reports as frontmost, per call; the last one repeats. */
  frontmost?: (number | null)[];
  accessibility?: boolean;
  screenRecording?: boolean;
  requireGrant?: () => void;
  probe?: typeof PROBE;
}

interface FakeDeps {
  deps: OsDeps;
  helperCalls: string[][];
  activate: ReturnType<typeof vi.fn>;
  evalInApp: ReturnType<typeof vi.fn>;
  preflight: ReturnType<typeof vi.fn>;
}

function fakeOsDeps(options: FakeOptions = {}): FakeDeps {
  const helperCalls: string[][] = [];
  const frontmost = [...(options.frontmost ?? [APP_PID])];
  const activate = vi.fn(async () => {});
  const evalInApp = vi.fn(async () => options.probe ?? PROBE);
  const preflight = vi.fn(async () => ({
    ok: true as const,
    accessibility: options.accessibility ?? true,
    screenRecording: options.screenRecording ?? true,
  }));

  const runHelper = (async (args: string[]) => {
    helperCalls.push(args);
    switch (args[0]) {
      case 'frontmost': {
        const pid = frontmost.length > 1 ? frontmost.shift() : frontmost[0];
        return pid === null || pid === undefined
          ? { ok: false, error: 'no on-screen application window found' }
          : { ok: true, pid, app: 'Stalagmight', windowId: WINDOW_ID };
      }
      case 'window-id':
        return { ok: true, windowId: WINDOW_ID, pid: APP_PID, app: 'Stalagmight', bounds: FRAME };
      case 'click':
        return {
          ok: true,
          action: 'click',
          x: Number(args[1]),
          y: Number(args[2]),
          button: args.includes('--right') ? 'right' : 'left',
          clickCount: args.includes('--double') ? 2 : 1,
        };
      case 'keys':
        return { ok: true, action: 'keys', spec: args[1], key: 's', keyCode: 1, modifiers: ['cmd'] };
      default:
        throw new Error(`unexpected helper call: ${args.join(' ')}`);
    }
  }) as unknown as OsDeps['runHelper'];

  return {
    helperCalls,
    activate,
    evalInApp,
    preflight,
    deps: {
      runHelper,
      requireGrant: options.requireGrant ?? (() => {}),
      preflight: preflight as unknown as OsDeps['preflight'],
      evalInApp: evalInApp as unknown as OsDeps['evalInApp'],
      activate,
      sleep: async () => {},
    },
  };
}

function fakeSession(appPid: number | null = APP_PID): AgentSession {
  return { browser: {} as Browser, appPid: () => appPid } as unknown as AgentSession;
}

/** A Linux-shaped session: the platform never learns the app's own pid. */
function sessionWithoutAppPid(): AgentSession {
  return { browser: {} as Browser } as unknown as AgentSession;
}

function helperVerbs(calls: string[][]): string[] {
  return calls.map((call) => call[0] ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('contentOriginFromFrame', () => {
  it('subtracts the title bar the frame and the content area disagree by', () => {
    expect(contentOriginFromFrame(FRAME, { width: 1000, height: 700 })).toEqual({ x: 100, y: 78 });
  });

  it('keeps the frame x: macOS windows have no side border', () => {
    expect(contentOriginFromFrame({ x: -40, y: 0, w: 800, h: 600 }, { width: 800, height: 600 }).x).toBe(-40);
  });

  it('clamps a negative title bar rather than shifting the click up', () => {
    expect(contentOriginFromFrame(FRAME, { width: 1000, height: 900 })).toEqual({ x: 100, y: 50 });
  });
});

describe('resolveTargetPoint', () => {
  it('composes a testid into screen points through the window content origin', async () => {
    const { deps, evalInApp } = fakeOsDeps();

    // 100 + 400 across; 50 (frame) + 28 (title bar) + 300 down.
    await expect(resolveTargetPoint(fakeSession(), { testid: 'save-button' }, deps)).resolves.toEqual({
      x: 500,
      y: 378,
    });
    expect(evalInApp.mock.calls[0]?.[2]).toEqual(['[data-testid="save-button"]']);
  });

  it('passes explicit screen points through without asking the app anything', async () => {
    const { deps, helperCalls, evalInApp } = fakeOsDeps();

    await expect(resolveTargetPoint(fakeSession(), { x: 12.4, y: 900.6 }, deps)).resolves.toEqual({
      x: 12,
      y: 901,
    });
    expect(helperCalls).toEqual([]);
    expect(evalInApp).not.toHaveBeenCalled();
  });

  it('prefers the testid when both a testid and coordinates are given', async () => {
    const { deps } = fakeOsDeps();

    await expect(
      resolveTargetPoint(fakeSession(), { testid: 'save-button', x: 5, y: 5 }, deps),
    ).resolves.toEqual({ x: 500, y: 378 });
  });

  it('refuses a target that names neither', async () => {
    const { deps } = fakeOsDeps();

    await expect(resolveTargetPoint(fakeSession(), {}, deps)).rejects.toThrow(
      'needs a testid or an x+y screen point',
    );
  });
});

describe('the os_* gates', () => {
  it('wires the real grant gate by default', () => {
    expect(defaultOsDeps.requireGrant).toBe(requireGrant);
  });

  it('refuses before touching the machine when the session is not granted', async () => {
    const { deps, helperCalls, preflight } = fakeOsDeps({ requireGrant });

    await expect(osClick(fakeSession(), { x: 10, y: 10 }, deps)).rejects.toThrow(GRANT_REQUIRED_MESSAGE);
    expect(preflight).not.toHaveBeenCalled();
    expect(helperCalls).toEqual([]);
  });

  it('refuses to post input while Accessibility is denied', async () => {
    const { deps, helperCalls } = fakeOsDeps({ accessibility: false });

    await expect(osClick(fakeSession(), { x: 10, y: 10 }, deps)).rejects.toThrow(
      'macOS Accessibility permission is not granted',
    );
    expect(helperCalls).toEqual([]);
  });

  it('does not need Screen Recording to click', async () => {
    const { deps } = fakeOsDeps({ screenRecording: false });

    await expect(osClick(fakeSession(), { x: 10, y: 10 }, deps)).resolves.toMatchObject({
      permissions: { accessibility: true, screenRecording: false },
    });
  });

  it('stops when no app pid is known, whether it is null or unimplemented', async () => {
    const noPid = fakeOsDeps();
    const noMethod = fakeOsDeps();

    await expect(osClick(fakeSession(null), { x: 10, y: 10 }, noPid.deps)).rejects.toThrow('no app pid is known');
    await expect(osKeys(sessionWithoutAppPid(), 'cmd+s', noMethod.deps)).rejects.toThrow('no app pid is known');
    expect(noPid.helperCalls).toEqual([]);
    expect(noMethod.helperCalls).toEqual([]);
  });
});

describe('ensureAppFrontmost', () => {
  it('activates nothing when the app is already in front', async () => {
    const { deps, activate, helperCalls } = fakeOsDeps({ frontmost: [APP_PID] });

    await expect(ensureAppFrontmost(APP_PID, deps)).resolves.toBe(true);
    expect(activate).not.toHaveBeenCalled();
    expect(helperVerbs(helperCalls)).toEqual(['frontmost']);
  });

  it('makes exactly ONE activate attempt and gives up on the re-check', async () => {
    const { deps, activate, helperCalls } = fakeOsDeps({ frontmost: [999, 999] });

    await expect(ensureAppFrontmost(APP_PID, deps)).resolves.toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(helperVerbs(helperCalls)).toEqual(['frontmost', 'frontmost']);
  });

  it('reports success when the one attempt worked', async () => {
    const { deps, activate } = fakeOsDeps({ frontmost: [999, APP_PID] });

    await expect(ensureAppFrontmost(APP_PID, deps)).resolves.toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('treats an activate that could not run as a failed re-check, not a throw', async () => {
    const { deps, activate } = fakeOsDeps({ frontmost: [999, 999] });
    activate.mockRejectedValueOnce(new Error('osascript is not authorized'));

    await expect(ensureAppFrontmost(APP_PID, deps)).resolves.toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('cannot prove frontmost when the helper reports no on-screen window', async () => {
    const { deps, activate } = fakeOsDeps({ frontmost: [null, null] });

    await expect(ensureAppFrontmost(APP_PID, deps)).resolves.toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
  });
});

describe('osClick', () => {
  it('posts the resolved point and reports the evidence conditions', async () => {
    const { deps, helperCalls } = fakeOsDeps();

    await expect(osClick(fakeSession(), { testid: 'save-button' }, deps)).resolves.toEqual({
      clicked: { x: 500, y: 378 },
      target: '[data-testid="save-button"]',
      frontmost_ok: true,
      permissions: { accessibility: true, screenRecording: true },
    });
    expect(helperCalls.at(-1)).toEqual(['click', '500', '378']);
  });

  it('forwards the right-button and double flags', async () => {
    const { deps, helperCalls } = fakeOsDeps();

    await osClick(fakeSession(), { x: 20, y: 30, button: 'right', double: true }, deps);
    expect(helperCalls.at(-1)).toEqual(['click', '20', '30', '--right', '--double']);
  });

  // A CGEvent goes to whatever app is frontmost, so a lost focus check means
  // the click would land in the human's window. Refusing to post is the only
  // safe default; labelling the evidence is not enough for a real mutation.
  it('refuses to click when focus was lost, and posts nothing', async () => {
    const { deps, helperCalls } = fakeOsDeps({ frontmost: [999, 999] });

    await expect(osClick(fakeSession(), { x: 20, y: 30 }, deps)).rejects.toThrow(/frontmost/i);
    expect(helperVerbs(helperCalls)).not.toContain('click');
  });

  it('clicks anyway under force, still labelling the evidence untrustworthy', async () => {
    const { deps, helperCalls } = fakeOsDeps({ frontmost: [999, 999] });

    await expect(osClick(fakeSession(), { x: 20, y: 30, force: true }, deps)).resolves.toMatchObject({
      clicked: { x: 20, y: 30 },
      target: 'screen 20,30',
      frontmost_ok: false,
    });
    expect(helperVerbs(helperCalls)).toContain('click');
  });

  it('refuses to post a key chord when focus was lost', async () => {
    const { deps, helperCalls } = fakeOsDeps({ frontmost: [999, 999] });

    await expect(osKeys(fakeSession(), 'cmd+s', deps)).rejects.toThrow(/frontmost/i);
    expect(helperVerbs(helperCalls)).not.toContain('keys');
  });

  it('resolves the point only after the activate attempt, so a moved window is read fresh', async () => {
    const { deps, helperCalls } = fakeOsDeps({ frontmost: [999, APP_PID] });

    await osClick(fakeSession(), { testid: 'save-button' }, deps);
    expect(helperVerbs(helperCalls)).toEqual(['frontmost', 'frontmost', 'window-id', 'click']);
  });

  it('surfaces a helper-level failure as an error', async () => {
    const { deps } = fakeOsDeps();
    const failing: OsDeps = {
      ...deps,
      runHelper: (async (args: string[]) =>
        args[0] === 'click'
          ? { ok: false, error: 'Accessibility is denied' }
          : deps.runHelper(args)) as unknown as OsDeps['runHelper'],
    };

    await expect(osClick(fakeSession(), { x: 1, y: 2 }, failing)).rejects.toThrow(
      'os helper click failed: Accessibility is denied',
    );
  });
});

describe('osKeys', () => {
  it('sends the spec verbatim and reports the evidence conditions', async () => {
    const { deps, helperCalls } = fakeOsDeps();

    await expect(osKeys(fakeSession(), 'cmd+shift+z', deps)).resolves.toEqual({
      spec: 'cmd+shift+z',
      frontmost_ok: true,
      permissions: { accessibility: true, screenRecording: true },
    });
    expect(helperCalls.at(-1)).toEqual(['keys', 'cmd+shift+z']);
  });

  it('surfaces an unparseable spec as an error', async () => {
    const { deps } = fakeOsDeps();
    const failing: OsDeps = {
      ...deps,
      runHelper: (async (args: string[]) =>
        args[0] === 'keys'
          ? { ok: false, error: 'unknown key "wat"' }
          : deps.runHelper(args)) as unknown as OsDeps['runHelper'],
    };

    await expect(osKeys(fakeSession(), 'cmd+wat', failing)).rejects.toThrow('unknown key "wat"');
  });
});
