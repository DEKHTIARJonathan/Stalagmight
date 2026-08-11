import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ONBOARDING_FLOWS,
  type OnboardingContext,
  type OnboardingStepDefinition,
} from '../onboarding/flows';

export interface ActiveOnboardingStep extends OnboardingStepDefinition {
  flowId: string;
  flowTitleKey: string;
}

interface UseOnboardingResult {
  activeFlowId: string | null;
  activeStep: ActiveOnboardingStep | null;
  stepIndex: number;
  stepCount: number;
  canGoBack: boolean;
  next: () => void;
  back: () => void;
  skip: () => void;
  resetProgress: () => void;
  startFlow: (flowId: string) => void;
  /**
   * Forgets every remembered interrupted-flow step (#368) - and ONLY that:
   * no config write, no touch to `completedFlowIds` or the active flow. See
   * `useOnboardingRestart.ts` for why Settings > General > Restart onboarding
   * needs this distinct from `resetProgress` (which does write config, live,
   * outside Settings' staged Save/Cancel).
   */
  clearRememberedProgress: () => void;
}

interface UseOnboardingOptions {
  enabled: boolean;
  completedFlowIds: string[];
  onCompletedFlowIdsChange?: (flowIds: string[]) => void;
}

function normalizeFlowIds(flowIds: string[]): string[] {
  const normalized: string[] = [];
  for (const flowId of flowIds) {
    const trimmed = flowId.trim();
    if (!trimmed) {
      continue;
    }
    if (!normalized.includes(trimmed)) {
      normalized.push(trimmed);
    }
  }
  return normalized;
}

function sameFlowIdList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((id, idx) => id === b[idx]);
}

export function useOnboarding(context: OnboardingContext, options: UseOnboardingOptions): UseOnboardingResult {
  const { enabled, completedFlowIds: completedFlowIdsProp, onCompletedFlowIdsChange } = options;
  const [completedFlowIds, setCompletedFlowIds] = useState<string[]>(
    normalizeFlowIds(completedFlowIdsProp)
  );
  const [activeFlowId, setActiveFlowId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  /**
   * Session-only memory of the step a flow was on when it was torn down by
   * the `shouldStart` re-check (never by an explicit skip/complete - see
   * `closeActiveFlow` below). `shouldStart`'s inputs can legitimately go
   * false for seconds during a real operation (a project load, a dialog) -
   * long enough that no bounded debounce can span it - so instead of
   * delaying the close, the close is immediate and invisible: the SAME flow
   * resumes from here instead of step 0 (#368). Not React state on purpose -
   * it must not itself trigger a render, and it is read once per restart.
   */
  const rememberedStepRef = useRef<Map<string, number>>(new Map());
  /**
   * The previous prop-derived `completedFlowIds`, used ONLY to detect a
   * config-level progress reset (below) - never the internal `completedFlowIds`
   * state, which grows ahead of this prop between a completion and its
   * (fire-and-forget) config persist landing; comparing against that instead
   * would misfire on every ordinary completion.
   */
  const previousCompletedFlowIdsPropRef = useRef<string[]>(normalizeFlowIds(completedFlowIdsProp));
  const previousOrientationConsumedRef = useRef(context.orientationConsumed);

  const activeFlow = useMemo(
    () => ONBOARDING_FLOWS.find((flow) => flow.id === activeFlowId) ?? null,
    [activeFlowId]
  );

  const stepCount = activeFlow?.steps.length ?? 0;

  const activeStep = useMemo<ActiveOnboardingStep | null>(() => {
    if (!activeFlow) {
      return null;
    }
    const step = activeFlow.steps[stepIndex];
    if (!step) {
      return null;
    }
    return {
      ...step,
      flowId: activeFlow.id,
      flowTitleKey: activeFlow.titleKey,
    };
  }, [activeFlow, stepIndex]);

  useEffect(() => {
    const normalized = normalizeFlowIds(completedFlowIdsProp);
    const previous = previousCompletedFlowIdsPropRef.current;
    if (normalized.length < previous.length) {
      // A shorter list than the config held a moment ago is an explicit
      // progress reset (#368), not ordinary completion: the only writers of
      // `onboarding_completed_flows` are `markFlowCompleted` (App.tsx's
      // `persistCompletedOnboardingFlows`, which only ever accumulates) and
      // Settings > General > Restart onboarding (which writes `[]`). Nothing
      // else in the codebase touches this field, so a shrink here can only
      // be that Restart - config just told every flow to start over, not
      // merely one interrupted flow to resume.
      rememberedStepRef.current.clear();
    }
    previousCompletedFlowIdsPropRef.current = normalized;
    setCompletedFlowIds((current) => (sameFlowIdList(current, normalized) ? current : normalized));
  }, [completedFlowIdsProp]);

  useEffect(() => {
    const previousOrientationConsumed = previousOrientationConsumedRef.current;
    previousOrientationConsumedRef.current = context.orientationConsumed;
    if (previousOrientationConsumed && !context.orientationConsumed) {
      // `orientationConsumed` only ever burns true (App.tsx's burn effect,
      // once the tour is actually on screen); the only write back to false
      // is Restart onboarding's `onboarding_first_launch_done: false`. That
      // covers the Restart shape the `completedFlowIds`-shrink check above
      // cannot: if nothing has completed yet (workspace-basics interrupted
      // mid-run, nothing else touched), `onboarding_completed_flows` is
      // already `[]` and Restart's write to it is a no-op length-wise, but
      // this flag still flips - the tour DID already burn it by the time it
      // is on screen to interrupt.
      rememberedStepRef.current.clear();
    }
  }, [context.orientationConsumed]);

  const markFlowCompleted = useCallback(
    (flowId: string) => {
      setCompletedFlowIds((current) => {
        if (current.includes(flowId)) {
          return current;
        }
        const next = [...current, flowId];
        onCompletedFlowIdsChange?.(next);
        return next;
      });
    },
    [onCompletedFlowIdsChange]
  );

  const closeActiveFlow = useCallback(
    (suppressActiveFlow: boolean) => {
      if (activeFlowId) {
        if (suppressActiveFlow) {
          // A completion or an explicit skip: never resume this. Drop any
          // memory of an earlier interrupted run so a later re-eligible
          // context can't resurrect a step past the one the user dismissed.
          markFlowCompleted(activeFlowId);
          rememberedStepRef.current.delete(activeFlowId);
        } else {
          // Torn down by the shouldStart re-check, not by the user (#368):
          // remember where it was so the auto-start effect resumes here
          // instead of step 0 once the flow is eligible again.
          rememberedStepRef.current.set(activeFlowId, stepIndex);
        }
      }
      setActiveFlowId(null);
      setStepIndex(0);
    },
    [activeFlowId, markFlowCompleted, stepIndex]
  );

  const next = useCallback(() => {
    if (!activeFlow) {
      return;
    }
    const isLastStep = stepIndex >= activeFlow.steps.length - 1;
    if (isLastStep) {
      closeActiveFlow(true);
      return;
    }
    setStepIndex((current) => current + 1);
  }, [activeFlow, closeActiveFlow, stepIndex]);

  const back = useCallback(() => {
    setStepIndex((current) => Math.max(0, current - 1));
  }, []);

  const skip = useCallback(() => {
    closeActiveFlow(true);
  }, [closeActiveFlow]);

  const resetProgress = useCallback(() => {
    setCompletedFlowIds([]);
    onCompletedFlowIdsChange?.([]);
    rememberedStepRef.current.clear();
    setActiveFlowId(null);
    setStepIndex(0);
  }, [onCompletedFlowIdsChange]);

  const clearRememberedProgress = useCallback(() => {
    rememberedStepRef.current.clear();
  }, []);

  const startFlow = useCallback((flowId: string) => {
    const flow = ONBOARDING_FLOWS.find((candidate) => candidate.id === flowId);
    if (!flow) {
      return;
    }
    // An explicit start (e.g. "Restart onboarding") always begins at step 0,
    // never resuming a stale interrupted run.
    rememberedStepRef.current.delete(flowId);
    setActiveFlowId(flowId);
    setStepIndex(0);
  }, []);

  useEffect(() => {
    if (!activeFlow || activeFlow.steps.length > 0) {
      return;
    }
    closeActiveFlow(true);
  }, [activeFlow, closeActiveFlow]);

  useEffect(() => {
    if (!activeFlow) {
      return;
    }
    if (!activeFlow.shouldStart(context)) {
      // Close immediately - the interrupting condition (a project load, a
      // dialog) can legitimately hold for seconds, far past anything a
      // bounded debounce could span, and every current step is
      // `interaction: 'locked'`: leaving the overlay up past its own
      // precondition would keep blocking clicks on whatever now owns the
      // screen. `closeActiveFlow(false)` remembers `stepIndex` (#368) so the
      // auto-start effect below resumes here instead of restarting at 0.
      closeActiveFlow(false);
    }
  }, [activeFlow, closeActiveFlow, context]);

  useEffect(() => {
    if (enabled) {
      return;
    }
    if (activeFlowId) {
      closeActiveFlow(false);
      // Toggling onboarding off is an explicit opt-out (#368), not a
      // transient interruption `closeActiveFlow(false)` should let the flow
      // resume from: forget the step it just remembered, same as an
      // explicit skip/completion.
      rememberedStepRef.current.clear();
    }
  }, [enabled, activeFlowId, closeActiveFlow]);

  useEffect(() => {
    if (!enabled || activeFlowId !== null) {
      return;
    }
    const nextFlow = ONBOARDING_FLOWS.find((flow) => {
      if (completedFlowIds.includes(flow.id)) {
        return false;
      }
      return flow.shouldStart(context);
    });
    if (!nextFlow) {
      return;
    }
    setActiveFlowId(nextFlow.id);
    // Resume where a `shouldStart` re-check interrupted this same flow
    // (#368), rather than restarting at step 0. `rememberedStepRef` holds
    // nothing for a flow that has never run, or that was completed/skipped
    // (cleared in `closeActiveFlow`), so both of those still start at 0.
    setStepIndex(rememberedStepRef.current.get(nextFlow.id) ?? 0);
  }, [
    enabled,
    activeFlowId,
    context,
    completedFlowIds,
  ]);

  return {
    activeFlowId,
    activeStep,
    stepIndex,
    stepCount,
    canGoBack: stepIndex > 0,
    next,
    back,
    skip,
    resetProgress,
    startFlow,
    clearRememberedProgress,
  };
}
