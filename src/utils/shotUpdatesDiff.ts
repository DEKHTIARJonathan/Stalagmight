/**
 * [#576 F32-EDIT] Edit paths send only the shot fields that changed.
 *
 * The project the frontend holds is decoded from the binary envelope, which
 * carries every shot reading as an f32 (see `core::load_binary`, the PRECISION
 * note): a length of 1.2 reaches the store as 1.2000000476837158. An edit path
 * that re-sends the whole row therefore writes that rounded value back over the
 * exact f64 the backend still holds for every field the user never touched, and
 * the noise is saved with the file. Sending only what differs from the store's
 * own value leaves every untouched field to the backend's copy, bit for bit.
 */
import type { ShotUpdates } from '../types/ipc/ShotUpdates';

/** A shot's fields as the store (or an editor's local copy) holds them. */
type ShotFields = { readonly [K in keyof ShotUpdates]?: ShotUpdates[K] };

/** Same value for patch purposes: identical (NaN included), or both unset. */
function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || (a == null && b == null);
}

/**
 * The entries of `proposed` whose value differs from `current`'s, i.e. the patch
 * that changes exactly those fields. An empty result means nothing would change:
 * callers skip the command rather than record an empty undo step.
 */
export function changedShotFields(current: ShotFields, proposed: Partial<ShotUpdates>): Partial<ShotUpdates> {
  const patch: Partial<ShotUpdates> = {};
  for (const key of Object.keys(proposed) as (keyof ShotUpdates)[]) {
    const next = proposed[key];
    if (next === undefined || sameValue(current[key], next)) continue;
    (patch as Record<string, unknown>)[key] = next;
  }
  return patch;
}
