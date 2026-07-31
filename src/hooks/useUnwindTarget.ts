import { useCallback, useEffect, useState } from 'react';
import { invokeIpc } from '../utils/ipc';
import { useSpeleoStore } from '../store/speleoStore';
import type { SpeleoRewindTarget, SpeleoUnwindTarget } from '../types/ipc.generated';

/**
 * [#303] Which revision a chain step would load - backward (`'back'`, the Unwind) or
 * forward (`'forward'`, "Redo into next SpeleoDB version").
 *
 * One hook for both directions because the fetch policy is the interesting part and it
 * is identical: fetched ON DEMAND (`enabled`), not on the status poll, since resolving
 * either costs a `GET /revisions/` and the only thing that needs the answer is the
 * dropdown while it is open. `null` means there is nothing to reach in that direction -
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

export function useUnwindTarget(
  enabled: boolean,
  direction: ChainDirection = 'back',
): {
  target: (SpeleoUnwindTarget & SpeleoRewindTarget) | null;
  refresh: () => Promise<void>;
} {
  type Target = (SpeleoUnwindTarget & SpeleoRewindTarget) | null;
  const [target, setTarget] = useState<Target>(null);
  // Only a remote project has revisions to walk; asking otherwise earns a refusal.
  const isRemote = useSpeleoStore((s) => s.projectLinkKind === 'remote');

  const refresh = useCallback(async () => {
    if (!isRemote) {
      setTarget(null);
      return;
    }
    try {
      setTarget(
        await invokeIpc<Target>(
          direction === 'forward' ? 'speleodb_rewind_target' : 'speleodb_unwind_target',
        ),
      );
    } catch {
      // Offline / logged out / no permission: nothing to offer, and nothing to say.
      setTarget(null);
    }
  }, [isRemote, direction]);

  useEffect(() => {
    if (!enabled) {
      // Drop the stale answer on close so a re-open re-asks rather than rendering a
      // target that a push or lock in between may have moved.
      setTarget(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { target, refresh };
}
