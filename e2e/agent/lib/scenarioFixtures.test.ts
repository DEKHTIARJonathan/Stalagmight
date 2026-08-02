import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_FIXTURE, fixturePath } from '../scenarios/common';

describe('agent fixture resolution', () => {
  it('points the default seed and scenarios at a tracked fixture', () => {
    expect(path.basename(fixturePath(DEFAULT_FIXTURE))).toBe(DEFAULT_FIXTURE);
    expect(fs.existsSync(fixturePath(DEFAULT_FIXTURE))).toBe(true);
  });

  it('confines caller-supplied fixture names to the fixture directory', () => {
    expect(fixturePath('../../outside.stalx')).toBe(fixturePath('outside.stalx'));
  });
});
