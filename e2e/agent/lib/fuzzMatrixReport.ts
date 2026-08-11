/**
 * What a FAILED matrix cell keeps of its output.
 *
 * Split out of `fuzz-matrix.ts` for the reason its sibling `fuzzMatrixArgs.ts`
 * states: the runner calls `main()` at module scope, so a test that imported it
 * would launch a matrix. This half is pure - it selects lines, it never spawns.
 *
 * The selection is the whole point. A cell that fails is the only artifact a
 * campaign gets to keep: the child process and its session are gone by the time
 * anyone reads the log, so whatever is NOT copied out of its stdout here has
 * been destroyed. The first version of this printer kept the tail only when the
 * failure carried no `reproduce:` line - and every oracle failure carries one,
 * so precisely the failures with a payload (the oracle's numbers, the move
 * history, the trace path) were the ones that lost it, while a bare crash kept
 * its tail. Two campaign reds were diagnosed from a retry log for that reason
 * and one could not be diagnosed at all.
 */

/** Last lines of a run that produced no `FAIL:` line at all (a crash, a timeout). */
export const TAIL_LINES = 15;

/**
 * Cap on the printed `FAIL:` block.
 *
 * `import-dialog-fuzz`'s own failure message is a headline, a repro line, the
 * knobs, the oracle's detail and up to 25 moves, so the cap has to sit above
 * that or the move history - the part that says what happened - is what gets
 * cut. Anything longer is a scenario printing into its failure, and the trace
 * file it names is the better artifact for that.
 */
export const FAIL_BLOCK_LINES = 60;

export interface FailureDetailInput {
  /** The child's stdout, split into lines. */
  outLines: readonly string[];
  /** stdout + stderr, split into lines - the fallback source. */
  allLines: readonly string[];
}

/**
 * The lines worth keeping from a failed cell.
 *
 * Prefers the FIRST `FAIL:` block, because that is where the scenario put
 * everything it knows; falls back to the tail of all output for a child that
 * died without printing one. Never returns the whole log: a cell streams the
 * scenario's own `   . ` progress lines, and a matrix of 30 of those is not a
 * report.
 */
export function failureDetail(input: FailureDetailInput): string {
  const failIndex = input.outLines.findIndex((line) => line.startsWith('FAIL: '));
  if (failIndex >= 0) {
    const block = input.outLines.slice(failIndex, failIndex + FAIL_BLOCK_LINES);
    // Trailing blanks only; interior ones are part of the message's shape.
    while (block.length > 0 && (block[block.length - 1] as string).trim() === '') block.pop();
    return block.join('\n');
  }
  return input.allLines
    .filter((line) => line.trim())
    .slice(-TAIL_LINES)
    .join('\n');
}
