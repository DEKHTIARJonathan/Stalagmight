import type { MockCommandFamily, MockReply } from './types';

/**
 * The corruption-recovery commands of the Playwright IPC mock (#576 E3): canned
 * "nothing to recover" answers. No backup exists, a repair reports that it changed
 * nothing, and nothing is salvaged. What the backend does on disk - the safety copy, the
 * `fs::copy` of a backup over the live project, REINDEX/VACUUM - is pinned by the Rust
 * command tests (`src-tauri/src/commands/recovery_tests.rs`), never here. A spec that
 * walks the recovery dialog seeds the answers it needs with `__MOCK_IPC_OVERRIDES__`
 * (corruption-recovery.spec.ts, recovery-integrity.spec.ts).
 *
 * Runs IN THE PAGE (serialized with `Function.prototype.toString`): only `ctx` and
 * browser globals, never an import (type-only imports are erased).
 */
export const recoveryCommands: MockCommandFamily = (ctx) => {
  return (cmd, args) => {
    switch (cmd) {
      case 'list_backups':
        return [] satisfies MockReply<'list_backups'>;

      case 'attempt_repair':
        return {
          success: false,
          backupPath: '',
          message: 'Mock: no repair was attempted.',
        } satisfies MockReply<'attempt_repair'>;

      case 'restore_from_backup':
        return `Restored ${String(args?.backupPath ?? '')}` satisfies MockReply<'restore_from_backup'>;

      case 'export_salvageable_data':
        return {
          projectName: null,
          projectLocation: null,
          sectionCount: 0,
          shotCount: 0,
          mergeCount: 0,
          sectionsJson: null,
          fullProjectJson: null,
          errors: [],
        } satisfies MockReply<'export_salvageable_data'>;

      default:
        return ctx.unhandled;
    }
  };
};
