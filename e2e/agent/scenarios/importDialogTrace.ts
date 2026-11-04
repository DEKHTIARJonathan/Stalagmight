/**
 * The trace steps the import-dialog fuzzer records, as pure functions of a move.
 *
 * Split out of the scenario's closure for two reasons. The step a move records
 * when it returns and the step a STALL leaves behind (the move that never
 * returned, #576 HFI-9) have to be the same step, so they come from one place.
 * And the file-opening steps are where a corpus file's real name used to leak
 * into every corpus trace (#576 HFI-13); with the construction here, a test can
 * build exactly what a run writes and look for the name in it.
 */
import { corpusEntryRel, isCorpusEntryRel, type TraceStep } from '../lib/fuzzTrace';
import { describeSource, type FileSource, type FuzzMove } from './importDialogGenerators';

/**
 * The step that PUT a move's input file on disk, recorded before the step that
 * opens it. A generated file travels as its spec; a corpus file as its id and
 * resolution hash and the directory it is copied into - never its name. A
 * tracked fixture or a replayed file needs no step.
 */
export function sourceTraceStep(source: FileSource): TraceStep | null {
  if (source.origin === 'gen') {
    return { kind: 'genFile', spec: source.spec, rel: source.rel, label: describeSource(source) };
  }
  if (source.origin === 'corpus') {
    return {
      kind: 'corpusFile',
      corpusId: source.id,
      // The resolution key. `corpusId` is 20 bits and labels the file in
      // everything a human reads; this is what a replay looks it up by, so a
      // corpus holding a second file that folds to the same id cannot be
      // materialized in its place.
      corpusHash: source.hash,
      // The DIRECTORY the copy lands in; the `route`/`fileDialog` step that
      // follows names the entry inside it as `corpusEntryRel(dirRel)`.
      rel: source.dirRel,
      label: describeSource(source),
    };
  }
  return null;
}

/**
 * The step a move records once it has been performed, or null for a move whose
 * step cannot be known before it runs (a RELATIVE map click is recorded at the
 * absolute point it resolved to).
 *
 * A file move records `source.rel`, which for a corpus source is the entry
 * token and never the copy's basename - see `fuzzTrace.CORPUS_ENTRY_SEGMENT`.
 * An `input` move records the value as DRAWN, before the shell substitutes a
 * real path for the projects-directory placeholder.
 */
export function moveTraceStep(move: FuzzMove): TraceStep | null {
  switch (move.kind) {
    case 'ui':
      return move.double === true
        ? { kind: 'ui', testid: move.testid, double: true, label: move.label }
        : { kind: 'ui', testid: move.testid, label: move.label };
    case 'input':
      return { kind: 'input', testid: move.testid, value: move.value, mode: move.mode, label: move.label };
    case 'openFile':
      return move.via === 'route'
        ? { kind: 'route', rel: move.source.rel, label: move.label }
        : { kind: 'fileDialog', trigger: move.trigger, dialog: 'open', rel: move.source.rel, label: move.label };
    case 'keyFile':
      return { kind: 'fileDialog', trigger: `key:${move.chord}`, dialog: 'open', rel: move.source.rel, label: move.label };
    case 'cancelDialog':
      return { kind: 'fileDialog', trigger: move.trigger, dialog: 'open', rel: null, label: move.label };
    case 'closeProject':
      return { kind: 'mutate', action: 'closeProject', args: [], label: move.label };
    case 'mapClick':
      return move.relative === true ? null : { kind: 'mapClick', lngLat: move.lngLat, label: move.label };
    case 'undo':
      return { kind: 'undo' };
    case 'redo':
      return { kind: 'redo' };
    case 'save':
      return { kind: 'save' };
    default:
      return null;
  }
}

/**
 * Where a REPLAY's corpus entry tokens point.
 *
 * A `corpusFile` step materializes a copy and binds its directory's token to the
 * entry file the copy produced; the `route` / `fileDialog` step after it carries
 * only the token and is resolved here. A token nobody bound - ddmin cut the
 * `corpusFile` step away, or this machine's corpus does not have the entry -
 * resolves to null, which the shell skips and counts like any missing file.
 */
export class CorpusEntryPaths {
  private readonly bound = new Map<string, string>();

  /** Bind the entry copied into `dirRel` to the absolute path of the copy. */
  bind(dirRel: string, absolutePath: string): void {
    this.bound.set(corpusEntryRel(dirRel), absolutePath);
  }

  /**
   * The absolute path a token stands for, null for an unbound token, and
   * undefined when `rel` is not a token at all (an ordinary session path).
   */
  resolve(rel: string): string | null | undefined {
    if (!isCorpusEntryRel(rel)) return undefined;
    return this.bound.get(rel.split('\\').join('/')) ?? null;
  }
}
