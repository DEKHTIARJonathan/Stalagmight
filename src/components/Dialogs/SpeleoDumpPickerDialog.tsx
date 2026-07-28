import { useState } from 'react';
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
 * one push too late. The canonical entry is pre-selected for the same reason: it
 * is the file SpeleoDB already serves, so accepting the default is the move that
 * changes nothing.
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

  // The file SpeleoDB currently serves, and so the default: choosing it is the
  // answer that leaves the server exactly as it is.
  const canonical = candidates.find((candidate) => candidate.is_canonical)?.entry_path ?? null;
  // A pick wins once made, but only while it still names something on screen.
  // Derived rather than seeded into state so a re-raise carrying a different dump
  // cannot leave the selection pointing at an entry that is no longer listed -
  // `entry_path` is looked up as an exact key, so a stale one resolves to "not
  // found" rather than to the wrong file.
  const selected =
    picked !== null && candidates.some((candidate) => candidate.entry_path === picked)
      ? picked
      : canonical;

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
                  <span className="font-mono break-all">{candidate.entry_path}</span>
                  {candidate.is_canonical && (
                    <span className="px-1.5 py-0.5 rounded text-xs bg-accent text-accent-on flex-shrink-0">
                      {t('speleodb.dumpPicker.currentBadge')}
                    </span>
                  )}
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
          {/* Primary + [data-primary-action]: DialogWrapper's initial-focus
              heuristic lands here, so a stray Enter takes the pre-selected
              canonical file - the answer that changes nothing on the server. When
              no candidate is canonical this button starts disabled, focus falls to
              Cancel, and Enter cancels rather than picking a file for the user. */}
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
