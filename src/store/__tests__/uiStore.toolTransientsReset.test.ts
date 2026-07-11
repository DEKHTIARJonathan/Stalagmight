/**
 * Project-switch tool-state reset (#275 B1).
 *
 * Entity refs held by the tool transients (moveCommentSource, merge picks,
 * commentTarget) use small per-project integer ids, so a stale ref from
 * project A usually RESOLVES against project B and the next click would
 * mutate the wrong entity. resetToolTransientsForProjectSwitch() must clear
 * them all and reset the active tool WITHOUT firing any persistence IPC
 * (a load-forced reset is not a user action - transient state never persists).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

import { useUIStore } from '../uiStore';

const armedState = () => ({
  activeTool: 'move_comment' as const,
  moveCommentSource: {
    type: 'shot' as const,
    sectionId: 2,
    shotId: 7,
    comment: 'stale comment from project A',
  },
  mergeStationA: { section_id: 1, station_index: 3 },
  mergeStationB: { section_id: 1, station_index: 4 },
  commentTarget: {
    type: 'shot' as const,
    sectionId: 2,
    shotId: 7,
    screenPos: { x: 10, y: 20 },
    currentComment: 'stale',
  },
});

describe('resetToolTransientsForProjectSwitch', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    useUIStore.setState(armedState());
  });

  it('clears every tool transient and resets the active tool', () => {
    useUIStore.getState().resetToolTransientsForProjectSwitch();
    const s = useUIStore.getState();
    expect(s.activeTool).toBe('select');
    expect(s.moveCommentSource).toBeNull();
    expect(s.mergeStationA).toBeNull();
    expect(s.mergeStationB).toBeNull();
    expect(s.commentTarget).toBeNull();
  });

  it('fires no persistence IPC (transient forced state never persists)', () => {
    useUIStore.getState().resetToolTransientsForProjectSwitch();
    const persisted = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([cmd]) => cmd === 'update_panel_layout' || cmd === 'save_display_setting'
      );
    expect(persisted).toHaveLength(0);
    // And no telemetry-style action tracking IPC either - the reset is not a
    // user action. (trackAction batches in-process, so simply assert the reset
    // made zero IPC calls of any kind.)
    expect(vi.mocked(invoke).mock.calls).toHaveLength(0);
  });
});
