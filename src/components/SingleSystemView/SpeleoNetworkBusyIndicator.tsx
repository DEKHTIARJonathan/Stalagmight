import { selectSpeleoNetworkBusy, useSpeleoNetworkStore } from '../../store/speleoNetworkStore';

export const SPELEO_NETWORK_BUSY_LABEL = 'Talking to SpeleoDB...';

/**
 * A small spinner shown beside the SpeleoDB tab label while any SpeleoDB network
 * call is in flight (see `speleoNetworkStore`).
 *
 * The slot is a zero-size inline anchor and the spinner is absolutely positioned
 * off it, so the tab keeps exactly the same width and its label never moves when
 * the spinner appears or disappears. The slot is also the live region, mounted
 * whether or not anything is in flight, so screen readers announce the label
 * when the spinner appears.
 */
export function SpeleoNetworkBusyIndicator() {
  const busy = useSpeleoNetworkStore(selectSpeleoNetworkBusy);
  return (
    <span
      role="status"
      aria-live="polite"
      className="relative inline-block h-0 w-0 align-middle"
      data-testid="speleodb-network-busy-slot"
    >
      {busy && (
        <span
          title={SPELEO_NETWORK_BUSY_LABEL}
          className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 inline-flex h-3 w-3 text-accent"
          data-testid="speleodb-network-busy"
        >
          {/* Filled, not stroked: a three-quarter ring drawn as one closed shape. */}
          <svg viewBox="0 0 16 16" className="h-3 w-3 animate-spin" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M8 0a8 8 0 1 0 8 8h-2.5A5.5 5.5 0 1 1 8 2.5V0z"
            />
          </svg>
          <span className="sr-only">{SPELEO_NETWORK_BUSY_LABEL}</span>
        </span>
      )}
    </span>
  );
}
