/**
 * MapLibre expression builder utilities for priority-based styling.
 *
 * These pure functions build MapLibre GL JS expressions as nested arrays.
 * They can be easily unit tested since expressions are just data structures.
 *
 * @see https://maplibre.org/maplibre-style-spec/expressions/
 */

/**
 * MapLibre expression type - nested array structure.
 * Using unknown[] since maplibre-gl doesn't export ExpressionSpecification directly.
 */
export type Expression = unknown[];

/**
 * A priority level for building case expressions.
 * Higher priority conditions (earlier in array) override lower ones.
 */
export interface PriorityLevel {
  /** MapLibre boolean expression that evaluates the condition */
  condition: Expression;
  /** Value to return when condition is true */
  value: number | string;
}

/**
 * Builds a MapLibre case expression with priority-ordered conditions.
 * Higher priority conditions (earlier in array) override lower ones.
 *
 * @example
 * const strokeWidth = buildPriorityExpression([
 *   { condition: compositeIdEquals(['sectionId', 'stationIndex'], '1:5'), value: 4 },
 *   { condition: inSection('1'), value: 3 },
 * ], 1);
 * // Returns: ['case', ['==', ...], 4, ['==', ...], 3, 1]
 */
export function buildPriorityExpression(
  priorities: PriorityLevel[],
  fallback: number | string
): Expression | number | string {
  if (priorities.length === 0) return fallback;

  const cases: unknown[] = ['case'];
  for (const { condition, value } of priorities) {
    cases.push(condition, value);
  }
  cases.push(fallback);

  return cases;
}

/**
 * Creates an equality condition for composite ID matching.
 * Used for station/shot IDs in format "sectionId:index".
 *
 * CRITICAL: Feature properties store sectionId as NUMBER.
 * This function converts both parts to strings before concatenating
 * to ensure reliable comparison.
 *
 * @param parts - Tuple of [sectionIdProp, indexProp] property names
 * @param value - The composite ID to match (e.g., "1:5") or null
 *
 * @example
 * compositeIdEquals(['sectionId', 'stationIndex'], '1:5')
 * // Returns: ['==', ['concat', ['to-string', ['get', 'sectionId']], ':', ['to-string', ['get', 'stationIndex']]], '1:5']
 */
export function compositeIdEquals(
  parts: [string, string],
  value: string | null
): Expression {
  const idExpr = [
    'concat',
    ['to-string', ['get', parts[0]]],
    ':',
    ['to-string', ['get', parts[1]]],
  ];
  return ['==', idExpr, value ?? ''];
}

/**
 * Creates a section membership condition.
 *
 * CRITICAL: sectionId is stored as NUMBER in feature properties.
 * This function converts it to string for comparison to avoid
 * type mismatch issues in MapLibre expressions.
 *
 * @param sectionId - Section ID as string (will be compared to stringified feature property)
 *
 * @example
 * inSection('1')
 * // Returns: ['==', ['to-string', ['get', 'sectionId']], '1']
 *
 * inSection(null)
 * // Returns: ['==', ['to-string', ['get', 'sectionId']], '']
 */
export function inSection(sectionId: string | null): Expression {
  // Features store sectionId as number - convert to string for comparison
  return ['==', ['to-string', ['get', 'sectionId']], sectionId ?? ''];
}
