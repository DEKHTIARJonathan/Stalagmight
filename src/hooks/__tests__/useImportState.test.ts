import { describe, it, expect } from 'vitest';
import type { EditableShot } from '../../components/common/ShotTableEditor';
import type { ImportState, SectionConfig } from '../useImportState';
import { importReducer } from '../useImportState';

const baseShot: EditableShot = {
  id: 0,
  azimuth_in: 10,
  azimuth_out: 10,
  length: 1,
  depth_in: 0,
  depth_out: 0,
  pitch_in: null,
  pitch_out: null,
  left: null,
  right: null,
  up: null,
  down: null,
  comment: null,
  is_virtual: false,
};

const baseConfig: SectionConfig = {
  sectionIndex: 0,
  name: null,
  surveyor: null,
  date: null,
  color: '#ffffff',
  direction: 'in',
  quality: 1.0,
  shots: [baseShot],
  placement: { type: 'origin' },
};

function buildState(): ImportState {
  return {
    sectionConfigs: new Map([[0, baseConfig]]),
    currentSectionIndex: 0,
    nextTempId: 1,
    placedSections: new Set(),
    excludedSections: new Set(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    originalValues: new Map([[0, baseConfig]]),
  };
}

describe('useImportState reducer', () => {
  it('adds shots with unique temp IDs and blank defaults', () => {
    const state1 = importReducer(buildState(), { type: 'ADD_SHOT' });
    const state2 = importReducer(state1, { type: 'ADD_SHOT' });

    const shots = state2.sectionConfigs.get(0)?.shots ?? [];
    const firstNew = shots[1];
    const secondNew = shots[2];

    expect(firstNew?.tempId).toBeDefined();
    expect(secondNew?.tempId).toBeDefined();
    expect(firstNew?.tempId).not.toBe(secondNew?.tempId);
    expect(firstNew?.id).not.toBe(secondNew?.id);
    expect(firstNew?.length).toBe(0);
    expect(firstNew?.azimuth_in).toBe(0);
    expect(firstNew?.azimuth_out).toBe(0);
    expect(firstNew?.depth_in).toBe(0);
    expect(firstNew?.depth_out).toBe(0);
    expect(state2.nextTempId).toBe(3);
  });
});
