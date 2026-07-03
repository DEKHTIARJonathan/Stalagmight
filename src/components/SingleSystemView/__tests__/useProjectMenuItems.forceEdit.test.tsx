/**
 * Hook test (#213) - the "Edit without lock" menu item is gated on the
 * `allow_force_edit` opt-in and only offered while read-only. A force-editor sees a
 * Reconnect item (not Unlock) as the top SpeleoDB action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../../../utils/ipc', () => ({
  invokeIpc: vi.fn(),
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

import { useProjectMenuItems } from '../useProjectMenuItems';
import { useSpeleoStore, type SpeleoLinkState } from '../../../store/speleoStore';
import type { AppMenuItem } from '../../common/AppMenu';

const LINK: SpeleoLinkState = {
  permission: 'READ_AND_WRITE',
  editState: 'read-only',
  lockHolder: null,
  lockedByOther: false,
  hasUnpushedEdits: false,
  forceEditing: false,
  forceEditAllowed: false,
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
};

/** The SpeleoDB submenu's child ids for a given link state. */
function speleoSubmenuIds(o: Partial<SpeleoLinkState> = {}): string[] {
  useSpeleoStore.setState({ link: { ...LINK, ...o } });
  const { result } = renderHook(() =>
    useProjectMenuItems({ onSave: async () => ({ success: true }) }),
  );
  const findSubmenu = (items: AppMenuItem[]): AppMenuItem[] => {
    for (const it of items) {
      const sub = (it as { id?: string; submenu?: AppMenuItem[] });
      if (sub.id === 'speleodb-menu' && sub.submenu) return sub.submenu;
    }
    return [];
  };
  return findSubmenu(result.current).map((it) => (it as { id: string }).id);
}

beforeEach(() => {
  useSpeleoStore.setState({
    link: null,
    session: { loggedIn: true, userEmail: 'me@x', endpoint: 'https://x/', keychainBacked: true },
  });
});

describe('useProjectMenuItems force-edit gating (#213)', () => {
  it('hides "Edit without lock" when the opt-in is off', () => {
    const ids = speleoSubmenuIds({ forceEditAllowed: false, editState: 'read-only' });
    expect(ids).not.toContain('speleodb-menu-edit-without-lock');
  });

  it('shows "Edit without lock" when opted-in and read-only', () => {
    const ids = speleoSubmenuIds({ forceEditAllowed: true, editState: 'read-only' });
    expect(ids).toContain('speleodb-menu-edit-without-lock');
  });

  it('hides "Edit without lock" once we are already editing (opted-in)', () => {
    const ids = speleoSubmenuIds({ forceEditAllowed: true, editState: 'editing' });
    expect(ids).not.toContain('speleodb-menu-edit-without-lock');
  });

  it('offers Reconnect (not Unlock) as the top action while force-editing', () => {
    const ids = speleoSubmenuIds({ forceEditAllowed: true, editState: 'editing', forceEditing: true });
    expect(ids).toContain('speleodb-menu-reconnect');
    expect(ids).not.toContain('speleodb-menu-unlock');
    // A force-editor reconnects rather than force-editing again.
    expect(ids).not.toContain('speleodb-menu-edit-without-lock');
  });
});
