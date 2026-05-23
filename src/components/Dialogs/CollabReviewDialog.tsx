import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { CollabChangeSet, MatchQuality } from '../../types/commands';
import type { ShotData } from '../../types/project';
import { trackDialogComplete } from '../../utils/telemetry';

interface CollabReviewDialogProps {
  changeSet: CollabChangeSet;
}

function fmtShot(d: ShotData): string {
  return `Az ${d.azimuth_in.toFixed(1)}° · ${d.length.toFixed(2)} m · ${d.depth_in.toFixed(1)}→${d.depth_out.toFixed(1)} m`;
}

/** i18n key for the advisory note shown per match-quality tier (none for exact tiers). */
const MATCH_QUALITY_NOTE_KEY: Record<MatchQuality, string | null> = {
  Uuid: null,
  ArianeId: null,
  Fingerprint: 'dialogs.collabReview.matchFingerprint',
  Positional: 'dialogs.collabReview.matchPositional',
};

export default function CollabReviewDialog({ changeSet }: CollabReviewDialogProps) {
  const { t } = useTranslation();
  const { applyCollabChanges } = useProjectStore();
  const { closeDialog, openDialog, triggerFitToBounds } = useUIStore();
  const [isApplying, setIsApplying] = useState(false);

  const counts = useMemo(() => {
    let removedDependents = 0;
    for (const r of changeSet.shots_removed) {
      removedDependents += r.impact.removed_closures.length + r.impact.removed_merges.length;
    }
    return {
      added: changeSet.shots_added.length,
      edited: changeSet.shots_edited.length,
      removed: changeSet.shots_removed.length,
      sectionsAdded: changeSet.sections_added.length,
      sectionMeta: changeSet.section_meta_changed.length,
      removedDependents,
    };
  }, [changeSet]);

  const total = counts.added + counts.edited + counts.removed + counts.sectionsAdded + counts.sectionMeta;
  const matchNoteKey = MATCH_QUALITY_NOTE_KEY[changeSet.match_quality];

  const handleApply = useCallback(async () => {
    setIsApplying(true);
    try {
      const result = await applyCollabChanges();
      if (!result.success) {
        setIsApplying(false);
        openDialog('error', {
          title: t('dialogs.collabReview.errorTitle'),
          message: result.error ?? t('dialogs.collabReview.errorUnknown'),
        });
        return;
      }
      trackDialogComplete('collab-review');
      closeDialog();
      triggerFitToBounds();
    } catch (e) {
      setIsApplying(false);
      openDialog('error', {
        title: t('dialogs.collabReview.errorTitle'),
        message: getErrorMessage(e, t('dialogs.collabReview.errorApply')),
      });
    }
  }, [applyCollabChanges, closeDialog, openDialog, triggerFitToBounds, t]);

  return (
    <DialogWrapper title={t('dialogs.collabReview.title')} onClose={closeDialog} size="lg" data-testid="collab-review-dialog">
      <div className="space-y-4">
        <div className="text-sm text-text-secondary">
          {t('dialogs.collabReview.intro')}
        </div>

        {/* Match-quality banner */}
        {matchNoteKey && (
          <div
            className="p-3 bg-warning-10 border border-warning-20 rounded text-sm"
            data-testid="collab-match-quality"
          >
            {t(matchNoteKey)}
          </div>
        )}

        {/* Summary stats */}
        <div className="grid grid-cols-5 gap-3 p-3 bg-surface-alt rounded">
          <div>
            <div className="text-xs text-text-tertiary">{t('dialogs.collabReview.countAdded')}</div>
            <div className="text-sm font-medium" data-testid="collab-count-added">{counts.added}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">{t('dialogs.collabReview.countEdited')}</div>
            <div className="text-sm font-medium" data-testid="collab-count-edited">{counts.edited}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">{t('dialogs.collabReview.countRemoved')}</div>
            <div className="text-sm font-medium" data-testid="collab-count-removed">{counts.removed}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">{t('dialogs.collabReview.countSections')}</div>
            <div className="text-sm font-medium" data-testid="collab-count-sections">{counts.sectionsAdded}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">{t('dialogs.collabReview.countSectionMeta')}</div>
            <div className="text-sm font-medium" data-testid="collab-count-section-meta">{counts.sectionMeta}</div>
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto space-y-4">
          {/* Edited shots */}
          {changeSet.shots_edited.length > 0 && (
            <div>
              <div className="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-1">{t('dialogs.collabReview.editedShots')}</div>
              <ul className="space-y-1" data-testid="collab-edited-list">
                {changeSet.shots_edited.map((s, i) => (
                  <li key={i} className="text-sm border-l-2 border-warning-20 pl-2">
                    <span className="text-text-secondary">{s.section_name}</span>{' '}
                    <span className="text-text-tertiary">#{s.shot_index + 1}</span>
                    <div className="text-xs text-text-tertiary">
                      {s.changes.map((c) => `${c.field}: ${c.old} → ${c.new}`).join('  ·  ')}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Added shots */}
          {changeSet.shots_added.length > 0 && (
            <div>
              <div className="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-1">{t('dialogs.collabReview.addedShots')}</div>
              <ul className="space-y-1" data-testid="collab-added-list">
                {changeSet.shots_added.map((s, i) => (
                  <li key={i} className="text-sm border-l-2 border-success-30 pl-2">
                    <span className="text-text-secondary">{s.section_name}</span>
                    <div className="text-xs text-text-tertiary">{fmtShot(s.data)}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Removed shots */}
          {changeSet.shots_removed.length > 0 && (
            <div>
              <div className="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-1">{t('dialogs.collabReview.removedShots')}</div>
              <ul className="space-y-1" data-testid="collab-removed-list">
                {changeSet.shots_removed.map((s, i) => {
                  const dependents = s.impact.removed_closures.length + s.impact.removed_merges.length;
                  return (
                    <li key={i} className="text-sm border-l-2 border-error-20 pl-2">
                      <span className="text-text-secondary">{s.section_name}</span>{' '}
                      <span className="text-text-tertiary">#{s.shot_index + 1}</span>
                      {dependents > 0 && (
                        <span className="ml-1 text-xs text-warning">
                          {t('dialogs.collabReview.alsoRemoves', { count: dependents })}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* New sections */}
          {changeSet.sections_added.length > 0 && (
            <div>
              <div className="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-1">{t('dialogs.collabReview.newSections')}</div>
              <ul className="space-y-1" data-testid="collab-sections-list">
                {changeSet.sections_added.map((s, i) => (
                  <li key={i} className="text-sm border-l-2 border-success-30 pl-2">
                    <span className="text-text-secondary">{s.name}</span>
                    <span className="ml-1 text-xs text-text-tertiary">{t('dialogs.collabReview.sectionShots', { count: s.shots.length })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Section metadata changes */}
          {changeSet.section_meta_changed.length > 0 && (
            <div>
              <div className="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-1">{t('dialogs.collabReview.sectionChanges')}</div>
              <ul className="space-y-1" data-testid="collab-section-meta-list">
                {changeSet.section_meta_changed.map((s, i) => (
                  <li key={i} className="text-sm border-l-2 border-warning-20 pl-2">
                    <span className="text-text-secondary">{s.section_name}</span>
                    <div className="text-xs text-text-tertiary">
                      {s.changes.map((c) => `${c.field}: ${c.old} → ${c.new}`).join('  ·  ')}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Warnings */}
        {changeSet.warnings.length > 0 && (
          <div className="p-3 bg-warning-10 border border-warning-20 rounded text-sm space-y-1" data-testid="collab-warnings">
            {changeSet.warnings.map((w, i) => (
              <div key={i}>{w.message}</div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog} data-testid="collab-review-cancel">{t('dialogs.collabReview.cancel')}</Button>
          <Button
            data-primary-action=""
            data-testid="collab-review-apply"
            onClick={handleApply}
            disabled={isApplying || total === 0}
          >
            {isApplying ? t('dialogs.collabReview.applying') : t('dialogs.collabReview.apply')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
