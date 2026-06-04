import { useCallback, useState } from 'react';

/** Layout density for the recent-projects list view. */
export type RecentDensity = 'cards' | 'table';

const STORAGE_KEY = 'recentProjectsDensity';

/**
 * Recent-projects view density (card grid vs compact table), persisted to
 * localStorage so it survives across sessions (mirrors useViewMode).
 */
export function useRecentDensity(): [RecentDensity, (density: RecentDensity) => void] {
  const [density, setDensityState] = useState<RecentDensity>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'cards' || stored === 'table') return stored;
    } catch {
      // localStorage may be unavailable
    }
    return 'cards';
  });

  const setDensity = useCallback((next: RecentDensity) => {
    setDensityState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  return [density, setDensity];
}
