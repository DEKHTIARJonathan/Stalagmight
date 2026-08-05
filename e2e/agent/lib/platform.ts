/**
 * ONE platform selector for every harness decision that follows the TARGET
 * platform - session class, build shape, capability reporting (domOnly
 * screenshots, Meta caveat). STALAGMIGHT_AGENT_PLATFORM overrides for tests;
 * splitting this predicate is how a forced platform ends up half-applied
 * (a MacSession whose honesty caveats never fire).
 *
 * Deliberately NOT used by procs.ts: comm/pgid lookups talk to the REAL OS
 * (/proc vs ps), which an override cannot change.
 */
export function targetPlatform(): string {
  return process.env.STALAGMIGHT_AGENT_PLATFORM ?? process.platform;
}

export function isDarwinTarget(): boolean {
  return targetPlatform() === 'darwin';
}
