/**
 * WHERE A DISTANCE CAME FROM, in words a person can act on (db/446).
 *
 * `properties.eff_geo_source` says which of four things the coordinate under a
 * distance actually is, and they are not remotely equivalent:
 *
 *   · `census` / `osm`      — our own lookup, stored only on an exact-address
 *                             match, so a rooftop.
 *   · `comp_trilateration`  — derived from the comparables around the property.
 *                             Measured on the real corpus: median 17 feet out,
 *                             worst 67. Excellent, and still an ESTIMATE.
 *   · `appraiser`           — the coordinate the appraisal itself carried, at
 *                             unknown precision. db/412's own comment says these
 *                             are "frequently the centre of the ZIP".
 *   · `mixed`               — a latitude from one source and a longitude from
 *                             another. A data problem, shown rather than trusted.
 *
 * A ZIP centroid is a mile or more from the house, so "0.3 miles away" computed
 * from one is not a slightly worse answer — it is a number with no relationship
 * to the question, and it was being rendered in exactly the same font as a
 * rooftop measurement. This module is the one place that decides how each is
 * said, so no two screens can describe the same basis differently.
 *
 * `trusted` is the flag a screen uses to decide whether to WARN. It is
 * deliberately not a score: ranking these on one scale invites a threshold
 * nobody can justify, and the useful question is only ever "is this measured
 * from the building, or from somewhere near it?".
 */
export const GEO_BASIS = {
  census: { label: 'exact address', detail: 'Looked up to the address (US Census).', trusted: true },
  osm: { label: 'exact address', detail: 'Looked up to the address (OpenStreetMap).', trusted: true },
  lookup: { label: 'exact address', detail: 'Looked up to the address.', trusted: true },
  comp_trilateration: {
    label: 'placed from its comparables',
    detail: 'No address lookup for this one — the position was worked out from the distances the '
      + 'appraiser stated to each comparable. Typically within about 20 feet.',
    trusted: true,
  },
  appraiser: {
    label: 'appraiser’s own coordinate',
    detail: 'This is the coordinate that came with the appraisal, and those are often the centre '
      + 'of the ZIP code rather than the building — so treat the distance as rough.',
    trusted: false,
  },
  mixed: {
    label: 'position is inconsistent',
    detail: 'The latitude and longitude came from two different sources. Do not rely on this '
      + 'distance.',
    trusted: false,
  },
};

/** The entry for a basis, or null when the property states none. */
export function geoBasisInfo(basis) {
  if (!basis) return null;
  return GEO_BASIS[String(basis)] || {
    label: String(basis),
    detail: 'This position came from a source this screen does not recognise.',
    trusted: false,
  };
}

/** True only when the distance is worth reading as a measurement. */
export const geoBasisTrusted = (basis) => !!(geoBasisInfo(basis) || {}).trusted;
