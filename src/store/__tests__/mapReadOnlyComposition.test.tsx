/**
 * Hook-composition coverage for `useUIStore(isMapReadOnly) || useSpeleoStore(selectSpeleoReadOnly)`
 * (#275 canonical-gating sweep) — the exact expression `DataTable.tsx`, `SectionsPanel.tsx`,
 * `WarningResolution.tsx`, `DetailPanel.tsx`, and `CollabReviewDialog.tsx` all use to derive
 * their local `geometryReadOnly`/`mapReadOnly` gate. `uiStore.isMapReadOnly.test.ts` already
 * covers the appMode/geometryMode truth table for the plain-function form; this covers the
 * SAME predicate wired through two live zustand hooks (subscription/re-render semantics differ
 * from a plain function call) plus the speleoReadOnly term those files add.
 *
 * DataTable.tsx itself is not rendered here (its SpreadsheetGrid subtree needs a heavier DOM
 * harness with no existing precedent in this repo) — component-level coverage is impractical
 * per the #275 task scope; this proves the shared predicate instead. The tripwire script
 * (`scripts/check-readonly-gates.mjs`) separately guards that call sites keep using it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUIStore, isMapReadOnly } from '../uiStore';
import { useSpeleoStore, selectSpeleoReadOnly, type SpeleoLinkState } from '../speleoStore';

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

function useComposedReadOnly(): boolean {
  return useUIStore(isMapReadOnly) || useSpeleoStore(selectSpeleoReadOnly);
}

beforeEach(() => {
  useUIStore.setState({ appMode: 'survey', geometryMode: 'measured' });
  useSpeleoStore.setState({ link: null });
});

describe('useUIStore(isMapReadOnly) || useSpeleoStore(selectSpeleoReadOnly)', () => {
  it('is false in the one fully-editable state: survey + measured + no lock', () => {
    const { result } = renderHook(() => useComposedReadOnly());
    expect(result.current).toBe(false);
  });

  it('is true in the closure-adjusted survey view', () => {
    useUIStore.setState({ geometryMode: 'closureAdjusted' });
    const { result } = renderHook(() => useComposedReadOnly());
    expect(result.current).toBe(true);
  });

  it('is true in Plan mode even though geometryMode fell back to measured', () => {
    useUIStore.setState({ appMode: 'plan', geometryMode: 'measured' });
    const { result } = renderHook(() => useComposedReadOnly());
    expect(result.current).toBe(true);
  });

  it('is true on a locked remote SpeleoDB project, independent of geometry/appMode', () => {
    useSpeleoStore.setState({ link: READ_ONLY_LINK });
    const { result } = renderHook(() => useComposedReadOnly());
    expect(result.current).toBe(true);
  });

  it('is false once the SpeleoDB write lock is held, in the editable survey state', () => {
    useSpeleoStore.setState({ link: { ...READ_ONLY_LINK, editState: 'editing', lockedByOther: false } });
    const { result } = renderHook(() => useComposedReadOnly());
    expect(result.current).toBe(false);
  });

  it('a local (non-SpeleoDB) project is never read-only via the speleo term', () => {
    useSpeleoStore.setState({ link: null });
    const { result } = renderHook(() => useComposedReadOnly());
    expect(result.current).toBe(false);
  });
});
