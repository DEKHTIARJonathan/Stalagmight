import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface HelpTooltipProps {
  text: string;
  icon?: ReactNode;
  ariaLabel?: string;
  className?: string;
  iconClassName?: string;
  tooltipClassName?: string;
  iconTestId?: string;
  tooltipTestId?: string;
}

/**
 * Small themed tooltip trigger used for inline "?" help affordances.
 * Shows on hover or keyboard focus, and Escape hides it while focused.
 * Clicking pins/unpins the tooltip independently of hover, so clicking while
 * already hovered never hides it (issue #532).
 */
export function HelpTooltip({
  text,
  icon = '?',
  ariaLabel,
  className = '',
  iconClassName = '',
  tooltipClassName = '',
  iconTestId,
  tooltipTestId,
}: HelpTooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const isVisible = isHovered || isFocused || isPinned;
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    transform: 'translate(-50%, -100%)',
  });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const triggerRect = trigger.getBoundingClientRect();
    const tooltipEl = tooltipRef.current;
    const margin = 8;

    let left = triggerRect.left + triggerRect.width / 2;
    let top = triggerRect.top - 10;
    let transform = 'translate(-50%, -100%)';

    if (tooltipEl) {
      const tooltipRect = tooltipEl.getBoundingClientRect();
      const halfWidth = tooltipRect.width / 2;

      if (left - halfWidth < margin) {
        left = margin + halfWidth;
      } else if (left + halfWidth > window.innerWidth - margin) {
        left = window.innerWidth - margin - halfWidth;
      }

      // If there isn't enough room above, place below the icon.
      if (top - tooltipRect.height < margin) {
        top = triggerRect.bottom + 10;
        transform = 'translate(-50%, 0)';
      }
    }

    setPosition({ left, top, transform });
  }, []);

  useLayoutEffect(() => {
    if (!isVisible) return;

    const rafId = requestAnimationFrame(updatePosition);
    const reposition = () => updatePosition();

    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [isVisible, updatePosition]);

  const hide = useCallback(() => {
    setIsHovered(false);
    setIsFocused(false);
    setIsPinned(false);
  }, []);

  const tooltip =
    isVisible && typeof document !== 'undefined'
      ? createPortal(
          <span
            ref={tooltipRef}
            id={tooltipId}
            className={`pointer-events-none fixed z-[10000] max-w-72 rounded border border-border bg-panel-90 px-3 py-2 text-sm leading-snug text-text-primary shadow-lg whitespace-pre-line ${tooltipClassName}`}
            style={{
              left: `${position.left}px`,
              top: `${position.top}px`,
              transform: position.transform,
            }}
            role="tooltip"
            data-testid={tooltipTestId}
          >
            {text}
          </span>,
          document.body
        )
      : null;

  return (
    <span className={`inline-flex items-center ${className}`}>
      <span
        ref={triggerRef}
        className={`inline-flex items-center justify-center w-4 h-4 rounded-full border border-border text-[10px] font-bold text-text-secondary cursor-help ${iconClassName}`}
        aria-label={ariaLabel ?? text}
        aria-describedby={isVisible ? tooltipId : undefined}
        role="button"
        tabIndex={0}
        data-testid={iconTestId}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onClick={() => {
          // Pin/unpin independent of hover: clicking while already visible
          // from hover must not hide it (issue #532).
          setIsPinned((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && isFocused) {
            hide();
            triggerRef.current?.blur();
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsPinned((v) => !v);
          }
        }}
      >
        {icon}
      </span>
      {tooltip}
    </span>
  );
}
