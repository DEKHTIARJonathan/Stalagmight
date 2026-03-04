import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ActiveOnboardingStep } from '../../hooks/useOnboarding';
import type { OnboardingPlacement } from '../../onboarding/flows';

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

const SPOTLIGHT_PADDING = 10;
const SPOTLIGHT_RADIUS = 14;
const TOOLTIP_GAP = 18;
const TOOLTIP_MAX_WIDTH = 360;
const VIEWPORT_MARGIN = 16;
const TOOLTIP_ESTIMATED_HEIGHT = 250;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

function toSpotlightRect(rect: DOMRect): SpotlightRect {
  return {
    top: Math.max(0, rect.top - SPOTLIGHT_PADDING),
    left: Math.max(0, rect.left - SPOTLIGHT_PADDING),
    width: rect.width + SPOTLIGHT_PADDING * 2,
    height: rect.height + SPOTLIGHT_PADDING * 2,
  };
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
  viewportVersion: number
): CSSProperties {
  void viewportVersion;

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 720;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - TOOLTIP_MAX_WIDTH - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - TOOLTIP_ESTIMATED_HEIGHT - VIEWPORT_MARGIN);

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

  let left = centerX - TOOLTIP_MAX_WIDTH / 2;
  let top = targetRect.top + targetRect.height + TOOLTIP_GAP;

  if (placement === 'top') {
    top = targetRect.top - TOOLTIP_ESTIMATED_HEIGHT - TOOLTIP_GAP;
  } else if (placement === 'left') {
    left = targetRect.left - TOOLTIP_MAX_WIDTH - TOOLTIP_GAP;
    top = centerY - TOOLTIP_ESTIMATED_HEIGHT / 2;
  } else if (placement === 'right') {
    left = targetRect.left + targetRect.width + TOOLTIP_GAP;
    top = centerY - TOOLTIP_ESTIMATED_HEIGHT / 2;
  }

  if (placement === 'bottom' && top > maxTop) {
    top = targetRect.top - TOOLTIP_ESTIMATED_HEIGHT - TOOLTIP_GAP;
  }
  if (placement === 'top' && top < VIEWPORT_MARGIN) {
    top = targetRect.top + targetRect.height + TOOLTIP_GAP;
  }
  if (placement === 'left' && left < VIEWPORT_MARGIN) {
    left = targetRect.left + targetRect.width + TOOLTIP_GAP;
  }
  if (placement === 'right' && left > maxLeft) {
    left = targetRect.left - TOOLTIP_MAX_WIDTH - TOOLTIP_GAP;
  }

  return {
    width: `min(${TOOLTIP_MAX_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`,
    left: clamp(left, VIEWPORT_MARGIN, maxLeft),
    top: clamp(top, VIEWPORT_MARGIN, maxTop),
  };
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
  const [targetRects, setTargetRects] = useState<SpotlightRect[]>([]);
  const [viewportVersion, setViewportVersion] = useState(0);

  const isLastStep = stepIndex >= stepCount - 1;
  const interaction = step.interaction ?? 'locked';
  const placement = step.placement ?? 'bottom';
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

        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          continue;
        }

        nextRects.push(toSpotlightRect(rect));
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

  const tooltipStyle = useMemo(
    () => calculateTooltipStyle(combinedTargetRect, placement, viewportVersion),
    [combinedTargetRect, placement, viewportVersion]
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
        className="fixed pointer-events-auto rounded-xl border border-border bg-panel px-4 py-4 shadow-2xl focus:outline-none"
        style={tooltipStyle}
      >
        <div className="mb-1 text-xs uppercase tracking-wide text-text-secondary">
          {t(step.flowTitleKey)}
        </div>
        <div className="mb-2 text-xs text-text-secondary">
          {t('onboarding.progress', { current: stepIndex + 1, total: stepCount })}
        </div>
        <h2 className="mb-2 text-lg font-semibold text-text-primary">{t(step.titleKey)}</h2>
        <p className="mb-4 text-sm leading-relaxed text-text-secondary">
          {t(step.descriptionKey)}
        </p>
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
