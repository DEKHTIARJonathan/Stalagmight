import { useEffect, useMemo, useState } from 'react';
import {
  fetchSpeleoLocalStates,
  type SpeleoLocalStateMap,
} from '../utils/speleoLocalState';

export interface SpeleoLocalStatesResult {
  /** Per-project local state, keyed by SpeleoDB project id. Empty until loaded. */
  states: SpeleoLocalStateMap;
  /** False until the first fetch has settled (either way). */
  loaded: boolean;
  /** True when the last fetch FAILED. `states` is then empty and says nothing:
      callers must not read it as "no project has local edits". */
  failed: boolean;
}

/**
 * Fetch the local (un-pushed) state of a SET of SpeleoDB projects once, for a
 * whole list (#270) - not per row: one IPC call answers every id, and the reply is
 * indexed by project id.
 *
 * Failure is non-fatal by design: `states` stays empty and `failed` goes true, so a
 * list simply renders without accents instead of breaking. Re-runs only when the id
 * SET changes (order and duplicates are normalised away), so a re-render with a
 * fresh array literal does not re-issue the call.
 */
export function useSpeleoLocalStates(projectIds: string[]): SpeleoLocalStatesResult {
  // Stable identity for the id SET: the effect keys off this string, so a new array
  // holding the same ids does not refetch.
  const key = useMemo(() => [...new Set(projectIds)].sort().join(','), [projectIds]);
  const [result, setResult] = useState<SpeleoLocalStatesResult>({
    states: {},
    loaded: false,
    failed: false,
  });

  useEffect(() => {
    const ids = key.length > 0 ? key.split(',') : [];
    if (ids.length === 0) {
      setResult({ states: {}, loaded: true, failed: false });
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const states = await fetchSpeleoLocalStates(ids);
        if (!cancelled) setResult({ states, loaded: true, failed: false });
      } catch {
        // Best-effort: no accents, and `failed` tells callers we do not KNOW that
        // these projects are clean (the held-lock prompt needs that distinction).
        if (!cancelled) setResult({ states: {}, loaded: true, failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  return result;
}
