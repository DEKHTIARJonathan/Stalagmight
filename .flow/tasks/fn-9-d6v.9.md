# fn-9-d6v.9 Unit tests for expression builder

## Description
Comprehensive unit tests for the MapLibre expression builder utility.

## New File: `src/utils/maplibre-expressions.test.ts`

### Test Approach
**Tests assert on plain array structure** - expressions are just nested arrays, no MapLibre runtime needed.

```typescript
// Type import only (no runtime dependency)
import type { ExpressionSpecification } from 'maplibre-gl';

// Functions return arrays that happen to satisfy ExpressionSpecification
// Tests verify the array structure matches expected MapLibre case syntax
```

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
    
    // Assert plain array structure
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
    
    // Verify conditions appear in order
    expect(result[0]).toBe('case');
    expect(result[1]).toEqual(['==', ['get', 'id'], 'a']);
    expect(result[2]).toBe(4);
    // ...
  });

  it('handles string fallback values', () => {
    const result = buildPriorityExpression([
      { condition: ['boolean', true], value: '#ff0000' }
    ], '#000000');
    
    expect(result[result.length - 1]).toBe('#000000');
  });
});
```

**2. compositeIdEquals tests:**
```typescript
describe('compositeIdEquals', () => {
  it('creates concat + equality expression', () => {
    const result = compositeIdEquals(['sectionId', 'stationIndex'], '123:0');
    
    expect(result).toEqual([
      '==',
      ['concat', ['to-string', ['get', 'sectionId']], ':', ['to-string', ['get', 'stationIndex']]],
      '123:0'
    ]);
  });

  it('handles null value by using empty string', () => {
    const result = compositeIdEquals(['sectionId', 'stationIndex'], null);
    
    expect(result[2]).toBe('');  // Fallback to empty string
  });
});
```

**3. inSection tests:**
```typescript
describe('inSection', () => {
  it('creates to-string + equality expression', () => {
    const result = inSection('123');
    
    expect(result).toEqual([
      '==',
      ['to-string', ['get', 'sectionId']],
      '123'
    ]);
  });

  it('handles null sectionId by using empty string', () => {
    const result = inSection(null);
    
    expect(result[2]).toBe('');
  });
});
```

**4. Integration test with mock map:**
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
      ['case', ['==', ['to-string', ['get', 'sectionId']], 'sec-1'], 3, 1]
    );
  });
});
```

## Test Runner
Use Vitest (already configured in project) with `pnpm test`.
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
- [ ] Uses type-only import for ExpressionSpecification (no runtime dependency)
- [ ] Tests assert on plain array structure (nested arrays)
- [ ] Tests for `buildPriorityExpression` with empty array (returns fallback)
- [ ] Tests for `buildPriorityExpression` with single priority
- [ ] Tests for `buildPriorityExpression` with multiple priorities (order preserved)
- [ ] Tests for `buildPriorityExpression` with string fallback values
- [ ] Tests for `compositeIdEquals` with valid value (concat + to-string)
- [ ] Tests for `compositeIdEquals` with null value (empty string fallback)
- [ ] Tests for `inSection` with valid sectionId (to-string conversion)
- [ ] Tests for `inSection` with null sectionId (empty string fallback)
- [ ] Mock integration test verifying setPaintProperty receives correct expression
- [ ] All tests pass with `pnpm test`
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
