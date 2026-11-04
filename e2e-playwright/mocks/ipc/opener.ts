/**
 * The opener plugin's half of the Playwright IPC mock (#576 NF-W12FE-1): its argument
 * contract, its grant, and its replies. The mock used to answer
 * `plugin:opener|reveal_item_in_dir` and `open_path` whatever they were sent, so the
 * project panel's hand-built `{ path }`, which the real plugin refuses (it takes `paths`),
 * passed every browser-tier spec while every real Show in folder failed (HFI-5). Now a call
 * the real app would refuse is refused the way Tauri refuses it, and the teardown fixture
 * (`../../fixtures/coverage.ts`) fails the test naming it.
 *
 * `src/test/__tests__/openerMock.test.ts` drives the real `@tauri-apps/plugin-opener`
 * functions through a stub IPC and checks what they send fits these shapes, and that the
 * capability file still grants no `open_path`.
 */

/**
 * What each opener command takes on the wire: the keys of its Rust command's arguments
 * (tauri-plugin-opener `src/commands.rs`: `open_url(url: String, with: Option<String>)`,
 * `open_path(path: String, with: Option<String>)`, `reveal_item_in_dir(paths: Vec<PathBuf>)`),
 * which is what the plugin's JS API (`dist-js/index.js`) sends.
 */
export interface OpenerCommandArgs {
  'plugin:opener|open_url': { url: string; with?: string };
  'plugin:opener|open_path': { path: string; with?: string };
  'plugin:opener|reveal_item_in_dir': { paths: string[] };
}

type WireKind<T> = T extends readonly string[] ? 'string[]' : T extends string ? 'string' : never;

/** Each argument's wire kind, `?` when the command may go without it; derived from the type, so the two cannot drift. */
type ArgShape<A> = {
  [F in keyof A]-?: Record<never, never> extends Pick<A, F> ? `${WireKind<Exclude<A[F], undefined>>}?` : WireKind<A[F]>;
};

export const OPENER_ARG_SHAPES: { [K in keyof OpenerCommandArgs]: ArgShape<OpenerCommandArgs[K]> } = {
  'plugin:opener|open_url': { url: 'string', with: 'string?' },
  'plugin:opener|open_path': { path: 'string', with: 'string?' },
  'plugin:opener|reveal_item_in_dir': { paths: 'string[]' },
};

/**
 * Opener commands `src-tauri/capabilities/default.json` does not grant, which the real app
 * refuses before they run: `opener:default` is `open_url` + `reveal_item_in_dir`, and no
 * `opener:allow-open-path` is listed.
 */
export const OPENER_COMMANDS_NOT_GRANTED: readonly (keyof OpenerCommandArgs)[] = ['plugin:opener|open_path'];

/**
 * The refusal the real app answers plugin command `cmd` with when sent `args`, or null when
 * it would run it (a command with no shape is not checked). The message follows Tauri's
 * own for a missing or mistyped argument. Runs in the page, serialized with
 * `Function.prototype.toString`, so it reads nothing but its parameters.
 */
export function pluginArgsRefusal(
  cmd: string,
  args: Record<string, unknown> | undefined,
  shapes: Record<string, Record<string, string>>,
  notGranted: readonly string[],
): string | null {
  if (notGranted.includes(cmd)) {
    return `${cmd} not allowed: src-tauri/capabilities/default.json does not grant it`;
  }
  const shape = shapes[cmd];
  if (!shape) return null;
  const command = cmd.slice(cmd.indexOf('|') + 1);
  for (const [key, kind] of Object.entries(shape)) {
    const optional = kind.endsWith('?');
    const base = optional ? kind.slice(0, -1) : kind;
    const value = args?.[key];
    if (value === undefined || (value === null && optional)) {
      if (optional) continue;
      return `invalid args \`${key}\` for command \`${command}\`: command ${command} missing required key ${key}`;
    }
    const fits =
      base === 'string[]' ? Array.isArray(value) && value.every((v) => typeof v === 'string') : typeof value === base;
    if (!fits) {
      const expected = base === 'string[]' ? 'a sequence of strings' : 'a string';
      return `invalid args \`${key}\` for command \`${command}\`: invalid type: ${JSON.stringify(value)}, expected ${expected}`;
    }
  }
  return null;
}

/**
 * Page-side: the opener mock the core is handed (see {@link openerMockSource}). Runs in
 * the page, serialized with `Function.prototype.toString`: only its parameters and
 * browser globals.
 */
export function installOpenerMock(
  refusal: typeof pluginArgsRefusal,
  shapes: Record<string, Record<string, string>>,
  notGranted: readonly string[],
) {
  // Every refused call, in call order: the teardown fixture reads it (and gets each one
  // live through the __E2E_REPORT_REFUSED_PLUGIN_CALL__ binding, which survives a reload).
  const refused: string[] = [];
  (window as unknown as Record<string, unknown>).__MOCK_REFUSED_PLUGIN_CALLS__ = refused;
  return {
    /** The refusal the real app answers this call with, recorded; null when it would run it. Asked first, before any override. */
    refuse(cmd: string, args?: Record<string, unknown>): string | null {
      const why = refusal(cmd, args, shapes, notGranted);
      if (why === null) return null;
      console.warn(`[Mock IPC] Refused plugin call: ${why}`);
      refused.push(why);
      const report = (window as unknown as Record<string, unknown>).__E2E_REPORT_REFUSED_PLUGIN_CALL__;
      if (typeof report === 'function') (report as (refusal: string) => void)(why);
      return why;
    },
    /** Whether this is an opener command the mock answers (once {@link refuse} let it through). */
    answers(cmd: string): boolean {
      return Object.prototype.hasOwnProperty.call(shapes, cmd);
    },
    /** The opener commands resolve with nothing: there is no desktop to open things on. */
    reply(cmd: string, args?: Record<string, unknown>): undefined {
      console.log(`[Mock IPC] ${cmd} called with:`, args);
      return undefined;
    },
  };
}

export type OpenerMock = ReturnType<typeof installOpenerMock>;

/** The page-side opener mock as source text, for the core's `addInitScript` content. */
export function openerMockSource(): string {
  const shapes = JSON.stringify(OPENER_ARG_SHAPES);
  const notGranted = JSON.stringify(OPENER_COMMANDS_NOT_GRANTED);
  return `(${installOpenerMock.toString()})(${pluginArgsRefusal.toString()}, ${shapes}, ${notGranted})`;
}
