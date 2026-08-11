/**
 * Lets Settings > General > Restart onboarding clear `useOnboarding`'s live,
 * session-only remembered-step map at click time, without prop-drilling a
 * callback through `SettingsDialog` and every settings category component
 * (only `GeneralSettings` needs it) - the same reason `useOnboardingStep.ts`
 * exists for a different piece of onboarding state.
 *
 * Why click time, not a reaction to the config write Restart stages: that
 * write only actually lands in the store on Settings Save, and even then can
 * be a same-session no-op for every field `useOnboarding` reads (#368).
 * `orientationConsumed` in particular is a one-shot, ref-guarded session flag
 * in App.tsx - once a first-time tour is on screen this session, it has
 * already burned true and stays there; writing
 * `onboarding_first_launch_done` back to `false` never re-fires
 * `setOrientationConsumed` with a NEW value, because it is already `false`
 * for the entire session a first-time tour can run in. And if nothing has
 * completed yet, `onboarding_completed_flows` was already `[]`, so writing
 * `[]` again is not an observable change either. So a tour interrupted by
 * opening Settings (the `shouldStart` re-check already closed it and
 * remembered its step, since `activeDialog !== null`) can survive Restart
 * with neither of `useOnboarding`'s own context-transition safeguards ever
 * firing. Clearing the map directly, at the moment the user clicks Restart,
 * does not depend on any of that.
 *
 * Deliberately narrower than `resetProgress` from `useOnboarding`: that also
 * writes `completedFlowIds` live (bypassing Settings' staged Save/Cancel)
 * and would let the user's later Cancel on the settings dialog leave a
 * config/live-state mismatch. This never touches config or persisted state -
 * only in-memory step memory, so it is safe to fire unconditionally on click
 * even if the surrounding Settings changes are later discarded (the one
 * honest cost: a since-cancelled Restart click still forgets an interrupted
 * flow's resume point).
 */
let clearOnboardingRememberedProgress: (() => void) | null = null;

/** App.tsx registers `useOnboarding`'s `clearRememberedProgress` while mounted. */
export function registerOnboardingRestart(fn: (() => void) | null): void {
  clearOnboardingRememberedProgress = fn;
}

/** Called by the Restart onboarding button, immediately on click. */
export function restartOnboardingProgress(): void {
  clearOnboardingRememberedProgress?.();
}
