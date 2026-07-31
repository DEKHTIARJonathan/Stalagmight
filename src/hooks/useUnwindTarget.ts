import { useCallback, useEffect, useState } from 'react';
import { invokeIpc } from '../utils/ipc';
import { useSpeleoStore } from '../store/speleoStore';
import type { SpeleoUnwindTarget } from '../types/ipc.generated';

/**
 * [#303] Which revision the next "Unwind to previous SpeleoDB version" would load.
 *
 * Fetched ON DEMAND (`enabled`), not on the status poll: resolving it costs a
 * `GET /revisions/`, and the only thing that needs the answer is the undo dropdown
 * while it is open. `null` means there is nothing left to reach - an empty repo, the
 * root of the history, or a project whose undo history is not pushed at all - and the
 * caller renders no affordance rather than one that fails when pressed.
 *
 * Errors resolve to `null` deliberately: the target is an affordance, so being
 * offline or unauthenticated should HIDE the entry, not raise anything. A user who
 * presses the entry gets the real error from the action itself.
 */
export function useUnwindTarget(enabled: boolean): {
  target: SpeleoUnwindTarget | null;
  refresh: () => Promise<void>;
} {
  const [target, setTarget] = useState<SpeleoUnwindTarget | null>(null);
  // Only a remote project has revisions to walk; asking otherwise earns a refusal.
  const isRemote = useSpeleoStore((s) => s.projectLinkKind === 'remote');

  const refresh = useCallback(async () => {
    if (!isRemote) {
      setTarget(null);
      return;
    }
    try {
      setTarget(await invokeIpc<SpeleoUnwindTarget | null>('speleodb_unwind_target'));
    } catch {
      // Offline / logged out / no permission: nothing to offer, and nothing to say.
      setTarget(null);
    }
  }, [isRemote]);

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
