/**
 * WHAT KIND OF BUILDING IS THAT COMPARABLE, AND HOW MANY DOORS DOES IT HAVE?
 *
 * The owner's first requirement for the whole research build: "there shouldn't
 * be a possibility that you should see a comparable in your system that doesn't
 * have how many units the property is, what property type it is."
 *
 * THREE PLACES CAN ANSWER, AND THE BEST-SOURCED ONE WINS.
 *
 *   1. THE COMPARABLE ROW ITSELF. `appraisal_comparables.property_type` /
 *      `.units` / `.identity_basis` (db/430-432) are populated for 769 of 769
 *      real comparables. THIS IS THE PRIMARY ANSWER and it is never discarded.
 *   2. THIS REPORT'S OBSERVATION in the warehouse — a copy of (1), useful only
 *      when the row is missing something.
 *   3. THE PROPERTY ROLL-UP — what every OTHER report that has ever described
 *      that same address concluded, which is the thing no data vendor has.
 *
 * THE FIRST CUT GOT THIS EXACTLY BACKWARDS AND AN AUDIT CAUGHT IT. It nulled the
 * row's own values and re-derived from (2)/(3), on a stated premise — "a MISMO
 * grid has no element for either, which is why those columns do not exist" —
 * that is simply false. Two real comparables at `212-1/2 Rancocas Rd` carry
 * `Multi 2–4 / 2 units / grid`, i.e. the appraiser WROTE IT ON THE GRID, and
 * they rendered as "type not stated · units not stated" in red because
 * `propertyKey` cannot parse that house number so the warehouse never saw them.
 * Worse, one failed warehouse read blanked EVERY comp on the report — and the
 * research ingest is fire-and-forget after an import and drains the back book
 * 400 reports per boot, so a freshly imported report showed an all-red grid as a
 * matter of course. The rule that prevents the whole class: **a later source may
 * only ever IMPROVE on what the row already states, never replace it with
 * nothing.**
 *
 * HOW "BEST-SOURCED" IS DECIDED — by `ingest._internals.identityRank`, the SAME
 * ranking the roll-up itself uses, so the screen and the warehouse can never
 * disagree about which reading to believe: a measurement (a subject observation,
 * where the appraiser stood in the building) outranks a grid statement, which
 * outranks a design-style or per-unit-price reading, which outranks a FORM
 * inference. That last one matters at scale: 409 of 769 real comparables get
 * both facts from `identity_basis='form'` — the 1004 the appraiser happened to
 * use, which proves one dwelling by the form's own definition and nothing more.
 * Without the ranking, a house genuinely counted as a triplex when it was some
 * report's SUBJECT would be re-labelled a single family the moment it turned up
 * as a comparable on a 1004 — which is word for word the trap `rollupProperty`
 * has its own written rule against.
 *
 * TWO MORE RULES THAT LOOK LIKE DETAIL AND ARE NOT:
 *
 * THE PAIR MOVES TOGETHER OR NOT AT ALL. Taking the unit count from one source
 * and the type from another lands "3 units" beside "SFR (1 unit)" on the same
 * row. A source that states both is preferred outright; only if none states both
 * is a partial answer used, and then from ONE source.
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
const PT = require('../property-type');
const PC = require('../appraisal/property-category');

const has = (v) => v != null && v !== '';

/**
 * How well-sourced a reading is, on the ingest's OWN scale. A comparable's basis
 * is whatever the parser recorded; the roll-up's winner may be a SUBJECT
 * observation, which is a measurement and outranks everything.
 */
const rankOfBasis = (basis) => I.identityRank(
  basis === 'subject' ? { role: 'subject', identity_basis: null }
    : { role: 'comparable', identity_basis: basis || null });

/**
 * THE PROPERTY TYPE IS SHOWN IN THE PORTAL'S OWN WORDS.
 *
 * `properties.property_type` holds TWO vocabularies, because
 * `property_observations` does: a comparable observation carries the display
 * label ("Multi 2–4"), while a SUBJECT observation carries the canonical key
 * ("multi_2_4") — and 130 of 955 real property rows carry a raw key. Those are
 * exactly the subject-only properties the roll-up path exists to answer from, so
 * without this a database key reaches the staff tab and the borrower's own
 * property report. An unrecognised value is passed through untouched rather than
 * dropped: a vocabulary we have not seen is still the appraiser's word.
 */
const label = (v) => {
  if (!has(v)) return null;
  // AN ATTACHMENT STYLE IS NOT A CATEGORY (db/405). `canonicalPropertyTypeLabel`
  // maps /detached/ to "SFR (1 unit)", so "Detached", "SemiDetached" and even
  // "Single Family Attached" would all render as a definite one-unit house —
  // a confident wrong answer where the raw value was merely unhelpful. The repo
  // already owns the test; use it rather than a second opinion.
  if (PC.isAttachmentStyle && PC.isAttachmentStyle(v)) return String(v);
  return PT.canonicalPropertyTypeLabel(v) || String(v);
};

/**
 * Attach `property_type` / `units` / `identity_source` / `property_id` to a set
 * of `appraisal_comparables` rows.
 *
 * `identity_source` is one of the `identity_basis` values ('grid' | 'form' |
 * 'style' | 'price'), 'records' when the property roll-up beat this report's own
 * reading, 'subject' for the subject row, or null when nothing establishes it.
 * The caller words it; this decides it.
 *
 * Never throws, and a failure degrades to THE ROW'S OWN VALUES — never to
 * "not stated", which would announce that facts we hold were never given.
 */
async function attachCompIdentity(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const dbc = opts.db || db;
  const appraisal = opts.appraisal || null;

  // SEEDED FROM THE ROW, ALWAYS. Everything below can only improve on this.
  const out = list.map((r) => Object.assign({}, r, {
    property_type: label(r.property_type),
    units: has(r.units) ? Number(r.units) : null,
    // A NULL BASIS IS NOT A CLAIM THAT THE APPRAISER WROTE IT ON THE GRID —
    // labelling it 'grid' asserted a provenance we do not have, while the
    // ranking scored the same row 0. `stated` says only that the row states it.
    identity_source: (has(r.property_type) || has(r.units)) ? (r.identity_basis || 'stated') : null,
    identity_observations: null, property_id: null,
  }));

  // The subject row is not a warehouse question — the report states it outright,
  // and `property-category.applyPropertyType` has already turned the appraisal's
  // stored value into a real category.
  for (const r of out) {
    if (!r.is_subject || !appraisal) continue;
    if (has(appraisal.property_type)) r.property_type = label(appraisal.property_type);
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
              p.units_basis AS roll_basis, p.observation_count
         FROM property_observations o
         LEFT JOIN properties p ON p.id = o.property_id
        WHERE o.comparable_id = ANY($1::uuid[])`, [ids])).rows;
  } catch (e) { return out; }

  const byComp = new Map();
  for (const o of obs) if (!byComp.has(o.comparable_id)) byComp.set(o.comparable_id, o);

  for (const r of out) {
    if (r.is_subject) continue;
    const o = byComp.get(r.id);
    if (!o) continue;                                   // the row's own answer stands
    r.property_id = o.property_id || null;
    r.identity_observations = o.observation_count != null ? Number(o.observation_count) : null;

    const src = list.find((x) => x.id === r.id) || {};
    // EVERY CANDIDATE ON ONE SCALE. Ordered best-first by how it was established;
    // ties keep this report's own statement, which needs no extra hop.
    const candidates = [
      { type: src.property_type, units: src.units, source: src.identity_basis || 'stated',
        rank: rankOfBasis(src.identity_basis) },
      { type: o.obs_type, units: o.obs_units, source: o.identity_basis || 'stated',
        rank: rankOfBasis(o.identity_basis) },
      { type: o.roll_type, units: o.roll_units, source: 'records', rank: rankOfBasis(o.roll_basis) },
    ].filter((c) => has(c.type) || has(c.units));
    if (!candidates.length) continue;

    // THE RANK DECIDES, AND COMPLETENESS ONLY BREAKS A TIE. Preferring a
    // complete answer FIRST let a form inference (rank 1) that states both beat
    // a grid statement (rank 3) that states only a count — and then, because
    // both fields were assigned from the winner, it DELETED the count the
    // appraiser had written and reddened the cell. Reproduced both ways against
    // a real database. The file's own headline rule is that a later source may
    // only ever improve on what the row states, so:
    //   · the best-sourced candidate wins; a complete answer breaks a tie
    //     between equals, which is where "the pair moves together" belongs;
    //   · a winner that states only ONE fact leaves the other where it was,
    //     rather than nulling it — but only if the seed does not contradict the
    //     band it just claimed, which cannot happen here because a candidate
    //     stating one fact never overwrites the other's source.
    const better = (a, b) => {
      if (b.rank !== a.rank) return b.rank > a.rank ? b : a;
      const ca = has(a.type) && has(a.units), cb = has(b.type) && has(b.units);
      return (cb && !ca) ? b : a;
    };
    const pick = candidates.reduce(better, candidates[0]);

    // NEVER LESS THAN THE ROW ALREADY SAID. A pick that states one fact upgrades
    // that fact and leaves the other as it was seeded.
    //
    // …BUT THE PAIR MUST NEVER CONTRADICT ITSELF. Ranking first (which is what
    // stops a form inference deleting a counted triplex) means the two facts can
    // now arrive from two different candidates — so a subject observation stating
    // `units=1` could land beside a grid statement of `Multi 2–4` and the row
    // would read "Multi 2–4 · 1 unit". That is not a partial answer, it is a
    // confident wrong one, and it is worse than either fact alone. When they
    // disagree, the BETTER-SOURCED fact stands and the other is dropped.
    const nextType = has(pick.type) ? label(pick.type) : r.property_type;
    const nextUnits = has(pick.units) ? Number(pick.units) : r.units;
    // Where each fact would be coming from, which is what makes the honesty
    // check below possible at all.
    const typeFrom = has(pick.type) ? pick.source : r.identity_source;
    const unitsFrom = has(pick.units) ? pick.source : r.identity_source;
    const typeRank = has(pick.type) ? pick.rank : rankOfBasis(r.identity_basis);
    const unitsRank = has(pick.units) ? pick.rank : rankOfBasis(r.identity_basis);

    if (PT.unitsContradictType(nextType, nextUnits)) {
      // The better-sourced one survives; a tie keeps the COUNT, because a count
      // is a measurement and a category is a reading of one.
      if (typeRank > unitsRank) { r.property_type = nextType; r.units = null; r.identity_source = typeFrom; }
      else { r.units = nextUnits; r.property_type = null; r.identity_source = unitsFrom; }
      continue;
    }

    r.property_type = nextType;
    r.units = nextUnits;
    // THE SOURCE MUST DESCRIBE WHAT IT ACTUALLY SOURCED. Stamping `pick.source`
    // for the whole row claimed the grid had stated a type the grid never
    // mentioned, whenever the pick supplied only the count — the same class of
    // over-claim that `units_basis` exists to prevent.
    if (has(pick.type) || has(pick.units)) {
      r.identity_source = typeFrom === unitsFrom ? typeFrom : `${typeFrom} + ${unitsFrom}`;
    }
  }
  return out;
}

module.exports = { attachCompIdentity, _internals: { rankOfBasis, label } };
