import { describe, it, expect } from 'vitest';
import {
  needsDirectionReversal,
  computeOverlapIds,
  computeActionableIds,
  computeTargetShotIndex,
  computeMergeOptions,
  reverseTargetShot,
  applyTargetData,
  interpolateShots,
  avgNullable,
  type TargetShotLike,
  type EditableShotLike,
  type OverlapParams,
} from '../overlapHelpers';

// ─── Test data helpers ──────────────────────────────────────────────────────

/** Create a realistic cave survey shot heading roughly NE at ~45°. */
function makeTargetShot(overrides: Partial<TargetShotLike> = {}): TargetShotLike {
  return {
    azimuth_in: 45,
    azimuth_out: 46,
    length: 5.0,
    depth_in: 10,
    depth_out: 12,
    pitch_in: -5,
    pitch_out: -6,
    left: 2.0,
    right: 3.0,
    up: 1.5,
    down: 0.5,
    ...overrides,
  };
}

function makeEditableShot(id: number, overrides: Partial<EditableShotLike> = {}): EditableShotLike {
  return {
    id,
    azimuth_in: 90,
    azimuth_out: 91,
    length: 4.0,
    depth_in: 8,
    depth_out: 10,
    pitch_in: -3,
    pitch_out: -4,
    left: 1.5,
    right: 2.5,
    up: 1.0,
    down: 0.8,
    comment: null,
    is_reference: false,
    ...overrides,
  };
}

// ─── needsDirectionReversal ─────────────────────────────────────────────────

describe('needsDirectionReversal', () => {
  it('Front + forward → false', () => {
    expect(needsDirectionReversal(0, 'forward')).toBe(false);
  });

  it('Front + reverse → true', () => {
    expect(needsDirectionReversal(0, 'reverse')).toBe(true);
  });

  it('Back + forward → true', () => {
    expect(needsDirectionReversal(5, 'forward')).toBe(true);
  });

  it('Back + reverse → false', () => {
    expect(needsDirectionReversal(5, 'reverse')).toBe(false);
  });

  it('Back with any station > 0 + forward → true', () => {
    expect(needsDirectionReversal(1, 'forward')).toBe(true);
    expect(needsDirectionReversal(10, 'forward')).toBe(true);
  });

  it('Back with any station > 0 + reverse → false', () => {
    expect(needsDirectionReversal(1, 'reverse')).toBe(false);
    expect(needsDirectionReversal(10, 'reverse')).toBe(false);
  });
});

// ─── computeOverlapIds ──────────────────────────────────────────────────────

describe('computeOverlapIds', () => {
  it('Front: returns 0..matchedShots-1', () => {
    const ids = computeOverlapIds(0, 3);
    expect(ids).toEqual(new Set([0, 1, 2]));
  });

  it('Front: single matched shot', () => {
    const ids = computeOverlapIds(0, 1);
    expect(ids).toEqual(new Set([0]));
  });

  it('Back: returns (importStationIndex-matchedShots)..(importStationIndex-1)', () => {
    // importStationIndex=5, matchedShots=3 → shots 2,3,4
    const ids = computeOverlapIds(5, 3);
    expect(ids).toEqual(new Set([2, 3, 4]));
  });

  it('Back: single matched shot', () => {
    // importStationIndex=5, matchedShots=1 → shot 4
    const ids = computeOverlapIds(5, 1);
    expect(ids).toEqual(new Set([4]));
  });

  it('Back: matchedShots === importStationIndex (full overlap)', () => {
    // importStationIndex=3, matchedShots=3 → shots 0,1,2
    const ids = computeOverlapIds(3, 3);
    expect(ids).toEqual(new Set([0, 1, 2]));
  });

  it('returns empty set for 0 matched shots', () => {
    expect(computeOverlapIds(0, 0)).toEqual(new Set());
    expect(computeOverlapIds(5, 0)).toEqual(new Set());
  });
});

// ─── computeActionableIds ───────────────────────────────────────────────────

describe('computeActionableIds', () => {
  it('Front: shots 0..mergeImportStation-1 are actionable', () => {
    // importStationIndex=0, matchedShots=3, mergeImportStation=2
    // overlap = {0,1,2}, actionable = shots 0..1 = {0,1}
    const ids = computeActionableIds(0, 3, 2);
    expect(ids).toEqual(new Set([0, 1]));
  });

  it('Front: mergeImportStation=0 → nothing actionable', () => {
    const ids = computeActionableIds(0, 3, 0);
    expect(ids).toEqual(new Set());
  });

  it('Front: mergeImportStation=matchedShots → all overlap actionable', () => {
    const ids = computeActionableIds(0, 3, 3);
    expect(ids).toEqual(new Set([0, 1, 2]));
  });

  it('Back: shots mergeImportStation..(importStationIndex-1) are actionable', () => {
    // importStationIndex=5, matchedShots=3, mergeImportStation=3
    // overlap = {2,3,4}, actionable = shots 3..4 = {3,4}
    const ids = computeActionableIds(5, 3, 3);
    expect(ids).toEqual(new Set([3, 4]));
  });

  it('Back: mergeImportStation=importStationIndex → nothing actionable', () => {
    // mergeImportStation=5, range is 5..4 which is empty
    const ids = computeActionableIds(5, 3, 5);
    expect(ids).toEqual(new Set());
  });

  it('Back: mergeImportStation at overlap start → all overlap actionable', () => {
    // importStationIndex=5, matchedShots=3, mergeImportStation=2
    // overlap = {2,3,4}, actionable = shots 2..4 = {2,3,4}
    const ids = computeActionableIds(5, 3, 2);
    expect(ids).toEqual(new Set([2, 3, 4]));
  });
});

// ─── computeTargetShotIndex ─────────────────────────────────────────────────

describe('computeTargetShotIndex', () => {
  // Example: 3 matched shots, existingStationIndex=10

  describe('Front + forward', () => {
    const params: OverlapParams = {
      importStationIndex: 0,
      matchedShots: 3,
      existingStationIndex: 10,
      direction: 'forward',
    };

    it('overlapId=0 → target 10', () => {
      expect(computeTargetShotIndex(0, params)).toBe(10);
    });

    it('overlapId=1 → target 11', () => {
      expect(computeTargetShotIndex(1, params)).toBe(11);
    });

    it('overlapId=2 → target 12', () => {
      expect(computeTargetShotIndex(2, params)).toBe(12);
    });
  });

  describe('Front + reverse', () => {
    const params: OverlapParams = {
      importStationIndex: 0,
      matchedShots: 3,
      existingStationIndex: 10,
      direction: 'reverse',
    };

    it('overlapId=0 → target 9', () => {
      expect(computeTargetShotIndex(0, params)).toBe(9);
    });

    it('overlapId=1 → target 8', () => {
      expect(computeTargetShotIndex(1, params)).toBe(8);
    });

    it('overlapId=2 → target 7', () => {
      expect(computeTargetShotIndex(2, params)).toBe(7);
    });
  });

  describe('Back + forward', () => {
    // importStationIndex=5, matchedShots=3 → overlapStart=2
    const params: OverlapParams = {
      importStationIndex: 5,
      matchedShots: 3,
      existingStationIndex: 10,
      direction: 'forward',
    };

    it('overlapId=2 (k=0) → target 12', () => {
      expect(computeTargetShotIndex(2, params)).toBe(12);
    });

    it('overlapId=3 (k=1) → target 11', () => {
      expect(computeTargetShotIndex(3, params)).toBe(11);
    });

    it('overlapId=4 (k=2) → target 10', () => {
      expect(computeTargetShotIndex(4, params)).toBe(10);
    });
  });

  describe('Back + reverse', () => {
    // importStationIndex=5, matchedShots=3 → overlapStart=2
    const params: OverlapParams = {
      importStationIndex: 5,
      matchedShots: 3,
      existingStationIndex: 10,
      direction: 'reverse',
    };

    it('overlapId=2 (k=0) → target 7', () => {
      expect(computeTargetShotIndex(2, params)).toBe(7);
    });

    it('overlapId=3 (k=1) → target 8', () => {
      expect(computeTargetShotIndex(3, params)).toBe(8);
    });

    it('overlapId=4 (k=2) → target 9', () => {
      expect(computeTargetShotIndex(4, params)).toBe(9);
    });
  });

  it('handles existingStationIndex=0 with Front+forward', () => {
    const params: OverlapParams = {
      importStationIndex: 0,
      matchedShots: 2,
      existingStationIndex: 0,
      direction: 'forward',
    };
    expect(computeTargetShotIndex(0, params)).toBe(0);
    expect(computeTargetShotIndex(1, params)).toBe(1);
  });
});

// ─── computeMergeOptions ────────────────────────────────────────────────────

describe('computeMergeOptions', () => {
  describe('Front + forward (non-partial)', () => {
    const suggestion = {
      importStationIndex: 0,
      existingStationIndex: 10,
      matchedShots: 3,
      direction: 'forward' as const,
      isPartial: false,
    };

    it('produces matchedShots+1 options', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts).toHaveLength(4); // k=0,1,2,3
    });

    it('first option: import=0, existing=10', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts[0]).toEqual({ offset: 0, importStation: 0, existingStation: 10 });
    });

    it('last option: import=3, existing=13', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts[3]).toEqual({ offset: 3, importStation: 3, existingStation: 13 });
    });

    it('import station increases, existing station increases', () => {
      const opts = computeMergeOptions(suggestion, 8);
      for (let i = 1; i < opts.length; i++) {
        expect(opts[i]!.importStation).toBeGreaterThan(opts[i - 1]!.importStation);
        expect(opts[i]!.existingStation).toBeGreaterThan(opts[i - 1]!.existingStation);
      }
    });
  });

  describe('Front + reverse (non-partial)', () => {
    const suggestion = {
      importStationIndex: 0,
      existingStationIndex: 10,
      matchedShots: 3,
      direction: 'reverse' as const,
      isPartial: false,
    };

    it('produces matchedShots+1 options', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts).toHaveLength(4);
    });

    it('first option: import=0, existing=10', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts[0]).toEqual({ offset: 0, importStation: 0, existingStation: 10 });
    });

    it('last option: import=3, existing=7', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts[3]).toEqual({ offset: 3, importStation: 3, existingStation: 7 });
    });

    it('import station increases, existing station decreases', () => {
      const opts = computeMergeOptions(suggestion, 8);
      for (let i = 1; i < opts.length; i++) {
        expect(opts[i]!.importStation).toBeGreaterThan(opts[i - 1]!.importStation);
        expect(opts[i]!.existingStation).toBeLessThan(opts[i - 1]!.existingStation);
      }
    });
  });

  describe('Back + forward (non-partial)', () => {
    const suggestion = {
      importStationIndex: 5,
      existingStationIndex: 10,
      matchedShots: 3,
      direction: 'forward' as const,
      isPartial: false,
    };

    it('produces matchedShots+1 options', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts).toHaveLength(4);
    });

    it('first option: import=5, existing=10', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts[0]).toEqual({ offset: 0, importStation: 5, existingStation: 10 });
    });

    it('last option: import=2, existing=13', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts[3]).toEqual({ offset: 3, importStation: 2, existingStation: 13 });
    });

    it('import station decreases, existing station increases', () => {
      const opts = computeMergeOptions(suggestion, 8);
      for (let i = 1; i < opts.length; i++) {
        expect(opts[i]!.importStation).toBeLessThan(opts[i - 1]!.importStation);
        expect(opts[i]!.existingStation).toBeGreaterThan(opts[i - 1]!.existingStation);
      }
    });
  });

  describe('Back + reverse (non-partial)', () => {
    const suggestion = {
      importStationIndex: 5,
      existingStationIndex: 10,
      matchedShots: 3,
      direction: 'reverse' as const,
      isPartial: false,
    };

    it('produces matchedShots+1 options', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts).toHaveLength(4);
    });

    it('first option: import=5, existing=10', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts[0]).toEqual({ offset: 0, importStation: 5, existingStation: 10 });
    });

    it('last option: import=2, existing=7', () => {
      const opts = computeMergeOptions(suggestion, 8);
      expect(opts[3]).toEqual({ offset: 3, importStation: 2, existingStation: 7 });
    });

    it('import station decreases, existing station decreases', () => {
      const opts = computeMergeOptions(suggestion, 8);
      for (let i = 1; i < opts.length; i++) {
        expect(opts[i]!.importStation).toBeLessThan(opts[i - 1]!.importStation);
        expect(opts[i]!.existingStation).toBeLessThan(opts[i - 1]!.existingStation);
      }
    });
  });

  it('partial match: maxOffset = matchedShots - 1', () => {
    const suggestion = {
      importStationIndex: 0,
      existingStationIndex: 10,
      matchedShots: 3,
      direction: 'forward' as const,
      isPartial: true,
    };
    const opts = computeMergeOptions(suggestion, 8);
    expect(opts).toHaveLength(3); // k=0,1,2 (not 3)
  });

  it('clamps import station to valid range', () => {
    // importStationIndex=1, matchedShots=3 → k can go up to 3
    // importStation = 1-k: 1, 0, -1 (clamped)
    const suggestion = {
      importStationIndex: 1,
      existingStationIndex: 5,
      matchedShots: 3,
      direction: 'forward' as const,
      isPartial: false,
    };
    const opts = computeMergeOptions(suggestion, 8);
    // k=0: import=1, k=1: import=0, k=2: import=-1 (skip), k=3: import=-2 (skip)
    expect(opts).toHaveLength(2);
    expect(opts[0]).toEqual({ offset: 0, importStation: 1, existingStation: 5 });
    expect(opts[1]).toEqual({ offset: 1, importStation: 0, existingStation: 6 });
  });

  it('clamps existing station to valid range (reverse)', () => {
    const suggestion = {
      importStationIndex: 0,
      existingStationIndex: 1,
      matchedShots: 3,
      direction: 'reverse' as const,
      isPartial: false,
    };
    const opts = computeMergeOptions(suggestion, 8);
    // k=0: existing=1, k=1: existing=0, k=2: existing=-1 (skip), k=3: existing=-2 (skip)
    expect(opts).toHaveLength(2);
    expect(opts[0]).toEqual({ offset: 0, importStation: 0, existingStation: 1 });
    expect(opts[1]).toEqual({ offset: 1, importStation: 1, existingStation: 0 });
  });
});

// ─── reverseTargetShot ──────────────────────────────────────────────────────

describe('reverseTargetShot', () => {
  const shot = makeTargetShot({
    azimuth_in: 45,
    azimuth_out: 46,
    length: 5.0,
    depth_in: 10,
    depth_out: 12,
    pitch_in: -5,
    pitch_out: -6,
    left: 2.0,
    right: 3.0,
    up: 1.5,
    down: 0.5,
  });

  it('adds 180° to azimuths and swaps in/out', () => {
    const reversed = reverseTargetShot(shot);
    expect(reversed.azimuth_in).toBe(226);  // (46+180) % 360
    expect(reversed.azimuth_out).toBe(225); // (45+180) % 360
  });

  it('keeps length unchanged', () => {
    const reversed = reverseTargetShot(shot);
    expect(reversed.length).toBe(5.0);
  });

  it('swaps depth_in and depth_out', () => {
    const reversed = reverseTargetShot(shot);
    expect(reversed.depth_in).toBe(12);
    expect(reversed.depth_out).toBe(10);
  });

  it('negates and swaps pitches', () => {
    const reversed = reverseTargetShot(shot);
    expect(reversed.pitch_in).toBe(6);   // -(-6)
    expect(reversed.pitch_out).toBe(5);  // -(-5)
  });

  it('swaps left and right', () => {
    const reversed = reverseTargetShot(shot);
    expect(reversed.left).toBe(3.0);
    expect(reversed.right).toBe(2.0);
  });

  it('keeps up and down unchanged', () => {
    const reversed = reverseTargetShot(shot);
    expect(reversed.up).toBe(1.5);
    expect(reversed.down).toBe(0.5);
  });

  it('handles null pitches', () => {
    const nullPitch = makeTargetShot({ pitch_in: null, pitch_out: null });
    const reversed = reverseTargetShot(nullPitch);
    expect(reversed.pitch_in).toBeNull();
    expect(reversed.pitch_out).toBeNull();
  });

  it('handles azimuth wrapping past 360°', () => {
    const highAz = makeTargetShot({ azimuth_in: 200, azimuth_out: 190 });
    const reversed = reverseTargetShot(highAz);
    expect(reversed.azimuth_in).toBe(10);  // (190+180) % 360
    expect(reversed.azimuth_out).toBe(20); // (200+180) % 360
  });
});

// ─── Round-trip reversal ────────────────────────────────────────────────────

describe('reverseTargetShot round-trip', () => {
  it('double reversal returns original values', () => {
    const original = makeTargetShot();
    const roundTrip = reverseTargetShot(reverseTargetShot(original));

    expect(roundTrip.azimuth_in).toBeCloseTo(original.azimuth_in, 10);
    expect(roundTrip.azimuth_out).toBeCloseTo(original.azimuth_out, 10);
    expect(roundTrip.length).toBe(original.length);
    expect(roundTrip.depth_in).toBe(original.depth_in);
    expect(roundTrip.depth_out).toBe(original.depth_out);
    expect(roundTrip.pitch_in).toBe(original.pitch_in);
    expect(roundTrip.pitch_out).toBe(original.pitch_out);
    expect(roundTrip.left).toBe(original.left);
    expect(roundTrip.right).toBe(original.right);
    expect(roundTrip.up).toBe(original.up);
    expect(roundTrip.down).toBe(original.down);
  });

  it('round-trip works with null pitches and null dimensions', () => {
    const original = makeTargetShot({
      pitch_in: null,
      pitch_out: null,
      left: null,
      right: null,
    });
    const roundTrip = reverseTargetShot(reverseTargetShot(original));

    expect(roundTrip.pitch_in).toBeNull();
    expect(roundTrip.pitch_out).toBeNull();
    expect(roundTrip.left).toBeNull();
    expect(roundTrip.right).toBeNull();
  });
});

// ─── applyTargetData ────────────────────────────────────────────────────────

describe('applyTargetData', () => {
  it('replaces measurement fields from target', () => {
    const shot = makeEditableShot(0);
    const target = makeTargetShot({ azimuth_in: 200, length: 10 });
    const result = applyTargetData(shot, target);

    expect(result.azimuth_in).toBe(200);
    expect(result.length).toBe(10);
    // Preserved from shot
    expect(result.id).toBe(0);
    expect(result.comment).toBeNull();
    expect(result.is_reference).toBe(false);
  });
});

// ─── interpolateShots ───────────────────────────────────────────────────────

describe('interpolateShots', () => {
  it('averages numeric fields', () => {
    const shot = makeEditableShot(0, { length: 4.0, depth_in: 8, depth_out: 10 });
    const target = makeTargetShot({ length: 6.0, depth_in: 12, depth_out: 14 });
    const result = interpolateShots(shot, target);

    expect(result.length).toBe(5.0);
    expect(result.depth_in).toBe(10);
    expect(result.depth_out).toBe(12);
  });

  it('uses circular mean for azimuths', () => {
    const shot = makeEditableShot(0, { azimuth_in: 350, azimuth_out: 355 });
    const target = makeTargetShot({ azimuth_in: 10, azimuth_out: 5 });
    const result = interpolateShots(shot, target);

    expect(result.azimuth_in).toBeCloseTo(0, 5);
    expect(result.azimuth_out).toBeCloseTo(0, 5);
  });

  it('preserves non-measurement fields', () => {
    const shot = makeEditableShot(42, { comment: 'test', is_reference: true });
    const target = makeTargetShot();
    const result = interpolateShots(shot, target);

    expect(result.id).toBe(42);
    expect(result.comment).toBe('test');
    expect(result.is_reference).toBe(true);
  });
});

// ─── avgNullable ────────────────────────────────────────────────────────────

describe('avgNullable', () => {
  it('averages two numbers', () => {
    expect(avgNullable(4, 6)).toBe(5);
  });

  it('returns non-null when one is null', () => {
    expect(avgNullable(4, null)).toBe(4);
    expect(avgNullable(null, 6)).toBe(6);
  });

  it('returns null when both are null', () => {
    expect(avgNullable(null, null)).toBeNull();
  });
});

// ─── Integration: overlap mode does not flip azimuths 180° ─────────────────

describe('integration: overlap mode correctness', () => {
  /**
   * Scenario: A 5-shot import section overlapping 3 shots with an existing
   * section. The import is heading ~90° and the target is also ~90°.
   *
   * After applying overlap data (existing_data mode), the resulting azimuths
   * should still be ~90°, NOT ~270° (which would be the original bug from
   * incorrect reversal logic).
   */

  // Existing section shots heading ~90° (east)
  const targetShots: TargetShotLike[] = Array.from({ length: 8 }, (_, i) =>
    makeTargetShot({
      azimuth_in: 88 + i,
      azimuth_out: 89 + i,
      length: 3.0 + i * 0.1,
      depth_in: i * 2,
      depth_out: (i + 1) * 2,
    }),
  );

  // Import shots heading ~90° (same direction)
  const importShots: EditableShotLike[] = Array.from({ length: 5 }, (_, i) =>
    makeEditableShot(i, {
      azimuth_in: 89 + i,
      azimuth_out: 90 + i,
      length: 3.1 + i * 0.1,
      depth_in: i * 2,
      depth_out: (i + 1) * 2,
    }),
  );

  it('Front + forward: existing_data preserves ~90° heading', () => {
    const params: OverlapParams = {
      importStationIndex: 0,
      matchedShots: 3,
      existingStationIndex: 5,
      direction: 'forward',
    };
    const reversed = needsDirectionReversal(0, 'forward');
    expect(reversed).toBe(false);

    const overlapIds = computeOverlapIds(0, 3);

    for (const overlapId of overlapIds) {
      const targetIdx = computeTargetShotIndex(overlapId, params);
      const target = targetShots[targetIdx]!;
      const applied = applyTargetData(importShots[overlapId]!, reversed ? reverseTargetShot(target) : target);
      // Azimuth should still be ~90°, not ~270°
      expect(applied.azimuth_in).toBeGreaterThan(80);
      expect(applied.azimuth_in).toBeLessThan(100);
    }
  });

  it('Front + reverse: existing_data preserves ~90° heading after reversal', () => {
    // Target is heading ~270° (opposite), import is heading ~90°.
    // Reversal flips target back to ~90°.
    const reverseTargets: TargetShotLike[] = Array.from({ length: 8 }, (_, i) =>
      makeTargetShot({
        azimuth_in: 268 + i,
        azimuth_out: 269 + i,
        length: 3.0 + i * 0.1,
        depth_in: i * 2,
        depth_out: (i + 1) * 2,
        pitch_in: 5,
        pitch_out: 6,
      }),
    );

    const params: OverlapParams = {
      importStationIndex: 0,
      matchedShots: 3,
      existingStationIndex: 5,
      direction: 'reverse',
    };
    const reversed = needsDirectionReversal(0, 'reverse');
    expect(reversed).toBe(true);

    const overlapIds = computeOverlapIds(0, 3);

    for (const overlapId of overlapIds) {
      const targetIdx = computeTargetShotIndex(overlapId, params);
      const target = reverseTargets[targetIdx]!;
      const applied = applyTargetData(importShots[overlapId]!, reversed ? reverseTargetShot(target) : target);
      // After reversal of ~270° target, azimuth should be ~90°
      expect(applied.azimuth_in).toBeGreaterThan(80);
      expect(applied.azimuth_in).toBeLessThan(100);
    }
  });

  it('Back + forward: existing_data preserves ~90° heading after reversal', () => {
    // Back+forward needs reversal. Target is heading ~270°.
    const reverseTargets: TargetShotLike[] = Array.from({ length: 15 }, (_, i) =>
      makeTargetShot({
        azimuth_in: 268 + (i % 10),
        azimuth_out: 269 + (i % 10),
        length: 3.0 + i * 0.1,
        depth_in: i * 2,
        depth_out: (i + 1) * 2,
        pitch_in: 5,
        pitch_out: 6,
      }),
    );

    const params: OverlapParams = {
      importStationIndex: 5,
      matchedShots: 3,
      existingStationIndex: 10,
      direction: 'forward',
    };
    const reversed = needsDirectionReversal(5, 'forward');
    expect(reversed).toBe(true);

    const overlapIds = computeOverlapIds(5, 3);

    for (const overlapId of overlapIds) {
      const targetIdx = computeTargetShotIndex(overlapId, params);
      const target = reverseTargets[targetIdx]!;
      const applied = applyTargetData(importShots[overlapId]!, reversed ? reverseTargetShot(target) : target);
      expect(applied.azimuth_in).toBeGreaterThan(80);
      expect(applied.azimuth_in).toBeLessThan(100);
    }
  });

  it('Back + reverse: existing_data preserves ~90° heading (no reversal)', () => {
    const params: OverlapParams = {
      importStationIndex: 5,
      matchedShots: 3,
      existingStationIndex: 10,
      direction: 'reverse',
    };
    const reversed = needsDirectionReversal(5, 'reverse');
    expect(reversed).toBe(false);

    const overlapIds = computeOverlapIds(5, 3);

    // Target also heading ~90° (same direction, no reversal needed)
    const sameDirectionTargets: TargetShotLike[] = Array.from({ length: 12 }, (_, i) =>
      makeTargetShot({
        azimuth_in: 88 + (i % 10),
        azimuth_out: 89 + (i % 10),
        length: 3.0 + i * 0.1,
        depth_in: i * 2,
        depth_out: (i + 1) * 2,
      }),
    );

    for (const overlapId of overlapIds) {
      const targetIdx = computeTargetShotIndex(overlapId, params);
      const target = sameDirectionTargets[targetIdx]!;
      const applied = applyTargetData(importShots[overlapId]!, reversed ? reverseTargetShot(target) : target);
      expect(applied.azimuth_in).toBeGreaterThan(80);
      expect(applied.azimuth_in).toBeLessThan(100);
    }
  });
});
