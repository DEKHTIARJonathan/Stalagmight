import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpeleoStore } from '../../store/speleoStore';
import { formatFixed } from '../../i18n/format';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { SpeleoDumpCandidate } from '../../types/ipc/SpeleoDumpCandidate';

const RADIO_GROUP = 'speleodb-dump-picker';

/**
 * Whether the Modified column carries anything the user can choose on.
 *
 * The dump is a `git archive`, which stamps every entry with the same commit
 * time, so the ordinary case is a column of identical dates - which reads as a
 * broken timestamp rather than as "these genuinely match", and invites picking
 * the wrong file for a reason that was never there. Shown only when at least two
 * candidates actually disagree; entries that declare no timestamp are not a
 * disagreement, they are an absence.
 *
 * Pure and exported so the rule can be pinned directly, without going through a
 * render to find out what the column did.
 */
export function shouldShowModified(candidates: SpeleoDumpCandidate[]): boolean {
  const stated = new Set(
    candidates.map((candidate) => candidate.modified).filter((when) => when !== null),
  );
  return stated.size > 1;
}

/**
 * Human size for one candidate. Capped at MB on purpose: the backend refuses any
 * entry over 512 MiB, so a GB row cannot reach this list, and a unit that can
 * never appear is one more thing to get wrong.
 *
 * Whole bytes below 1 KB (a decimal on a raw byte count is noise), one decimal
 * from KB up - that is the tier the choice is usually made on, and two survey
 * files a few hundred KB apart otherwise round to the same integer and look like
 * the same file.
 */
/**
 * A ZIP entry path, rendered so it cannot lie about which entry it is.
 *
 * Entry names come from the archive, which a collaborator writes. Unicode carries
 * characters that reorder or hide the text around them - the bidi overrides and
 * isolates (U+202A..U+202E, U+2066..U+2069), the zero-width joiners and marks, and the
 * C0/C1 controls - so a decoy row can be made to READ as `misc/project.stalx` while the
 * radio's value stays the attacker's original string. The user picks what they see; the
 * app opens what was sent, and later pushes it over the project file.
 *
 * So the display is escaped and the value is not: `entry_path` still travels back to
 * the backend byte-identical, because that is what has to match the archive's own
 * membership test. Only what is drawn changes, and it changes into something visibly
 * wrong rather than something invisibly wrong.
 */
export function visiblePath(path: string): string {
  // eslint-disable-next-line no-control-regex
  return path.replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/gu, (ch) =>
    `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`,
  );
}

function formatSize(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${formatFixed(value, undefined, 0)} B`;
  if (value < 1024 * 1024) return `${formatFixed(value / 1024, undefined, 1)} KB`;
  return `${formatFixed(value / (1024 * 1024), undefined, 1)} MB`;
}

/** Localised timestamp, falling back to the raw value rather than dropping it. */
function formatModified(modified: string | null): string {
  if (modified === null) return '-';
  const parsed = new Date(modified);
  return Number.isNaN(parsed.getTime()) ? modified : parsed.toLocaleString();
}

/**
 * [#258] "Which of these is the survey?" - raised when a SpeleoDB project dump
 * holds more than one openable file, so the classifier cannot name one and the
 * backend hands back the candidates instead of guessing.
 *
 * An INDEPENDENT top-layer overlay (`dumpPickerOpen`), not the shared
 * `activeDialog` slot, for the reason {@link SpeleoStorageChoiceDialog} is, plus
 * one of its own: this question is raised from four unrelated surfaces, three of
 * which already occupy that single slot themselves, so taking it would unmount
 * the very surface the user has to come back to.
 *
 * The consequence sits ABOVE the list rather than beside the confirm button,
 * because the stakes are not in the choosing - they are in what the choice does
 * later. The chosen file becomes the project, and the next push replaces the
 * project file on SpeleoDB with it, so a user who picks the wrong one finds out
 * one push too late.
 *
 * NOTHING is pre-selected, and no candidate is badged. Both used to be, keyed on a
 * `project.stalx` BASENAME - and that asserted something no dump records. The push
 * target is `<TARGET_FOLDER>/project.stalx` for a folder the archive never names, so
 * with `backup/project.stalx` and `misc/current.stalx` under a target of `misc/`, the
 * badge landed on the BACKUP, sorted it first, pre-selected it and took initial focus:
 * a stray Enter accepted the one file the next push would overwrite. A guess that
 * confident is worse than no guess, so the list is path-ordered and the confirm stays
 * disabled until the user says which file they mean.
 *
 * Nothing here decides anything on its own - `resolveDumpPicker` re-invokes the
 * backend with the chosen entry, and the open runs again from the top.
 */
export default function SpeleoDumpPickerDialog() {
  const { t } = useTranslation();
  const candidates = useSpeleoStore((s) => s.dumpPickerCandidates);
  const kind = useSpeleoStore((s) => s.dumpPickerKind);
  const busy = useSpeleoStore((s) => s.dumpPickerBusy);
  const error = useSpeleoStore((s) => s.dumpPickerError);
  const resolveDumpPicker = useSpeleoStore((s) => s.resolveDumpPicker);
  // Close this OVERLAY only - the shared `closeDialog` would take the SpeleoDB
  // browser underneath with it.
  const closeDumpPicker = useSpeleoStore((s) => s.closeDumpPicker);

  const [picked, setPicked] = useState<string | null>(null);

  // A RE-OFFER is a new question, so it clears the old answer. The store hands over a
  // fresh array each time the picker is raised, so its identity is the offer's.
  //
  // Keeping the pick across a re-offer defeated the thing the re-offer exists for. The
  // backend refuses a reply that answers a different revision and re-asks with the new
  // tree's metadata - but this component stays mounted, and a path that survives the
  // push (a backup routinely does) left `selected` non-null, Confirm re-enabled and
  // still focused. A second Enter then accepted bytes from a tree the user never
  // looked at, which is precisely the deliberate re-choice the refusal was demanding.
  useEffect(() => {
    setPicked(null);
  }, [candidates]);

  // The user's pick, and only ever the user's pick. Derived rather than seeded into
  // state so a re-raise carrying a different dump cannot leave the selection pointing
  // at an entry that is no longer listed - `entry_path` is looked up as an exact key,
  // so a stale one resolves to "not found" rather than to the wrong file.
  const selected =
    picked !== null && candidates.some((candidate) => candidate.entry_path === picked)
      ? picked
      : null;

  // No candidates means there was no ambiguity to resolve, so there is no question
  // to ask. Refusing to render beats an empty list with a dead confirm button.
  if (candidates.length === 0) return null;

  const showModified = shouldShowModified(candidates);

  return (
    <DialogWrapper
      title={
        kind === 'stalx'
          ? t('speleodb.dumpPicker.titleStalx')
          : t('speleodb.dumpPicker.titleAriane')
      }
      // Not dismissable while the resolve is in flight, the same hardening
      // SpeleoQuitDialog / SpeleoUnpushedLocalDialog carry: Escape, the title-bar X
      // and the backdrop all reach `onClose`, none of them is gated on a button's
      // `disabled`, and unmounting mid-resolve leaves an open that is still running
      // with nothing on screen that says so.
      onClose={busy ? () => {} : closeDumpPicker}
      size="lg"
      data-testid="speleodb-dump-picker-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{t('speleodb.dumpPicker.body')}</p>
        <p
          className="p-3 rounded bg-surface border border-border text-xs text-text-secondary"
          data-testid="speleodb-dump-picker-consequence"
        >
          {t('speleodb.dumpPicker.consequence')}
        </p>

        <div className="border border-border rounded">
          <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border text-xs font-medium text-text-secondary">
            {/* Spacer matching the radio column so the headers sit over their values. */}
            <span className="w-4 flex-shrink-0" aria-hidden="true" />
            <span className="flex-1">{t('speleodb.dumpPicker.columnFile')}</span>
            <span className="w-20 text-right flex-shrink-0">
              {t('speleodb.dumpPicker.columnSize')}
            </span>
            {showModified && (
              <span className="w-40 text-right flex-shrink-0">
                {t('speleodb.dumpPicker.columnModified')}
              </span>
            )}
          </div>

          <div className="max-h-56 overflow-y-auto p-2 space-y-1">
            {candidates.map((candidate, index) => (
              // `entry_path` is unique within an archive - it is the key the entry
              // is looked up by - so it is also the row key.
              <label
                key={candidate.entry_path}
                className="flex items-center gap-3 text-sm p-1 rounded hover:bg-background-50"
              >
                <input
                  type="radio"
                  name={RADIO_GROUP}
                  value={candidate.entry_path}
                  checked={selected === candidate.entry_path}
                  onChange={() => setPicked(candidate.entry_path)}
                  disabled={busy}
                  className="flex-shrink-0"
                  data-testid={`speleodb-dump-picker-option-${index}`}
                />
                <span className="flex-1 min-w-0 flex items-center gap-2">
                  {/* The FULL path, wrapped rather than truncated: the candidates
                      routinely differ only in their directory, so an elided middle
                      would hide the one thing that tells them apart. */}
                  <span className="font-mono break-all">
                    {visiblePath(candidate.entry_path)}
                  </span>
                </span>
                <span className="w-20 text-right flex-shrink-0 text-text-secondary tabular-nums">
                  {formatSize(candidate.size_bytes)}
                </span>
                {showModified && (
                  <span className="w-40 text-right flex-shrink-0 text-text-secondary">
                    {formatModified(candidate.modified)}
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>

        {/* The retry runs from HERE, not from a host, so this is the only place its
            failure can be seen. Without it a rejected confirmation left the dialog
            open and silent. */}
        {error && (
          <p className="text-error" role="alert" data-testid="speleodb-dump-picker-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          {/* Disabled alongside `onClose` above, not merely alongside the confirm:
              it calls `closeDumpPicker` directly, so leaving it live would walk
              straight past the guard the dismissal routes are held to. */}
          <Button onClick={closeDumpPicker} disabled={busy} data-testid="speleodb-dump-picker-cancel">
            {t('common.actions.cancel')}
          </Button>
          {/* Primary + [data-primary-action]: DialogWrapper's initial-focus heuristic
              lands here, and it starts DISABLED because nothing is pre-selected - so
              focus falls to Cancel and a stray Enter cancels rather than picking a file
              on the user's behalf. That is the whole point of dropping the default:
              there is no candidate the app can honestly nominate. */}
          <Button
            variant="primary"
            // The store owns the in-flight state (`dumpPickerBusy`) and leaves the
            // dialog open on failure, so there is nothing to await here.
            onClick={() => {
              if (selected !== null) void resolveDumpPicker(selected);
            }}
            disabled={busy || selected === null}
            data-testid="speleodb-dump-picker-confirm"
          >
            {kind === 'stalx'
              ? t('speleodb.dumpPicker.confirmStalx')
              : t('speleodb.dumpPicker.confirmAriane')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
