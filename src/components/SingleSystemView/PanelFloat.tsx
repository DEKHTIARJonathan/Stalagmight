import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { PanelEdge } from './PanelOpenerTab';
import type { PanelReveal } from './usePanelReveal';

/** Slide duration; mirror in the transition below. */
const SLIDE_MS = 150;

interface PanelFloatProps {
  edge: PanelEdge;
  /** Width (left/right) or height (bottom) of the floating panel, in px. */
  size: number;
  reveal: PanelReveal;
  children: ReactNode;
}

/**
 * Floating overlay for a hover-revealed panel: anchored to its window edge,
 * above the map (and map controls), sliding in/out. Mounted only while open (or
 * animating out), so heavy panel content isn't kept alive at rest. Part of the
 * panel's hover region via the reveal enter/leave handlers.
 */
export function PanelFloat({ edge, size, reveal, children }: PanelFloatProps) {
  const open = reveal.isFloatingOpen;
  const [mounted, setMounted] = useState(open);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Activate next frame so the enter transition runs from the off-edge state.
      const id = requestAnimationFrame(() => setActive(true));
      return () => cancelAnimationFrame(id);
    }
    setActive(false);
    const id = window.setTimeout(() => setMounted(false), SLIDE_MS);
    return () => window.clearTimeout(id);
  }, [open]);

  if (!mounted) return null;

  const vertical = edge === 'left' || edge === 'right';
  const hiddenTransform =
    edge === 'left'
      ? 'translateX(-100%)'
      : edge === 'right'
        ? 'translateX(100%)'
        : 'translateY(100%)';
  const borderCls =
    edge === 'left' ? 'border-r' : edge === 'right' ? 'border-l' : 'border-t';

  const style: CSSProperties = {
    ...(vertical ? { top: 0, bottom: 0, width: size } : { left: 0, right: 0, height: size, bottom: 0 }),
    ...(edge === 'left' ? { left: 0 } : edge === 'right' ? { right: 0 } : {}),
    transform: active ? 'none' : hiddenTransform,
    transition: `transform ${SLIDE_MS}ms ease-out`,
  };

  return (
    <div
      className={`absolute z-20 bg-panel ${borderCls} border-border shadow-xl overflow-hidden`}
      style={style}
      onMouseEnter={reveal.onRegionEnter}
      onMouseLeave={reveal.onRegionLeave}
    >
      {children}
    </div>
  );
}

export default PanelFloat;
