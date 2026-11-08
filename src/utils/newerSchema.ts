import i18n from '../i18n';
import type { NewerSchema } from '../types/ipc/NewerSchema';

/**
 * #649: the one user-facing wording for a file a newer Stalagmight saved,
 * rendered from `newerSchema.message` with the file name and both versions.
 *
 * Every frontend surface that reports the refusal goes through here: the open
 * dialog (from `LoadError.newerSchema`) and SpeleoDB errors (from
 * `SpeleoErrorDto.newer_schema`). The backend's English for the surfaces that
 * relay its text (merge, rename, restore, repair, dive plans) is the `Display`
 * of `NewerSchema` in stalagmight-models, the same sentence; change both
 * together. `fallback` is the backend's own message, for a refusal that arrives
 * without its payload.
 */
export function newerSchemaMessage(newer: NewerSchema | null | undefined, fallback: string): string {
  if (!newer) return fallback;
  return i18n.t('newerSchema.message', {
    file: newer.file,
    found: newer.found,
    supported: newer.supported,
  });
}
