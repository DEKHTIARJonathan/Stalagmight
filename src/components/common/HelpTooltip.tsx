import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

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
 * Shows on hover or keyboard focus; Escape hides it and does not bubble to a
 * host dialog's own Escape-to-close handler (#532).
 *
 * Click is a pin/unpin toggle, kept deterministic by treating the two clicks
 * of a pair asymmetrically rather than as a plain `!isPinned` flip: pinning
 * (going from unpinned to pinned) only ever ADDS visibility, so a click
 * while merely hover-shown never hides it (the original #532 bug); unpinning
 * (the second, deliberate "close" click) force-clears hover and focus too,
 * not just the pin - a click's own pointer events fire a `mouseenter` first,
 * so at the moment of that second click the pointer genuinely never left the
 * trigger and a plain `setIsPinned(false)` would leave it open by hover
 * alone. The trigger's `onFocus` also ignores focus that immediately follows
 * its own `onPointerDown` (a plain mouse click also focuses a tabbable
 * element), so clicking never leaves a stray "focused" state either. A
 * pinned tooltip is dismissed by an outside pointerdown or Escape from
 * anywhere, mirroring {@link MapAttribution}'s pinned panel.
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
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const pointerDownRef = useRef(false);
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

  // Deterministic full close, used by every dismiss path (Escape, outside
  // pointerdown, the second click of a pin/unpin pair). Forcing `isHovered`
  // false too matters: a click's own pointer events fire a `mouseenter`
  // first, so at the moment of the SECOND click the pointer genuinely never
  // left the trigger and `isHovered` is still true - closing only `isPinned`
  // would leave the tooltip open by hover alone.
  const closeAll = useCallback(() => {
    setIsHovered(false);
    setIsFocused(false);
    setIsPinned(false);
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

  // A pinned tooltip has no trigger/hover/focus tie left to dismiss it, so it
  // needs its own outside-dismiss: a pointerdown outside the trigger/tooltip,
  // or Escape from anywhere. Scoped to only fire while pinned, and scoped to
  // just these two events (not scroll/resize) so it doesn't fight the
  // reposition-on-scroll effect above.
  //
  // CAPTURE phase, deliberately: if the pinned tooltip's trigger is inside a
  // DialogWrapper and focus has moved to some OTHER control in that dialog, a
  // real Escape keydown targets that control. DialogWrapper's own Escape
  // handling is a React (bubble-phase) listener on the dialog container -
  // which, because the dialog is portaled to `#dialog-root`, is where React
  // actually attaches its native delegated listener for that subtree. A
  // bubble-phase document listener sits ABOVE `#dialog-root` in real DOM
  // ancestry, so DialogWrapper's `e.stopPropagation()` (which also stops the
  // underlying native event since React 17) would win the race and this
  // listener would never run. A capture-phase listener runs on the way DOWN,
  // before any bubble-phase listener anywhere in the tree, so it always sees
  // the keydown first. It also calls `preventDefault()` so DialogWrapper's
  // own `!e.defaultPrevented` gate skips closing the dialog on that same
  // press - the tooltip owns this Escape, the dialog does not.
  useEffect(() => {
    if (!isPinned) return;

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || tooltipRef.current?.contains(target))) {
        return;
      }
      closeAll();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closeAll();
    };

    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isPinned, closeAll]);

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
        className={`inline-flex items-center justify-center w-4 h-4 rounded-full border border-border text-[10px] font-bold text-text-secondary cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${iconClassName}`}
        aria-label={ariaLabel ?? t('common.actions.help')}
        aria-describedby={isVisible ? tooltipId : undefined}
        role="button"
        tabIndex={0}
        data-testid={iconTestId}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onPointerDown={() => {
          pointerDownRef.current = true;
        }}
        onFocus={() => {
          // Skip focus triggered by the mousedown that precedes a click - only
          // keyboard (Tab) focus should open the tooltip via `isFocused`; a
          // click already gets its own affordance via `isPinned`.
          if (pointerDownRef.current) return;
          setIsFocused(true);
        }}
        onBlur={() => {
          setIsFocused(false);
          pointerDownRef.current = false;
        }}
        onClick={() => {
          pointerDownRef.current = false;
          // Pinning (this element was NOT already pinned) only ever ADDS
          // visibility, so a click while merely hover-shown never hides it
          // (issue #532). Unpinning (it WAS already pinned - this is the
          // deliberate "close" click) always fully closes, regardless of
          // any hover/focus state still active at that instant.
          if (isPinned) {
            closeAll();
          } else {
            setIsPinned(true);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // A keydown only reaches a focused element, so this only fires
            // while the trigger has focus. Only consume it while there is
            // something to dismiss - otherwise a second Escape press (the
            // tooltip already closed by the first one) would keep eating the
            // keystroke and a host dialog could never see it.
            if (!isVisible) return;
            // Stop it here so it can't bubble into a host dialog's own
            // Escape-to-close handler.
            e.preventDefault();
            e.stopPropagation();
            closeAll();
          } else if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
            e.preventDefault();
            e.stopPropagation();
            if (isPinned) {
              closeAll();
            } else {
              setIsPinned(true);
            }
          }
        }}
      >
        {icon}
      </span>
      {tooltip}
    </span>
  );
}
