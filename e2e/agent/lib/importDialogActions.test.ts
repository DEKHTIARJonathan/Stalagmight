/**
 * The import fuzzer's testid allowlists, from both directions.
 *
 * `runUiStep` reaches a control by TESTID, and on a replay that testid comes out
 * of a trace file, which `readTrace` checks only for its schema version and step
 * shapes. So the allowlist is what stops a crafted trace clicking a
 * project-delete confirm or a SpeleoDB push inside a privileged webview with the
 * `__E2E_TEST__` hooks live - and it is only useful if it also COVERS everything
 * the generators legitimately produce, or the first honest repro of a newly
 * added control dies at the boundary instead of reproducing.
 *
 * Mirrors `fuzzableActions.test.ts`, which pins the same two directions for the
 * undo fuzzer's store-action allowlist.
 */
import { describe, expect, it } from 'vitest';

import {
  ARMABLE_KEYS,
  CHECKABLE_PATTERNS,
  CHECKABLE_TESTIDS,
  CLICKABLE_PATTERNS,
  CLICKABLE_TESTIDS,
  isDispatchable,
  keyEventInit,
  PRESSABLE_KEYS,
  SELECTABLE_PATTERNS,
  SELECTABLE_TESTIDS,
  TYPEABLE_TESTIDS,
} from '../scenarios/importDialogBridge';
import {
  ADVANCE_MOVE,
  ESCAPE_PATH,
  IN_FLOW_SCREENS,
  NON_FLOW_SCREENS,
  SELECT_TESTIDS,
  TESTID_INVENTORY,
} from '../scenarios/importDialogModel';
import { describeSource, enabledFamilies, GENERATORS } from '../scenarios/importDialogGenerators';
import { corpusPathHash } from './fixtureCorpus';

/**
 * Testids a generator can emit, as literals.
 *
 * Read out of the SOURCE rather than by calling the generators: every `build`
 * needs a live `ScenarioContext` and a digest of a running app, so the emitted
 * ids cannot be enumerated by invoking them. The two regexes are anchored to the
 * `click(...)` / `type(...)` / `select(...)` / `check(...)` call shapes the
 * catalog uses for every entry, plus the template literals the dynamic ones
 * build.
 */
const source = new URL('../scenarios/importDialogGenerators.ts', import.meta.url);

async function generatorSource(): Promise<string> {
  const fs = await import('fs');
  return fs.readFileSync(source, 'utf8');
}

/** `click('x', ...)` / `type('x', ...)` / `select('x', ...)` / `check('x', ...)`. */
function literalTargets(text: string, fn: string): string[] {
  const re = new RegExp(`\\b${fn}\\('([^']+)'`, 'g');
  return [...text.matchAll(re)].map((match) => match[1] as string);
}

/** Every `` `prefix-${...}` `` template the catalog drives, by call shape. */
function templateTargets(text: string, fn = 'click'): string[] {
  const re = new RegExp(`\\b${fn}\\(\`([^\`]+)\``, 'g');
  return [...text.matchAll(re)].map((match) => match[1] as string);
}

/** Turn a template into a concrete id a pattern can be tested against. */
function sampleFrom(template: string): string {
  return template
    .replace(/\$\{[^}]*\[1\][^}]*\}/g, 'length')
    .replace(/\$\{[^}]*\}/g, '7');
}

describe('import fuzzer testid allowlists', () => {
  it('allows every literal testid the generators can click', async () => {
    const text = await generatorSource();
    const clicked = literalTargets(text, 'click').filter((id) => !id.startsWith('key:'));
    expect(clicked.length).toBeGreaterThan(25);
    const rejected = clicked.filter((id) => !isDispatchable({ kind: 'ui', testid: id, label: 'x' }));
    expect(rejected).toEqual([]);
  });

  it('allows every dynamic testid the generators can click', async () => {
    const text = await generatorSource();
    const templates = templateTargets(text);
    expect(templates.length).toBeGreaterThan(4);
    const rejected = templates
      .map(sampleFrom)
      .filter((id) => !isDispatchable({ kind: 'ui', testid: id, label: 'x' }));
    expect(rejected).toEqual([]);
  });

  it('allows every key a generator can press', async () => {
    const text = await generatorSource();
    const keys = literalTargets(text, 'click').filter((id) => id.startsWith('key:'));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(isDispatchable({ kind: 'ui', testid: key, label: 'x' })).toBe(true);
    }
  });

  it('allows every testid the generators can type into, select or check', async () => {
    const text = await generatorSource();
    for (const [fn, mode] of [
      ['type', 'type'],
      ['select', 'select'],
      ['check', 'check'],
    ] as const) {
      const targets = literalTargets(text, fn);
      expect(targets.length).toBeGreaterThan(2);
      const rejected = targets.filter(
        (id) => !isDispatchable({ kind: 'input', testid: id, value: 'v', mode, label: 'x' }),
      );
      expect(rejected).toEqual([]);
    }
    // `check` also drives `section-checkbox-N`, built as a template literal.
    expect(
      isDispatchable({ kind: 'input', testid: 'section-checkbox-12', value: 'true', mode: 'check', label: 'x' }),
    ).toBe(true);
    // Selects reached through a variable rather than a literal (the wizard's
    // from-existing / manual families) still have to be allowed.
    for (const id of SELECT_TESTIDS) {
      expect(isDispatchable({ kind: 'input', testid: id, value: '0', mode: 'select', label: 'x' })).toBe(true);
    }
  });

  it('allows every testid the model can force as an advance or an escape', () => {
    const forced = [
      ...Object.values(ADVANCE_MOVE).flatMap((route) => [...(route ?? [])]),
      ...Object.values(ESCAPE_PATH).flatMap((route) => [...route]),
    ].filter((id): id is string => typeof id === 'string');
    expect(forced.length).toBeGreaterThan(30);
    const rejected = forced.filter((id) => !isDispatchable({ kind: 'ui', testid: id, label: 'x' }));
    expect(rejected).toEqual([]);
  });

  it('allows every dynamic testid the generators can select', async () => {
    const text = await generatorSource();
    const templates = templateTargets(text, 'select');
    expect(templates.length).toBeGreaterThan(0);
    const rejected = templates
      .map(sampleFrom)
      .filter((id) => !isDispatchable({ kind: 'input', testid: id, value: 'v', mode: 'select', label: 'x' }));
    expect(rejected).toEqual([]);
  });

  it('allows the two dynamic checkbox families', () => {
    // Both are built into a local before the call, so the source scan above
    // cannot see them; they are named here instead of being missed.
    for (const id of ['section-checkbox-12', 'walls-survey-7']) {
      expect(
        isDispatchable({ kind: 'input', testid: id, value: 'true', mode: 'check', label: 'x' }),
        `${id} must be checkable`,
      ).toBe(true);
    }
  });

  it('does NOT carry the destructive controls a trace must never reach', () => {
    // The ones that make a hostile trace worth writing: destroy the project,
    // publish it somewhere, or write it to a path of the trace's choosing.
    const forbidden = [
      'delete-project-confirm',
      'delete-project-button',
      'confirm-delete-button',
      'speleodb-publish',
      'publish-to-speleodb-confirm',
      'speleodb-push',
      'speleodb-force-edit-confirm',
      'save-as-button',
      'project-save-path-browse-button',
      'bulk-delete-confirm',
      'unsaved-changes-discard',
      'debug-trigger-panic',
    ];
    for (const id of forbidden) {
      expect(CLICKABLE_TESTIDS.has(id), `${id} must not be clickable`).toBe(false);
      expect(TYPEABLE_TESTIDS.has(id), `${id} must not be typeable`).toBe(false);
      expect(SELECTABLE_TESTIDS.has(id), `${id} must not be selectable`).toBe(false);
      expect(CHECKABLE_TESTIDS.has(id), `${id} must not be checkable`).toBe(false);
      expect(isDispatchable({ kind: 'ui', testid: id, label: 'x' }), `${id} must not dispatch`).toBe(false);
    }
  });

  it('keeps every pattern anchored and bounded', () => {
    for (const pattern of [...CLICKABLE_PATTERNS, ...CHECKABLE_PATTERNS, ...SELECTABLE_PATTERNS]) {
      const body = pattern.source;
      expect(body.startsWith('^'), `${body} must be anchored at the start`).toBe(true);
      expect(body.endsWith('$'), `${body} must be anchored at the end`).toBe(true);
      // An unbounded quantifier is how a pattern widens into an id it was never
      // meant to reach, so the digit and key runs carry explicit ceilings.
      expect(/[+*]/.test(body.replace(/\\[+*]/g, '')), `${body} must not use + or *`).toBe(false);
    }
  });

  it('refuses a key nobody registered', () => {
    expect(PRESSABLE_KEYS.has('Escape')).toBe(true);
    for (const key of ['Enter', 'Control+o', 'F5', 'Delete', 'ctrl+e']) {
      expect(isDispatchable({ kind: 'ui', testid: `key:${key}`, label: 'x' })).toBe(false);
    }
  });

  it('keeps the ARMABLE chords out of the pressable set', () => {
    // A bare press of Ctrl+O raises a native picker with no armed answer, which
    // falls through to the real GTK chooser and hangs the webview. The two
    // vocabularies must not be interchangeable even by accident.
    for (const chord of ARMABLE_KEYS) {
      expect(PRESSABLE_KEYS.has(chord), `${chord} must not be pressable`).toBe(false);
      expect(isDispatchable({ kind: 'ui', testid: `key:${chord}`, label: 'x' })).toBe(false);
    }
  });

  it('spells a chord the way the app itself reads one back', () => {
    /**
     * A MIRROR of `parseKeyEvent` + `normalizeKeyName` (`src/utils/shortcuts.ts`),
     * not an import of them: that module's first line pulls in `../i18n`, whose
     * `import.meta.env` does not typecheck under `tsconfig.agent.json`. The
     * mirror is three lines and is what the pseudo-testid's whole meaning rests
     * on - a chord this fuzzer presses has to fold back into the shortcut name
     * the app registered, or the keystroke is silently inert.
     */
    const spell = (init: ReturnType<typeof keyEventInit>): string => {
      const parts: string[] = [];
      if (init.ctrl) parts.push('Ctrl');
      if (init.alt) parts.push('Alt');
      if (init.shift) parts.push('Shift');
      parts.push(/^[a-zA-Z]$/.test(init.key) ? init.key.toUpperCase() : init.key);
      return parts.join('+');
    };
    for (const chord of [...PRESSABLE_KEYS, ...ARMABLE_KEYS]) {
      expect(spell(keyEventInit(chord)), `${chord} must round-trip`).toBe(chord);
    }
    // A real browser reports the LOWERCASE letter for an unshifted press, and
    // sending the uppercase one would make the event look like Shift+E.
    expect(keyEventInit('Ctrl+E').key).toBe('e');
    expect(keyEventInit('Escape').key).toBe('Escape');
  });

  it('has an inventory that covers every allowlisted literal', () => {
    // The other direction of the same contract: a control the bridge would
    // dispatch but the DIGEST never reports is one the generators can only ever
    // reach blind, so every literal in an allowlist must be observable.
    const inventory = new Set(TESTID_INVENTORY);
    const prefixes = TESTID_INVENTORY.filter((entry) => entry.endsWith('*')).map((entry) => entry.slice(0, -1));
    const covered = (id: string): boolean =>
      inventory.has(id) || prefixes.some((prefix) => id.startsWith(prefix));
    const uncovered = [
      ...CLICKABLE_TESTIDS,
      ...TYPEABLE_TESTIDS,
      ...SELECTABLE_TESTIDS,
      ...CHECKABLE_TESTIDS,
    ].filter((id) => !covered(id));
    expect(uncovered).toEqual([]);
  });

  it('has a generator catalog whose screens are all escapable', () => {
    const screens = new Set(GENERATORS.flatMap((generator) => [...generator.screens]));
    expect(screens.size).toBeGreaterThan(8);
    for (const screen of screens) {
      expect(ESCAPE_PATH[screen], `no escape path for ${screen}`).toBeDefined();
    }
  });

  it('has a generator for every screen a flow can be on', () => {
    // The other half of the escapability contract: a screen with an escape path
    // and no generators is one the walk can only ever leave, so the controls on
    // it are never exercised at all.
    const screens = new Set(GENERATORS.flatMap((generator) => [...generator.screens]));
    const uncovered = [...IN_FLOW_SCREENS].filter((screen) => !screens.has(screen));
    // The exceptions are named rather than tolerated. `wiz-init` and
    // `wiz-blank` are transient wizard phases that render no control of their
    // own, and `first-run` is the telemetry modal, whose only choice the
    // scenario makes once at startup - so progress forcing is the only thing
    // that ever acts on any of the three.
    expect(uncovered.sort()).toEqual(['first-run', 'wiz-blank', 'wiz-init']);
    for (const screen of NON_FLOW_SCREENS) {
      expect(screens.has(screen), `${screen} needs a generator too`).toBe(true);
    }
  });

  it('never names a corpus file in anything a run publishes', () => {
    // A survey filename can name a cave, a landowner or an unreleased project.
    // `describeSource` is what reaches the move history, the metric keys and the
    // failure payload, so it carries the id and never the path.
    const relPath = 'some-cave-system/2019-expedition/final.tml';
    const described = describeSource({
      origin: 'corpus',
      corpusRel: relPath,
      id: 'abc12',
      hash: corpusPathHash(relPath),
      dirRel: 'fuzz-files/corpus-3',
      rel: 'fuzz-files/corpus-3/final.tml',
    });
    expect(described).toBe('corpus #abc12');
    for (const segment of relPath.split('/')) expect(described).not.toContain(segment);
    // The resolution key is not published either: it is a lookup field on the
    // trace step, and nothing renders it.
    expect(described).not.toContain(corpusPathHash(relPath));
  });

  it('reads the format axis at call time and falls back to every family', () => {
    const before = process.env.STALAGMIGHT_FUZZ_IMPORT_FORMAT;
    try {
      delete process.env.STALAGMIGHT_FUZZ_IMPORT_FORMAT;
      expect([...enabledFamilies()].sort()).toEqual(['compass', 'dmp', 'gpx', 'tml', 'walls']);
      process.env.STALAGMIGHT_FUZZ_IMPORT_FORMAT = 'walls, GPX ,nonsense';
      expect([...enabledFamilies()].sort()).toEqual(['gpx', 'walls']);
      // An axis that names nothing this build knows is a typo, and silently
      // fuzzing zero formats would be worse than fuzzing all of them.
      process.env.STALAGMIGHT_FUZZ_IMPORT_FORMAT = 'nonsense';
      expect([...enabledFamilies()].sort()).toEqual(['compass', 'dmp', 'gpx', 'tml', 'walls']);
    } finally {
      if (before === undefined) delete process.env.STALAGMIGHT_FUZZ_IMPORT_FORMAT;
      else process.env.STALAGMIGHT_FUZZ_IMPORT_FORMAT = before;
    }
  });

  it('has a generator catalog with only positive weights', () => {
    for (const generator of GENERATORS) {
      expect(generator.weight, `${generator.name} weight`).toBeGreaterThan(0);
      expect(generator.screens.length, `${generator.name} screens`).toBeGreaterThan(0);
    }
    const names = GENERATORS.map((generator) => generator.name);
    expect(new Set(names).size, 'generator names must be unique').toBe(names.length);
  });
});
