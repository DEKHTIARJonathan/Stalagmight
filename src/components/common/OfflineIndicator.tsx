import { useNetworkStatus } from '../../hooks/useNetworkStatus';

interface OfflineIndicatorProps {
  /** Custom className for positioning */
  className?: string;
}

/**
 * Indicator component that displays when the application is offline.
 *
 * Shows a subtle banner when network connectivity is unavailable,
 * informing users that they're working with cached data.
 */
export function OfflineIndicator({ className = '' }: OfflineIndicatorProps) {
  const { isOnline } = useNetworkStatus();

  // Only show when offline
  if (isOnline) {
    return null;
  }

  return (
    <div
      data-testid="offline-indicator"
      className={`flex items-center gap-2 px-3 py-1.5 bg-warning/10 border border-warning/30 rounded text-warning text-sm ${className}`}
      role="status"
      aria-live="polite"
    >
      <span className="inline-block w-2 h-2 rounded-full bg-warning animate-pulse" />
      <span>Offline - using cached tiles</span>
    </div>
  );
}
