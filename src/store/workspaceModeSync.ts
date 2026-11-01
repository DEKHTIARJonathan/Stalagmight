/**
 * [#576 C5] Mirror the workspace mode (`uiStore.appMode`) into the backend.
 *
 * Plan and Export are read-only workspaces. The UI hides and disables the editing
 * controls there (docs/app-modes.md), but the backend is the backstop: while the
 * mode it was last told is Plan or Export, its mutation chokepoint refuses every
 * survey edit with `EDIT_DISABLED: WORKSPACE_READ_ONLY` (see `editErrors.ts`), so a
 * gap in the UI gating cannot reach the project. Only the project name, the
 * validation thresholds and the rename are allowed there, on purpose.
 *
 * Every `appMode` change is sent, whoever made it (`setAppMode`, the load reset in
 * `applyDisplaySettings`, `exitGasPlan` on close). The backend also resets to
 * Survey on every project open, create and close, matching the frontend's own
 * reset, so the two agree across a project switch without a round trip.
 *
 * Sends are chained so they reach the backend in the order the mode changed; a
 * failed send is logged and the next mode change sends again (a stale Plan would
 * refuse edits in Survey with the workspace notice, a stale Survey is the old
 * UI-only gating - neither corrupts the project).
 */
import { invokeIpc } from '../utils/ipc';
import { useUIStore, type AppMode } from './uiStore';

let chain: Promise<void> = Promise.resolve();

/** Send one mode, after every send already queued. Never rejects. */
export function sendWorkspaceMode(mode: AppMode): Promise<void> {
  chain = chain.then(() =>
    invokeIpc<void>('set_workspace_mode', { mode }, {
      purpose: 'mirror the workspace mode for the read-only gate',
      fields: { mode },
    }).catch((e: unknown) => {
      console.warn('[workspaceModeSync] could not report the workspace mode to the backend', {
        mode,
        reason: String(e),
      });
    })
  );
  return chain;
}

/**
 * Start mirroring: send the current mode once (a webview reload keeps the backend
 * but starts the frontend in Survey), then every change. Returns the unsubscribe.
 */
export function startWorkspaceModeSync(): () => void {
  void sendWorkspaceMode(useUIStore.getState().appMode);
  return useUIStore.subscribe((state, prev) => {
    if (state.appMode !== prev.appMode) void sendWorkspaceMode(state.appMode);
  });
}
