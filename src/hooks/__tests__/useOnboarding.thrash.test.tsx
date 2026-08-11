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
});
