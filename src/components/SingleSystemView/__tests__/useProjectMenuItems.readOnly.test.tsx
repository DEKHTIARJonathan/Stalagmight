/**
 * Import item gating for useProjectMenuItems - one door (#407): the "Import"
 * hamburger row is NEVER disabled, in any read-only state. The pre-#407
 * `disabled: editingBlocked` gate (#275) was picker-side and over-broad once
 * the row offers the unified filter set: a `.stalx` open and an
 * import-as-new-project are legal while editing is blocked, and the one case
 * that is not - additive DMP into the open project - is rejected by
 * routeOpenedFile's read-only guard with a cause-specific message (pinned in
 * openOrImport.test.ts). These pins keep a picker-side disable from quietly
 * coming back.
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
  unwound: false,
  forceEditing: false,
  forceEditAllowed: false,
  undoMode: 'full',
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
};

function importItem(): { disabled?: boolean; submenu?: unknown[] } | undefined {
  const { result } = renderHook(() =>
    useProjectMenuItems({ onSave: async () => ({ success: true }) }),
  );
  return result.current.find(
    (it) => (it as { id?: string }).id === 'global-import-menu-button',
  ) as { disabled?: boolean; submenu?: unknown[] } | undefined;
}

beforeEach(() => {
  useUIStore.setState({ appMode: 'survey', geometryMode: 'measured' });
  // Confirmed-local project - the editable baseline (#270 fail-closed gate).
  useSpeleoStore.setState({ link: null, projectLinkKind: 'local', session: null });
});

describe('useProjectMenuItems Import item - never picker-disabled (#407)', () => {
  it('is present with its row in the fully-editable baseline', () => {
    const item = importItem();
    expect(item?.disabled).toBeUndefined();
    expect(item?.submenu).toHaveLength(1);
  });

  it('stays enabled in the closure-adjusted view (router guards the DMP case)', () => {
    useUIStore.setState({ geometryMode: 'closureAdjusted' });
    expect(importItem()?.disabled).toBeUndefined();
  });

  it('stays enabled in Plan mode even when geometryMode falls back to measured', () => {
    useUIStore.setState({ appMode: 'plan', geometryMode: 'measured' });
    expect(importItem()?.disabled).toBeUndefined();
  });

  it('stays enabled on a locked remote SpeleoDB project', () => {
    useSpeleoStore.setState({ link: READ_ONLY_LINK });
    expect(importItem()?.disabled).toBeUndefined();
  });

  it('stays enabled with the SpeleoDB write lock held', () => {
    useSpeleoStore.setState({ link: { ...READ_ONLY_LINK, editState: 'editing', lockedByOther: false } });
    expect(importItem()?.disabled).toBeUndefined();
  });
});
