/**
 * WHAT KIND OF BUILDING IS THAT COMPARABLE, AND HOW MANY DOORS DOES IT HAVE?
 *
 * The owner's first requirement for the whole research build: "there shouldn't
 * be a possibility that you should see a comparable in your system that doesn't
 * have how many units the property is, what property type it is."
 *
 * The comp SEARCH answers it, the property page answers it and the valuation
 * grid answers it — they all read the warehouse, which stores those two facts
 * per observation. The APPRAISAL TAB did not, and that is the surface an
 * underwriter actually reviews an appraiser's own comps on: its grid showed the
 * address, the distance, the living area, the beds, the baths, the condition
 * and the price, and nothing about what the building IS. So a three-family
 * could sit in the As-Is grid of a single-family report with nothing on the
 * screen saying so.
 *
 * `appraisal_comparables` cannot answer it on its own — a MISMO 2.6 sales grid
 * has no element for a comparable's property type or unit count, which is why
 * those columns do not exist on that table. The warehouse answers it, three
 * ways, and this module is the one place that decides which:
 *
 *   1. THIS REPORT'S OWN OBSERVATION. The ingest already resolved it when the
 *      report was filed and recorded HOW (`identity_basis`): `grid` — the
 *      appraiser stated it on an adjustment line; `form` — the report form only
 *      compares that kind of dwelling, so a 1004 comp is one unit by the form's
 *      own definition; `style` — read from the stated design.
 *   2. THE PROPERTY ROLL-UP — what every OTHER report that has ever described
 *      that same address says, which is the thing no data vendor has and the
 *      entire reason the warehouse was built.
 *   3. Nothing, which SAYS SO. A blank column reads as "ordinary" and that is
 *      the misreading the requirement exists to prevent.
 *
 * TWO RULES THAT LOOK LIKE DETAIL AND ARE NOT:
 *
 * THE PAIR MOVES TOGETHER OR NOT AT ALL. Taking the unit count from one source
 * and the type from another lands "3 units" beside "SFR (1 unit)" on the same
 * row — the self-contradiction `ingest.rollupProperty` has its own rule to
 * prevent. A source that states both is preferred outright; only if none states
 * both is a partial answer used, and then from ONE source.
 *
 * NOTHING IS EVER INHERITED FROM THE REPORT'S SUBJECT. It is the tempting fix
 * (every comp on a 1025 is *probably* a 2-4) and it is fabrication: it would
 * paint the answer onto every row whether or not anyone established it, and the
 * one comp that is genuinely a different kind of building — the exact thing an
 * underwriter is looking for — would be the one it hid. `identity_basis='form'`
 * is NOT subject inheritance: it is what the FORM proves about its own grid.
 */
'use strict';
const db = require('../../db');
const { _internals: I } = require('./ingest');

const has = (v) => v != null && v !== '';

/**
 * Which of two readings of one comparable to believe. Delegates to the ingest's
 * OWN ranking so this can never disagree with the roll-up that produced the
 * property row it falls back to.
 */
function betterObservation(a, b) {
  if (!a) return b;
  if (!b) return a;
  return I.identityRank(b) > I.identityRank(a) ? b : a;
}

/**
 * Attach `property_type` / `units` / `identity_source` / `property_id` to a set
 * of `appraisal_comparables` rows.
 *
 * `identity_source` is one of the `identity_basis` values ('grid' | 'form' |
 * 'style' | 'price'), 'records' when it came from the property roll-up rather
 * than from this report, 'subject' for the subject row, or null when nothing
 * establishes it. The caller words it; this decides it.
 *
 * Never throws: the appraisal tab must still render if the warehouse is
 * unreachable, and a missing fact reads exactly like an unstated one.
 */
async function attachCompIdentity(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const dbc = opts.db || db;
  const appraisal = opts.appraisal || null;
  const out = list.map((r) => Object.assign({}, r, {
    property_type: null, units: null, identity_source: null,
    identity_observations: null, property_id: null,
  }));

  // The subject row is not a warehouse question — the report states it outright,
  // and `property-category.applyPropertyType` has already turned the appraisal's
  // stored value into a real category.
  for (const r of out) {
    if (!r.is_subject || !appraisal) continue;
    if (has(appraisal.property_type)) r.property_type = appraisal.property_type;
    if (has(appraisal.units)) r.units = Number(appraisal.units);
    if (r.property_type != null || r.units != null) r.identity_source = 'subject';
  }

  const ids = out.filter((r) => !r.is_subject && r.id).map((r) => r.id);
  if (!ids.length) return out;

  let obs = [];
  try {
    obs = (await dbc.query(
      `SELECT o.comparable_id, o.property_id, o.role, o.identity_basis,
              o.property_type AS obs_type, o.units AS obs_units,
              p.property_type AS roll_type, p.units AS roll_units,
              p.observation_count
         FROM property_observations o
         LEFT JOIN properties p ON p.id = o.property_id
        WHERE o.comparable_id = ANY($1::uuid[])`, [ids])).rows;
  } catch (e) { return out; }

  // `uq_prop_obs_comparable` makes this one row per comparable, but a stale
  // duplicate must not decide the answer on rank order alone — keep the
  // better-sourced reading rather than whichever row the scan returned last.
  const byComp = new Map();
  for (const o of obs) byComp.set(o.comparable_id, betterObservation(byComp.get(o.comparable_id), o));

  for (const r of out) {
    if (r.is_subject) continue;
    const o = byComp.get(r.id);
    if (!o) continue;
    r.property_id = o.property_id || null;
    r.identity_observations = o.observation_count != null ? Number(o.observation_count) : null;
    // THE PAIR MOVES TOGETHER. A source stating both wins outright; a partial
    // answer is only ever taken whole from one source.
    const candidates = [
      { type: o.obs_type, units: o.obs_units, source: o.identity_basis || 'grid' },
      { type: o.roll_type, units: o.roll_units, source: 'records' },
    ];
    const pick = candidates.find((c) => has(c.type) && has(c.units))
      || candidates.find((c) => has(c.type) || has(c.units));
    if (!pick) continue;
    if (has(pick.type)) r.property_type = pick.type;
    if (has(pick.units)) r.units = Number(pick.units);
    r.identity_source = pick.source;
  }
  return out;
}

module.exports = { attachCompIdentity, _internals: { betterObservation } };
