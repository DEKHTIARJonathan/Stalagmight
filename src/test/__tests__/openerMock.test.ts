/**
 * [#576 NF-W12FE-1] The Playwright IPC mock checks the arguments of the opener plugin's
 * commands (`e2e-playwright/mocks/ipc/opener.ts`). It used to answer
 * `plugin:opener|reveal_item_in_dir` whatever it was sent, which is why the project panel's
 * hand-built `{ path }` (the plugin takes `paths`; the real app refused every call, HFI-5)
 * passed the browser tier.
 *
 * Here the REAL `@tauri-apps/plugin-opener` functions run against a stub IPC: what they send
 * must fit the mock's shapes (else the mock would refuse correct calls), and the HFI-5 call
 * must not (else it would accept the broken one again).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  OPENER_ARG_SHAPES,
  OPENER_COMMANDS_NOT_GRANTED,
  installOpenerMock,
  pluginArgsRefusal,
} from '../../../e2e-playwright/mocks/ipc/opener';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Sent {
  cmd: string;
  args: Record<string, unknown>;
}

let sent: Sent[] = [];
let page: Record<string, unknown> = {};

beforeEach(() => {
  sent = [];
  page = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        // What Tauri receives is the JSON of the call: an undefined key is not sent.
        sent.push({ cmd, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
        return null;
      },
    },
  };
  vi.stubGlobal('window', page);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The verdict on a call's arguments alone (the grant is pinned separately below). */
const shapeRefusal = (call: Sent) => pluginArgsRefusal(call.cmd, call.args, OPENER_ARG_SHAPES, []);

describe('the mock takes what the real opener plugin sends (#576 NF-W12FE-1)', () => {
  it.each([
    ['revealItemInDir(path)', () => revealItemInDir('/survey/CaveA.stalx')],
    ['revealItemInDir([paths])', () => revealItemInDir(['/survey/CaveA.stalx', '/survey/CaveB.stalx'])],
    ['openUrl(url)', () => openUrl('https://example.org')],
    ['openUrl(url, with)', () => openUrl('https://example.org', 'firefox')],
    ['openPath(path)', () => openPath('/survey/CaveA.stalx')],
    ['openPath(path, with)', () => openPath('/survey/CaveA.stalx', 'gedit')],
  ])('%s fits its shape', async (_name, call) => {
    await call();
    expect(sent).toHaveLength(1);
    const [only] = sent;
    if (!only) throw new Error('no call was sent');
    expect(Object.keys(OPENER_ARG_SHAPES)).toContain(only.cmd);
    expect(shapeRefusal(only)).toBeNull();
  });

  it('refuses the HFI-5 call: reveal_item_in_dir with { path } (missing paths)', () => {
    expect(shapeRefusal({ cmd: 'plugin:opener|reveal_item_in_dir', args: { path: '/survey/CaveA.stalx' } })).toBe(
      'invalid args `paths` for command `reveal_item_in_dir`: command reveal_item_in_dir missing required key paths',
    );
  });

  it.each([
    ['paths as one string', 'plugin:opener|reveal_item_in_dir', { paths: '/survey/CaveA.stalx' }],
    ['paths holding a number', 'plugin:opener|reveal_item_in_dir', { paths: ['/survey', 7] }],
    ['url missing', 'plugin:opener|open_url', { href: 'https://example.org' }],
    ['url null', 'plugin:opener|open_url', { url: null }],
    ['with as a number', 'plugin:opener|open_path', { path: '/survey', with: 3 }],
  ])('refuses %s', (_name, cmd, args) => {
    expect(shapeRefusal({ cmd, args })).toMatch(/^invalid args `\w+` for command `\w+`/);
  });

  it('leaves a plugin command it has no shape for to the rest of the mock', () => {
    expect(pluginArgsRefusal('plugin:dialog|open', { anything: 1 }, OPENER_ARG_SHAPES, OPENER_COMMANDS_NOT_GRANTED)).toBeNull();
  });
});

describe('the mock refuses what the capabilities do not grant (#576 NF-W12FE-1)', () => {
  const capability = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src-tauri/capabilities/default.json'), 'utf8')) as {
    permissions: Array<string | { identifier: string }>;
  };
  const granted = capability.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));

  it('open_path: granted by no permission in default.json, so refused even with the right shape', () => {
    // `opener:default` is allow-open-url + allow-reveal-item-in-dir + allow-default-urls.
    expect(granted).not.toContain('opener:allow-open-path');
    expect(OPENER_COMMANDS_NOT_GRANTED).toEqual(['plugin:opener|open_path']);
    expect(
      pluginArgsRefusal('plugin:opener|open_path', { path: '/survey' }, OPENER_ARG_SHAPES, OPENER_COMMANDS_NOT_GRANTED),
    ).toBe('plugin:opener|open_path not allowed: src-tauri/capabilities/default.json does not grant it');
  });

  it('reveal_item_in_dir and open_url: granted, so only their shape is checked', () => {
    expect(granted).toEqual(expect.arrayContaining(['opener:default', 'opener:allow-reveal-item-in-dir', 'opener:allow-open-url']));
    expect(
      pluginArgsRefusal('plugin:opener|reveal_item_in_dir', { paths: ['/survey'] }, OPENER_ARG_SHAPES, OPENER_COMMANDS_NOT_GRANTED),
    ).toBeNull();
  });
});

describe('the page-side opener mock (#576 NF-W12FE-1)', () => {
  const install = () => installOpenerMock(pluginArgsRefusal, OPENER_ARG_SHAPES, OPENER_COMMANDS_NOT_GRANTED);

  it('records a refusal and reports it through the teardown binding', () => {
    const reported: string[] = [];
    page.__E2E_REPORT_REFUSED_PLUGIN_CALL__ = (refusal: string) => reported.push(refusal);
    const opener = install();

    const why = opener.refuse('plugin:opener|reveal_item_in_dir', { path: '/survey/CaveA.stalx' });

    expect(why).toMatch(/missing required key paths$/);
    expect(page.__MOCK_REFUSED_PLUGIN_CALLS__).toEqual([why]);
    expect(reported).toEqual([why]);
  });

  it('lets a call it would run through, records nothing, and answers it with nothing', () => {
    const opener = install();

    expect(opener.refuse('plugin:opener|reveal_item_in_dir', { paths: ['/survey/CaveA.stalx'] })).toBeNull();
    expect(opener.refuse('get_config', {})).toBeNull();
    expect(page.__MOCK_REFUSED_PLUGIN_CALLS__).toEqual([]);
    expect(opener.answers('plugin:opener|reveal_item_in_dir')).toBe(true);
    expect(opener.answers('plugin:dialog|open')).toBe(false);
    expect(opener.reply('plugin:opener|reveal_item_in_dir', { paths: ['/survey/CaveA.stalx'] })).toBeUndefined();
  });
});
