import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// uiStore → telemetry → @tauri-apps/api/core; stub the IPC so importing the store
// in jsdom doesn't hit Tauri. `.tsx` so this runs in the jsdom tier (renderHook).
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

import { usePanelReveal } from '../usePanelReveal';
import { useUIStore } from '../../../store/uiStore';

describe('usePanelReveal — close-grace + pin clearing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Detail panel in hover mode, closed at rest.
    useUIStore.setState({ detailPanelMode: 'hover', detailPanelOpen: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not let a shorter scheduleClose clobber a longer pending grace', () => {
    const { result } = renderHook(() => usePanelReveal('detail'));

    act(() => result.current.onRegionEnter()); // hovering → floating open
    expect(result.current.isFloatingOpen).toBe(true);

    act(() => result.current.scheduleClose(700)); // generous post-resize grace
    act(() => result.current.scheduleClose(120)); // shorter — must NOT clobber the 700

    act(() => vi.advanceTimersByTime(120));
    // The 120ms grace would have closed it; the 700ms one is still pending.
    expect(result.current.isFloatingOpen).toBe(true);

    act(() => vi.advanceTimersByTime(600)); // total 720 > 700
    expect(result.current.isFloatingOpen).toBe(false);
  });

  it('a later LONGER scheduleClose does extend a shorter pending grace', () => {
    const { result } = renderHook(() => usePanelReveal('detail'));

    act(() => result.current.onRegionEnter());
    act(() => result.current.scheduleClose(120));
    act(() => result.current.scheduleClose(700)); // longer — replaces the 120

    act(() => vi.advanceTimersByTime(120));
    expect(result.current.isFloatingOpen).toBe(true); // 120 timer was cleared
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.isFloatingOpen).toBe(false);
  });

  it('clears transient hover + cancels the pending grace when the panel is pinned', () => {
    const { result } = renderHook(() => usePanelReveal('detail'));

    act(() => result.current.onRegionEnter());
    act(() => result.current.scheduleClose(700));
    expect(result.current.isFloatingOpen).toBe(true);

    // Pin (section-focus / keyboard / menu all force mode='pin').
    act(() => {
      useUIStore.setState({ detailPanelMode: 'pin' });
    });
    expect(result.current.isFloatingOpen).toBe(false);

    // Returning to hover must NOT re-float: hovering was cleared on pin (no pointer
    // is over the region), and the pending grace was cancelled.
    act(() => {
      useUIStore.setState({ detailPanelMode: 'hover' });
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.isFloatingOpen).toBe(false);
  });
});
