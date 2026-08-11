import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOnboarding } from '../useOnboarding';
import { ORIENTATION_FLOW_ID } from '../../onboarding/flows';
import type { OnboardingContext } from '../../onboarding/flows';

// `.tsx` so this runs in the jsdom tier (renderHook needs a DOM).

const baseContext: OnboardingContext = {
  view: 'single',
  hasProject: true,
  activeDialog: null,
  dmpImportWizardPhase: null,
  placementModeActive: false,
  loadingProject: false,
  splashVisible: false,
  configLoaded: true,
  orientationConsumed: false,
};

// A context only the `dmp-selection` contextual flow accepts (mirrors
// flows.gating.test.ts's own construction of it), used to exercise "a
// DIFFERENT flow starts at 0" without depending on ONBOARDING_FLOWS order.
const dmpSelectionContext: OnboardingContext = {
  ...baseContext,
  hasProject: false,
  activeDialog: 'dmp-selection',
};

// A stable reference: an inline `[]` literal in the renderHook callback would
// be a new array every render, defeating the completedFlowIds-sync effect
// the same way the unmemoized onboarding context defeated App.tsx's memo
// before it was added (#368).
const noCompletedFlows: string[] = [];

describe('useOnboarding: workspace-basics start/close thrash (#368)', () => {
  it('resumes the SAME flow at its remembered step after a sustained shouldStart dip, not step 0', () => {
    const { result, rerender } = renderHook(
      (context: OnboardingContext) =>
        useOnboarding(context, { enabled: true, completedFlowIds: noCompletedFlows }),
      { initialProps: baseContext }
    );

    // The auto-start effect fires on mount.
    expect(result.current.activeFlowId).toBe(ORIENTATION_FLOW_ID);
    expect(result.current.stepIndex).toBe(0);

    act(() => {
      result.current.next();
      result.current.next();
    });
    expect(result.current.stepIndex).toBe(2);

    // Simulate the #368 scenario directly, without any fake-timer trickery:
    // `loadingProject` holds true for a real operation - long enough that no
    // bounded debounce could survive it, so the fix must not depend on
    // timing at all. The flow closes immediately.
    rerender({ ...baseContext, loadingProject: true });
    expect(result.current.activeFlowId).toBeNull();

    // Injection: seed `setStepIndex(0)` (the pre-fix line) instead of
    // `setStepIndex(rememberedStepRef.current.get(nextFlow.id) ?? 0)` in the
    // auto-start effect, and `stepIndex` below reads 0, failing this.
    rerender(baseContext);
    expect(result.current.activeFlowId).toBe(ORIENTATION_FLOW_ID);
    expect(result.current.stepIndex).toBe(2);
  });

  it('does not resume a flow completed by reaching its last step: completedFlowIds gates the restart', () => {
    const { result, rerender } = renderHook(
      (context: OnboardingContext) =>
        useOnboarding(context, { enabled: true, completedFlowIds: noCompletedFlows }),
      { initialProps: baseContext }
    );
    const stepCountAtStart = result.current.stepCount;

    // Each `next()` must be its own `act()`: `next()` closes over the
    // `stepIndex` from the render it was read in, so batching every call
    // into one `act()` would have them all read the stale, pre-loop
    // `stepIndex` and never detect the last step.
    for (let i = 0; i < stepCountAtStart; i += 1) {
      act(() => {
        result.current.next();
      });
    }
    // `next()` on the last step closes via `closeActiveFlow(true)`, which
    // calls `markFlowCompleted` - populating the SAME internal
    // `completedFlowIds` list the auto-start effect's
    // `ONBOARDING_FLOWS.find` filters against.
    expect(result.current.activeFlowId).toBeNull();

    // Re-render with the flow still eligible by every OTHER measure
    // (`baseContext` is unchanged). Injection: deleting the
    // `completedFlowIds.includes(flow.id)` filter from the auto-start
    // effect's `.find` would restart this flow, failing the assertion below.
    rerender(baseContext);
    expect(result.current.activeFlowId).toBeNull();
  });

  it('does not resume a skipped flow: skip() also marks it completed, gating the restart the same way', () => {
    const { result, rerender } = renderHook(
      (context: OnboardingContext) =>
        useOnboarding(context, { enabled: true, completedFlowIds: noCompletedFlows }),
      { initialProps: baseContext }
    );

    act(() => {
      result.current.next();
      result.current.next();
    });
    expect(result.current.stepIndex).toBe(2);

    act(() => {
      result.current.skip();
    });
    expect(result.current.activeFlowId).toBeNull();

    // `skip()` goes through the same `closeActiveFlow(true)` path as
    // reaching the last step - `completedFlowIds` is what blocks the
    // restart. (`skip()` also deletes the remembered step, defensively, but
    // that alone would not stop it from restarting at step 0; it is
    // `completedFlowIds` that keeps it closed at all.) Injection: same as
    // the completion test - drop the `completedFlowIds` filter from the
    // auto-start effect's `.find` and this flow restarts, failing the
    // assertion below.
    rerender(baseContext);
    expect(result.current.activeFlowId).toBeNull();
  });

  it('starts a DIFFERENT flow at step 0, never seeded by another flow\'s remembered step', () => {
    const { result, rerender } = renderHook(
      (context: OnboardingContext) =>
        useOnboarding(context, { enabled: true, completedFlowIds: noCompletedFlows }),
      { initialProps: baseContext }
    );
    expect(result.current.activeFlowId).toBe(ORIENTATION_FLOW_ID);

    act(() => {
      result.current.next();
      result.current.next();
    });
    expect(result.current.stepIndex).toBe(2);

    // Leave workspace-basics eligible (never completed, remembered step 2
    // still on file) and switch straight to a context only `dmp-selection`
    // accepts. Injection: if the auto-start effect indexed
    // `rememberedStepRef` by anything other than the id of the flow actually
    // being started (e.g. reused the previous `stepIndex` unconditionally
    // instead of `rememberedStepRef.current.get(nextFlow.id)`), this second
    // flow would open at step 2 instead of 0.
    rerender(dmpSelectionContext);
    expect(result.current.activeFlowId).toBe('dmp-selection');
    expect(result.current.stepIndex).toBe(0);
  });

  it('an explicit skip closes the flow immediately', () => {
    const { result } = renderHook(
      (context: OnboardingContext) =>
        useOnboarding(context, { enabled: true, completedFlowIds: noCompletedFlows }),
      { initialProps: baseContext }
    );
    expect(result.current.activeFlowId).toBe(ORIENTATION_FLOW_ID);

    act(() => {
      result.current.skip();
    });
    expect(result.current.activeFlowId).toBeNull();
  });

  it('a shouldStart dip closes the overlay-owning flow immediately, not after a delay', () => {
    // #368 review finding: every current step is `interaction: 'locked'`, so
    // an overlay left up past its own precondition keeps blocking clicks on
    // whatever now owns the screen (a freshly opened dialog, for instance).
    // Injection: reintroducing any close delay (a debounce/setTimeout) on
    // the re-check path would leave `activeFlowId` non-null immediately
    // after this synchronous rerender.
    const { result, rerender } = renderHook(
      (context: OnboardingContext) =>
        useOnboarding(context, { enabled: true, completedFlowIds: noCompletedFlows }),
      { initialProps: baseContext }
    );
    expect(result.current.activeFlowId).toBe(ORIENTATION_FLOW_ID);

    rerender({ ...baseContext, activeDialog: 'settings' });
    expect(result.current.activeFlowId).toBeNull();
  });

  it('does not resume after disable -> restart (config rewrite shape) -> re-enable: starts at 0', () => {
    // Mirrors Settings > General > toggle onboarding off, then Restart
    // onboarding (which rewrites enabled: true, completedFlowIds: [],
    // independent of the toggle) - a review-confirmed gap (#368): the
    // enabled-false effect used to remember the interrupted step via
    // `closeActiveFlow(false)`, and nothing forgot it again on re-enable.
    interface Props {
      context: OnboardingContext;
      enabled: boolean;
      completedFlowIds: string[];
    }
    const { result, rerender } = renderHook(
      (props: Props) => useOnboarding(props.context, props),
      { initialProps: { context: baseContext, enabled: true, completedFlowIds: noCompletedFlows } }
    );
    expect(result.current.activeFlowId).toBe(ORIENTATION_FLOW_ID);

    act(() => {
      result.current.next();
      result.current.next();
    });
    expect(result.current.stepIndex).toBe(2);

    // Toggle off mid-tour: the enabled-false effect closes and (pre-fix)
    // would remember step 2.
    rerender({ context: baseContext, enabled: false, completedFlowIds: noCompletedFlows });
    expect(result.current.activeFlowId).toBeNull();

    // Restart onboarding's config rewrite: enabled back to true,
    // completedFlowIds cleared (a fresh `[]` reference, as a real config
    // reload would produce - not the same `noCompletedFlows` instance).
    // Injection: removing `rememberedStepRef.current.clear()` from the
    // enabled-false effect makes `stepIndex` read 2 below instead of 0.
    rerender({ context: baseContext, enabled: true, completedFlowIds: [] });
    expect(result.current.activeFlowId).toBe(ORIENTATION_FLOW_ID);
    expect(result.current.stepIndex).toBe(0);
  });

  it('a mid-tour Settings-open interruption does not resume after clearRememberedProgress() fires (the Restart-click wiring), even though nothing else in the hook\'s inputs changed', () => {
    // #368 review finding: opening Settings mid-tour (activeDialog !=
    // null) closes and remembers the step via the ordinary shouldStart
    // re-check - same as any other interruption. Clicking Restart onboarding
    // stages a config rewrite that will not actually reach the store until
    // Settings Save, and even then can be a same-session no-op for every
    // field this hook reads (a first-time tour already burned
    // `orientationConsumed`'s underlying flag, and nothing has completed
    // yet, so `completedFlowIds` does not shrink). That is why Restart calls
    // `clearRememberedProgress()` directly (via useOnboardingRestart.ts),
    // not something this test can trigger by rerendering `context` alone.
    const { result, rerender } = renderHook(
      (context: OnboardingContext) =>
        useOnboarding(context, { enabled: true, completedFlowIds: noCompletedFlows }),
      { initialProps: baseContext }
    );
    expect(result.current.activeFlowId).toBe(ORIENTATION_FLOW_ID);

    act(() => {
      result.current.next();
      result.current.next();
    });
    expect(result.current.stepIndex).toBe(2);

    // Settings opens: the ordinary re-check closes and remembers step 2.
    rerender({ ...baseContext, activeDialog: 'settings' });
    expect(result.current.activeFlowId).toBeNull();

    // Restart is clicked (GeneralSettings calls this immediately, at click
    // time - see useOnboardingRestart.ts). Injection: if
    // `clearRememberedProgress` did not clear `rememberedStepRef`, this call
    // would be a no-op and the assertion below would still fail with 2.
    act(() => {
      result.current.clearRememberedProgress();
    });

    // Settings closes (context returns to baseContext, exactly as it was
    // before Settings opened - reproducing the "nothing else changed"
    // scenario the review confirmed).
    rerender(baseContext);
    expect(result.current.activeFlowId).toBe(ORIENTATION_FLOW_ID);
    expect(result.current.stepIndex).toBe(0);
  });
});
