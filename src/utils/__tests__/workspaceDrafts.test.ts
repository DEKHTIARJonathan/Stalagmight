import { describe, expect, it, vi } from 'vitest';
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: confirmMock }));
import { confirmWorkspaceDrafts, hasWorkspaceDrafts, registerWorkspaceDraft } from '../workspaceDrafts';

describe('workspace draft exit protection', () => {
  it('protects invalid drafts without depending on save eligibility', async () => {
    const discard = vi.fn();
    const unregister = registerWorkspaceDraft({ dirty: () => true, discard });
    confirmMock.mockResolvedValueOnce(false);
    expect(hasWorkspaceDrafts()).toBe(true);
    expect(await confirmWorkspaceDrafts()).toBe(false);
    expect(discard).not.toHaveBeenCalled();
    confirmMock.mockResolvedValueOnce(true);
    expect(await confirmWorkspaceDrafts()).toBe(true);
    expect(discard).toHaveBeenCalledOnce();
    unregister();
    expect(hasWorkspaceDrafts()).toBe(false);
  });
});
