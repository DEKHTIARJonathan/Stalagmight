import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { isEditingBlockedNow } from '../../hooks/useEditingBlocked';
import { getErrorMessage } from '../../utils/ipc';
import { trackDialogComplete } from '../../utils/telemetry';
import { applyReverseAftermath } from '../../utils/reverseAftermath';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * Stable identity for the project this dialog is acting on, following the
 * `projectIdentityKey` pattern in `useMapTools`. Deliberately WITHOUT
 * `modified_at`: the reverse itself bumps that, so including it would make the
 * check fail on every success.
 */
function projectKeyOf(
  project: { created_at?: string; file_path?: string | null } | null | undefined
): string {
  return `${project?.created_at ?? ''}|${project?.file_path ?? ''}`;
}

/**
 * Confirm dialog for reversing one or more sections end-to-end (#24).
 *
 * Reverse flips which physical end of a section is station 0 without moving the
 * cave: every station keeps its world coordinate, and merges/closures/datums/
 * comments follow their physical station. The one thing the app cannot decide
 * on the user's behalf is left/right - whether LRUD was recorded facing along
 * travel is a survey convention - so it is an explicit, unticked choice here.
 */
export default function ReverseSectionDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const { reverseSection, executeBatch, project } = useProjectStore();

  const sectionIds = (dialogData.sectionIds as number[] | undefined) ?? [];
  const [swapLeftRight, setSwapLeftRight] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Everything below counts RESOLVED sections, never `sectionIds`. A section
  // deleted between opening the menu and confirming would otherwise put
  // "Reverse 3 Sections" over a 2-item list and then submit a batch the backend
  // rolls back whole. The stale entry disables confirm instead of silently
  // reverse-ing a different set than the one on screen.
  const sections = sectionIds
    .map((id) => project?.sections.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const hasMissing = sections.length < sectionIds.length;

  const isMulti = sections.length > 1;
  const title = isMulti ? `Reverse ${sections.length} Sections` : 'Reverse Section';

  const handleConfirm = async () => {
    if (isSubmitting || sections.length === 0 || hasMissing) return;

    // Read-only self-check at confirm time: a reverse has NO server backstop for
    // the local closure-adjusted / Plan / Export case (see useEditingBlocked's
    // backstop-asymmetry note), so a dialog left open across a view switch to a
    // read-only mode must refuse here rather than mutate. Re-checked now, not at
    // open time, because the mode can flip while the dialog is up.
    if (isEditingBlockedNow()) {
      setError('Editing is disabled in the current view.');
      return;
    }

    // A section with no shots is a single station and reverses to itself, so the
    // backend deliberately changes nothing (and does not even touch the project).
    // Sending it anyway would mark the project dirty - and cost an Undo - for an
    // action that provably did nothing.
    const changing = sections.filter((s) => s.shots.length > 0);
    if (changing.length === 0) {
      trackDialogComplete('reverse-section');
      closeDialog();
      return;
    }

    setIsSubmitting(true);
    setError(null);
    // Captured BEFORE the await. Escape closes this dialog (useKeyboardShortcuts /
    // DialogWrapper) without cancelling the command already in flight, so a late
    // reply must not close whatever dialog is open by then, nor emit a second
    // trackDialogComplete. `dialogData` is a fresh object per openDialog call, so
    // reference identity distinguishes even a re-opened Reverse dialog.
    const dialogKey = dialogData;
    const projectKey = projectKeyOf(project);
    try {
      // Reversing a multi-selection is one user action, so it goes through a
      // batch: the backend rolls the whole thing back if any section fails, and
      // it lands as a single undo entry. Looping one command per section would
      // leave the project half-reversed on a mid-loop failure while reporting an
      // error, and would need one Undo per section to get back.
      const only = changing[0];
      const result =
        changing.length === 1 && only !== undefined
          ? await reverseSection(only.id, swapLeftRight)
          : await executeBatch(
              changing.map((s) => ({
                type: 'reverse_section' as const,
                section_id: s.id,
                swap_left_right: swapLeftRight,
              }))
            );
      if (!result.success) {
        setError(result.error ?? 'Failed to reverse section');
        setIsSubmitting(false);
        return;
      }
      // The backend mirrors everything it owns; these are the frontend's own
      // POSITIONAL refs, which a reverse leaves in-range but pointing at the
      // opposite physical station. See utils/reverseAftermath. Applied even when
      // the dialog is already gone - the reverse landed either way - but not
      // across a project switch, whose refs belong to a different project.
      // Keyed off the sections this dialog submitted rather than the result's
      // `reversed_section_ids`: the call is synchronous and all-or-nothing, so on
      // success the two lists are the same, and unlike undo/redo - which replays a
      // history entry the frontend never saw - there is nothing here to discover.
      if (projectKeyOf(useProjectStore.getState().project) === projectKey) {
        applyReverseAftermath(new Map(changing.map((s) => [s.id, s.shots.length] as const)));
      }

      if (useUIStore.getState().dialogData !== dialogKey) return;
      trackDialogComplete('reverse-section');
      closeDialog();
    } catch (e) {
      setError(getErrorMessage(e));
      setIsSubmitting(false);
    }
  };

  return (
    <DialogWrapper title={title} onClose={closeDialog} size="md" data-testid="reverse-section-dialog">
      <div className="space-y-4">
        <p className="text-text-secondary">
          {isMulti
            ? `Renumber ${sections.length} sections end-to-end, so each section's last station becomes station 0.`
            : 'Renumber this section end-to-end, so the last station becomes station 0.'}
        </p>

        {sections.length > 0 && (
          <ul
            className="list-disc list-inside text-sm text-text-secondary"
            data-testid="reverse-section-list"
          >
            {sections.map((s) => (
              <li key={s.id}>
                {s.name ?? `Section ${s.id}`}
                {s.shots.length > 0 && (
                  <span className="text-text-tertiary">
                    {' '}
                    (station 0 &rarr; {s.shots.length}, station {s.shots.length} &rarr; 0)
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="text-sm text-text-tertiary">
          The cave does not move: every station keeps its position on the map, and merges, loop
          closures, zero datums and comments stay on the station they were set on. Only the
          numbering direction changes.
        </p>

        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={swapLeftRight}
            onChange={(e) => setSwapLeftRight(e.target.checked)}
            className="mt-0.5"
            data-testid="reverse-swap-lr"
          />
          <span>
            <span className="text-text-primary">Swap left/right passage measurements</span>
            <span className="block text-text-tertiary">
              Tick this if LRUD was recorded facing along the survey direction, so what was on the
              left is now on the right. Leave it unticked to keep the values as recorded.
            </span>
          </span>
        </label>

        {hasMissing && (
          <div
            className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm"
            data-testid="reverse-stale"
          >
            One or more of the selected sections no longer exists. Close this and pick the
            sections again.
          </div>
        )}

        {error && (
          <div
            className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm"
            data-testid="reverse-error"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={isSubmitting || sections.length === 0 || hasMissing}
            data-primary-action=""
            data-testid="reverse-confirm"
          >
            {isMulti ? `Reverse ${sections.length} Sections` : 'Reverse'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
