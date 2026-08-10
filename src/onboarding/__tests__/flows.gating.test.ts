import { describe, expect, it } from 'vitest';
import { ONBOARDING_FLOWS, ORIENTATION_FLOW_ID, type OnboardingContext } from '../flows';

const baseContext: OnboardingContext = {
  view: 'single',
  hasProject: true,
  hasRecentProjects: false,
  configRecentProjectsCount: 0,
  activeDialog: null,
  dmpImportWizardPhase: null,
  placementModeActive: false,
  isDmpImportContext: false,
  loadingProject: false,
  splashVisible: false,
  configLoaded: true,
  orientationConsumed: false,
};

const flow = (id: string) => {
  const found = ONBOARDING_FLOWS.find((f) => f.id === id);
  if (!found) throw new Error(`no flow ${id}`);
  return found;
};

describe('onboarding flow gating', () => {
  it('does not start a dialog-anchored flow while placement mode is active', () => {
    // Defensive guard (#331): a dialog flow must never anchor to a wizard
    // control while the map is in placement mode, because that control is not
    // on screen. See the comment on canShowDialogOnboarding.
    const inWizard = { ...baseContext, activeDialog: 'dmp-selection' };
    expect(flow('dmp-selection').shouldStart(inWizard)).toBe(true);
    expect(
      flow('dmp-selection').shouldStart({ ...inWizard, placementModeActive: true })
    ).toBe(false);
  });

  it('starts the workspace flow only with an open project in single view', () => {
    // This is why the first-launch flag must not be burned at config load: on a
    // genuine first launch there is no project, so nothing can start yet.
    expect(flow(ORIENTATION_FLOW_ID).shouldStart(baseContext)).toBe(true);
    expect(flow(ORIENTATION_FLOW_ID).shouldStart({ ...baseContext, hasProject: false })).toBe(false);
    expect(flow(ORIENTATION_FLOW_ID).shouldStart({ ...baseContext, view: 'global' })).toBe(false);
  });

  it('suppresses only the orientation tour once consumed, never the contextual flows', () => {
    // The whole point of scoping (#331): the one-shot rule governs the tour.
    // A DMP import may first happen months later and must still be guided.
    const consumed = { ...baseContext, orientationConsumed: true };
    expect(flow(ORIENTATION_FLOW_ID).shouldStart(consumed)).toBe(false);

    for (const id of ['dmp-selection', 'zero-datum-selection', 'zero-datum-config'] as const) {
      expect(flow(id).shouldStart({ ...consumed, activeDialog: id })).toBe(true);
    }
    expect(
      flow('dmp-suggested-connection').shouldStart({
        ...consumed,
        activeDialog: 'dmp-import-new',
        dmpImportWizardPhase: 'suggesting',
      })
    ).toBe(true);
    expect(
      flow('placement-mode-map').shouldStart({ ...consumed, placementModeActive: true })
    ).toBe(true);
  });

  it('keeps the Display-menu steps adjacent so the menu is not closed between them', () => {
    // DisplayMenu auto-opens for exactly these two step ids; a step between them
    // would close and re-open the menu mid-tour.
    const ids = flow('workspace-basics').steps.map((s) => s.id);
    expect(Math.abs(ids.indexOf('display-options') - ids.indexOf('geometry'))).toBe(1);
  });

  it('never leaves a step pointing at an illustration with no renderer', () => {
    const allowed = new Set(['tools-overview', 'map-with-pan-zoom', 'mouse-pan-zoom', 'map-controls']);
    for (const f of ONBOARDING_FLOWS) {
      for (const s of f.steps) {
        if (s.illustration) expect(allowed.has(s.illustration)).toBe(true);
      }
    }
  });
});
