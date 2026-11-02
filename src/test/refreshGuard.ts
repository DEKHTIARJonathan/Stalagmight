/**
 * [#576 NF-W6A-5] A guard for the refresh every edit, import and project switch
 * ends with (`projectStore.refreshProjectState`).
 *
 * Since #576 A9-D2 the refresh reads `get_project_state_binary`, and an IPC mock
 * that answers it with nothing (`undefined`, `null`, a JSON object) makes the
 * decoder throw: the store logs "Failed to refresh project state", skips the undo
 * and warning re-reads that follow it, and the test still passes - over a path
 * the app never takes. A mock answers it with `new ArrayBuffer(0)` (no project
 * open) or a real envelope (`src/test/projectStateEnvelope.ts`); a file that calls
 * {@link failOnRefreshErrors} then fails if its mock stops doing so.
 */
import { afterEach, beforeEach, expect, vi, type MockInstance } from 'vitest';

/**
 * Fail every test in the calling file whose run logged a failed refresh. Call it
 * at the top level of the file (it installs a `beforeEach` / `afterEach` pair).
 */
export function failOnRefreshErrors(): void {
  let errors: MockInstance<typeof console.error> | null = null;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error');
  });
  afterEach(() => {
    const failed = (errors?.mock.calls ?? []).filter(
      ([message]) => typeof message === 'string' && message.startsWith('Failed to refresh project state'),
    );
    errors?.mockRestore();
    errors = null;
    expect(
      failed.map(([, error]) => String(error)),
      "refreshProjectState failed: answer get_project_state_binary in this file's IPC mock",
    ).toEqual([]);
  });
}
