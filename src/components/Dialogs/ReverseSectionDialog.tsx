import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { trackDialogComplete } from '../../utils/telemetry';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

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
  const { reverseSection, project } = useProjectStore();

  const sectionIds = (dialogData.sectionIds as number[] | undefined) ?? [];
  const [swapLeftRight, setSwapLeftRight] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sections = sectionIds
    .map((id) => project?.sections.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  const isMulti = sectionIds.length > 1;
  const title = isMulti ? `Reverse ${sectionIds.length} Sections` : 'Reverse Section';

  const handleConfirm = async () => {
    if (sectionIds.length === 0) return;
    setIsSubmitting(true);
    setError(null);
    try {
      for (const sectionId of sectionIds) {
        const result = await reverseSection(sectionId, swapLeftRight);
        if (!result.success) {
          setError(result.error ?? 'Failed to reverse section');
          setIsSubmitting(false);
          return;
        }
      }
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
            ? `Renumber ${sectionIds.length} sections end-to-end, so each section's last station becomes station 0.`
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
            disabled={isSubmitting || sectionIds.length === 0}
            data-primary-action=""
            data-testid="reverse-confirm"
          >
            {isMulti ? `Reverse ${sectionIds.length} Sections` : 'Reverse'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
