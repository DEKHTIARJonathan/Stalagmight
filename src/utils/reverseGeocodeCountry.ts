import { COUNTRY_BOUNDS } from '../data/countryBounds';

/**
 * Offline reverse-geocode (#217): map a WGS84 lat/long to an ISO 3166-1 alpha-2
 * country code using the coarse bounding-box table in `data/countryBounds.ts`. No
 * network. Returns `null` when the point falls outside every known box (leave the
 * field empty rather than guess a wrong country) or when the input is not a finite,
 * in-range coordinate.
 *
 * When several boxes contain the point (e.g. near a shared border, or an island
 * nation inside a larger box), the country whose box-centre is nearest wins. This
 * is a convenience prefill for a user-editable field, not an authoritative geocode -
 * an interior point is usually right; a coastal/border point may need one correction.
 */
export function reverseGeocodeCountry(latitude: number, longitude: number): string | null {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  let best: string | null = null;
  let bestDist = Infinity;
  for (const [code, minLat, maxLat, minLon, maxLon] of COUNTRY_BOUNDS) {
    if (latitude < minLat || latitude > maxLat || longitude < minLon || longitude > maxLon) {
      continue;
    }
    // Squared lat/long distance to the box centre - fine as a tie-break at these
    // scales (no need for a great-circle metric to rank overlapping boxes).
    const dLat = latitude - (minLat + maxLat) / 2;
    const dLon = longitude - (minLon + maxLon) / 2;
    const dist = dLat * dLat + dLon * dLon;
    if (dist < bestDist) {
      bestDist = dist;
      best = code;
    }
  }
  return best;
}
