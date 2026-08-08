/**
 * Flow-level oracles for `import-dialog-fuzz`.
 *
 * A per-STEP oracle can only see that the app is still coherent. These five run
 * once per FLOW - one file, from the picker to whatever ends it - and are where
 * the import's actual contract is checked:
 *
 *   F1 UNDO ROUNDTRIP  - an import that landed sections pushed at least one undo
 *                        entry; a CANCELLED one pushed none and changed nothing;
 *                        and undoing exactly what was pushed returns the project
 *                        to the state it had before the flow, byte for byte
 *                        (modulo `projectSnapshot.ts`'s numeric tolerance),
 *                        with the redo taking it back.
 *   F2 RESIDUE         - no dialog, no placement, no import context, and
 *                        `isImportInProgress` false once the flow is over.
 *   F3 ACCOUNTING      - the section and shot deltas equal what the receipt
 *                        claimed. The receipt is the user's only account of what
 *                        happened, so a receipt that disagrees with the project
 *                        is a bug even when the import itself was correct.
 *   F4 RECEIPT         - the warnings list is capped and the details toggle
 *                        appears exactly when there is something behind it.
 *   F5 TEMP FILES      - no `.stalx.tmp` / `.download.tmp` / `.vacuum.tmp`
 *                        left beside the project.
 *
 * Every one of them THROWS. There is no tolerance, no classifier and no
 * known-bug list, per the delete-when-fixed contract the undo fuzzers follow: a
 * breach of any shape is a failure, and the way to make one go away is to fix
 * the app.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { ImportScreenDigest } from './importScreenDigest';
import { describeDiffs, diffSnapshots } from './projectSnapshot';
import { isLeftoverTempName } from './oracles';

/** What a flow looked like before it started and after it ended. */
export interface FlowBounds {
  /** Canonical `get_project_state`, or null when no project was open. */
  snapshot: string | null;
  undoDepth: number;
  sections: number;
  shots: number;
  /** Directory the project lives in, for the temp-file sweep. */
  projectDir: string | null;
  /** Leftover temp names beside the project at that moment. */
  leftovers: string[];
}

/** What the receipt said, captured before it was dismissed. */
export interface ReceiptClaim {
  summary: string;
  sections: number | null;
  shots: number | null;
  shown: number;
  more: number;
  hasDetails: boolean;
}

export class ImportOracleError extends Error {}

function fail(headline: string, detail: string[] = []): never {
  throw new ImportOracleError([headline, ...detail.map((line) => `  ${line}`)].join('\n'));
}

/**
 * The receipt's summary, parsed.
 *
 * `importReceiptSummaryParts` joins i18n'd fragments with ' - ', so the numbers
 * are extracted positionally rather than by label: the FIRST integer is the
 * section count and the SECOND is the shot count (`sections`, `shots`, then an
 * optional `loops`). Returns nulls when the text does not look like that, and
 * F3 then reports that it could not check rather than inventing a comparison.
 */
export function parseReceiptSummary(summary: string): { sections: number | null; shots: number | null } {
  const parts = summary.split(' - ');
  const firstInt = (text: string | undefined): number | null => {
    if (text === undefined) return null;
    const match = /(\d[\d\s,.']*)/.exec(text);
    if (!match) return null;
    const digits = (match[1] as string).replace(/[^\d]/g, '');
    return digits === '' ? null : Number(digits);
  };
  return { sections: firstInt(parts[0]), shots: firstInt(parts[1]) };
}

export function receiptClaimFrom(digest: ImportScreenDigest): ReceiptClaim | null {
  if (!digest.receipt) return null;
  const parsed = parseReceiptSummary(digest.receipt.summary);
  return {
    summary: digest.receipt.summary,
    sections: parsed.sections,
    shots: parsed.shots,
    shown: digest.receipt.shown,
    more: digest.receipt.more,
    hasDetails: digest.receipt.hasDetails,
  };
}

/** `MAX_VISIBLE_WARNINGS` in `src/components/Dialogs/ImportReceiptDialog.tsx`. */
export const MAX_VISIBLE_WARNINGS = 3;

/**
 * F4. Checked the moment the receipt is SEEN, because the numbers behind it are
 * gone once it is dismissed.
 *
 * The cap is 3, not the round number a plan might assume: the component slices
 * at `MAX_VISIBLE_WARNINGS` and renders the View-details toggle if and only if
 * anything was left over. Both halves are asserted, in both directions - a
 * toggle with nothing behind it is as wrong as hidden warnings with no toggle.
 */
export function checkReceipt(claim: ReceiptClaim): void {
  if (claim.shown > MAX_VISIBLE_WARNINGS) {
    fail(
      `F4 RECEIPT: ${claim.shown} warning(s) rendered in the always-visible list, cap is ${MAX_VISIBLE_WARNINGS}`,
      [`summary: ${claim.summary}`],
    );
  }
  if (claim.more > 0 && !claim.hasDetails) {
    fail('F4 RECEIPT: hidden warnings are rendered with no details toggle to reveal them', [
      `shown=${claim.shown} more=${claim.more}`,
    ]);
  }
  if (claim.shown < MAX_VISIBLE_WARNINGS && claim.hasDetails) {
    fail('F4 RECEIPT: a details toggle is offered although the visible list is not even full', [
      `shown=${claim.shown} cap=${MAX_VISIBLE_WARNINGS}`,
    ]);
  }
}

/** F2. Nothing of the flow may outlive it. */
export function checkResidue(digest: ImportScreenDigest, what: string): void {
  const wrong: string[] = [];
  if (digest.dialog !== null) wrong.push(`activeDialog=${JSON.stringify(digest.dialog)}`);
  if (digest.placement) wrong.push('placementMode is still set');
  if (digest.ctx !== null) wrong.push(`importContext=${JSON.stringify(digest.ctx)}`);
  if (digest.importInProgress) wrong.push('isImportInProgress is still true');
  if (digest.phase !== null) wrong.push(`dmpImportWizardPhase=${JSON.stringify(digest.phase)}`);
  if (wrong.length === 0) return;
  fail(`F2 RESIDUE: ${what} left import state behind`, wrong);
}

/**
 * F3. The receipt is an account of the import; the project is what happened.
 *
 * Only checked when a receipt was actually seen AND its summary parsed. The DMP
 * wizard calls `import_sections` up to four times for one logical import and
 * `aggregateImportReceipts` merges the results, so the claim is compared against
 * the WHOLE flow's delta, never against one command's.
 */
export function checkAccounting(claim: ReceiptClaim, before: FlowBounds, after: FlowBounds): void {
  if (claim.sections === null || claim.shots === null) return;
  const sectionDelta = after.sections - before.sections;
  const shotDelta = after.shots - before.shots;
  if (sectionDelta !== claim.sections || shotDelta !== claim.shots) {
    fail('F3 ACCOUNTING: the receipt does not describe what landed in the project', [
      `receipt:  ${claim.sections} section(s), ${claim.shots} shot(s)`,
      `project:  ${sectionDelta} section(s), ${shotDelta} shot(s)`,
      `summary:  ${claim.summary}`,
    ]);
  }
}

/** F5. A leftover staging file means an atomic write did not finish. */
export function checkTempFiles(before: FlowBounds, after: FlowBounds, what: string): void {
  if (after.projectDir === null) return;
  const known = new Set(before.leftovers);
  const fresh = after.leftovers.filter((name) => !known.has(name));
  if (fresh.length === 0) return;
  fail(`F5 TEMP FILES: ${what} left ${fresh.length} staging file(s) beside the project`, [
    `dir:   ${after.projectDir}`,
    `files: ${fresh.join(', ')}`,
  ]);
}

/** Leftover staging names beside a project path (empty when there is none). */
export function leftoverTempNames(projectPath: string | null): { dir: string | null; names: string[] } {
  if (!projectPath) return { dir: null, names: [] };
  const dir = path.dirname(projectPath);
  try {
    return { dir, names: fs.readdirSync(dir).filter(isLeftoverTempName) };
  } catch {
    return { dir, names: [] };
  }
}

/** How a flow ended, as far as F1 is concerned. */
export type FlowShape = 'imported' | 'cancelled';

/**
 * F1, first half: did the flow push the number of entries its shape implies?
 *
 * An import that landed at least one section MUST be undoable - a mutation with
 * no entry is a change the user cannot take back, which is the worst outcome
 * this scenario can find. A cancelled flow must have pushed nothing AND changed
 * nothing; "nothing was pushed" alone would pass a cancel that mutated silently.
 */
export function checkPushed(
  shape: FlowShape,
  before: FlowBounds,
  after: FlowBounds,
  what: string,
): number {
  const pushed = after.undoDepth - before.undoDepth;
  if (pushed < 0) {
    fail(`F1 UNDO ROUNDTRIP: ${what} SHRANK the undo stack by ${-pushed}`, [
      `before=${before.undoDepth} after=${after.undoDepth}`,
    ]);
  }
  if (shape === 'imported' && pushed < 1) {
    fail(`F1 UNDO ROUNDTRIP: ${what} imported sections but pushed no undo entry`, [
      `sections ${before.sections} -> ${after.sections}, shots ${before.shots} -> ${after.shots}`,
    ]);
  }
  if (shape === 'cancelled') {
    if (pushed !== 0) {
      fail(`F1 UNDO ROUNDTRIP: ${what} was cancelled but pushed ${pushed} undo entr(ies)`);
    }
    if (before.snapshot !== null && after.snapshot !== null && before.snapshot !== after.snapshot) {
      const diffs = diffSnapshots(before.snapshot, after.snapshot);
      if (diffs.length > 0) {
        fail(`F1 UNDO ROUNDTRIP: ${what} was cancelled but changed the project`, [describeDiffs(diffs)]);
      }
    }
  }
  return pushed;
}

/** F1, second half: the state each direction of the walk must land on. */
export function checkRoundtripState(
  label: string,
  expected: string | null,
  actual: string | null,
  what: string,
): void {
  if (expected === null || actual === null) return;
  if (expected === actual) return;
  const diffs = diffSnapshots(expected, actual);
  // Byte-inequality with an empty tolerant diff is float dust the canonical
  // rounding did not absorb, and is not a finding - `projectSnapshot.ts` owns
  // that judgement for both fuzzers.
  if (diffs.length === 0) return;
  fail(`F1 UNDO ROUNDTRIP: ${what} did not restore the ${label} state`, [describeDiffs(diffs)]);
}
