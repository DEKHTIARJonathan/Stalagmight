import type { CommandResult } from '../types/commands';

/**
 * A `CommandResult` for an outcome the frontend decided itself (a cancelled or
 * superseded request, a caught IPC rejection): no warnings unless given, no
 * sections, and `error` only on failure.
 *
 * A leaf module so the store slices can share it without importing
 * projectStore (#576 D27-32(b): projectConfigActions importing it from
 * projectStore, which imports projectConfigActions, was part of a value-import
 * cycle).
 */
export function emptyCommandResult(
  success: boolean,
  error?: string | null,
  warnings: CommandResult['warnings'] = []
): CommandResult {
  return {
    success,
    warnings,
    error: success ? null : (error ?? null),
    section_ids: [],
  };
}
