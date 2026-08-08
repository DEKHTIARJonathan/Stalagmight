/**
 * Seeded generators for the survey-file specs `surveyFileWriters.ts` renders,
 * plus the one function in the import-fuzz stack that touches disk.
 *
 * ## Draws, not values
 *
 * A generator takes the framework's `rng` (`() => number`, see `mulberry32` in
 * `scenarios/framework.ts`) and nothing else, so a seed reproduces a file set
 * exactly. The boundary-biasing convention is the one
 * `scenarios/undoRedoFuzzActions.ts` established - `P_BOUNDARY` of every value
 * takes an extreme instead of a nominal draw, because the bugs live at zero, at
 * the sentinel, and just past the end of the range.
 *
 * Those helpers (`chance`, `biasedFloat`, `biasedText`, `P_BOUNDARY`) are
 * module-private over there and take a `ScenarioContext` rather than an `rng`.
 * Importing them would drag the whole targeting-digest surface into a module
 * that has no app to target, so the shapes are MIRRORED here against a bare
 * `Rng`. `P_BOUNDARY` is deliberately the same number: a reader comparing the
 * two files should not have to wonder whether the difference is meaningful.
 *
 * ## The one invariant a 'valid' DMP spec must keep
 *
 * `split_into_sections` cuts the file wherever it sees the end-of-section
 * pattern - for v2/v3/v4 that is a `3` byte followed by 15/20/28 ZEROS. A shot
 * record full of zeros can therefore terminate a section in the middle of
 * itself. So the valid profile never draws `length` or `markerIndex` as exactly
 * zero, which bounds the longest zero run inside a record at 21 bytes (v4's
 * worst case) against a 28-byte pattern. `surveyFileSpecs.test.ts` checks the
 * consequence directly - a valid spec yields exactly as many sections as it
 * declares - over enough seeds that the argument is not taken on trust.
 */
import * as fs from 'fs';
import * as path from 'path';

import { crc32Text } from './crc32';
import {
  type DmpSectionSpec,
  type DmpShotSpec,
  type DmpSpec,
  type TmlShotSpec,
  type TmlSpec,
  writeDmpBytes,
  writeTmlZip,
  writeTmluXml,
} from './surveyFileWriters';

/** The framework's PRNG shape (`ScenarioContext.rng`). */
export type Rng = () => number;

/** `valid` aims to parse and import; `malformed` aims to be rejected cleanly. */
export type SpecProfile = 'valid' | 'malformed';

export type SurveyFileFormat = 'dmp' | 'tml' | 'tmlu';

/** A generated file: what to write, and under what name. */
export type GeneratedFileSpec =
  | { format: 'dmp'; name: string; profile: SpecProfile; dmp: DmpSpec }
  | { format: 'tml'; name: string; profile: SpecProfile; tml: TmlSpec }
  | { format: 'tmlu'; name: string; profile: SpecProfile; tml: TmlSpec };

// ---------------------------------------------------------------------------
// Draw helpers (mirrors of undoRedoFuzzActions.ts, against a bare Rng)
// ---------------------------------------------------------------------------

/** Share of generated values that take an extreme instead of a nominal one. */
export const P_BOUNDARY = 0.15;

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** An integer draw that lands on `extremes` `P_BOUNDARY` of the time. */
function biasedInt(rng: Rng, min: number, max: number, extremes: readonly number[]): number {
  if (rng() < P_BOUNDARY) return pick(rng, extremes);
  return randInt(rng, min, max);
}

// ---------------------------------------------------------------------------
// Hostile text corpus
// ---------------------------------------------------------------------------

/**
 * Comment text that has historically broken something downstream of an import.
 *
 * The first four are spreadsheet-formula injection: a comment that reaches a CSV
 * or clipboard export unquoted is executed by Excel and LibreOffice on paste.
 * The rest are encoding and markup hazards - a leading control character, XML
 * fragments that must arrive as data, an entity that must not be decoded twice,
 * a zero-width joiner that makes two comments look like one, a bidi override
 * that reorders whatever follows it in a table cell, and a payload large enough
 * to find a length clamp.
 *
 * LONE SURROGATES ARE ABSENT, deliberately. An unpaired UTF-16 code unit cannot
 * survive a JS string on its way to bytes: `TextEncoder` substitutes U+FFFD, so
 * a spec carrying `'\uD83D'` would render the same bytes as one carrying
 * U+FFFD, and the trace would claim to reproduce a case it never produced. The
 * stand-in is U+FFFD itself, spelled out below - it exercises the same "the
 * decoder already gave up on this" path in the receipt and label code without
 * pretending the writer can emit something it cannot.
 */
export const HOSTILE_COMMENTS: readonly string[] = [
  "=cmd|' /C calc'!A0",
  '+1+1',
  '-2+3',
  '@SUM(1)',
  '\tleading tab',
  '\rleading carriage return',
  ']]>',
  '<![CDATA[',
  '&amp;',
  'raw & ampersand',
  'part one\u200bpart two\u200bpart three',
  '\u202eoverridden',
  '\ufffd replacement, standing in for a lone surrogate',
  'x'.repeat(8 * 1024),
];

/** Section/explorer/cave names that are not just ASCII words. */
const BOUNDARY_NAMES: readonly string[] = [
  '',
  ' ',
  'Cueva del Rio \u00d1andu\u0301',
  '\u6d1e\u7a74\u6e2c\u91cf',
  '\ud83d\udd26\ud83e\udd3f',
  'x'.repeat(512),
  '"quoted", \\backslash\\ and \nnewline',
];

function biasedName(rng: Rng, nominal: string): string {
  if (rng() < P_BOUNDARY) return pick(rng, BOUNDARY_NAMES);
  return nominal;
}

function maybeHostileComment(rng: Rng, nominal: string): string {
  if (rng() < P_BOUNDARY) return pick(rng, HOSTILE_COMMENTS);
  return nominal;
}

// ---------------------------------------------------------------------------
// DMP
// ---------------------------------------------------------------------------

/** Standard dominates; the two cross-section types are drawn occasionally. */
const VALID_SHOT_TYPES: readonly number[] = [2, 2, 2, 2, 2, 0, 1];

function randomDmpShot(rng: Rng, profile: SpecProfile): DmpShotSpec {
  const malformed = profile === 'malformed';
  return {
    shotType: malformed ? randInt(rng, 0, 255) : pick(rng, VALID_SHOT_TYPES),
    headingIn: biasedInt(rng, 0, 3599, [0, 3599, 3600, -1, 32767, -32768]),
    headingOut: biasedInt(rng, 0, 3599, [0, 3599, 3600, -1, 32767, -32768]),
    // Never exactly zero in either profile: see the zero-run invariant at the
    // top of this file. A NEGATIVE length is still a boundary the parser has to
    // handle (`.max(0.0)` clamps it) and its bytes are not zero.
    length: biasedInt(rng, 1, 2000, [1, -1, 32767, -32768, 20000]),
    depthIn: biasedInt(rng, 0, 4000, [0, -1, 32767, -32768]),
    depthOut: biasedInt(rng, 0, 4000, [0, -1, 32767, -32768]),
    pitchIn: biasedInt(rng, -900, 900, [0, 900, -900, 32767, -32768]),
    pitchOut: biasedInt(rng, -900, 900, [0, 900, -900, 32767, -32768]),
    left: biasedInt(rng, 0, 500, [0, -1, 32767]),
    right: biasedInt(rng, 0, 500, [0, -1, 32767]),
    up: biasedInt(rng, 0, 500, [0, -1, 32767]),
    down: biasedInt(rng, 0, 500, [0, -1, 32767]),
    temperature: biasedInt(rng, 40, 300, [0, -400, 32767]),
    hour: randInt(rng, 0, 23),
    minute: randInt(rng, 0, 59),
    second: randInt(rng, 0, 59),
    markerIndex: malformed ? randInt(rng, 0, 255) : biasedInt(rng, 1, 9, [1, 9, 255]),
  };
}

const DMP_NAME_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomDmpSectionName(rng: Rng, profile: SpecProfile): DmpSectionSpec['name'] {
  if (profile === 'malformed' && chance(rng, 0.3)) {
    // Bytes that are not valid UTF-8 on their own: `parse_section` falls back to
    // a numeric spelling rather than failing, and that fallback name then flows
    // into the preview, the content hash and the imported section title.
    return [randInt(rng, 128, 255), randInt(rng, 128, 255), randInt(rng, 128, 255)];
  }
  const letter = (): string => DMP_NAME_ALPHABET[randInt(rng, 0, DMP_NAME_ALPHABET.length - 1)];
  return `${letter()}${letter()}${letter()}`;
}

/**
 * A DMP file spec.
 *
 * The `valid` profile keeps every field inside what `parse_section` accepts -
 * year 2000..2099, month 1..12, day 1..28 (never a day that only exists in some
 * months, so the file parses in February too), hour < 24, minute < 60 - and
 * relies on the corruption catalog for everything past those edges.
 */
export function randomDmpSpec(rng: Rng, profile: SpecProfile = 'valid'): DmpSpec {
  const malformed = profile === 'malformed';
  const version = pick(rng, [5, 5, 5, 4, 4, 3, 2]);
  const sectionCount = randInt(rng, 1, 4);
  const sections: DmpSectionSpec[] = [];

  for (let index = 0; index < sectionCount; index++) {
    const section: DmpSectionSpec = {
      name: randomDmpSectionName(rng, profile),
      direction: malformed ? randInt(rng, 0, 255) : pick(rng, [0, 1]),
      year: biasedInt(rng, 20, 26, [0, 99]),
      month: biasedInt(rng, 1, 12, [1, 12]),
      day: biasedInt(rng, 1, 28, [1, 28]),
      hour: biasedInt(rng, 0, 23, [0, 23]),
      minute: biasedInt(rng, 0, 59, [0, 59]),
      shots: Array.from({ length: randInt(rng, 1, 8) }, () => randomDmpShot(rng, profile)),
    };
    // A clone of an earlier section collides on `content_hash` while carrying
    // its own date, which is the shape re-import deduplication has to notice.
    if (index > 0 && chance(rng, 0.2)) section.sameContentAs = randInt(rng, 0, index - 1);
    sections.push(section);
  }

  const spec: DmpSpec = { version, sections };
  if (chance(rng, 0.5)) spec.signedTokens = true;
  return spec;
}

// ---------------------------------------------------------------------------
// TML / TMLU
// ---------------------------------------------------------------------------

const TML_UNITS: readonly string[] = ['m', 'm', 'm', 'ft', 'metric', 'imperial'];
const TML_EXPLORERS: readonly string[] = ['', 'Tester', 'A. Surveyor', 'team-2'];

function hex2(rng: Rng): string {
  return randInt(rng, 0, 255).toString(16).padStart(2, '0');
}

function randomTmlColor(rng: Rng, profile: SpecProfile): string {
  if (profile === 'malformed' && chance(rng, 0.4)) {
    return pick(rng, ['', 'not-a-color', '0x', '#ff00', '0xZZZZZZZZ', '0x8f6112']);
  }
  return `0x${hex2(rng)}${hex2(rng)}${hex2(rng)}ff`;
}

function randomTmlDate(rng: Rng): string {
  // `2000-01-01` is Ariane's "no date" sentinel, so it gets deliberate weight
  // rather than being one date in seven thousand.
  if (chance(rng, P_BOUNDARY)) return pick(rng, ['2000-01-01', '', '0000-00-00', '2099-12-31']);
  return `20${String(randInt(rng, 10, 26)).padStart(2, '0')}-${String(randInt(rng, 1, 12)).padStart(2, '0')}-${String(
    randInt(rng, 1, 28),
  ).padStart(2, '0')}`;
}

function roundedFloat(rng: Rng, min: number, max: number, decimals: number): number {
  return Number((min + rng() * (max - min)).toFixed(decimals));
}

function biasedFloat(rng: Rng, min: number, max: number, decimals: number, extremes: readonly number[]): number {
  if (rng() < P_BOUNDARY) return pick(rng, extremes);
  return roundedFloat(rng, min, max, decimals);
}

/**
 * A TML/TMLU spec.
 *
 * The `valid` profile builds a proper rooted tree: shot 0 is the `START` with no
 * parent, every later shot names an EARLIER id as its `FromID`, and ids are
 * unique and non-negative. Cycles, self-parents, dangling parents, duplicate ids
 * and negative ids are all reachable - through `malformed`, or through the
 * schema-level entries of the corruption catalog.
 */
export function randomTmlSpec(rng: Rng, profile: SpecProfile = 'valid'): TmlSpec {
  const malformed = profile === 'malformed';
  const shotCount = randInt(rng, 1, 12);
  const sectionNames = Array.from({ length: randInt(rng, 1, 3) }, (_unused, index) =>
    biasedName(rng, `Section ${index + 1}`),
  );

  const shots: TmlShotSpec[] = [];
  for (let index = 0; index < shotCount; index++) {
    const isStart = index === 0;
    const parent = isStart ? -1 : randInt(rng, 0, index - 1);
    shots.push({
      id: malformed && chance(rng, 0.25) ? randInt(rng, -5, shotCount) : index,
      fromId: malformed && chance(rng, 0.25) ? randInt(rng, -5, shotCount + 5) : parent,
      closureToId: !isStart && chance(rng, 0.1) ? randInt(rng, 0, index - 1) : -1,
      type: isStart ? 'START' : pick(rng, ['REAL', 'REAL', 'REAL', 'REAL', 'VIRTUAL']),
      section: pick(rng, sectionNames),
      azimuth: biasedFloat(rng, 0, 359.9, 1, [0, 359.9, 360, -1, 1e6]),
      length: biasedFloat(rng, 0.1, 30, 2, [0, -1, 1e-9, 1e6]),
      depth: biasedFloat(rng, 0, 60, 2, [0, -1, 1e6]),
      // -1.0 is the file's "not recorded" sentinel, read by `resolve_tml_depth_in`.
      depthIn: chance(rng, 0.3) ? -1 : biasedFloat(rng, 0, 60, 2, [0, -1, 1e6]),
      inclination: biasedFloat(rng, -90, 90, 1, [0, 90, -90, 1e6]),
      left: biasedFloat(rng, 0, 5, 2, [0, -1]),
      right: biasedFloat(rng, 0, 5, 2, [0, -1]),
      up: biasedFloat(rng, 0, 5, 2, [0, -1]),
      down: biasedFloat(rng, 0, 5, 2, [0, -1]),
      comment: chance(rng, 0.3) ? maybeHostileComment(rng, `note-${randInt(rng, 0, 9999)}`) : '',
      explorer: pick(rng, TML_EXPLORERS),
      date: randomTmlDate(rng),
      color: randomTmlColor(rng, profile),
      excluded: chance(rng, 0.1),
      latitude: chance(rng, 0.2) ? roundedFloat(rng, -90, 90, 6) : 0,
      longitude: chance(rng, 0.2) ? roundedFloat(rng, -180, 180, 6) : 0,
    });
  }

  const spec: TmlSpec = {
    caveName: biasedName(rng, `fuzz-cave-${randInt(rng, 1000, 9999)}`),
    unit: malformed && chance(rng, 0.3) ? pick(rng, ['', 'furlongs', 'M ', '\u00b5m']) : pick(rng, TML_UNITS),
    useMagneticAzimuth: chance(rng, 0.8),
    firstStartAbsoluteElevation:
      malformed && chance(rng, 0.3)
        ? pick(rng, ['', 'NaN', 'abc', '1e999', 'Infinity'])
        : String(biasedFloat(rng, -500, 2000, 2, [0, -1, 1e6])),
    shots,
  };
  if (chance(rng, 0.5)) spec.dialect = 'short';
  return spec;
}

// ---------------------------------------------------------------------------
// Naming, rendering, materialization
// ---------------------------------------------------------------------------

/**
 * A basename derived from the spec's own content.
 *
 * Content-addressed on purpose: two identical specs get the same name and the
 * same bytes, which is how the fuzzer produces a "the user imported the SAME
 * file twice" case without a separate `sameFileAs` mechanism. Two different
 * specs practically never collide, and a collision would only mean one
 * materialization overwrote an identical-length sibling.
 */
export function surveyFileName(format: SurveyFileFormat, spec: DmpSpec | TmlSpec): string {
  const digest = crc32Text(JSON.stringify(spec)).toString(16).padStart(8, '0');
  return `fuzz-${digest}.${format}`;
}

/** Draw a whole file: a format, a spec for it, and its content-addressed name. */
export function randomSurveyFileSpec(
  rng: Rng,
  profile: SpecProfile = 'valid',
  format?: SurveyFileFormat,
): GeneratedFileSpec {
  const chosen = format ?? pick(rng, ['dmp', 'dmp', 'tml', 'tmlu'] as const);
  if (chosen === 'dmp') {
    const dmp = randomDmpSpec(rng, profile);
    return { format: 'dmp', name: surveyFileName('dmp', dmp), profile, dmp };
  }
  const tml = randomTmlSpec(rng, profile);
  return { format: chosen, name: surveyFileName(chosen, tml), profile, tml };
}

/** The bytes a generated spec becomes on disk. Pure - `materializeSurveyFile` writes them. */
export function renderSurveyFile(spec: GeneratedFileSpec): Uint8Array {
  if (spec.format === 'dmp') return writeDmpBytes(spec.dmp);
  if (spec.format === 'tml') return writeTmlZip(spec.tml);
  return new TextEncoder().encode(writeTmluXml(spec.tml));
}

/**
 * Write a generated file into a caller-supplied directory.
 *
 * `dir` MUST be a session-owned path - a subdirectory of the run's artifact
 * directory (`<sessionDir>/fuzz-files/`) or an OS temp dir. Nothing here writes
 * to `e2e/fixtures/`, and nothing here is ever committed. Two independent
 * mechanisms keep it that way, and both are load-bearing because the repo
 * forbids fixture files outright:
 *
 *   1. `.gitignore` ignores `*.dmp`, `*.tml`, `*.tmlu` (and the other survey
 *      extensions) REPO-WIDE, so a generated file is untracked wherever it
 *      lands - including inside the repo tree.
 *   2. Session artifact directories live under `.agent-artifacts/`, which
 *      `.gitignore` also ignores wholesale, so the containing directory is
 *      invisible to git even before the extension rule applies.
 *
 * The spec's name is a basename by construction; it is re-checked here so a
 * hand-built spec cannot make this write outside `dir`.
 */
export function materializeSurveyFile(
  dir: string,
  spec: GeneratedFileSpec,
): { path: string; bytes: Uint8Array } {
  if (spec.name !== path.basename(spec.name) || spec.name === '' || spec.name.startsWith('.')) {
    throw new Error(`generated file name must be a plain basename, got ${JSON.stringify(spec.name)}`);
  }
  const bytes = renderSurveyFile(spec);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, spec.name);
  fs.writeFileSync(target, bytes);
  return { path: target, bytes };
}
