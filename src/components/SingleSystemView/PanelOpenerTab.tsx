import type { ReactNode } from 'react';
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
  /** Panel id used for test ids (`panel-tab-${id}` etc.). */
  testId: string;
  labels: { open: string; pin: string; unpin: string; close: string };
}

/**
 * Presentational opener tab for a panel. Rendered as a child of the Dock's outer
 * wrapper (which positions it flush to the panel's inner edge and owns the hover
 * region), so this component only renders the state-appropriate control box:
 *  - closed       → label + open-arrow (click/hover opens)
 *  - hover-open   → pin icon (click pins)
 *  - pinned-open  → active pin (click un-pins) + close-arrow (click closes)
 */
export function PanelOpenerTab({
  reveal,
  edge,
  label,
  openArrow,
  closeArrow,
  testId,
  labels,
}: PanelOpenerTabProps) {
  const vertical = edge === 'left' || edge === 'right';
  // Omit the border on the panel-facing edge and overlap it by 1px (negative
  // margin) so the tab reads as part of the panel — no seam between them.
  const edgeCls =
    edge === 'left'
      ? 'border-y border-r rounded-r -ml-px'
      : edge === 'right'
        ? 'border-y border-l rounded-l -mr-px'
        : 'border-x border-t rounded-t -mb-px';

  const box = [
    'flex items-center justify-center border-border bg-panel text-text-secondary select-none',
    vertical ? 'flex-col gap-1 w-7 py-2' : 'flex-row gap-1 h-7 px-2',
    edgeCls,
  ].join(' ');

  if (!reveal.isOpen) {
    return (
      <div className={box}>
        <button
          type="button"
          className={`flex items-center justify-center gap-1.5 ${vertical ? 'flex-col' : 'flex-row'} transition-colors hover:text-text-primary`}
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
    <div className={box}>
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
          className="flex items-center justify-center transition-colors hover:text-text-primary"
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
