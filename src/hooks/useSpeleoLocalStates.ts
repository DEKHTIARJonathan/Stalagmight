import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchSpeleoLocalStates,
  type SpeleoLocalStateMap,
} from '../utils/speleoLocalState';

export interface SpeleoLocalStatesResult {
  /** Per-project local state, keyed by SpeleoDB project id. Empty until loaded. */
  states: SpeleoLocalStateMap;
  /** False until the CURRENT id set's fetch has settled (either way). Goes back to
      false whenever the set changes, so it always describes the answer callers are
      about to read - not merely the first one of the session. */
  loaded: boolean;
  /** True when the last fetch FAILED. `states` is then empty and says nothing:
      callers must not read it as "no project has local edits". */
  failed: boolean;
  /** Re-issue the fetch for the same id set. The effect keys off the set, so a
      manual refresh over an UNCHANGED list would otherwise be a no-op and the
      caller would keep rendering mount-time state (#270: the GlobalView refresh
      button updated the lock badges but not the un-pushed-edits accent). */
  reload: () => void;
}

/**
 * Fetch the local (un-pushed) state of a SET of SpeleoDB projects once, for a
 * whole list (#270) - not per row: one IPC call answers every id, and the reply is
 * indexed by project id.
 *
 * Failure is non-fatal by design: `states` stays empty and `failed` goes true, so a
 * list simply renders without accents instead of breaking. Re-runs only when the id
 * SET changes (order and duplicates are normalised away) or when `reload` is
 * called, so a re-render with a fresh array literal does not re-issue the call.
 */
export function useSpeleoLocalStates(projectIds: string[]): SpeleoLocalStatesResult {
  // Stable identity for the id SET: the effect keys off this string, so a new array
  // holding the same ids does not refetch.
  const key = useMemo(() => [...new Set(projectIds)].sort().join(','), [projectIds]);
  // Bumped by `reload` to re-run the effect for an unchanged key.
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const [result, setResult] = useState<Omit<SpeleoLocalStatesResult, 'reload'>>({
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
    // Back to "checking" for the duration of the fetch. Only the initial state used
    // to carry loaded:false, so the flag guarded the FIRST fetch and nothing after
    // it: an id ADDED to the set while mounted (a second lock scan landing while
    // the held-lock prompt is up) left `loaded` true over the OLD map, the new id
    // read as absent - i.e. clean - and the dialog offered an irreversible "Release
    // lock" for a project whose un-pushed work it had not actually checked.
    //
    // The previous map is kept rather than cleared: consumers that gate on `loaded`
    // never see it, and the one that does not (the recents accent) holds its last
    // known accents for a frame instead of flickering them off and on.
    setResult((prev) => (prev.loaded ? { ...prev, loaded: false, failed: false } : prev));
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
  }, [key, nonce]);

  return useMemo(() => ({ ...result, reload }), [result, reload]);
}
