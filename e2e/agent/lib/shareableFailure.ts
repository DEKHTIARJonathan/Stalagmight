/**
 * A scenario failure as a SHAREABLE artifact prints it: codes, counts and code
 * locations, never the app's own text (#576 W21-NF1).
 *
 * A failure message mixes the harness's words with the app's: an INTEGRITY
 * failure lists `check_project_integrity` messages, an S6 IPC CONTRACT failure
 * quotes the backend's deserialization lines (argument values included), an
 * undo diff prints `expected:` / `actual:` values out of the project, an
 * `error:` line is a command's error, and a move note can quote either. Those
 * name sections, stations and projects of the loaded data, which no corpus fold
 * knows. The FAIL line, a fuzz trace and `fuzz-shrink`'s output are what a
 * campaign attaches to an issue, so they carry this form; the full text stays
 * in the session's `actions.jsonl` (docs/agent-harness.md lists what is not for
 * sharing).
 *
 * Fail-closed: a line is kept only if its SHAPE is one the harness writes from
 * its own vocabulary, and everything else is withheld and counted - so a new
 * oracle that quotes the app is covered without anyone remembering to mark it.
 */
import { redactCorpusText } from './fixtureCorpus';

/** Lines the harness writes from its own vocabulary, kept whole. */
const KEPT_LINES: readonly RegExp[] = [
  /^\s*reproduce: /, // the command that re-runs it
  /^\s*trace: /, // where the trace went
  // A diff path - a code location in the data model: field names, indices.
  /^\s*at [A-Za-z_]\w*(?:\[(?:\d+|\*)\]|\.(?:[A-Za-z_]\w*|\d+))*$/,
  /^\s*last \d+ [^:]*:$/, // the move tail's heading, a count
  /^ {2}\(\d+ line\(s\) withheld: /, // a count this function wrote: projecting twice changes nothing
];

/** A classifier the message names - an id from a harness table, kept as the id alone. */
const CLASSIFIER = /(KNOWN OPEN APP BUG|ATTRIBUTED) \[([a-z0-9-]+)\]/g;

/**
 * Headlines that end in the app's or the page's own text, as `prefix: text`:
 * the prefix names the code path, the rest is the app's words.
 * - `page.ts` puts `ipc <command>:` / `eval compile:` / `eval:` in front of an
 *   error it rethrows;
 * - a scenario words a refused action as `<action> failed: <its error>`
 *   (`loadProject(<fixture>) failed: ...`, `createSection 3 failed: ...`);
 * - a headline that ends in a JSON array or object carries values, such as
 *   `E2 INTEGRITY: ... at the start of episode 3: [<integrity messages>]`.
 */
const APP_ERROR_HEADLINES: readonly RegExp[] = [
  /^(ipc \w+|eval compile|eval): (.*)$/,
  /^(.*? failed): (.*)$/,
  /^(.*?): ([[{].*)$/,
];

/** What `shareableFailureText` leaves of the app's text in a headline. */
const WITHHELD_TEXT = /^\(\d+ characters of the app's text withheld\)$/;

/** `headline` with the app's text after an `APP_ERROR_HEADLINES` prefix replaced by its length. */
function shareableHeadline(headline: string): string {
  for (const shape of APP_ERROR_HEADLINES) {
    const app = shape.exec(headline);
    if (!app) continue;
    const [, prefix = '', text = ''] = app;
    return WITHHELD_TEXT.test(text) ? headline : `${prefix}: (${text.length} characters of the app's text withheld)`;
  }
  return headline;
}

function withheldLine(count: number): string {
  return `  (${count} line(s) withheld: they can quote the app's text - the full failure is in the session's actions.jsonl)`;
}

/**
 * `message` with the corpus fold applied and every line the harness did not
 * word itself withheld, a run of them replaced by one count line. The headline
 * (line 1) stays - a scenario writes it from harness words, numbers and names
 * (scenario, fixture, move, screen) - except the app's text an
 * `APP_ERROR_HEADLINES` shape ends in, which is replaced by its length.
 */
export function shareableFailureText(message: string): string {
  const [first = '', ...rest] = redactCorpusText(message).split('\n');
  const out = [shareableHeadline(first)];
  let withheld = 0;
  const flush = (): void => {
    if (withheld > 0) out.push(withheldLine(withheld));
    withheld = 0;
  };
  for (const line of rest) {
    if (KEPT_LINES.some((shape) => shape.test(line))) {
      flush();
      out.push(line);
      continue;
    }
    const classifiers = [...line.matchAll(CLASSIFIER)].map((found) => `${found[1]} [${found[2]}]`);
    if (classifiers.length > 0) {
      flush();
      out.push(`  ${classifiers.join(' ')}`);
      continue;
    }
    withheld++;
  }
  flush();
  return out.join('\n');
}

/**
 * What `agent:scenario` / `agent:scenarios` print for a scenario that threw:
 * the `FAIL: <name> threw:` line `fuzz-matrix` anchors on, then the shareable
 * failure, whose first line is the headline the matrix reports.
 */
export function scenarioFailOutput(name: string, err: unknown): string {
  return `FAIL: ${name} threw:\n${shareableFailureText(err instanceof Error ? err.message : String(err))}\n`;
}
