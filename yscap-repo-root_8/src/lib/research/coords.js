/**
 * A COORDINATE IS A PAIR — BOTH OR NEITHER.
 *
 * A latitude with no longitude is not a position. It reads as one to every
 * `IS NOT NULL` check written on a single column, and `properties.eff_latitude`
 * is a GENERATED `COALESCE(geo_latitude, latitude)`, so a half pair makes a
 * property look placed while nothing can place it.
 *
 * MEASURED ON THE REAL CORPUS, and it is not hypothetical: 11 comparables carry
 * a latitude and no longitude, and it propagates the whole way —
 * `appraisal_comparables` → `property_observations` → `properties` →
 * `eff_latitude`. Worse, the values are not latitudes at all: `-86.96`,
 * `-86.98`, `-74.74`. Those are LONGITUDES (Alabama, then New Jersey), written
 * by the vendor into `LatitudeNumber` with `LongitudeNumber` left empty. The
 * parser is right to bound a latitude to ±90 — and every one of these passes
 * that bound, because a US longitude is a perfectly legal latitude. Only the
 * MISSING OTHER HALF gives it away.
 *
 * The distance search happens to require both columns, so nothing has yet shown
 * a wrong distance. That is luck, not design: the next surface to write
 * `WHERE latitude IS NOT NULL` — a map, a property page, an export — plots a
 * house in the Gulf of Guinea. This is the same class as `gla_basis` travelling
 * without the `gla` it describes (105 property rows reading "we do not know the
 * area, but we know it is a building area"), and it gets the same answer: the
 * pair moves together or not at all.
 *
 * Deliberately NOT a plausibility check on the values. All 441 complete pairs in
 * the corpus sit inside the US bounding box, so there is nothing to catch, and a
 * geographic whitelist would refuse the first legitimate market outside it.
 *
 * Pure.
 */
'use strict';

const ok = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/**
 * @returns {{latitude:number|null, longitude:number|null}} — both, or both null.
 */
function coordPair(lat, lng) {
  const la = ok(lat), lo = ok(lng);
  return (la != null && lo != null) ? { latitude: la, longitude: lo }
    : { latitude: null, longitude: null };
}

/** True when the two together are a usable position. */
const placed = (row) => !!(row && ok(row.latitude) != null && ok(row.longitude) != null);

module.exports = { coordPair, placed };
