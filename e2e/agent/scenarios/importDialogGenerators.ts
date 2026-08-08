/**
 * `import-dialog-fuzz`'s move generators: a weighted catalog, one entry per
 * thing a user can do on a screen of the DMP import flow.
 *
 * ## The contract every entry keeps
 *
 * `build` returns `null` when the move is IMPOSSIBLE right now - the control is
 * not there, the select has no options, there is no frozen row to aim at. That
 * is the harness's standing rule (`undoRedoFuzzActions.ts` has the same one):
 * an impossible move is skipped and counted, never asserted away, because a
 * ddmin-cut trace runs against a state the original run never had and every
 * removed step makes more moves impossible. A generator that threw instead
 * would make shrinking impossible.
 *
 * Weights are the ones the wave-2 plan fixed. Tune them only against a smoke run
 * that shows a screen starving; a weight changed for taste silently rewrites
 * every seed's trajectory and invalidates every repro line in the header of
 * `importDialogFuzz.ts`.
 *
 * ## DMP only, this wave
 *
 * `randomDmpSpec` / `corruptSpec` can emit TML and TMLU too, and
 * `lib/fixtureCorpus.ts` exists. Neither is drawn here: the flow model, the
 * escape paths and the accounting oracle are all DMP-shaped, and widening them
 * is wave 3.
 */
import type { ScenarioContext } from './framework';
import type { ImportScreenDigest } from '../lib/importScreenDigest';
import {
  HOSTILE_COMMENTS,
  randomDmpSpec,
  type GeneratedFileSpec,
  type Rng,
} from '../lib/surveyFileSpecs';
import { corruptSpec } from '../lib/surveyFileCorrupt';
import { OVERLAP_MODES, type ScreenId } from './importDialogModel';

// ---------------------------------------------------------------------------
// Move vocabulary
// ---------------------------------------------------------------------------

/** Where an input file comes from. */
export type FileSource =
  /** Built here from a spec; the SPEC travels in the trace, never the bytes. */
  | { origin: 'gen'; spec: GeneratedFileSpec; rel: string }
  /** A tracked fixture, materialized by `ctx.fixturePath` under `fixtures/`. */
  | { origin: 'fixture'; name: string; rel: string }
  /**
   * REPLAY ONLY: a file a preceding `genFile` step already wrote. The spec does
   * not travel twice, so the reference is just the rel - and if ddmin cut the
   * `genFile` step away, the file is simply not there and the move is skipped
   * and counted like any other impossible one.
   */
  | { origin: 'disk'; rel: string };

/**
 * One move. The first two mirror the `ui` / `input` trace steps exactly; the
 * rest are shell-level moves that need Node (disk, a native dialog answer, the
 * map projection) and are translated into their own trace steps there.
 */
export type FuzzMove =
  | { kind: 'ui'; testid: string; double?: boolean; label: string }
  | { kind: 'input'; testid: string; value: string; mode: 'type' | 'select' | 'check'; label: string }
  /** Materialize a file and hand it to the app, by picker or by router. */
  | { kind: 'openFile'; source: FileSource; via: 'dialog' | 'route'; trigger: string; label: string }
  /** Answer a picker with a CANCEL, which is its own code path. */
  | { kind: 'cancelDialog'; trigger: string; label: string }
  /**
   * A map click. `relative` means `lngLat` is an OFFSET from the map's current
   * centre, resolved by the shell at dispatch and recorded ABSOLUTE - a
   * generator cannot know where the survey is, and `lib/controls.ts`'s
   * `mapClick` refuses a point outside the visible viewport, so an absolute
   * draw would be skipped on essentially every attempt.
   */
  | { kind: 'mapClick'; lngLat: [number, number]; relative?: boolean; label: string }
  /** `uiStore.confirmPlacement()` - the map's confirm has no button. */
  | { kind: 'confirmPlacement'; label: string }
  | { kind: 'undo'; label: string }
  | { kind: 'redo'; label: string }
  | { kind: 'save'; label: string };

/** What a generator gets to look at. */
export interface GenEnv {
  ctx: ScenarioContext;
  digest: ImportScreenDigest;
  /** Session-relative directory generated files are written under. */
  filesRel: string;
  /** Draw counter, so generated file names are unique within a run. */
  fileSeq: number;
}

export interface Generator {
  name: string;
  weight: number;
  screens: readonly ScreenId[];
  build(env: GenEnv): FuzzMove | null;
}

// ---------------------------------------------------------------------------
// Draw helpers
// ---------------------------------------------------------------------------

function actionable(digest: ImportScreenDigest, testid: string): boolean {
  return digest.live[testid] === 2;
}

function presentButOff(digest: ImportScreenDigest, testid: string): boolean {
  return digest.live[testid] === 1;
}

/** Live ids matching `prefix<index>` (and nothing longer), sorted by index. */
function indexedIds(digest: ImportScreenDigest, prefix: string, onlyActionable = true): number[] {
  const out: number[] = [];
  for (const [testid, state] of Object.entries(digest.live)) {
    if (!testid.startsWith(prefix)) continue;
    if (onlyActionable && state !== 2) continue;
    const rest = testid.slice(prefix.length);
    if (!/^\d+$/.test(rest)) continue;
    out.push(Number(rest));
  }
  return out.sort((a, b) => a - b);
}

/** Rendered cells, as `[row, columnKey]`. */
function gridCells(digest: ImportScreenDigest): [number, string][] {
  const out: [number, string][] = [];
  for (const [testid, state] of Object.entries(digest.live)) {
    if (state !== 2 || !testid.startsWith('shot-editor-cell-')) continue;
    const match = /^shot-editor-cell-(\d{1,3})-([a-z_]{1,20})$/.exec(testid);
    if (!match) continue;
    out.push([Number(match[1]), match[2] as string]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
}

function click(testid: string, label: string, double = false): FuzzMove {
  return double ? { kind: 'ui', testid, double: true, label } : { kind: 'ui', testid, label };
}

function type(testid: string, value: string, label: string): FuzzMove {
  return { kind: 'input', testid, value, mode: 'type', label };
}

function select(testid: string, value: string, label: string): FuzzMove {
  return { kind: 'input', testid, value, mode: 'select', label };
}

function check(testid: string, value: boolean, label: string): FuzzMove {
  return { kind: 'input', testid, value: value ? 'true' : 'false', mode: 'check', label };
}

// ---------------------------------------------------------------------------
// Hostile corpora
// ---------------------------------------------------------------------------

/**
 * Dates that are not dates, plus the two ends of the four-digit year range.
 * `<input type="date">` rejects most of them outright - which is the point: the
 * oracle asserts the app stays coherent, not that the value stuck.
 */
export const DATE_BOUNDARIES: readonly string[] = [
  '',
  '0000-01-01',
  '9999-12-31',
  '2024-02-30',
  'not-a-date',
];

/**
 * GPS strings the zero-datum parser has to survive.
 *
 * `'1e400'` is `Infinity` once parsed, `'-0'` is the negative zero that
 * `section_offsets`' dust rule turns on, `'91,181'` is out of range on both
 * axes, and the RLO/PDF pair is a bidi override that reorders whatever a table
 * cell renders after it. The 512-character entry looks for a length clamp.
 */
export const GPS_HOSTILE: readonly string[] = [
  '',
  '0,0',
  '91,181',
  '12 34 56 N',
  'NaN',
  '1e400',
  '-0',
  '48.8583N,2.2944E',
  '‮abc مرحبا‬',
  'x'.repeat(512),
];

/** Numeric strings a shot cell has to accept, clamp or reject without crashing. */
export const CELL_BOUNDARIES: readonly string[] = [
  '0',
  '-0',
  '1e3',
  '-1e3',
  '1e-9',
  'NaN',
  'Infinity',
  '1,5',
  '  7  ',
  '360',
  '-1',
  '',
];

/** Names/surveyors: half plain, half from the shared hostile-text corpus. */
export function biasedText(rng: Rng, seq: number): string {
  if (rng() < 0.5) return HOSTILE_COMMENTS[Math.floor(rng() * HOSTILE_COMMENTS.length)] as string;
  return `fuzz-${seq}-${Math.floor(rng() * 1000)}`;
}

function pickFrom<T>(rng: Rng, items: readonly T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(rng() * items.length)] as T;
}

// ---------------------------------------------------------------------------
// File sources
// ---------------------------------------------------------------------------

/** Tracked `.dmp` fixtures the flow starters may draw. */
export const DMP_FIXTURES: readonly string[] = [
  'kb5.dmp',
  'test_v2.dmp',
  'test_v5.dmp',
  'test_v5_buggy_EOS.dmp',
  'test_corrupted.dmp',
];

/**
 * Stand-in for the session's `fuzz-projects/` directory in a save-path move.
 *
 * The shell substitutes the real absolute path at dispatch time. A trace
 * therefore carries the PLACEHOLDER, never a path - so replaying one on another
 * machine cannot choose where this process creates a `.stalx`, the same rule
 * `fuzzTrace.ts` enforces for every `rel`.
 */
export const PROJECT_DIR_PLACEHOLDER = '<fuzz-projects>';

/** Share of generated files drawn from the corruption catalog. */
export function malformedProbability(): number {
  const raw = Number(process.env.STALAGMIGHT_FUZZ_IMPORT_MALFORMED_P);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.2;
}

/** Draw one input file: a generated spec (valid-biased) or a tracked fixture. */
export function drawFileSource(env: GenEnv): FileSource {
  const rng = () => env.ctx.rng();
  if (rng() < 0.25) {
    const name = pickFrom(rng, DMP_FIXTURES) as string;
    return { origin: 'fixture', name, rel: `fixtures/${name}` };
  }
  const malformed = rng() < malformedProbability();
  const profile = malformed ? 'malformed' : 'valid';
  const clean: GeneratedFileSpec = {
    format: 'dmp',
    name: `fuzz-${env.fileSeq}.dmp`,
    profile,
    dmp: randomDmpSpec(rng, profile),
  };
  let spec = clean;
  if (malformed) {
    const corrupted = corruptSpec(rng, clean);
    // The catalog id is `dmp:<entry>`; a colon is a legal Linux filename byte
    // and an illegal Windows one, and a trace is meant to be portable.
    const tag = corrupted.corruption.replace(/[^a-z0-9]+/gi, '-');
    if (corrupted.spec.format !== 'dmp') throw new Error('the DMP corruption catalog returned a non-DMP spec');
    spec = { ...corrupted.spec, name: `fuzz-${env.fileSeq}-${tag}.dmp` };
  }
  return { origin: 'gen', spec, rel: `${env.filesRel}/${spec.name}` };
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * Flow starters. Only legal on `idle`.
 *
 * With NO project open a `.dmp` routes to `new-project-for-import` rather than
 * to the selection dialog, so the same starters exercise
 * `importContext='new-project'` and its deferred initial save. That is not a
 * separate generator: it falls out of whether a project happens to be open.
 */
const STARTERS: Generator[] = [
  {
    name: 'start:picker',
    weight: 10,
    screens: ['idle'],
    build: (env) => {
      const trigger = actionable(env.digest, 'toolbar-import-button')
        ? 'toolbar-import-button'
        : actionable(env.digest, 'global-open-import-button')
          ? 'global-open-import-button'
          : null;
      if (trigger === null) return null;
      const source = drawFileSource(env);
      return { kind: 'openFile', source, via: 'dialog', trigger, label: `import via ${trigger}` };
    },
  },
  {
    name: 'start:route',
    weight: 6,
    screens: ['idle'],
    build: (env) => {
      const source = drawFileSource(env);
      return { kind: 'openFile', source, via: 'route', trigger: 'routeOpenedFile', label: 'import via router' };
    },
  },
  {
    name: 'start:cancel-picker',
    weight: 2,
    screens: ['idle'],
    build: (env) => {
      const trigger = actionable(env.digest, 'toolbar-import-button')
        ? 'toolbar-import-button'
        : actionable(env.digest, 'global-open-import-button')
          ? 'global-open-import-button'
          : null;
      if (trigger === null) return null;
      return { kind: 'cancelDialog', trigger, label: `cancel the picker on ${trigger}` };
    },
  },
];

const DMP_SELECT: Generator[] = [
  {
    name: 'dmp:toggle-section',
    weight: 12,
    screens: ['dmp-select'],
    build: (env) => {
      const index = pickFrom(() => env.ctx.rng(), indexedIds(env.digest, 'section-checkbox-'));
      if (index === null) return null;
      const testid = `section-checkbox-${index}`;
      const want = env.ctx.rng() < 0.5;
      return check(testid, want, `set ${testid}=${want}`);
    },
  },
  {
    name: 'dmp:select-all',
    weight: 3,
    screens: ['dmp-select'],
    build: (env) => (actionable(env.digest, 'select-all-button') ? click('select-all-button', 'select all') : null),
  },
  {
    name: 'dmp:select-none',
    weight: 3,
    screens: ['dmp-select'],
    build: (env) => (actionable(env.digest, 'select-none-button') ? click('select-none-button', 'select none') : null),
  },
  {
    name: 'dmp:invert',
    weight: 3,
    screens: ['dmp-select'],
    build: (env) =>
      actionable(env.digest, 'invert-selection-button') ? click('invert-selection-button', 'invert selection') : null,
  },
  {
    name: 'dmp:surveyor',
    weight: 5,
    screens: ['dmp-select'],
    build: (env) => {
      if (!actionable(env.digest, 'default-surveyor-input')) return null;
      const value = biasedText(() => env.ctx.rng(), env.fileSeq);
      return type('default-surveyor-input', value, `default surveyor=${JSON.stringify(value.slice(0, 24))}`);
    },
  },
  {
    name: 'dmp:date',
    weight: 5,
    screens: ['dmp-select'],
    build: (env) => {
      if (!actionable(env.digest, 'default-date-input')) return null;
      const value = pickFrom(() => env.ctx.rng(), DATE_BOUNDARIES) as string;
      return type('default-date-input', value, `default date=${JSON.stringify(value)}`);
    },
  },
  {
    name: 'dmp:continue',
    weight: 14,
    screens: ['dmp-select'],
    build: (env) => (actionable(env.digest, 'continue-button') ? click('continue-button', 'continue') : null),
  },
  {
    name: 'dmp:cancel',
    weight: 2,
    screens: ['dmp-select'],
    build: (env) => (actionable(env.digest, 'cancel-button') ? click('cancel-button', 'cancel selection') : null),
  },
  {
    /**
     * The ONLY generator that deliberately targets a control the digest says is
     * NOT actionable.
     *
     * `continue-button` is disabled while the duplicate-hash and section-hash
     * probes are still in flight, and that window is short and real. Clicking
     * into it asserts the disabled state is HONEST: a disabled control must not
     * advance the flow. The shell checks that inline (the screen must not have
     * changed); everything else about the move is an ordinary click.
     */
    name: 'dmp:race-continue',
    weight: 6,
    screens: ['dmp-select'],
    build: (env) =>
      presentButOff(env.digest, 'continue-button')
        ? click('continue-button', 'RACE: continue while disabled')
        : null,
  },
];

const ZERO_DATUM: Generator[] = [
  {
    name: 'zd:pick-section',
    weight: 8,
    screens: ['zero-datum-select'],
    build: (env) => {
      const index = pickFrom(() => env.ctx.rng(), indexedIds(env.digest, 'zero-datum-section-card-'));
      if (index === null) return null;
      return click(`zero-datum-section-card-${index}`, `zero datum on section ${index}`);
    },
  },
  {
    name: 'zd:skip',
    weight: 6,
    screens: ['zero-datum-select'],
    build: (env) =>
      actionable(env.digest, 'zero-datum-selection-skip') ? click('zero-datum-selection-skip', 'skip zero datum') : null,
  },
  {
    name: 'zd:back',
    weight: 3,
    screens: ['zero-datum-select'],
    build: (env) =>
      actionable(env.digest, 'zero-datum-selection-back') ? click('zero-datum-selection-back', 'back') : null,
  },
  {
    name: 'zd:cancel',
    weight: 2,
    screens: ['zero-datum-select'],
    build: (env) =>
      actionable(env.digest, 'zero-datum-selection-cancel') ? click('zero-datum-selection-cancel', 'cancel') : null,
  },
];

const ZERO_DATUM_CONFIG: Generator[] = [
  {
    name: 'zdc:station',
    weight: 6,
    screens: ['zero-datum-config'],
    build: (env) => {
      if (!actionable(env.digest, 'zero-datum-station-select')) return null;
      // Station count is shots+1; `rows` is the rendered grid window, which is
      // the honest upper bound available without opening the listbox. An index
      // the select does not offer is skipped-and-counted by the bridge.
      const bound = Math.max(1, env.digest.rows);
      const index = Math.floor(env.ctx.rng() * bound);
      return select('zero-datum-station-select', String(index), `zero-datum station ${index}`);
    },
  },
  {
    name: 'zdc:gps',
    weight: 8,
    screens: ['zero-datum-config'],
    build: (env) => {
      if (!actionable(env.digest, 'zero-datum-gps-input')) return null;
      const value = pickFrom(() => env.ctx.rng(), GPS_HOSTILE) as string;
      return type('zero-datum-gps-input', value, `gps=${JSON.stringify(value.slice(0, 24))}`);
    },
  },
  {
    name: 'zdc:name',
    weight: 5,
    screens: ['zero-datum-config'],
    build: (env) => {
      if (!actionable(env.digest, 'section-name-input')) return null;
      const value = biasedText(() => env.ctx.rng(), env.fileSeq);
      return type('section-name-input', value, `section name=${JSON.stringify(value.slice(0, 24))}`);
    },
  },
  {
    name: 'zdc:confirm',
    weight: 12,
    screens: ['zero-datum-config'],
    build: (env) =>
      actionable(env.digest, 'zero-datum-config-confirm') ? click('zero-datum-config-confirm', 'confirm zero datum') : null,
  },
  {
    name: 'zdc:back',
    weight: 4,
    screens: ['zero-datum-config'],
    build: (env) => (actionable(env.digest, 'zero-datum-config-back') ? click('zero-datum-config-back', 'back') : null),
  },
  {
    name: 'zdc:cancel',
    weight: 2,
    screens: ['zero-datum-config'],
    build: (env) =>
      actionable(env.digest, 'zero-datum-config-cancel') ? click('zero-datum-config-cancel', 'cancel') : null,
  },
];

const WIZARD_SUGGEST: Generator[] = [
  {
    name: 'wiz:confirm',
    weight: 14,
    screens: ['wiz-suggest'],
    build: (env) => (actionable(env.digest, 'confirm-button') ? click('confirm-button', 'accept suggestion') : null),
  },
  {
    name: 'wiz:skip',
    weight: 6,
    screens: ['wiz-suggest'],
    build: (env) => (actionable(env.digest, 'skip-button') ? click('skip-button', 'skip suggestion') : null),
  },
  {
    name: 'wiz:toggle-alternatives',
    weight: 4,
    screens: ['wiz-suggest'],
    build: (env) =>
      actionable(env.digest, 'toggle-alternatives') ? click('toggle-alternatives', 'toggle alternatives') : null,
  },
  {
    name: 'wiz:alternative',
    weight: 5,
    screens: ['wiz-suggest'],
    build: (env) => {
      const index = pickFrom(() => env.ctx.rng(), indexedIds(env.digest, 'alternative-'));
      if (index === null) return null;
      return click(`alternative-${index}`, `alternative ${index}`);
    },
  },
  {
    name: 'wiz:back',
    weight: 3,
    screens: ['wiz-suggest', 'wiz-manual', 'wiz-no-suggest'],
    build: (env) => (actionable(env.digest, 'back-button') ? click('back-button', 'wizard back') : null),
  },
  {
    name: 'wiz:overlap-mode',
    weight: 5,
    screens: ['wiz-suggest'],
    build: (env) => {
      if (!actionable(env.digest, 'overlap-mode-select')) return null;
      const mode = pickFrom(() => env.ctx.rng(), OVERLAP_MODES) as string;
      return select('overlap-mode-select', mode, `overlap mode ${mode}`);
    },
  },
  {
    name: 'wiz:merge-station',
    weight: 4,
    screens: ['wiz-suggest'],
    build: (env) => {
      if (!actionable(env.digest, 'merge-station-select')) return null;
      // The offsets are computed per suggestion, so the readable list is the
      // only source of truth; blind draws would be skips almost every time.
      const options = env.digest.opts['merge-station-select'];
      const value = options && options.length > 0 ? pickFrom(() => env.ctx.rng(), options) : String(env.ctx.randInt(-2, 2));
      if (value === null) return null;
      return select('merge-station-select', value, `merge station offset ${value}`);
    },
  },
  {
    name: 'wiz:cancel',
    weight: 2,
    screens: ['wiz-suggest', 'wiz-manual', 'wiz-no-suggest', 'wiz-done', 'wiz-error'],
    build: (env) => (actionable(env.digest, 'cancel-button') ? click('cancel-button', 'wizard cancel') : null),
  },
];

/** Mid-import metadata edits, legal wherever a SectionMetadataForm is mounted. */
const METADATA_SCREENS: readonly ScreenId[] = ['zero-datum-config', 'wiz-suggest', 'wiz-manual'];

const METADATA: Generator[] = [
  {
    name: 'meta:name',
    weight: 4,
    screens: ['wiz-suggest', 'wiz-manual'],
    build: (env) => {
      if (!actionable(env.digest, 'section-name-input')) return null;
      const value = biasedText(() => env.ctx.rng(), env.fileSeq);
      return type('section-name-input', value, `name=${JSON.stringify(value.slice(0, 24))}`);
    },
  },
  {
    name: 'meta:surveyor',
    weight: 3,
    screens: METADATA_SCREENS,
    build: (env) => {
      if (!actionable(env.digest, 'section-surveyor-input')) return null;
      const value = biasedText(() => env.ctx.rng(), env.fileSeq);
      return type('section-surveyor-input', value, `surveyor=${JSON.stringify(value.slice(0, 24))}`);
    },
  },
  {
    name: 'meta:date',
    weight: 3,
    screens: METADATA_SCREENS,
    build: (env) => {
      if (!actionable(env.digest, 'section-date-input')) return null;
      const value = pickFrom(() => env.ctx.rng(), DATE_BOUNDARIES) as string;
      return type('section-date-input', value, `date=${JSON.stringify(value)}`);
    },
  },
  {
    name: 'meta:direction',
    weight: 3,
    screens: METADATA_SCREENS,
    build: (env) => {
      if (!actionable(env.digest, 'section-direction-select')) return null;
      const value = env.ctx.rng() < 0.5 ? 'in' : 'out';
      return select('section-direction-select', value, `direction ${value}`);
    },
  },
  {
    name: 'meta:quality',
    weight: 2,
    screens: METADATA_SCREENS,
    build: (env) => {
      if (!actionable(env.digest, 'section-quality-input')) return null;
      const value = String(env.ctx.randInt(-1, 6));
      return type('section-quality-input', value, `quality=${value}`);
    },
  },
  {
    name: 'meta:color',
    weight: 2,
    screens: METADATA_SCREENS,
    build: (env) => {
      if (!actionable(env.digest, 'section-color-hex-input')) return null;
      const value = pickFrom(() => env.ctx.rng(), ['#000000', '#ffffff', 'not-a-colour', '#12345', '#ABCDEF']) as string;
      return type('section-color-hex-input', value, `colour=${value}`);
    },
  },
  {
    name: 'meta:reverse',
    weight: 5,
    screens: METADATA_SCREENS,
    build: (env) => {
      if (!actionable(env.digest, 'section-reverse-checkbox')) return null;
      const want = env.ctx.rng() < 0.5;
      return check('section-reverse-checkbox', want, `reverse=${want}`);
    },
  },
];

const WIZARD_MANUAL: Generator[] = [
  {
    name: 'man:mode-suggestion',
    weight: 4,
    screens: ['wiz-manual'],
    build: (env) =>
      actionable(env.digest, 'segment-mode-suggestion-input')
        ? check('segment-mode-suggestion-input', true, 'segment mode: suggestion')
        : null,
  },
  {
    name: 'man:mode-from-existing',
    weight: 5,
    screens: ['wiz-manual'],
    build: (env) =>
      actionable(env.digest, 'segment-mode-from-existing-input')
        ? check('segment-mode-from-existing-input', true, 'segment mode: from existing')
        : null,
  },
  {
    name: 'man:from-existing-selects',
    weight: 12,
    screens: ['wiz-manual'],
    build: (env) => {
      const candidates = [
        'from-existing-import-section-select',
        'from-existing-import-station-select',
        'from-existing-section-select',
        'from-existing-station-select',
      ].filter((testid) => actionable(env.digest, testid));
      const testid = pickFrom(() => env.ctx.rng(), candidates);
      if (testid === null) return null;
      const options = env.digest.opts[testid];
      const value =
        options && options.length > 0
          ? (pickFrom(() => env.ctx.rng(), options) as string)
          : String(env.ctx.randInt(0, Math.max(1, env.digest.rows)));
      return select(testid, value, `${testid}=${value}`);
    },
  },
  {
    name: 'man:mode-manual',
    weight: 5,
    screens: ['wiz-manual'],
    build: (env) =>
      actionable(env.digest, 'segment-mode-manual-input')
        ? check('segment-mode-manual-input', true, 'segment mode: manual')
        : null,
  },
  {
    name: 'man:manual-selects',
    weight: 6,
    screens: ['wiz-manual'],
    build: (env) => {
      const candidates = ['manual-import-section-select', 'manual-import-station-select'].filter((testid) =>
        actionable(env.digest, testid),
      );
      const testid = pickFrom(() => env.ctx.rng(), candidates);
      if (testid === null) return null;
      const options = env.digest.opts[testid];
      const value =
        options && options.length > 0
          ? (pickFrom(() => env.ctx.rng(), options) as string)
          : String(env.ctx.randInt(0, Math.max(1, env.digest.rows)));
      return select(testid, value, `${testid}=${value}`);
    },
  },
  {
    name: 'man:place-on-map',
    weight: 8,
    screens: ['wiz-manual'],
    build: (env) =>
      actionable(env.digest, 'segment-place-on-map-button')
        ? click('segment-place-on-map-button', 'place segment on map')
        : null,
  },
  {
    name: 'man:mode-discard',
    weight: 3,
    screens: ['wiz-manual'],
    build: (env) =>
      actionable(env.digest, 'segment-mode-discard-input')
        ? check('segment-mode-discard-input', true, 'segment mode: discard')
        : null,
  },
  {
    name: 'man:place',
    weight: 10,
    screens: ['wiz-manual'],
    build: (env) => (actionable(env.digest, 'segment-place-button') ? click('segment-place-button', 'place segment') : null),
  },
  {
    name: 'man:skip',
    weight: 5,
    screens: ['wiz-manual'],
    build: (env) =>
      actionable(env.digest, 'segment-skip-button') ? click('segment-skip-button', 'skip segment') : null,
  },
];

// ---------------------------------------------------------------------------
// Shot table
// ---------------------------------------------------------------------------

const SHOT_TABLE_SCREENS: readonly ScreenId[] = ['zero-datum-config', 'wiz-suggest', 'wiz-manual'];

const SHOT_TABLE: Generator[] = [
  {
    /**
     * Edit a cell: double-click opens the grid's textarea editor, and the value
     * lands on the NEXT step (an `input` on `shot-editor-cell-editor`). Two
     * moves rather than one because both are plain trace steps, and the trace
     * schema has no compound "edit" step to record a fused one with.
     */
    name: 'grid:open-cell',
    weight: 10,
    screens: SHOT_TABLE_SCREENS,
    build: (env) => {
      const cell = pickFrom(() => env.ctx.rng(), gridCells(env.digest));
      if (cell === null) return null;
      return click(`shot-editor-cell-${cell[0]}-${cell[1]}`, `open cell ${cell[0]}/${cell[1]}`, true);
    },
  },
  {
    name: 'grid:edit-cell',
    weight: 10,
    screens: SHOT_TABLE_SCREENS,
    build: (env) => {
      if (!actionable(env.digest, 'shot-editor-cell-editor')) return null;
      const value = pickFrom(() => env.ctx.rng(), CELL_BOUNDARIES) as string;
      return type('shot-editor-cell-editor', value, `cell=${JSON.stringify(value)}`);
    },
  },
  {
    name: 'grid:select-row',
    weight: 6,
    screens: SHOT_TABLE_SCREENS,
    build: (env) => {
      const index = pickFrom(() => env.ctx.rng(), indexedIds(env.digest, 'shot-editor-gutter-'));
      if (index === null) return null;
      return click(`shot-editor-gutter-${index}`, `select row ${index}`);
    },
  },
  {
    name: 'grid:insert-above',
    weight: 5,
    screens: SHOT_TABLE_SCREENS,
    build: (env) =>
      env.digest.rows > 0 ? click('shot-editor-context-insert-above', 'insert row above') : null,
  },
  {
    name: 'grid:insert-below',
    weight: 5,
    screens: SHOT_TABLE_SCREENS,
    build: (env) =>
      env.digest.rows > 0 ? click('shot-editor-context-insert-below', 'insert row below') : null,
  },
  {
    name: 'grid:delete-rows',
    weight: 6,
    screens: SHOT_TABLE_SCREENS,
    build: (env) => (env.digest.rows > 0 ? click('shot-editor-context-delete-rows', 'delete selected rows') : null),
  },
  {
    /**
     * The frozen-row expected refusal, in two legal moves.
     *
     * The wizard freezes the shots an overlap matched and REFUSES to delete
     * them: `handleDeleteShots` filters them out, raises the
     * `dmp-wizard-frozen-delete` toast and returns false. So this generator
     * first makes a frozen row the active one, then asks for the delete; the
     * shell asserts the refusal whenever a delete's whole selection was frozen
     * (it has the pre-click selection in the digest).
     */
    name: 'grid:delete-frozen',
    weight: 4,
    screens: SHOT_TABLE_SCREENS,
    build: (env) => {
      if (env.digest.frozen.length === 0) return null;
      const armed =
        env.digest.activeRow !== null &&
        env.digest.frozen.includes(env.digest.activeRow) &&
        env.digest.selRows.length > 0 &&
        env.digest.selRows.every((row) => env.digest.frozen.includes(row));
      if (armed) return click('shot-editor-context-delete-rows', 'delete FROZEN rows (expect refusal)');
      const row = pickFrom(() => env.ctx.rng(), env.digest.frozen);
      if (row === null) return null;
      return click(`shot-editor-gutter-${row}`, `select FROZEN row ${row}`);
    },
  },
  {
    name: 'grid:paste-block',
    weight: 3,
    screens: SHOT_TABLE_SCREENS,
    build: (env) => (env.digest.rows > 0 ? click('shot-editor-context-paste', 'paste into grid') : null),
  },
  {
    name: 'grid:fill-down',
    weight: 2,
    screens: SHOT_TABLE_SCREENS,
    build: (env) => (env.digest.rows > 0 ? click('shot-editor-context-fill-down', 'fill down') : null),
  },
  {
    name: 'grid:copy',
    weight: 2,
    screens: SHOT_TABLE_SCREENS,
    build: (env) => (env.digest.rows > 0 ? click('shot-editor-context-copy', 'copy grid selection') : null),
  },
  {
    /**
     * Appending is typing into the trailing PHANTOM row - the grid has no add
     * button. The phantom is the last row the grid renders, so the highest
     * rendered `length` cell is the target. (The grid virtualizes, so that is
     * only the true phantom when the grid is scrolled to the bottom; when it is
     * not, this is an ordinary edit, which is a fine move to make anyway.)
     */
    name: 'grid:append',
    weight: 5,
    screens: SHOT_TABLE_SCREENS,
    build: (env) => {
      const lengths = gridCells(env.digest).filter((cell) => cell[1] === 'length');
      if (lengths.length === 0) return null;
      const last = lengths[lengths.length - 1] as [number, string];
      return click(`shot-editor-cell-${last[0]}-length`, `open trailing row ${last[0]} (append)`, true);
    },
  },
];

// ---------------------------------------------------------------------------
// Map placement
// ---------------------------------------------------------------------------

const PLACEMENT: Generator[] = [
  {
    name: 'map:click',
    weight: 12,
    screens: ['map-placement'],
    build: (env) => {
      // An OFFSET from the map centre, which is where the survey is: the shell
      // resolves it against the live centre at dispatch. An absolute draw would
      // land in the Gulf of Guinea and be refused before it reached the app.
      const jitter = (): number => (env.ctx.rng() - 0.5) * 0.0008;
      return {
        kind: 'mapClick',
        lngLat: [jitter(), jitter()],
        relative: true,
        label: 'place near the map centre',
      };
    },
  },
  {
    name: 'map:confirm',
    weight: 3,
    screens: ['map-placement'],
    build: () => ({ kind: 'confirmPlacement', label: 'confirmPlacement()' }),
  },
  {
    name: 'map:escape',
    weight: 3,
    screens: ['map-placement'],
    build: () => click('key:Escape', 'Escape out of placement'),
  },
  {
    /**
     * Route a SECOND file while a placement owns the screen.
     *
     * `routeOpenedFile`'s `importFlowOwnsScreen` guard must refuse it - toast,
     * no state change - and the shell asserts exactly that. This is the guard's
     * only test path (see the hook's comment in `src/main.tsx`).
     */
    name: 'map:interject-route',
    weight: 4,
    screens: ['map-placement'],
    build: (env) => {
      const source = drawFileSource(env);
      return {
        kind: 'openFile',
        source,
        via: 'route',
        trigger: 'routeOpenedFile',
        label: 'INTERJECT: route a second file mid-placement',
      };
    },
  },
];

const TERMINALS: Generator[] = [
  {
    name: 'receipt:details',
    weight: 4,
    screens: ['receipt'],
    build: (env) =>
      actionable(env.digest, 'import-receipt-details') ? click('import-receipt-details', 'receipt details') : null,
  },
  {
    name: 'receipt:continue',
    weight: 14,
    screens: ['receipt'],
    build: (env) =>
      actionable(env.digest, 'import-receipt-continue') ? click('import-receipt-continue', 'dismiss receipt') : null,
  },
  {
    name: 'confirm:continue',
    weight: 6,
    screens: ['wiz-confirm'],
    build: (env) => {
      const testid = actionable(env.digest, 'cancel-confirm-continue')
        ? 'cancel-confirm-continue'
        : actionable(env.digest, 'back-confirm-continue')
          ? 'back-confirm-continue'
          : null;
      if (testid === null) return null;
      return click(testid, 'keep going (confirm dialog)');
    },
  },
  {
    name: 'confirm:accept',
    weight: 8,
    screens: ['wiz-confirm'],
    build: (env) => {
      const testid = actionable(env.digest, 'confirm-cancel-button')
        ? 'confirm-cancel-button'
        : actionable(env.digest, 'confirm-back-button')
          ? 'confirm-back-button'
          : null;
      if (testid === null) return null;
      return click(testid, 'confirm the cancel/back');
    },
  },
  {
    name: 'blocked:choose',
    weight: 10,
    screens: ['blocked'],
    build: (env) => {
      const testid = env.ctx.rng() < 0.5 ? 'import-blocked-switch' : 'import-blocked-stay';
      return actionable(env.digest, testid) ? click(testid, `import blocked: ${testid}`) : null;
    },
  },
  {
    name: 'as-new:choose',
    weight: 10,
    screens: ['as-new-project'],
    build: (env) => {
      const testid = env.ctx.rng() < 0.4 ? 'import-as-new-project-confirm' : 'import-as-new-project-cancel';
      return actionable(env.digest, testid) ? click(testid, `import as new project: ${testid}`) : null;
    },
  },
  {
    name: 'orphan:choose',
    weight: 10,
    screens: ['orphan-placement'],
    build: (env) => {
      const candidates = ['orphan-accept', 'orphan-skip', 'orphan-accept-all', 'orphan-close'].filter((testid) =>
        actionable(env.digest, testid),
      );
      const testid = pickFrom(() => env.ctx.rng(), candidates);
      return testid === null ? null : click(testid, `orphan placement: ${testid}`);
    },
  },
  {
    name: 'error:dismiss',
    weight: 10,
    screens: ['error'],
    build: (env) => (actionable(env.digest, 'error-dialog-close') ? click('error-dialog-close', 'dismiss error') : null),
  },
  {
    name: 'wiz:retry',
    weight: 8,
    screens: ['wiz-error', 'wiz-placing'],
    build: (env) => (actionable(env.digest, 'retry-button') ? click('retry-button', 'retry import') : null),
  },
];

/**
 * The new-project-for-import screen. It needs a NAME and a SAVE PATH, and the
 * path has to be one the app may write: the shell substitutes the session's
 * `fuzz-projects/` directory for the placeholder below, which is what keeps the
 * save path out of a replayed trace's control.
 */
const NEW_PROJECT: Generator[] = [
  {
    name: 'newproj:name',
    weight: 8,
    screens: ['new-project'],
    build: (env) => {
      if (!actionable(env.digest, 'project-name-input')) return null;
      const value = env.ctx.rng() < 0.3 ? '' : `fuzz-project-${env.fileSeq}`;
      return type('project-name-input', value, `project name=${JSON.stringify(value)}`);
    },
  },
  {
    name: 'newproj:path',
    weight: 8,
    screens: ['new-project'],
    build: (env) =>
      actionable(env.digest, 'project-save-path-input')
        ? type('project-save-path-input', PROJECT_DIR_PLACEHOLDER, 'project save path (session dir)')
        : null,
  },
  {
    name: 'newproj:create',
    weight: 12,
    screens: ['new-project'],
    build: (env) =>
      actionable(env.digest, 'create-and-continue-button')
        ? click('create-and-continue-button', 'create project and continue')
        : null,
  },
  {
    name: 'newproj:cancel',
    weight: 3,
    screens: ['new-project'],
    build: (env) =>
      actionable(env.digest, 'new-project-for-import-cancel') ? click('new-project-for-import-cancel', 'cancel') : null,
  },
];

/** Every generator, in catalog order. */
export const GENERATORS: readonly Generator[] = [
  ...STARTERS,
  ...DMP_SELECT,
  ...ZERO_DATUM,
  ...ZERO_DATUM_CONFIG,
  ...WIZARD_SUGGEST,
  ...METADATA,
  ...WIZARD_MANUAL,
  ...SHOT_TABLE,
  ...PLACEMENT,
  ...TERMINALS,
  ...NEW_PROJECT,
];

/** Generators legal on `screen`, expanded by weight. */
export function weightedFor(screen: ScreenId): readonly Generator[] {
  const out: Generator[] = [];
  for (const generator of GENERATORS) {
    if (!generator.screens.includes(screen)) continue;
    for (let i = 0; i < generator.weight; i += 1) out.push(generator);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interjections
// ---------------------------------------------------------------------------

/**
 * Moves legal on EVERY screen, drawn from their own PRNG stream so adding one
 * does not shift the trajectory every existing repro line depends on (the
 * convention `framework.ts`'s `mulberry32` header states).
 */
export type Interjection = 'escape' | 'route' | 'undo' | 'redo' | 'save';

export function interjectProbability(): number {
  const raw = Number(process.env.STALAGMIGHT_FUZZ_IMPORT_INTERJECT_P);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.08;
}

/** Salt for the interjection stream (`mulberry32(seed ^ SALT)`). */
export const INTERJECT_STREAM_SALT = 0x27d4eb2f;

export function drawInterjection(rng: Rng): Interjection {
  const roll = rng();
  if (roll < 0.3) return 'escape';
  if (roll < 0.5) return 'route';
  if (roll < 0.7) return 'undo';
  if (roll < 0.85) return 'redo';
  return 'save';
}

export function buildInterjection(kind: Interjection, env: GenEnv): FuzzMove | null {
  if (kind === 'escape') return click('key:Escape', 'INTERJECT: Escape');
  if (kind === 'undo') return { kind: 'undo', label: 'INTERJECT: undo mid-flow' };
  if (kind === 'redo') return { kind: 'redo', label: 'INTERJECT: redo mid-flow' };
  if (kind === 'save') {
    return env.digest.hasProject ? { kind: 'save', label: 'INTERJECT: saveProject mid-flow' } : null;
  }
  const source = drawFileSource(env);
  return {
    kind: 'openFile',
    source,
    via: 'route',
    trigger: 'routeOpenedFile',
    label: 'INTERJECT: route a second file mid-flow',
  };
}
