/**
 * [#650] The baked pre-release rule About's version is built from. Mirrors the
 * Rust tests on `effective_version` (src-tauri/src/commands/app_update.rs):
 * `the_baked_prerelease_makes_the_effective_version`,
 * `a_final_build_is_its_plain_package_version` and
 * `an_invalid_prerelease_falls_back_to_the_plain_version` - same inputs, same
 * answers, so the two implementations cannot drift apart unnoticed.
 */
import { describe, it, expect } from 'vitest';
import { readBakedPrerelease } from '../semverPrerelease';

describe('readBakedPrerelease', () => {
  it.each([
    ['rc.1', 'rc.1'],
    ['rc.2', 'rc.2'],
    ['rc.10', 'rc.10'],
    // Trimmed, as Rust trims.
    [' rc.10 ', 'rc.10'],
  ])('%j is the candidate pre-release %j', (raw, prerelease) => {
    expect(readBakedPrerelease(raw)).toEqual({ kind: 'candidate', prerelease });
  });

  it.each([[undefined], [''], ['   ']])('%j is a final release', (raw) => {
    expect(readBakedPrerelease(raw)).toEqual({ kind: 'final' });
  });

  it.each([
    ['rc.02', 'a leading zero in a numeric identifier'],
    ['rc..2', 'an empty identifier'],
    ['rc 2', 'a space'],
    ['rc.2+abc', 'build metadata, which is not part of a pre-release'],
    ['-rc.2', 'a leading hyphen'],
  ])('%j is refused: %s', (raw) => {
    expect(readBakedPrerelease(raw)).toEqual({ kind: 'invalid', value: raw });
  });
});
