import { useTranslation } from 'react-i18next';
import { useUIStore, type AppMode } from '../../store/uiStore';

const MODES: readonly AppMode[] = ['survey', 'plan', 'export'];

/**
 * Top-middle workspace switcher (#38, Daniel's reframe). Selects the top-level mode
 * for an open project: Survey (the editable survey workspace), Plan (the gas planner
 * over a read-only closure map), or Export (read-only closure map + export stub).
 * Lives in the Toolbar's center slot — the active *tool* is already shown by the
 * highlighted toolbar button, so the center is free for the mode switch.
 */
export function ModeCarousel({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const appMode = useUIStore((s) => s.appMode);
  const setAppMode = useUIStore((s) => s.setAppMode);

  return (
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
            onClick={() => setAppMode(mode)}
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
  );
}
