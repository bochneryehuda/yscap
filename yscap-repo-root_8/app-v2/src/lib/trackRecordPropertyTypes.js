/* WHAT KIND OF BUILDING A PAST DEAL WAS — the PORTAL's copy of the track-record
   property-type vocabulary.

   THIS IS A MIRROR OF `src/lib/property-type.js`, NOT A SECOND OPINION. The
   portal is a browser bundle and cannot require server code (the same
   arrangement as `lib/payoff.js` and `lib/dealBasis.js`), so the list is
   restated here — and `scripts/test-track-record-property-type-pure.js` reads
   BOTH files and fails the build the moment they disagree, value for value and
   group for group. A picker offering a type the server then stores differently
   is exactly the drift that guard exists to stop.

   The reasoning behind every entry — why this list is separate from the loan
   application's `PROPERTY_TYPES`, why the tool's original spellings are kept
   verbatim, why "Condo / townhome" was split, and why `Commercial` and
   `Land / lot` deliberately do not reach a CorrFirst option — lives in the
   server file. Read it there; do not re-argue it here, and do not edit one
   list without the other. */

export const TRACK_RECORD_PROPERTY_GROUPS = [
  {
    group: 'Residential',
    types: [
      'Single-family',
      'Townhouse',
      'Condo',
      'PUD',
      '2-4 unit residential',
      '5+ unit multifamily',
      'Manufactured',
      'Modular',
    ],
  },
  {
    group: 'Commercial & mixed-use',
    types: [
      'Mixed-use',
      'Office',
      'Retail',
      'Industrial',
      'Warehouse',
      'Self storage',
      'Commercial',
    ],
  },
  {
    group: 'Land',
    types: ['Land / lot'],
  },
];

export const TRACK_RECORD_PROPERTY_TYPES =
  TRACK_RECORD_PROPERTY_GROUPS.flatMap((g) => g.types);

// A spelling no longer OFFERED but still on disk — recognised and rendered,
// never dropped. See the server file.
export const TRACK_RECORD_LEGACY_PROPERTY_TYPES = ['Condo / townhome'];

const trkKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const LABEL_BY_KEY = new Map(
  TRACK_RECORD_PROPERTY_TYPES.concat(TRACK_RECORD_LEGACY_PROPERTY_TYPES)
    .map((label) => [trkKey(label), label]));

/** How a stored track-record property type is DISPLAYED. Blank → null. */
export function trackRecordPropertyTypeLabel(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return LABEL_BY_KEY.get(trkKey(s)) || s;
}

/**
 * The groups a picker should OFFER for a line currently holding `current`.
 *
 * A stored value this vocabulary does not carry is APPENDED in its own group
 * rather than dropped — a `<select>` whose value is not among its options
 * renders EMPTY, which is how a screen silently offers to erase an answer the
 * moment somebody saves anything else on the line.
 */
export function trackRecordPropertyTypeOptions(current) {
  const label = trackRecordPropertyTypeLabel(current);
  if (!label) return TRACK_RECORD_PROPERTY_GROUPS;
  if (TRACK_RECORD_PROPERTY_TYPES.includes(label)) return TRACK_RECORD_PROPERTY_GROUPS;
  return TRACK_RECORD_PROPERTY_GROUPS.concat([{ group: 'On this deal', types: [label] }]);
}
