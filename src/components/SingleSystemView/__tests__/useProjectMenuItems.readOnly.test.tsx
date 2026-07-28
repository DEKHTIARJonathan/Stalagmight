/**
 * Import item read-only gating for useProjectMenuItems (#275): the "Import"
 * hamburger row's `disabled` flag must toggle with the composed editing-blocked
 * predicate (isMapReadOnly || speleoReadOnly via useEditingBlocked()), not just
 * the closure-adjusted geometry check.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../../../utils/ipc', () => ({
  invokeIpc: vi.fn(),
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

import { useProjectMenuItems } from '../useProjectMenuItems';
import { useUIStore } from '../../../store/uiStore';
import { useSpeleoStore, type SpeleoLinkState } from '../../../store/speleoStore';

const READ_ONLY_LINK: SpeleoLinkState = {
  permission: 'READ_AND_WRITE',
  editState: 'read-only',
  lockHolder: 'someone-else',
  lockedByOther: true,
  hasUnpushedEdits: false,
  forceEditing: false,
  forceEditAllowed: false,
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
};

function importItemDisabled(): boolean | undefined {
  const { result } = renderHook(() =>
    useProjectMenuItems({ onSave: async () => ({ success: true }) }),
  );
  const item = result.current.find((it) => (it as { id?: string }).id === 'global-import-menu-button');
  return (item as { disabled?: boolean } | undefined)?.disabled;
}

beforeEach(() => {
  useUIStore.setState({ appMode: 'survey', geometryMode: 'measured' });
  // Confirmed-local project - the editable baseline (#270 fail-closed gate).
  useSpeleoStore.setState({ link: null, projectLinkKind: 'local', session: null });
});

describe('useProjectMenuItems Import item - composed read-only gate (#275)', () => {
  it('is enabled in the fully-editable baseline', () => {
    expect(importItemDisabled()).toBe(false);
  });

  it('is disabled in the closure-adjusted view', () => {
    useUIStore.setState({ geometryMode: 'closureAdjusted' });
    expect(importItemDisabled()).toBe(true);
  });

  it('is disabled in Plan mode even when geometryMode falls back to measured', () => {
    useUIStore.setState({ appMode: 'plan', geometryMode: 'measured' });
    expect(importItemDisabled()).toBe(true);
  });

  it('is disabled on a locked remote SpeleoDB project (otherwise-editable baseline)', () => {
    useSpeleoStore.setState({ link: READ_ONLY_LINK });
    expect(importItemDisabled()).toBe(true);
  });

  it('is enabled once the SpeleoDB write lock is held', () => {
    useSpeleoStore.setState({ link: { ...READ_ONLY_LINK, editState: 'editing', lockedByOther: false } });
    expect(importItemDisabled()).toBe(false);
  });
});
