/**
 * The values a fuzz trace step's trigger, export format and oracle name print
 * as in `fuzz-shrink`'s minimal action list (#576 W58 NF2).
 *
 * A trace is attached to issues and shrunk from wherever someone got it, and
 * `readTrace` checks these fields only as text (`requireText`), so
 * `describeSteps` prints one only when it is a value the harness defines -
 * listed here - and any other as its length (`valueShape`). The other fields it
 * checks only as text print through their own helpers: a test id through
 * `shareableTestId`, a path through `foldLocalPaths`, a reload's fixture
 * through `shareableFixtureName`, a corpus id only in its 5-hex form.
 *
 * The lists copy the scenarios' own tables: the triggers are literals of the
 * generators, the oracle names live inside `exportRoundtripFuzz`'s run, where
 * nothing can import them, and the formats are private to
 * `exportFuzzActions.ts` (the compiler holds this copy to `ExportFormat`).
 * `traceStepFields.test.ts` holds each copy to its table, so a value a
 * scenario starts recording cannot print as a length unnoticed.
 */
import type { ExportFormat } from './exportOracles';
import { valueShape } from './shareableFailure';

/**
 * The triggers the import-dialog fuzzer records in a `fileDialog` step
 * (`importDialogGenerators.ts` through `importDialogTrace.moveTraceStep`): the
 * two picker buttons, and the armed-keyboard picker as `key:<chord>`.
 */
export const TRACE_TRIGGERS: ReadonlySet<string> = new Set(['toolbar-import-button', 'global-open-import-button', 'key:Ctrl+O']);

/** Every `ExportFormat`, which the compiler holds to the type: the formats the export fuzzer draws (`exportFuzzActions.ts` ALL_FORMATS). */
const FORMATS: Readonly<Record<ExportFormat, true>> = {
  csv: true,
  json: true,
  tml: true,
  tmlu: true,
  png: true,
  svg: true,
  pdf: true,
  preview: true,
  diveProfile: true,
};
export const TRACE_EXPORT_FORMATS: ReadonlySet<string> = new Set(Object.keys(FORMATS));

/** The structural oracles the export fuzzer runs (`exportRoundtripFuzz.ts` ORACLE_NAMES). */
export const TRACE_ORACLE_NAMES: ReadonlySet<string> = new Set([
  'x3-differential',
  'x4-byte-identity',
  'x5x6-roundtrip',
  'x7-hostile-comments',
  'x8-option-independence',
  'x9-mode-invariants',
  'x9b-pre-plan-leak',
]);

/** A trace field's value as `describeSteps` prints it: itself when `known` has it, else `valueShape` (its length). */
export function shareableTraceWord(value: unknown, known: ReadonlySet<string>): string {
  return typeof value === 'string' && known.has(value) ? value : valueShape(value);
}
