# fn-5-jef.8 Add unit tests for getDepthColor() HSL interpolation

## Description
Add unit tests for the modified `getDepthColor()` function.

## Test File
`src/utils/__tests__/colors.test.ts` (create if doesn't exist)

## Test Cases

### Return Values
```typescript
describe('getDepthColor', () => {
  it('returns shallow color at minimum depth', () => {
    const color = getDepthColor(0, '#00bfff', '#ff4444', 0, 50);
    expect(color).toBe('#00bfff');
  });

  it('returns deep color at maximum depth', () => {
    const color = getDepthColor(50, '#00bfff', '#ff4444', 0, 50);
    expect(color).toBe('#ff4444');
  });

  it('returns intermediate color at midpoint', () => {
    const color = getDepthColor(25, '#00bfff', '#ff4444', 0, 50);
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(color).not.toBe('#00bfff');
    expect(color).not.toBe('#ff4444');
  });
});
```

### Clamping
```typescript
it('clamps depth below minimum to shallow color', () => {
  const color = getDepthColor(-10, '#00bfff', '#ff4444', 0, 50);
  expect(color).toBe('#00bfff');
});

it('clamps depth above maximum to deep color', () => {
  const color = getDepthColor(100, '#00bfff', '#ff4444', 0, 50);
  expect(color).toBe('#ff4444');
});
```

### Edge Cases
```typescript
it('returns shallow color when min equals max', () => {
  const color = getDepthColor(25, '#00bfff', '#ff4444', 25, 25);
  expect(color).toBe('#00bfff');
});

it('returns null for NaN depth', () => {
  const color = getDepthColor(NaN, '#00bfff', '#ff4444', 0, 50);
  expect(color).toBeNull();
});

it('returns null for invalid color format', () => {
  const color = getDepthColor(25, 'invalid', '#ff4444', 0, 50);
  expect(color).toBeNull();
});
```

### HSL Interpolation
```typescript
describe('interpolateHue', () => {
  it('takes shortest path across 0/360 boundary', () => {
    // From 350° to 10° should go through 0°, not 180°
    const result = interpolateHue(350, 10, 0.5);
    expect(result).toBeCloseTo(0, 1);
  });
});
```
## Test File
`src/utils/__tests__/colors.test.ts` (create if doesn't exist)

## Test Cases

### HSL Interpolation Tests
```typescript
describe('getDepthColor', () => {
  it('returns shallow color at minimum depth', () => {
    const color = getDepthColor(0, '#00bfff', '#ff4444', 0, 50);
    expect(color).toBe('#00bfff');
  });

  it('returns deep color at maximum depth', () => {
    const color = getDepthColor(50, '#00bfff', '#ff4444', 0, 50);
    expect(color).toBe('#ff4444');
  });

  it('returns intermediate color at midpoint depth', () => {
    const color = getDepthColor(25, '#00bfff', '#ff4444', 0, 50);
    // Should be somewhere between shallow and deep, via HSL
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(color).not.toBe('#00bfff');
    expect(color).not.toBe('#ff4444');
  });

  it('clamps depth below minimum to shallow color', () => {
    const color = getDepthColor(-10, '#00bfff', '#ff4444', 0, 50);
    expect(color).toBe('#00bfff');
  });

  it('clamps depth above maximum to deep color', () => {
    const color = getDepthColor(100, '#00bfff', '#ff4444', 0, 50);
    expect(color).toBe('#ff4444');
  });

  it('handles equal shallow and deep depth', () => {
    const color = getDepthColor(25, '#00bfff', '#ff4444', 25, 25);
    expect(color).toBe('#00bfff');  // Returns shallow color
  });
});
```

### Helper Function Tests
```typescript
describe('hexToHSL', () => {
  it('converts red correctly', () => {
    expect(hexToHSL('#ff0000')).toEqual({ h: 0, s: 100, l: 50 });
  });

  it('converts blue correctly', () => {
    expect(hexToHSL('#0000ff')).toEqual({ h: 240, s: 100, l: 50 });
  });
});

describe('interpolateHue', () => {
  it('takes shortest path across 0/360 boundary', () => {
    // From 350 to 10 should go through 0, not through 180
    const result = interpolateHue(350, 10, 0.5);
    expect(result).toBe(0);  // Midpoint of 350→10 via 0
  });
});
```
## Acceptance
- [ ] Test file created at `src/utils/__tests__/colors.test.ts`
- [ ] Tests for getDepthColor at min, max, midpoint depths
- [ ] Tests for depth clamping (below min, above max)
- [ ] Test for equal min/max depth returns shallow color
- [ ] Test for NaN depth returns null
- [ ] Test for invalid color format returns null
- [ ] Tests for interpolateHue shortest path
- [ ] All tests pass with `pnpm test`
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
