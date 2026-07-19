import type { ExpressionSpecification } from 'maplibre-gl';

/** Dim matching labels without nesting zoom below a non-camera expression. */
export function dimmedZoomOpacity(
  dimmedCheck: ExpressionSpecification,
): ExpressionSpecification {
  return [
    'interpolate', ['linear'], ['zoom'],
    14, ['case', dimmedCheck, 0.25, 0.7],
    18, ['case', dimmedCheck, 0.25, 1],
  ] as ExpressionSpecification;
}
