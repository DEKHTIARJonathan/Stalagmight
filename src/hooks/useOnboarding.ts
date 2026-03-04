import { useCallback, useEffect, useMemo, useState } from 'react';
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
}

export function useOnboarding(context: OnboardingContext): UseOnboardingResult {
  const [suppressedFlowIds, setSuppressedFlowIds] = useState<string[]>([]);
  const [activeFlowId, setActiveFlowId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);

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

  const suppressFlow = useCallback((flowId: string) => {
    setSuppressedFlowIds((current) => {
      if (current.includes(flowId)) {
        return current;
      }
      return [...current, flowId];
    });
  }, []);

  const closeActiveFlow = useCallback(
    (suppressActiveFlow: boolean) => {
      if (activeFlowId && suppressActiveFlow) {
        suppressFlow(activeFlowId);
      }
      setActiveFlowId(null);
      setStepIndex(0);
    },
    [activeFlowId, suppressFlow]
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
    setSuppressedFlowIds([]);
  }, []);

  const startFlow = useCallback((flowId: string) => {
    const flow = ONBOARDING_FLOWS.find((candidate) => candidate.id === flowId);
    if (!flow) {
      return;
    }
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
      closeActiveFlow(false);
    }
  }, [activeFlow, closeActiveFlow, context]);

  useEffect(() => {
    setSuppressedFlowIds((current) => {
      const filtered = current.filter((flowId) => {
        const flow = ONBOARDING_FLOWS.find((candidate) => candidate.id === flowId);
        return flow ? flow.shouldStart(context) : false;
      });
      const unchanged =
        filtered.length === current.length &&
        filtered.every((flowId, idx) => flowId === current[idx]);
      return unchanged ? current : filtered;
    });
  }, [context]);

  useEffect(() => {
    if (activeFlowId !== null) {
      return;
    }
    const nextFlow = ONBOARDING_FLOWS.find((flow) => {
      if (suppressedFlowIds.includes(flow.id)) {
        return false;
      }
      return flow.shouldStart(context);
    });
    if (!nextFlow) {
      return;
    }
    setActiveFlowId(nextFlow.id);
    setStepIndex(0);
  }, [
    activeFlowId,
    context,
    suppressedFlowIds,
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
  };
}
