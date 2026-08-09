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
 *                        claimed, measured WHERE THE RECEIPT WAS MADE. The
 *                        receipt is the user's only account of what happened, so
 *                        a receipt that disagrees with the project is a bug even
 *                        when the import itself was correct.
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

/**
 * Tauri's answer to an argument body it cannot deserialize:
 * `invalid args \`X\` for command \`Y\`: <serde error>`.
 *
 * The distinction this pattern draws is the whole point of the S6 oracle. A
 * command that RAN and returned `success: false` is the app reporting a problem
 * properly, and this scenario provokes plenty of those on purpose with
 * malformed files. This is the other thing: the call never reached the command,
 * because what the frontend serialized is not what the backend can parse. That
 * is a wire-format disagreement, and it is always a defect no matter which
 * command or which content triggered it - which is what makes asserting on it
 * an oracle rather than a classifier for one bug.
 */
export const IPC_ARG_REJECTION_RE = /invalid args [`'"]?(\w+)[`'"]? for command [`'"]?(\w+)[`'"]?/;

/** Log lines that are an argument-deserialization rejection. */
export function ipcArgRejections(lines: readonly string[]): string[] {
  return lines.filter((line) => IPC_ARG_REJECTION_RE.test(line));
}

/**
 * S6. No command may be invoked with arguments the backend cannot deserialize.
 *
 * Reads the app's own log ring rather than a patched `invoke`, because Tauri
 * ships `window.__TAURI_INTERNALS__.invoke` non-configurable and the spy in
 * `importDialogBridge.ts` cannot get in on a stock build. The log always
 * carries the failure; the spy, when it works, only adds the payload.
 */
export function checkIpcContract(lines: readonly string[], what: string, detail: string[] = []): void {
  const rejected = ipcArgRejections(lines);
  if (rejected.length === 0) return;
  fail(
    `S6 IPC CONTRACT: the app sent arguments the backend could not deserialize (${rejected.length} line(s))`,
    [`after: ${what}`, ...rejected.slice(0, 4), ...detail],
  );
}

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

/**
 * F2. Nothing of the flow may outlive it.
 *
 * `importContext` is NOT asserted here, and the reason is worth writing down
 * because two earlier versions of this oracle got it wrong in opposite ways.
 *
 * The app's contract is real: `completeImportToSingleView`
 * (`utils/saveFeedback.ts`) says "This is also where the import flow ENDS, so it
 * is where `importContext` is dropped", and `routeOpenedFile` says a CANCELLED
 * dialog leaving it set is fine because the next flow's entry resets it. So the
 * value is only wrong after a COMPLETION - and this scenario cannot reliably
 * tell a completion from an abandonment:
 *
 *   - "the undo stack grew" does not mean completed. The DMP wizard commits
 *     EARLY and mid-flow (`transitionToPlacingOrManual` calls `import_sections`
 *     well before the end), so a user can land sections and then walk back and
 *     cancel. Keying on that reported a leak for flows that ended on the cancel
 *     path, where retention is by design.
 *   - "a receipt was shown" does not fire often enough to be a gate. A clean
 *     receipt is a toast, not the modal, and a toast has expired by the time a
 *     wedge-settled digest is taken - measured: on the seed that first raised
 *     this, no flow presented a receipt in either surface at all.
 *
 * So it is COUNTED (`residualImportContext:*`) and left to a reader. The
 * completion-path defect itself is #477, which was established by reading the
 * code - every other importer routes through the shared helper and the DMP
 * wizard hand-rolled it - not by this oracle.
 */
export function checkResidue(digest: ImportScreenDigest, what: string): void {
  const wrong: string[] = [];
  if (digest.dialog !== null) wrong.push(`activeDialog=${JSON.stringify(digest.dialog)}`);
  if (digest.placement) wrong.push('placementMode is still set');
  if (digest.importInProgress) wrong.push('isImportInProgress is still true');
  if (digest.phase !== null) wrong.push(`dmpImportWizardPhase=${JSON.stringify(digest.phase)}`);
  if (wrong.length === 0) return;
  fail(`F2 RESIDUE: ${what} left import state behind`, wrong);
}

/** The two numbers F3 compares. `FlowBounds` satisfies it. */
export interface CountedProject {
  sections: number;
  shots: number;
}

/**
 * F3. The receipt is an account of the import; the project is what happened.
 *
 * Only checked when a receipt was actually seen AND its summary parsed. The DMP
 * wizard calls `import_sections` up to four times for one logical import and
 * `aggregateImportReceipts` merges the results, so the claim is compared against
 * the WHOLE flow's delta, never against one command's.
 *
 * `atReceipt` is the project AS IT WAS WHEN THE RECEIPT WAS PRESENTED, not at
 * the end of the flow, and that distinction is the oracle. The walk keeps moving
 * after a receipt appears - the interjection stream plays `undo`, a second file
 * gets imported, the receipt is dismissed onto another import - so a delta taken
 * at the end of the flow measures the WALK, not the receipt. Measured, on the
 * campaign's seed-8 cell: a Walls import whose receipt correctly said "1 section
 * - 7 shots" was reported as a 0/0 delta, because an `undo` interjection two
 * moves later had taken the import back. The receipt was right; the oracle was
 * subtracting numbers from two different moments.
 *
 * The caller reads both counts off the receipt's OWN digest, so this costs
 * nothing extra and cannot drift from the claim it is checking.
 */
export function checkAccounting(claim: ReceiptClaim, before: CountedProject, atReceipt: CountedProject): void {
  if (claim.sections === null || claim.shots === null) return;
  // `-1` is the digest's "no project open" sentinel, not a count.
  //
  // A measurement taken with no project has nothing to compare against, so there
  // is no claim to check. A flow that STARTED with none created one, and a
  // project that did not exist had zero sections: subtracting the sentinel would
  // make every count one too many. Measured, on the first five-format run: a
  // `.tml` imported into a project the flow itself created reported a 3/5 delta
  // against a receipt that correctly said 2/4.
  if (atReceipt.sections < 0 || atReceipt.shots < 0) return;
  const sectionDelta = atReceipt.sections - Math.max(0, before.sections);
  const shotDelta = atReceipt.shots - Math.max(0, before.shots);
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
