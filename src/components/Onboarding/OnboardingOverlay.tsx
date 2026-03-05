import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ActiveOnboardingStep } from '../../hooks/useOnboarding';
import type { OnboardingIllustration, OnboardingPlacement } from '../../onboarding/flows';

interface OnboardingOverlayProps {
  step: ActiveOnboardingStep;
  stepIndex: number;
  stepCount: number;
  canGoBack: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface RectBounds {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

const SPOTLIGHT_PADDING = 10;
const SPOTLIGHT_RADIUS = 14;
const TOOLTIP_GAP = 18;
const TOOLTIP_MAX_WIDTH = 360;
const VIEWPORT_MARGIN = 16;
const TOOLTIP_ESTIMATED_HEIGHT = 250;
const STEP_SCROLL_TOP_PADDING = 10;
const STEP_SCROLL_MAX_ATTEMPTS = 12;
const STEP_SCROLL_RETRY_MS = 80;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

function boundsFromDomRect(rect: DOMRect): RectBounds {
  return {
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
  };
}

function isNonEmptyBounds(bounds: RectBounds): boolean {
  return bounds.right > bounds.left && bounds.bottom > bounds.top;
}

function intersectBounds(a: RectBounds, b: RectBounds): RectBounds | null {
  const next: RectBounds = {
    top: Math.max(a.top, b.top),
    left: Math.max(a.left, b.left),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return isNonEmptyBounds(next) ? next : null;
}

function toSpotlightRect(bounds: RectBounds): SpotlightRect {
  return {
    top: bounds.top,
    left: bounds.left,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
  };
}

function getElementClippingBounds(element: HTMLElement): RectBounds | null {
  if (typeof window === 'undefined') {
    return null;
  }

  let clippingBounds: RectBounds = {
    top: 0,
    left: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };

  let ancestor = element.parentElement;
  while (ancestor) {
    const style = window.getComputedStyle(ancestor);
    const clipsX = style.overflowX !== 'visible';
    const clipsY = style.overflowY !== 'visible';

    if (clipsX || clipsY) {
      const ancestorRect = ancestor.getBoundingClientRect();
      const ancestorBounds: RectBounds = {
        top: clipsY ? ancestorRect.top : Number.NEGATIVE_INFINITY,
        left: clipsX ? ancestorRect.left : Number.NEGATIVE_INFINITY,
        right: clipsX ? ancestorRect.right : Number.POSITIVE_INFINITY,
        bottom: clipsY ? ancestorRect.bottom : Number.POSITIVE_INFINITY,
      };
      const nextBounds = intersectBounds(clippingBounds, ancestorBounds);
      if (!nextBounds) {
        return null;
      }
      clippingBounds = nextBounds;
    }

    ancestor = ancestor.parentElement;
  }

  return clippingBounds;
}

function getVisibleSpotlightRect(element: HTMLElement): SpotlightRect | null {
  const elementBounds = boundsFromDomRect(element.getBoundingClientRect());
  if (!isNonEmptyBounds(elementBounds)) {
    return null;
  }

  const clippingBounds = getElementClippingBounds(element);
  if (!clippingBounds) {
    return null;
  }

  const visibleBounds = intersectBounds(elementBounds, clippingBounds);
  if (!visibleBounds) {
    return null;
  }

  const paddedBounds: RectBounds = {
    top: visibleBounds.top - SPOTLIGHT_PADDING,
    left: visibleBounds.left - SPOTLIGHT_PADDING,
    right: visibleBounds.right + SPOTLIGHT_PADDING,
    bottom: visibleBounds.bottom + SPOTLIGHT_PADDING,
  };

  const spotlightBounds = intersectBounds(paddedBounds, clippingBounds);
  return spotlightBounds ? toSpotlightRect(spotlightBounds) : null;
}

function combineSpotlightRects(rects: SpotlightRect[]): SpotlightRect | null {
  if (rects.length === 0) {
    return null;
  }
  const top = Math.min(...rects.map((rect) => rect.top));
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  return {
    top,
    left,
    width: right - left,
    height: bottom - top,
  };
}

function calculateTooltipStyle(
  targetRect: SpotlightRect | null,
  placement: OnboardingPlacement,
  viewportVersion: number,
  offsetX: number = 0,
  offsetY: number = 0,
  anchorY: 'auto' | 'top' | 'bottom' = 'auto',
  tooltipHeight: number = TOOLTIP_ESTIMATED_HEIGHT
): CSSProperties {
  void viewportVersion;

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 720;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - TOOLTIP_MAX_WIDTH - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - tooltipHeight - VIEWPORT_MARGIN);

  if (!targetRect || placement === 'center') {
    return {
      width: `min(${TOOLTIP_MAX_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`,
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
    };
  }

  const centerX = targetRect.left + targetRect.width / 2;
  const centerY = targetRect.top + targetRect.height / 2;
  const targetTop = targetRect.top;
  const targetBottom = targetRect.top + targetRect.height;

  let left = centerX - TOOLTIP_MAX_WIDTH / 2;
  let top = (anchorY === 'top' ? targetTop : targetBottom) + TOOLTIP_GAP;

  if (placement === 'top') {
    top = (anchorY === 'bottom' ? targetBottom : targetTop) - tooltipHeight - TOOLTIP_GAP;
  } else if (placement === 'left') {
    left = targetRect.left - TOOLTIP_MAX_WIDTH - TOOLTIP_GAP;
    top = centerY - tooltipHeight / 2;
  } else if (placement === 'right') {
    left = targetRect.left + targetRect.width + TOOLTIP_GAP;
    top = centerY - tooltipHeight / 2;
  }

  const allowAutoFlip = anchorY === 'auto';
  if (allowAutoFlip && placement === 'bottom' && top > maxTop) {
    top = targetRect.top - tooltipHeight - TOOLTIP_GAP;
  }
  if (allowAutoFlip && placement === 'top' && top < VIEWPORT_MARGIN) {
    top = targetRect.top + targetRect.height + TOOLTIP_GAP;
  }
  if (placement === 'left' && left < VIEWPORT_MARGIN) {
    left = targetRect.left + targetRect.width + TOOLTIP_GAP;
  }
  if (placement === 'right' && left > maxLeft) {
    left = targetRect.left - TOOLTIP_MAX_WIDTH - TOOLTIP_GAP;
  }

  left += offsetX;
  top += offsetY;

  return {
    width: `min(${TOOLTIP_MAX_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`,
    left: clamp(left, VIEWPORT_MARGIN, maxLeft),
    top: clamp(top, VIEWPORT_MARGIN, maxTop),
  };
}

function renderMouseIcon(className: string, highlight: 'left' | 'wheel'): JSX.Element {
  return (
    <svg viewBox="0 0 44 54" className={className} aria-hidden="true">
      <defs>
        <clipPath id="mouse-body-clip">
          <rect x="2.5" y="2.5" width="39" height="49" rx="18" />
        </clipPath>
      </defs>
      <rect x="2.5" y="2.5" width="39" height="49" rx="18" fill="#f8fafc" stroke="#111827" strokeWidth="2" />
      {highlight === 'left' ? (
        <path
          d="M21 21.5H3.5V3.5H21V21.5Z"
          fill="#ef4444"
          clipPath="url(#mouse-body-clip)"
        />
      ) : null}
      <line x1="22" y1="5.5" x2="22" y2="20.5" stroke="#9ca3af" strokeWidth="1.6" />
      <line x1="5.5" y1="22" x2="38.5" y2="22" stroke="#9ca3af" strokeWidth="1.4" />
      <rect
        x="19"
        y="8"
        width="6"
        height="10.5"
        rx="3"
        fill={highlight === 'wheel' ? '#ef4444' : '#9ca3af'}
        fillOpacity={highlight === 'wheel' ? 1 : 1}
      />
    </svg>
  );
}

function renderStepIllustration(
  illustration: OnboardingIllustration | undefined,
  t: (key: string) => string
): JSX.Element | null {
  if (illustration !== 'mouse-pan-zoom') {
    return null;
  }

  return (
    <div className="mb-2 grid grid-cols-1 gap-1" data-testid="onboarding-illustration-mouse-pan-zoom">
      <div className="rounded-md border border-border bg-background px-2 py-1.5">
        <div className="mb-0 text-xs font-semibold text-text-primary">
          {t('onboarding.illustrations.mouse.panTitle')}
        </div>
        <div className="-mt-0.5 grid grid-cols-[auto_auto_auto_auto_auto] items-center justify-center gap-x-2 gap-y-0 text-xs text-text-secondary">
          <span className="col-start-3 row-start-1 justify-self-center text-center text-[11px] leading-none">Left click</span>
          <span className="col-start-5 row-start-1 justify-self-center text-center text-[11px] leading-none">Middle click</span>
          <span className="col-start-1 row-start-2 inline-flex h-7 min-w-[2.7rem] items-center justify-center rounded-md border border-border bg-background-50 px-2 font-semibold text-text-primary">
            CTRL
          </span>
          <span className="col-start-2 row-start-2">+</span>
          {renderMouseIcon('col-start-3 row-start-2 justify-self-center h-7 w-6', 'left')}
          <span className="col-start-4 row-start-2 px-1 text-text-secondary">/</span>
          {renderMouseIcon('col-start-5 row-start-2 justify-self-center h-7 w-6', 'wheel')}
        </div>
      </div>
      <div className="rounded-md border border-border bg-background px-2 py-1.5">
        <div className="mb-0 text-xs font-semibold text-text-primary">
          {t('onboarding.illustrations.mouse.zoomTitle')}
        </div>
        <div className="-mt-0.5 grid grid-cols-[auto_auto_auto_auto_auto] items-end justify-center gap-x-2 gap-y-0 text-xs text-text-secondary">
          <span className="col-start-1 row-start-1 justify-self-center text-center text-[11px] leading-none">Scroll</span>
          {renderMouseIcon('col-start-1 row-start-2 justify-self-center h-7 w-6', 'wheel')}
          <svg viewBox="0 0 14 40" className="col-start-2 row-start-2 h-7 w-3" aria-hidden="true">
            <path d="M7 4v32" stroke="#d1d5db" strokeWidth="2" strokeLinecap="round" />
            <path d="M7 3L3 9h8z" fill="#d1d5db" />
            <path d="M7 37l-4-6h8z" fill="#d1d5db" />
          </svg>
          <span className="col-start-3 row-start-2 pb-2 px-1 text-text-secondary">/</span>
          <svg viewBox="0 0 220 200" className="col-start-4 row-start-2 h-14 w-12" aria-hidden="true">
            <defs>
              <clipPath id="touch-gesture-left-cutout" clipPathUnits="userSpaceOnUse">
                <path
                  clipRule="evenodd"
                  d="
                    M 0 0 H 220 V 200 H 0 Z
                    M 65 55
                    A 15 15 0 0 1 80 40
                    A 15 15 0 0 1 95 55
                    L 95 200
                    A 15 15 0 0 1 80 215
                    A 15 15 0 0 1 65 200
                    Z
                  "
                />
              </clipPath>
              <clipPath id="touch-gesture-right-cutout" clipPathUnits="userSpaceOnUse">
                <path
                  clipRule="evenodd"
                  d="
                    M 0 0 H 220 V 200 H 0 Z
                    M 84 45
                    A 15 15 0 0 1 99 30
                    A 15 15 0 0 1 114 45
                    L 114 200
                    A 15 15 0 0 1 99 215
                    A 15 15 0 0 1 84 200
                    Z
                  "
                />
              </clipPath>
            </defs>
            <g clipPath="url(#touch-gesture-left-cutout)">
              <g clipPath="url(#touch-gesture-right-cutout)">
                <circle cx="80" cy="55" r="24" fill="#f00" />
                <circle cx="99" cy="45" r="24" fill="#f00" />
              </g>
            </g>
            <path
              d="
                M 42 158
                Q 47 132 42 105
                Q 42 101 47 101
                H 46
                Q 62 101 62 124
                Q 64 142 64 159
                Z
              "
              fill="#fff"
              transform="rotate(-40 52 129)"
            />
            <rect x="42" y="158" width="40" height="41" fill="#fff" transform="rotate(-40 52 129)" />
            <rect x="52" y="138" width="20" height="20" fill="#fff" transform="rotate(-40 52 129)" />
            <rect x="85" y="135" width="58" height="63" fill="#fff" />
            <g fill="none" stroke="#fff" strokeWidth="20" strokeLinecap="round" strokeLinejoin="round">
              <line x1="80" y1="55" x2="80" y2="135" />
              <line x1="99" y1="45" x2="99" y2="145" />
              <line x1="117" y1="95" x2="117" y2="145" strokeWidth="20" />
              <line x1="136.5" y1="102" x2="136.5" y2="157" strokeWidth="20" />
            </g>
          </svg>
          <svg viewBox="0 0 14 40" className="col-start-5 row-start-2 h-7 w-3" aria-hidden="true">
            <path d="M7 4v32" stroke="#d1d5db" strokeWidth="2" strokeLinecap="round" />
            <path d="M7 3L3 9h8z" fill="#d1d5db" />
            <path d="M7 37l-4-6h8z" fill="#d1d5db" />
          </svg>
        </div>
      </div>
    </div>
  );
}

export default function OnboardingOverlay({
  step,
  stepIndex,
  stepCount,
  canGoBack,
  onBack,
  onNext,
  onSkip,
}: OnboardingOverlayProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const maskIdRef = useRef(`onboarding-mask-${Math.random().toString(36).slice(2)}`);
  const previousFlowIdRef = useRef(step.flowId);
  const previousStepRef = useRef({ flowId: step.flowId, stepIndex });
  const scrolledContainerSelectorsRef = useRef<Set<string>>(new Set());
  const [targetRects, setTargetRects] = useState<SpotlightRect[]>([]);
  const [viewportVersion, setViewportVersion] = useState(0);
  const [tooltipHeight, setTooltipHeight] = useState(TOOLTIP_ESTIMATED_HEIGHT);

  const isLastStep = stepIndex >= stepCount - 1;
  const interaction = step.interaction ?? 'locked';
  const placement = step.placement ?? 'bottom';
  const description = t(step.descriptionKey);
  const descriptionItemsRaw = t(`${step.descriptionKey}Items`, {
    returnObjects: true,
  }) as unknown;
  const descriptionItems = Array.isArray(descriptionItemsRaw)
    ? descriptionItemsRaw.filter((item): item is string => typeof item === 'string')
    : [];
  const illustration = renderStepIllustration(step.illustration, t);
  const targetSelectorList = useMemo(() => {
    if (step.targetSelectors && step.targetSelectors.length > 0) {
      return step.targetSelectors;
    }
    if (step.targetSelector) {
      return [step.targetSelector];
    }
    return [];
  }, [step.targetSelector, step.targetSelectors]);
  const selectorKey = targetSelectorList.join('|');

  const resetScrolledContainers = useCallback(() => {
    for (const selector of scrolledContainerSelectorsRef.current) {
      const container = document.querySelector(selector) as HTMLElement | null;
      if (!container) {
        continue;
      }
      container.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
    scrolledContainerSelectorsRef.current.clear();
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const updateRect = () => {
      if (targetSelectorList.length === 0) {
        setTargetRects([]);
        return;
      }

      const nextRects: SpotlightRect[] = [];
      for (const selector of targetSelectorList) {
        const element = document.querySelector(selector) as HTMLElement | null;
        if (!element) {
          continue;
        }

        const spotlightRect = getVisibleSpotlightRect(element);
        if (!spotlightRect) {
          continue;
        }

        nextRects.push(spotlightRect);
      }

      setTargetRects(nextRects);
    };

    updateRect();
    const intervalId = window.setInterval(updateRect, 200);

    const handleViewportChange = () => {
      setViewportVersion((current) => current + 1);
      updateRect();
    };

    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', updateRect, true);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [selectorKey, step.id, targetSelectorList]);

  useEffect(() => {
    cardRef.current?.focus();
  }, [step.id]);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) {
      return;
    }

    const updateHeight = () => {
      const nextHeight = Math.ceil(card.getBoundingClientRect().height);
      setTooltipHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
    };

    updateHeight();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(updateHeight);
    observer.observe(card);

    return () => {
      observer.disconnect();
    };
  }, [step.id, stepIndex]);

  useEffect(() => {
    const previousFlowId = previousFlowIdRef.current;
    if (previousFlowId !== step.flowId) {
      resetScrolledContainers();
    }
    previousFlowIdRef.current = step.flowId;
  }, [resetScrolledContainers, step.flowId]);

  useEffect(() => {
    const previousStep = previousStepRef.current;
    const movedBackWithinFlow = previousStep.flowId === step.flowId && stepIndex < previousStep.stepIndex;
    if (movedBackWithinFlow && (!step.scrollContainerSelector || !step.scrollTargetSelector)) {
      resetScrolledContainers();
    }
    previousStepRef.current = { flowId: step.flowId, stepIndex };
  }, [
    resetScrolledContainers,
    step.flowId,
    step.scrollContainerSelector,
    step.scrollTargetSelector,
    stepIndex,
  ]);

  useEffect(() => () => {
    resetScrolledContainers();
  }, [resetScrolledContainers]);

  useEffect(() => {
    if (!step.scrollContainerSelector || !step.scrollTargetSelector) {
      return;
    }
    const scrollContainerSelector = step.scrollContainerSelector;
    const scrollTargetSelector = step.scrollTargetSelector;
    const scrollAlignment = step.scrollAlignment ?? 'top';

    let timeoutId: number | null = null;
    let isCancelled = false;

    const scrollStepTargetToTop = (attempt: number) => {
      if (isCancelled) {
        return;
      }

      const container = document.querySelector(scrollContainerSelector) as HTMLElement | null;
      const target = document.querySelector(scrollTargetSelector) as HTMLElement | null;

      if (!container || !target) {
        if (attempt >= STEP_SCROLL_MAX_ATTEMPTS) {
          return;
        }
        timeoutId = window.setTimeout(
          () => scrollStepTargetToTop(attempt + 1),
          STEP_SCROLL_RETRY_MS
        );
        return;
      }

      scrolledContainerSelectorsRef.current.add(scrollContainerSelector);

      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetTopInContainer = container.scrollTop + (targetRect.top - containerRect.top);
      const targetBottomInContainer = targetTopInContainer + targetRect.height;
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      let nextScrollTop: number;

      if (scrollAlignment === 'nearest') {
        const visibleTop = container.scrollTop + STEP_SCROLL_TOP_PADDING;
        const visibleBottom =
          container.scrollTop + container.clientHeight - STEP_SCROLL_TOP_PADDING;

        if (targetTopInContainer < visibleTop) {
          nextScrollTop = targetTopInContainer - STEP_SCROLL_TOP_PADDING;
        } else if (targetBottomInContainer > visibleBottom) {
          nextScrollTop =
            targetBottomInContainer - container.clientHeight + STEP_SCROLL_TOP_PADDING;
        } else {
          nextScrollTop = container.scrollTop;
        }
      } else {
        nextScrollTop = targetTopInContainer - STEP_SCROLL_TOP_PADDING;
      }

      nextScrollTop = clamp(nextScrollTop, 0, maxScrollTop);
      container.scrollTo({ top: nextScrollTop, left: 0, behavior: 'auto' });
    };

    scrollStepTargetToTop(0);

    return () => {
      isCancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [step.id, step.scrollAlignment, step.scrollContainerSelector, step.scrollTargetSelector]);

  useEffect(() => {
    const isAllowedTarget = (node: Node | null): boolean => {
      if (!node) return false;
      if (cardRef.current?.contains(node)) return true;
      if (interaction === 'free') return true;
      if (interaction === 'target' && targetSelectorList.length > 0) {
        for (const selector of targetSelectorList) {
          const target = document.querySelector(selector);
          if (target?.contains(node)) {
            return true;
          }
        }
      }
      return false;
    };

    const handlePointer = (event: PointerEvent | MouseEvent) => {
      if (isAllowedTarget(event.target as Node | null)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    const handleWheel = (event: WheelEvent) => {
      if (isAllowedTarget(event.target as Node | null)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onSkip();
        return;
      }

      if (event.key === 'ArrowLeft' && canGoBack) {
        event.preventDefault();
        event.stopPropagation();
        onBack();
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        onNext();
      }
    };

    document.addEventListener('pointerdown', handlePointer, true);
    document.addEventListener('click', handlePointer, true);
    document.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    document.addEventListener('keydown', handleKeyboard, true);

    return () => {
      document.removeEventListener('pointerdown', handlePointer, true);
      document.removeEventListener('click', handlePointer, true);
      document.removeEventListener('wheel', handleWheel, true);
      document.removeEventListener('keydown', handleKeyboard, true);
    };
  }, [canGoBack, interaction, onBack, onNext, onSkip, targetSelectorList]);

  const combinedTargetRect = useMemo(() => combineSpotlightRects(targetRects), [targetRects]);
  const tooltipTargetRect = useMemo(() => {
    if (!step.tooltipTargetSelector) {
      return combinedTargetRect;
    }
    const tooltipTarget = document.querySelector(step.tooltipTargetSelector) as HTMLElement | null;
    if (!tooltipTarget) {
      return combinedTargetRect;
    }
    const rect = getVisibleSpotlightRect(tooltipTarget);
    return rect ?? combinedTargetRect;
  }, [combinedTargetRect, step.tooltipTargetSelector, viewportVersion]);

  const tooltipStyle = useMemo(
    () =>
      calculateTooltipStyle(
        tooltipTargetRect,
        placement,
        viewportVersion,
        step.tooltipOffsetX ?? 0,
        step.tooltipOffsetY ?? 0,
        step.tooltipAnchorY ?? 'auto',
        tooltipHeight
      ),
    [
      placement,
      step.tooltipAnchorY,
      step.tooltipOffsetX,
      step.tooltipOffsetY,
      tooltipHeight,
      tooltipTargetRect,
      viewportVersion,
    ]
  );

  const overlay = (
    <div className="fixed inset-0 z-[100000] pointer-events-none" data-testid="onboarding-overlay">
      {targetRects.length > 0 ? (
        <>
          <svg
            className="fixed inset-0 h-full w-full pointer-events-none"
            aria-hidden="true"
            preserveAspectRatio="none"
          >
            <defs>
              <mask id={maskIdRef.current}>
                <rect x="0" y="0" width="100%" height="100%" fill="white" />
                {targetRects.map((rect, idx) => (
                  <rect
                    key={`hole-${idx}`}
                    x={rect.left}
                    y={rect.top}
                    width={rect.width}
                    height={rect.height}
                    rx={SPOTLIGHT_RADIUS}
                    ry={SPOTLIGHT_RADIUS}
                    fill="black"
                  />
                ))}
              </mask>
            </defs>
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill="rgba(0, 0, 0, 0.66)"
              mask={`url(#${maskIdRef.current})`}
            />
          </svg>
          {targetRects.map((rect, idx) => (
            <div
              key={`outline-${idx}`}
              className="fixed pointer-events-none border-2 border-accent/90 shadow-[0_0_0_3px_rgba(56,189,248,0.18)] transition-all duration-200"
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                borderRadius: SPOTLIGHT_RADIUS,
              }}
            />
          ))}
        </>
      ) : (
        <div className="fixed inset-0 bg-black/70 pointer-events-none" />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={t(step.titleKey)}
        tabIndex={-1}
        className="fixed pointer-events-auto max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-border bg-panel px-4 py-4 shadow-[0_0_42px_14px_rgba(0,0,0,0.72)] focus:outline-none"
        style={tooltipStyle}
      >
        <div className="mb-1 text-xs uppercase tracking-wide text-text-secondary">
          {t(step.flowTitleKey)}
        </div>
        <div className="mb-2 text-xs text-text-secondary">
          {t('onboarding.progress', { current: stepIndex + 1, total: stepCount })}
        </div>
        <h2 className="mb-2 text-lg font-semibold text-text-primary">{t(step.titleKey)}</h2>
        <div className="mb-4">
          <p className="text-sm leading-relaxed text-text-secondary">{description}</p>
          {illustration}
          {descriptionItems.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-sm leading-relaxed text-text-secondary">
              {descriptionItems.map((item, index) => (
                <li key={`${step.id}-desc-item-${index}`}>{item}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <button
            className="rounded-md px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-background-50 hover:text-text-primary"
            onClick={onSkip}
            type="button"
          >
            {t('onboarding.actions.skip')}
          </button>
          <div className="flex items-center gap-2">
            {canGoBack && (
              <button
                className="rounded-md border border-border px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-background-50"
                onClick={onBack}
                type="button"
              >
                {t('common.actions.back')}
              </button>
            )}
            <button
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
              onClick={onNext}
              type="button"
            >
              {isLastStep ? t('common.actions.done') : t('common.actions.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
