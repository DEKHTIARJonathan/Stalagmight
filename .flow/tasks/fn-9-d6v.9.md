# fn-9-d6v.9 Unit tests for expression builder

## Description
Comprehensive unit tests for the MapLibre expression builder utility.

## New File: `src/utils/maplibre-expressions.test.ts`

### Test Categories

**1. buildPriorityExpression tests:**
```typescript
describe('buildPriorityExpression', () => {
  it('returns fallback when priorities array is empty', () => {
    expect(buildPriorityExpression([], 1)).toBe(1);
  });

  it('builds correct case expression with single priority', () => {
    const result = buildPriorityExpression([
      { condition: ['==', ['get', 'id'], 'abc'], value: 3 }
    ], 1);
    expect(result).toEqual([
      'case',
      ['==', ['get', 'id'], 'abc'], 3,
      1
    ]);
  });

  it('maintains priority order (first condition wins)', () => {
    const result = buildPriorityExpression([
      { condition: ['==', ['get', 'id'], 'a'], value: 4 },
      { condition: ['==', ['get', 'id'], 'b'], value: 3 },
      { condition: ['==', ['get', 'id'], 'c'], value: 2 },
    ], 1);
    // Verify array structure matches MapLibre case syntax
  });

  it('handles string fallback values', () => {
    const result = buildPriorityExpression([...], '#000000');
    expect(result[result.length - 1]).toBe('#000000');
  });
});
```

**2. featureEquals tests:**
```typescript
describe('featureEquals', () => {
  it('creates equality expression for property', () => {
    expect(featureEquals('id', 'station-1')).toEqual(
      ['==', ['get', 'id'], 'station-1']
    );
  });

  it('handles null value by using empty string', () => {
    expect(featureEquals('id', null)).toEqual(
      ['==', ['get', 'id'], '']
    );
  });
});
```

**3. inSection tests:**
```typescript
describe('inSection', () => {
  it('creates sectionId equality expression', () => {
    expect(inSection('section-abc')).toEqual(
      ['==', ['get', 'sectionId'], 'section-abc']
    );
  });

  it('handles null sectionId', () => {
    expect(inSection(null)).toEqual(
      ['==', ['get', 'sectionId'], '']
    );
  });
});
```

**4. Integration/mock tests:**
```typescript
describe('expression builder with mocked map', () => {
  it('produces valid expressions for setPaintProperty', () => {
    const mockMap = {
      setPaintProperty: vi.fn(),
    };
    
    const expr = buildPriorityExpression([
      { condition: inSection('sec-1'), value: 3 }
    ], 1);
    
    mockMap.setPaintProperty('layer-id', 'circle-stroke-width', expr);
    
    expect(mockMap.setPaintProperty).toHaveBeenCalledWith(
      'layer-id',
      'circle-stroke-width',
      ['case', ['==', ['get', 'sectionId'], 'sec-1'], 3, 1]
    );
  });
});
```

## Test Runner
Use Vitest (already configured in project) with `pnpm test`.
## Acceptance
- [ ] Test file created at `src/utils/maplibre-expressions.test.ts`
- [ ] Tests for `buildPriorityExpression` with empty array
- [ ] Tests for `buildPriorityExpression` with single priority
- [ ] Tests for `buildPriorityExpression` with multiple priorities (order preserved)
- [ ] Tests for `buildPriorityExpression` with string fallback values
- [ ] Tests for `featureEquals` with valid value
- [ ] Tests for `featureEquals` with null value
- [ ] Tests for `inSection` with valid sectionId
- [ ] Tests for `inSection` with null sectionId
- [ ] Mock integration test verifying setPaintProperty receives correct expression
- [ ] All tests pass with `pnpm test`
- [ ] Tests cover edge cases (empty array, null values)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
