import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import i18n from '../index';

/**
 * Import-dialog i18n contract (issue #411, finding 3.5).
 *
 * Five import-chain dialogs (Compass, Walls, GPX, DMP selection, orphan
 * placement) were externalized mechanically: the rendered English had to stay
 * byte-identical. Two properties of that externalization are load-bearing and
 * invisible to `tsc`, so they are pinned here against the REAL i18n instance
 * (`../index`) rather than a `useTranslation` mock:
 *
 *  1. Six keys are called WITH `count` but define no `_one`/`_other` siblings,
 *     because the original strings never varied by number. That relies on
 *     i18next falling back from `key_one`/`key_other` to the plain `key`. If
 *     that fallback ever stops working these render EMPTY in production, not
 *     loudly: `index.ts` sets `parseMissingKeyHandler: () => ''` outside dev.
 *     A failure here means ADD `_other` variants to the keys, not relax the test.
 *
 *  2. Every `t('dialogs....')` literal in the five dialogs resolves. A typo'd or
 *     later-deleted key is otherwise a blank label in production and a green
 *     test suite - the same silent-drift class as the IPC mock contract test.
 *
 * Grammar note for future translators: `wallsImport.nothingToImport.missing_one`
 * says "was found" where the pre-i18n string said "file(s) were found". That is
 * more than dropping the "(s)" - it is the grammatical agreement the "(s)" form
 * was papering over, and it is the only intentional English change in #411.
 *
 * Future-locale trap: the six count-but-no-plural keys below render the SAME
 * text at count 1 and count 2 by design (e.g. "1 shots"). Adding a `_one`
 * variant for them in ANOTHER locale silently changes count-1 rendering in that
 * locale only. That is usually what a translator wants, but it means en and
 * non-en can disagree on whether count 1 is special-cased.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIALOGS_DIR = path.resolve(__dirname, '../../components/Dialogs');

const DIALOG_FILES = [
  'CompassImportDialog.tsx',
  'WallsImportDialog.tsx',
  'GpxSelectionDialog.tsx',
  'DmpSelectionDialog.tsx',
  'OrphanPlacementDialog.tsx',
];

/**
 * Conservative on purpose: only `t('literal.key')` calls, never a template
 * literal or a computed key. Anything fancier would need real parsing, and a
 * regex that quietly matches nothing is the failure mode this test guards
 * against - hence the per-file "extracted at least one key" assertion below.
 */
const T_CALL = /\bt\('(dialogs\.[A-Za-z0-9_.]+)'/g;

function extractKeys(source: string): string[] {
  return [...source.matchAll(T_CALL)].map((m) => m[1]!);
}

/**
 * i18next reports a miss by running `parseMissingKeyHandler`, which returns
 * `[key]` in dev and `''` in production. Treat both - plus a bare echo of the
 * key - as unresolved.
 */
function isUnresolved(key: string, value: string): boolean {
  return value.length === 0 || value === key || value === `[${key}]`;
}

/**
 * Always probe with a `count`: a plural key (`foo_one`/`foo_other`) has no plain
 * `foo` entry to find, and a non-plural key falls back from `foo_other` to `foo`
 * without reporting a miss. Probing plain-first would work too but would spray
 * spurious `missingKeyHandler` warnings for every plural key.
 */
function resolve(key: string): string {
  return i18n.t(key, { count: 2 });
}

describe('import-dialog i18n keys', () => {
  it('has an initialized real i18n instance in en', () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t('dialogs.compassImport.title')).toBe('Import Compass Survey');
  });

  describe('count without _one/_other falls back to the plain key', () => {
    // These six render the SAME text at every count by design - that is what the
    // pre-i18n JSX did. "1 shots" is ungrammatical and byte-correct: the original
    // was `{metadata.totalShots} shots`, with no singular branch. Do not "fix" the
    // English here; that would be a copy change smuggled in as an i18n change.
    it('renders the plain string at count 2', () => {
      expect(i18n.t('dialogs.gpxSelection.points', { count: 2 })).toBe('(2 pts)');
      expect(i18n.t('dialogs.gpxSelection.waypointsSection', { count: 2 })).toBe('Waypoints (2)');
      expect(i18n.t('dialogs.gpxSelection.tracksSection', { count: 2 })).toBe('Tracks (2)');
      expect(i18n.t('dialogs.gpxSelection.routesSection', { count: 2 })).toBe('Routes (2)');
      expect(i18n.t('dialogs.dmpSelection.shots', { count: 2 })).toBe('2 shots');
      expect(i18n.t('dialogs.orphanPlacement.skipped', { count: 2 })).toBe('2 skipped');
    });

    it('renders the same plain string at count 1', () => {
      expect(i18n.t('dialogs.gpxSelection.points', { count: 1 })).toBe('(1 pts)');
      expect(i18n.t('dialogs.gpxSelection.waypointsSection', { count: 1 })).toBe('Waypoints (1)');
      expect(i18n.t('dialogs.gpxSelection.tracksSection', { count: 1 })).toBe('Tracks (1)');
      expect(i18n.t('dialogs.gpxSelection.routesSection', { count: 1 })).toBe('Routes (1)');
      expect(i18n.t('dialogs.dmpSelection.shots', { count: 1 })).toBe('1 shots');
      expect(i18n.t('dialogs.orphanPlacement.skipped', { count: 1 })).toBe('1 skipped');
    });
  });

  describe('_one/_other pairs select end to end', () => {
    it('picks the singular at count 1 and the plural at count 2', () => {
      expect(i18n.t('dialogs.wallsImport.missingFiles', { count: 1 })).toBe(
        '1 referenced survey file not found on disk.'
      );
      expect(i18n.t('dialogs.wallsImport.missingFiles', { count: 2 })).toBe(
        '2 referenced survey files not found on disk.'
      );
    });

    it('agrees the verb, not just the noun suffix, on the missing-SRV message', () => {
      expect(i18n.t('dialogs.wallsImport.nothingToImport.missing', { count: 1, fileName: 'a.wpj' })).toContain(
        'survey file was found'
      );
      expect(i18n.t('dialogs.wallsImport.nothingToImport.missing', { count: 2, fileName: 'a.wpj' })).toContain(
        'survey files were found'
      );
    });
  });

  describe('every key the dialogs reference resolves', () => {
    it.each(DIALOG_FILES)('%s', (fileName) => {
      const source = fs.readFileSync(path.join(DIALOGS_DIR, fileName), 'utf8');
      const keys = extractKeys(source);

      // Guards the regex against rotting into a no-op: every one of these files
      // is fully externalized, so zero extracted keys means the scanner broke,
      // not that the file is clean.
      expect(keys.length).toBeGreaterThan(0);

      const unresolved = keys.filter((key) => isUnresolved(key, resolve(key)));
      expect(unresolved).toEqual([]);
    });
  });
});
