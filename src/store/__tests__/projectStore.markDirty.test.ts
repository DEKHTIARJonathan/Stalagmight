import { afterEach, describe, expect, it } from 'vitest';

import { useProjectStore } from '../projectStore';

/**
 * #110: the DMP import wizard applies sections via direct `import_sections` IPC
 * calls that bypass `executeCommand`, so they never set `isDirty` themselves —
 * leaving the un-finalized in-memory sections unprotected by the close-guard
 * (an abnormal exit mid-wizard drops them). The wizard now calls `markDirty()`
 * after each successful batch. This guards that primitive.
 */
describe('projectStore.markDirty (#110)', () => {
  afterEach(() => {
    useProjectStore.setState({ isDirty: false });
  });

  it('flips isDirty so the close-guard protects un-finalized imports', () => {
    useProjectStore.setState({ isDirty: false });

    useProjectStore.getState().markDirty();

    expect(useProjectStore.getState().isDirty).toBe(true);
  });

  it('is idempotent — staying dirty across repeated batches', () => {
    useProjectStore.setState({ isDirty: false });

    useProjectStore.getState().markDirty();
    useProjectStore.getState().markDirty();

    expect(useProjectStore.getState().isDirty).toBe(true);
  });
});
