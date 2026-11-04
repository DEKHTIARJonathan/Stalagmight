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

/**
 * What one cell's child process amounted to.
 *
 * - `pass`: it printed `PASS:` and exited 0.
 * - `fail`: the SCENARIO reached a verdict and it was not a pass - a `FAIL:`
 *   line, or a `PASS:` line with a non-zero exit.
 * - `lost`: there is NO verdict. The spawn failed, the cell hit its timeout, or
 *   the child died without printing either line - which is what an app that
 *   never attached looks like. Measured (#576 HFI-7): with the debug build's
 *   single-instance plugin, a `--workers 4` matrix lost 9 of 12 cells at about
 *   33 s each, and because those cells cost seconds rather than minutes the
 *   summary still printed a 3.91x speedup. A lost cell says nothing about the
 *   scenario, so it is reported apart from the failures and it voids the
 *   speedup.
 */
export type CellVerdict = 'pass' | 'fail' | 'lost';

export interface CellExit {
  spawnFailed: boolean;
  timedOut: boolean;
  code: number | null;
  sawPass: boolean;
  sawFail: boolean;
}

export function cellVerdict(exit: CellExit): CellVerdict {
  if (exit.spawnFailed || exit.timedOut) return 'lost';
  if (exit.sawFail) return 'fail';
  if (exit.sawPass) return exit.code === 0 ? 'pass' : 'fail';
  return 'lost';
}

/**
 * The closing lines of a matrix report: the counts, and the speedup ONLY when
 * every cell reached a verdict.
 *
 * The speedup compares the summed cell durations against the wall clock, which
 * is a measure of parallel throughput only if every cell did its work. A lost
 * cell's duration is an attach timeout, so including it inflates the ratio and
 * excluding it measures a different matrix than the one that ran - neither is a
 * number worth printing next to a run that did not happen.
 */
export function matrixSummary(
  cells: readonly { verdict: CellVerdict; durationMs: number }[],
  wallMs: number,
): string[] {
  const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  const failed = cells.filter((cell) => cell.verdict === 'fail').length;
  const lost = cells.filter((cell) => cell.verdict === 'lost').length;
  const serialMs = cells.reduce((sum, cell) => sum + cell.durationMs, 0);
  const lines = [
    lost > 0
      ? `wall clock ${secs(wallMs)}; speedup NOT reported: ${lost} cell(s) LOST (no PASS or FAIL - the ` +
        'child died before its scenario reached a verdict, e.g. an app that never attached)'
      : `wall clock ${secs(wallMs)}; serial-equivalent ${secs(serialMs)}; ` +
        `speedup ${(serialMs / Math.max(wallMs, 1)).toFixed(2)}x`,
    `${failed} failed, ${lost} lost / ${cells.length} run(s)`,
  ];
  if (lost > 0) lines.push(`MATRIX INCOMPLETE: ${lost} of ${cells.length} cell(s) produced no verdict`);
  return lines;
}
