import { useCallback, useEffect, useRef, useState } from 'react';
import { invokeIpc } from '../utils/ipc';
import { useSpeleoStore } from '../store/speleoStore';
import type { SpeleoRewindTarget, SpeleoUnwindTarget } from '../types/ipc.generated';

/**
 * [#303] Which revision a chain step would load - backward (`'back'`, the Unwind) or
 * forward (`'forward'`, "Redo into next SpeleoDB version").
 *
 * One hook for both directions because the fetch policy is the interesting part and it
 * is identical: fetched ON DEMAND (`enabled` / `resolve`), not on the status poll, since
 * resolving either costs a `GET /revisions/` and the only thing that needs the answer is
 * the dropdown. `null` means there is nothing to reach in that direction -
 * backward: an empty repo, the root of the history, or a project whose undo history is
 * not pushed at all; forward: not mid-walk (which is how an EDIT removes the direction,
 * since a forward command drops the chain pointer), or already back at BASE. Either way
 * the caller renders no affordance rather than one that fails when pressed.
 *
 * Errors resolve to `null` deliberately: the target is an affordance, so being
 * offline or unauthenticated should HIDE the entry, not raise anything. A user who
 * presses the entry gets the real error from the action itself.
 */
export type ChainDirection = 'back' | 'forward';

/**
 * [#303] The resolved step, tagged with the direction it was asked for.
 *
 * A UNION, not an intersection. The two commands answer with different shapes -
 * `speleodb_unwind_target` has `is_current`/`discards_unpushed`, `speleodb_rewind_target`
 * has `is_latest` - and the old `SpeleoUnwindTarget & SpeleoRewindTarget` described a
 * value neither of them ever returns: it typed the other direction's field as a `boolean`
 * that was in fact `undefined` at runtime. Discriminating on the direction the hook was
 * asked for makes the reads narrow, so a caller cannot silently consult a field the
 * command it called never sent.
 */
export type ChainTarget =
  | ({ direction: 'back' } & SpeleoUnwindTarget)
  | ({ direction: 'forward' } & SpeleoRewindTarget);

/**
 * How long a resolved target stays good enough to reuse, in ms.
 *
 * [#303] The hover path resolves the target BEFORE opening the panel (it is the only way
 * to know whether there is anything to show), which puts a `GET /revisions/` behind a
 * 300ms hover of a disabled button - cheap per press, not cheap when a cursor crosses the
 * toolbar. The TTL is the agreed mitigation and is here from the start, not bolted on:
 * repeated hovers inside the window answer from the last fetch.
 */
const TARGET_TTL_MS = 5000;

export function useUnwindTarget(
  enabled: boolean,
  direction: ChainDirection = 'back',
): {
  target: ChainTarget | null;
  refresh: () => Promise<void>;
  resolve: () => Promise<ChainTarget | null>;
} {
  const [target, setTarget] = useState<ChainTarget | null>(null);
  // Only a remote project has revisions to walk; asking otherwise earns a refusal.
  const isRemote = useSpeleoStore((s) => s.projectLinkKind === 'remote');

  // The memo carries the inputs it was fetched for, so a change of direction or of
  // remote-ness invalidates it by not matching rather than by needing to be cleared -
  // no window in which a stale answer for the other direction can be read back.
  const cacheKey = `${direction}:${String(isRemote)}`;
  const cacheRef = useRef<{ at: number; key: string; value: ChainTarget | null } | null>(null);

  const fetchTarget = useCallback(async (): Promise<ChainTarget | null> => {
    if (!isRemote) return null;
    try {
      if (direction === 'forward') {
        const raw = await invokeIpc<SpeleoRewindTarget | null>('speleodb_rewind_target');
        return raw ? { direction: 'forward', ...raw } : null;
      }
      const raw = await invokeIpc<SpeleoUnwindTarget | null>('speleodb_unwind_target');
      return raw ? { direction: 'back', ...raw } : null;
    } catch {
      // Offline / logged out / no permission: nothing to offer, and nothing to say.
      return null;
    }
  }, [isRemote, direction]);

  const remember = useCallback(
    (value: ChainTarget | null): ChainTarget | null => {
      cacheRef.current = { at: Date.now(), key: cacheKey, value };
      setTarget(value);
      return value;
    },
    [cacheKey],
  );

  // The open-panel path: always a real fetch, since a push or a lock change while the
  // panel sits open is exactly what it is there to notice.
  const refresh = useCallback(async () => {
    remember(await fetchTarget());
  }, [fetchTarget, remember]);

  // The before-opening path: answer from the memo when it is fresh, so a cursor crossing
  // the toolbar cannot turn into one `GET /revisions/` per pass. Stores either way, so an
  // open panel renders what the caller decided to open on.
  const resolve = useCallback(async (): Promise<ChainTarget | null> => {
    const cached = cacheRef.current;
    if (cached && cached.key === cacheKey && Date.now() - cached.at < TARGET_TTL_MS) {
      setTarget(cached.value);
      return cached.value;
    }
    return remember(await fetchTarget());
  }, [cacheKey, fetchTarget, remember]);

  useEffect(() => {
    if (!enabled) {
      // Drop the stale answer on close so a re-open re-asks rather than rendering a
      // target that a push or lock in between may have moved.
      setTarget(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { target, refresh, resolve };
}
