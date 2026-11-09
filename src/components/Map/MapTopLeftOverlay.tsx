import { useTranslation } from 'react-i18next';
import { FitToViewIcon, LockIcon } from '../common/icons';
import {
  RawDataResumeButton,
  SpeleoLogInButton,
  SpeleoReadOnlyLabel,
  SpeleoResumeEditingButton,
} from './MapReadOnlyResume';

/**
 * The map's top-left overlay row: the fit-to-view / exit-focus button, and the
 * read-only notices that sit beside it.
 *
 * Extracted from `MapCanvas` because the two notices used to be independent
 * `absolute top-2 left-2` elements, which can only ever draw on top of each
 * other - a remote read-only project in the closure-adjusted view stacked the
 * SpeleoDB badge and the closure badge over the same pixels. As flex siblings
 * they lay out instead, and a future third notice cannot reintroduce the bug.
 *
 * Every gate arrives pre-computed. That is deliberate: it keeps the raw
 * geometry-mode comparison (and the `speleoReadOnly` subscription) in
 * `MapCanvas`, where `scripts/check-readonly-gates.mjs` allow-lists them by
 * exact count, so this file adds none of its own - which is also why the
 * comparison is not spelled out literally anywhere below. That lint scans
 * source text, comments included.
 */
export function MapTopLeftOverlay({
  focused,
  onFitOrExitFocus,
  showSpeleoReadOnly,
  showClosureReadOnly,
  showClosureComputing,
}: {
  /** In section-focus mode, the fit button doubles as "exit focus". */
  focused: boolean;
  onFitOrExitFocus: () => void;
  /** Remote project open without the write lock (Survey mode only). */
  showSpeleoReadOnly: boolean;
  /**
   * Closure-adjusted geometry is why editing is off. Shown only when nothing
   * else already explains the read-only state - see `MapCanvas` for the rule.
   */
  showClosureReadOnly: boolean;
  /** The closure solve is running (can be true while the notice above is not). */
  showClosureComputing: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="absolute top-2 left-2 flex items-center gap-2">
      {/* The solve's announcement channel, and the ONLY thing that speaks it.
          Mounted unconditionally and empty until the solve starts, because a live
          region injected at the same moment as its text is unreliably announced -
          the chip below appears and disappears with the solve, so it can never be
          the region itself. Same reason `ToastStack` and the selection announcer
          in `App` are permanent. `sr-only` is absolutely positioned, so this is
          not a flex item in any layout sense. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {showClosureComputing
          ? t(
              showClosureReadOnly
                ? 'map.geometry.computingReadOnly'
                : 'map.geometry.computing'
            )
          : ''}
      </div>

      <button
        onClick={onFitOrExitFocus}
        className="flex items-center gap-1.5 bg-panel border border-border rounded px-2 py-1 text-sm hover:bg-background"
        title={focused ? t('sections.focus.exit') : t('map.fitToViewTitle')}
        aria-label={focused ? t('sections.focus.exit') : t('map.fitToViewTitle')}
        data-testid="fit-to-view-button"
      >
        <FitToViewIcon size={16} />
        {/* In focus mode the button also exits focus - label it so that's clear. */}
        {focused && <span>{t('sections.focus.exitLabel')}</span>}
      </button>

      {showSpeleoReadOnly && (
        <div
          className="bg-panel border border-accent rounded px-3 py-1.5 text-xs flex items-center gap-1.5"
          data-testid="speleodb-readonly-banner"
        >
          <LockIcon size={13} />
          <SpeleoReadOnlyLabel />
          <SpeleoResumeEditingButton />
          <SpeleoLogInButton />
        </div>
      )}

      {/* One chip, two reasons to exist. The read-only testid rides ONLY on the
          notice itself: a spec asserting "no closure read-only banner in Plan
          mode" must not be satisfied by a progress indicator.

          Purely visual - it carries no live-region role, because it is mounted and
          unmounted BY the thing it would have to announce. The region above speaks
          for it. */}
      {(showClosureReadOnly || showClosureComputing) && (
        <div
          className="bg-panel border border-accent rounded px-3 py-1.5 text-xs flex items-center gap-2"
          data-testid={showClosureReadOnly ? 'geometry-readonly-banner' : 'geometry-computing-banner'}
        >
          {showClosureComputing && (
            <span
              className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin"
              aria-hidden="true"
              data-testid="geometry-computing-spinner"
            />
          )}
          {/* Closed padlock, exactly as the SpeleoDB badge above draws it: both
              notices tell the user the same thing (editing is off), so they carry
              the same glyph rather than one being text-only. Deliberately NOT on
              the computing branch below - the spinner already owns that slot, and
              a solve in progress is not itself the reason editing is off. */}
          {showClosureReadOnly && !showClosureComputing && (
            <>
              <LockIcon size={13} />
              <span className="text-accent font-medium">{t('map.geometry.adjustedBadge')}</span>
            </>
          )}
          {showClosureComputing && (
            <span className="text-accent font-medium" data-testid="geometry-computing">
              {t(
                showClosureReadOnly
                  ? 'map.geometry.computingReadOnly'
                  : 'map.geometry.computing'
              )}
            </span>
          )}
          {/* Leaving the computed view applies whether or not the solve is still
              running; outside Survey (Plan/Export force it) the notice is off and
              so is this. */}
          {showClosureReadOnly && <RawDataResumeButton />}
        </div>
      )}
    </div>
  );
}
