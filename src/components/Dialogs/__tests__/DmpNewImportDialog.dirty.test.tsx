import { describe, expect, it, vi } from 'vitest';

vi.mock('../SectionPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../SectionPreview')>()),
  default: () => null,
}));
vi.mock('maplibre-gl', () => ({ default: {} }));

import { markSuccessfulDmpImportDirty } from '../dmpWizard/useDmpImportRun';

describe('DMP direct-import aftermath', () => {
  it('marks both the local file and SpeleoDB forward-edit state dirty', () => {
    const markProjectDirty = vi.fn();
    const markForwardEdit = vi.fn();

    markSuccessfulDmpImportDirty(markProjectDirty, markForwardEdit);

    expect(markProjectDirty).toHaveBeenCalledOnce();
    expect(markForwardEdit).toHaveBeenCalledOnce();
  });
});
