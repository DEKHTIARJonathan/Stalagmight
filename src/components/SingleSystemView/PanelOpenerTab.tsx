import type { CSSProperties, ReactNode } from 'react';
import { PinIcon } from '../common/icons';
import type { PanelReveal } from './usePanelReveal';

export type PanelEdge = 'left' | 'right' | 'bottom';

interface PanelOpenerTabProps {
  reveal: PanelReveal;
  edge: PanelEdge;
  /** Short panel name shown on the closed tab (e.g. "Sections"). */
  label: string;
  /** Chevron pointing into the viewport (open hint), e.g. ChevronRightIcon. */
  openArrow: ReactNode;
  /** Chevron pointing toward the window edge (close), e.g. ChevronLeftIcon. */
  closeArrow: ReactNode;
  /** Absolute placement of the tab within the (relative) content container. */
  style?: CSSProperties;
  /** Panel id used for test ids / aria (`panel-tab-${id}` etc.). */
  testId: string;
  /** i18n'd control labels. */
  labels: { open: string; pin: string; unpin: string; close: string };
}

/**
 * The opener tab for one in-project panel. Sits on the panel's window edge and
 * changes contents by reveal state (see the panel-reveal plan):
 *  - closed       → vertical/horizontal label + open-arrow (click/hover opens)
 *  - hover-open   → pin icon (click pins)
 *  - pinned-open  → filled pin (click un-pins) + close-arrow (click closes)
 * Shares the panel's hover region via the reveal enter/leave handlers.
 */
export function PanelOpenerTab({
  reveal,
  edge,
  label,
  openArrow,
  closeArrow,
  style,
  testId,
  labels,
}: PanelOpenerTabProps) {
  const vertical = edge === 'left' || edge === 'right';
  const rounded =
    edge === 'left' ? 'rounded-r' : edge === 'right' ? 'rounded-l' : 'rounded-t';

  const container = [
    'absolute z-30 flex items-center justify-center border border-border bg-panel',
    'text-text-secondary shadow-sm select-none',
    vertical ? 'flex-col gap-1 w-7 py-2' : 'flex-row gap-1 h-7 px-2',
    rounded,
  ].join(' ');

  const hoverHandlers = {
    onMouseEnter: reveal.onRegionEnter,
    onMouseLeave: reveal.onRegionLeave,
  };

  // Closed: the whole tab is one big opener button.
  if (!reveal.isOpen) {
    return (
      <div className={container} style={style} {...hoverHandlers}>
        <button
          type="button"
          className={`flex items-center justify-center ${vertical ? 'flex-col gap-1.5' : 'flex-row gap-1.5'} hover:text-text-primary transition-colors`}
          onClick={reveal.openClick}
          title={labels.open}
          aria-label={labels.open}
          data-testid={`panel-tab-${testId}`}
        >
          <span aria-hidden className="flex items-center justify-center">
            {openArrow}
          </span>
          <span
            className="text-[11px] font-medium tracking-wide"
            style={vertical ? { writingMode: 'vertical-rl' } : undefined}
          >
            {label}
          </span>
        </button>
      </div>
    );
  }

  const pinned = reveal.isPinnedOpen;

  return (
    <div className={container} style={style} {...hoverHandlers}>
      <button
        type="button"
        className={`flex items-center justify-center transition-colors ${pinned ? 'text-accent' : 'hover:text-text-primary'}`}
        onClick={pinned ? reveal.unpin : reveal.pin}
        title={pinned ? labels.unpin : labels.pin}
        aria-label={pinned ? labels.unpin : labels.pin}
        aria-pressed={pinned}
        data-testid={`panel-pin-${testId}`}
      >
        <PinIcon size={16} />
      </button>
      {pinned && (
        <button
          type="button"
          className="flex items-center justify-center hover:text-text-primary transition-colors"
          onClick={reveal.close}
          title={labels.close}
          aria-label={labels.close}
          data-testid={`panel-close-${testId}`}
        >
          <span aria-hidden className="flex items-center justify-center">
            {closeArrow}
          </span>
        </button>
      )}
    </div>
  );
}

export default PanelOpenerTab;
