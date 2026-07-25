import { create } from 'zustand';

/**
 * The active onboarding step, published by OnboardingOverlay into a tiny store.
 * Components outside the overlay's React tree (DisplayMenu, SingleSystemView)
 * read it without threading the controller through.
 */
export interface OnboardingStep {
  flowId: string | null;
  stepId: string | null;
}

const EMPTY: OnboardingStep = { flowId: null, stepId: null };

interface OnboardingStepState {
  /** Replaced (new identity) only when a field actually changes - see below. */
  step: OnboardingStep;
}

const useOnboardingStepStore = create<OnboardingStepState>(() => ({ step: EMPTY }));

/**
 * Publish the active onboarding step. OnboardingOverlay calls this on mount /
 * step change and resets it to empty on unmount. The overlay is the SOLE writer,
 * so it pushes the step directly into this store instead of every consumer
 * running its own body-wide MutationObserver - the previous design fired on
 * EVERY DOM mutation app-wide (react-virtual row churn during table scroll, map
 * tooltips), even though onboarding is inactive in nearly all sessions.
 *
 * The `step` object identity is preserved when neither field changes (and reused
 * across renders), so effects keyed on the result don't re-run on unrelated
 * store updates.
 */
export function publishOnboardingStep(flowId: string | null, stepId: string | null): void {
  const prev = useOnboardingStepStore.getState().step;
  if (prev.flowId === flowId && prev.stepId === stepId) return;
  useOnboardingStepStore.setState({
    step: flowId === null && stepId === null ? EMPTY : { flowId, stepId },
  });
}

/** Subscribe to the active onboarding step. */
export function useOnboardingStep(): OnboardingStep {
  return useOnboardingStepStore((s) => s.step);
}
