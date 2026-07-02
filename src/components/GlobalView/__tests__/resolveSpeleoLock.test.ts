import { describe, it, expect } from 'vitest';
import { resolveSpeleoLock } from '../SpeleoLockBadge';

const me = 'me@example.com';

describe('resolveSpeleoLock (#201)', () => {
  it('a local project is never remote and carries no lock', () => {
    const got = resolveSpeleoLock({ is_remote: false }, {}, me);
    expect(got).toEqual({ isRemote: false, lockHolder: undefined, lockedByMe: false });
  });

  it('a remote project not in the scan map is remote with an unknown holder', () => {
    // Logged out / offline: no scan yet, so lockHolder is undefined (bare mark).
    const got = resolveSpeleoLock(
      { is_remote: true, speleodb_project_id: 'p1' },
      {},
      me,
    );
    expect(got).toEqual({ isRemote: true, lockHolder: undefined, lockedByMe: false });
  });

  it('a free remote project reports a null holder', () => {
    const got = resolveSpeleoLock(
      { is_remote: true, speleodb_project_id: 'p1' },
      { p1: null },
      me,
    );
    expect(got).toEqual({ isRemote: true, lockHolder: null, lockedByMe: false });
  });

  it('locked by another user', () => {
    const got = resolveSpeleoLock(
      { is_remote: true, speleodb_project_id: 'p1' },
      { p1: 'other@example.com' },
      me,
    );
    expect(got.lockHolder).toBe('other@example.com');
    expect(got.lockedByMe).toBe(false);
  });

  it('locked by me (case-insensitive email match)', () => {
    const got = resolveSpeleoLock(
      { is_remote: true, speleodb_project_id: 'p1' },
      { p1: 'Me@Example.com' },
      me,
    );
    expect(got.lockedByMe).toBe(true);
  });

  it('a held lock never reads as mine when we do not know our own email', () => {
    const got = resolveSpeleoLock(
      { is_remote: true, speleodb_project_id: 'p1' },
      { p1: 'me@example.com' },
      null,
    );
    expect(got.lockedByMe).toBe(false);
  });
});
