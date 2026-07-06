import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore, type AppMode } from '../../store/uiStore';
import { selectIsPlanDirty, useGasPlanStore } from '../../store/gasPlanStore';

const MODES: readonly AppMode[] = ['survey', 'plan', 'export'];

/**
 * Top-middle workspace switcher (#38, the workspace-mode reframe). Selects the top-level mode
 * for an open project: Survey (the editable survey workspace), Plan (the gas planner
 * over a read-only closure map), or Export (read-only closure map + export stub).
 * Lives in the Toolbar's center slot — the active *tool* is already shown by the
 * highlighted toolbar button, so the center is free for the mode switch.
 *
 * Leaving Plan mode resets the gas store (`setAppMode`), so with unsaved dive-plan
 * edits (#244) we confirm the discard first via an inline popover rather than a
 * registered dialog.
 */
export function ModeCarousel({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const appMode = useUIStore((s) => s.appMode);
  const setAppMode = useUIStore((s) => s.setAppMode);
  const [pendingMode, setPendingMode] = useState<AppMode | null>(null);

  const requestMode = (mode: AppMode) => {
    if (mode === appMode) return;
    // Checked at click time (no subscription) so typing in the panel doesn't re-render this.
    if (appMode === 'plan' && selectIsPlanDirty(useGasPlanStore.getState())) {
      setPendingMode(mode);
      return;
    }
    setAppMode(mode);
  };

  return (
    <div className="relative">
      <div
        className={`inline-flex rounded border border-border overflow-hidden ${
          disabled ? 'opacity-45 grayscale' : ''
        }`}
        role="group"
        aria-label={t('modeCarousel.aria')}
        data-testid="mode-carousel"
      >
        {MODES.map((mode, i) => {
          const active = appMode === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={active}
              // Disabled while a survey placement is in progress: switching to the
              // read-only Plan/Export map would otherwise leave that mutation live.
              disabled={disabled}
              data-testid={`mode-${mode}`}
              onClick={() => requestMode(mode)}
              className={`px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                i > 0 ? 'border-l border-border' : ''
              } ${
                active ? 'bg-accent text-accent-on' : 'text-text-secondary hover:text-text hover:bg-panel'
              }`}
            >
              {t(`modeCarousel.${mode}`)}
            </button>
          );
        })}
      </div>

      {pendingMode && (
        <div
          className="absolute left-1/2 top-full z-50 mt-1 w-64 -translate-x-1/2 rounded border border-warning-30 bg-panel p-2 text-xs text-warning shadow-lg"
          role="alertdialog"
          data-testid="mode-switch-discard-confirm"
        >
          <p className="mb-2">{t('modeCarousel.discardPlanPrompt')}</p>
          <div className="flex justify-end gap-1">
            <button
              type="button"
              data-testid="mode-switch-discard-yes"
              className="rounded border border-warning-30 px-2 py-0.5 hover:bg-warning-10"
              onClick={() => {
                const mode = pendingMode;
                setPendingMode(null);
                setAppMode(mode);
              }}
            >
              {t('divePlanBar.discard')}
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-0.5 text-text-secondary hover:bg-panel"
              onClick={() => setPendingMode(null)}
            >
              {t('common.actions.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
