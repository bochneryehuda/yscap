'use strict';
/**
 * WHERE TWO REPORTS DISAGREE ABOUT THE SAME HOUSE.
 *
 * The warehouse holds one row per report × property, never overwritten, so a
 * property described by four appraisals holds four opinions. The roll-up picks
 * ONE of them for the property row (best-sourced, then most recent) — which is
 * the right answer for "what do we think this house is", and throws away the
 * fact that the reports did not agree.
 *
 * That disagreement is a review signal nobody else can compute, because nobody
 * else holds several appraisals of one house. Measured across the 152 real
 * reports: 766 distinct properties, 119 of them described by more than one
 * report, and 13 of those carrying a disagreement.
 *
 * THE WHOLE DESIGN IS THE TOLERANCE, and getting it wrong is how this feature
 * becomes noise that everybody learns to ignore. From the same measurement:
 *
 *   · year built  1909 vs 1910   — noise. Appraisers round, and public records
 *                                  differ by a year on half the housing stock.
 *   · year built  1906 vs 1930   — real. That is a different building era, and
 *                                  it changes the comparable set.
 *   · living area  745 vs 719    — noise. 3.5%, inside ordinary measurement
 *                                  variance between two people with tapes.
 *   · living area 1540 vs 1632   — real. 6% is a room.
 *   · units          2 vs 3      — ALWAYS real. There is no measurement variance
 *                                  in a dwelling count: it is a different
 *                                  building, and it is the fact the owner named
 *                                  first.
 *
 * So each fact carries its own tolerance and its own reason for it, and a fact
 * whose tolerance is zero says so explicitly rather than by omission.
 *
 * ADVISORY, ALWAYS. This reports; it never edits an observation, never changes
 * the roll-up, and never resolves a disagreement. Two appraisers are allowed to
 * disagree — a human decides which is right, or that both are.
 *
 * Pure except for `conflictsForProperty`, which is a thin database read on top.
 * `property-type` is required for its comparison key and is itself pure — it
 * carries no database and no clock.
 */

const { propertyTypeCompareKey } = require('../property-type');

/**
 * WHAT COUNTS AS A DISAGREEMENT, per fact.
 *
 * `tolerance` is absolute for a count and fractional for a measurement. A fact
 * absent from this table is NOT compared — silence here means "we have not
 * decided what a meaningful difference looks like", which is honest, where a
 * default of zero would flag every rounding difference in the warehouse.
 */
const COMPARED = Object.freeze({
  units: {
    label: 'Unit count', kind: 'exact',
    // No tolerance, and this is the point. A count of dwellings is not measured,
    // it is counted, and two people cannot honestly count 2 and 3 in the same
    // building. It is also the fact everything downstream keys on — the property
    // type, the price per door, whether it is even a comparable.
    why: 'a dwelling count is counted, not measured — there is no honest variance in it',
    severity: 'high',
  },
  property_type: {
    label: 'Property type', kind: 'exact',
    why: 'a house is a house or it is a duplex; the two are not a matter of degree',
    severity: 'high',
    // COMPARED BY MEANING, NEVER BY SPELLING. The warehouse deliberately stores
    // TWO VOCABULARIES for this one column, both written by the ingest: a SUBJECT
    // observation carries the canonical key (`multi_2_4`, `sfr`) and a COMPARABLE
    // carries the display label (`Multi 2–4`, `SFR (1 unit)`). Comparing the text
    // made every such pair a HIGH-severity "a house is a house or it is a duplex"
    // — measured on the real corpus, 2 of the 3 high-severity conflicts in the
    // whole warehouse, and 100% of the property-type hits, were this artifact,
    // sorted to the top of the list. `propertyTypeCompareKey` is the repo's own
    // definition of what two property types mean the same thing, so the two can
    // never drift; an unrecognized value keys to itself and is never collapsed.
    compareKey: propertyTypeCompareKey,
  },
  year_built: {
    label: 'Year built', kind: 'absolute', tolerance: 3,
    // Public records and an appraiser's estimate routinely differ by a year or
    // two on older stock; twenty years is a different building era.
    why: 'records and estimates differ by a year or two on older housing; three years is the point where it stops being rounding',
    severity: 'medium',
  },
  gla: {
    label: 'Living area', kind: 'fraction', tolerance: 0.05,
    // Two people with tapes measuring the same house land within a few percent.
    // Beyond 5% one of them has counted a room the other did not.
    why: 'two people measuring the same house land within a few percent; beyond 5% one has counted a room the other did not',
    severity: 'medium',
  },
  beds: {
    label: 'Bedrooms', kind: 'absolute', tolerance: 0,
    // Deliberately zero, but only MEDIUM: a den, a converted attic or a
    // basement room is genuinely arguable, so a difference is worth showing and
    // is not by itself evidence of an error.
    why: 'a den or a converted room is genuinely arguable, so any difference is shown — but a difference alone is not an error',
    severity: 'medium',
  },
  total_rooms: {
    label: 'Total rooms', kind: 'absolute', tolerance: 1,
    why: 'room counting conventions differ by one at the edges (a foyer, a finished porch)',
    severity: 'low',
  },
  lot_sqft: {
    label: 'Lot size', kind: 'fraction', tolerance: 0.10,
    why: 'a lot is taken from records that round differently; 10% is where it stops being the survey',
    severity: 'low',
  },
});

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const txt = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/**
 * The value as it is COMPARED — the one definition, used by `disagrees` and by
 * the grouping below, so the two can never judge the same pair differently.
 * Null means "said nothing", which is not a competing opinion.
 */
function exactKey(spec, v) {
  const s = txt(v);
  if (s == null) return null;
  if (spec && typeof spec.compareKey === 'function') {
    // A COMPARISON KEY MAY NEVER BREAK THE PAGE. `findConflicts` is pure and its
    // callers do not guard it, so a future key that throws on some value would
    // take the whole property screen down over a review signal. Falling back to
    // the plain text can only ever report MORE, never hide a disagreement.
    try {
      const k = spec.compareKey(s);
      if (k != null && String(k) !== '') return String(k).toLowerCase();
    } catch (_) { /* fall through to the text */ }
  }
  return s.toLowerCase();
}

/**
 * Do these two values disagree ENOUGH to be worth a person's attention?
 * Returns false when either side is silent — a report that did not state a fact
 * has not contradicted one that did.
 */
function disagrees(spec, a, b) {
  if (!spec) return false;
  if (spec.kind === 'exact') {
    const x = exactKey(spec, a), y = exactKey(spec, b);
    if (x == null || y == null) return false;
    return x !== y;
  }
  const x = num(a), y = num(b);
  if (x == null || y == null) return false;
  if (spec.kind === 'absolute') return Math.abs(x - y) > (spec.tolerance || 0);
  if (spec.kind === 'fraction') {
    const base = Math.max(Math.abs(x), Math.abs(y));
    if (base === 0) return false;
    return Math.abs(x - y) / base > (spec.tolerance || 0);
  }
  return false;
}

/** Who speaks for a report about one fact — the newest row, then the lowest id. */
function spokesman(rows, field) {
  return rows.slice().sort((a, b) => {
    const ad = String(a.observed_on || ''), bd = String(b.observed_on || '');
    if (ad !== bd) return bd.localeCompare(ad);          // newest first
    return String(a.id || '').localeCompare(String(b.id || ''));
  })[0] || rows[0];
}

/** One report saying two different things — its own finding, in its own words. */
function selfEntry(field, spec, inconsistent) {
  const values = inconsistent.map((rows) => ({
    // Every distinct thing this report said, so the reader sees the pair rather
    // than a claim that a pair exists.
    said: [...new Set(rows.map((o) => String(o[field])))],
    said_by: rows.map((o) => ({
      observation_id: o.id || null,
      appraisal_id: o.appraisal_id || null,
      observed_on: o.observed_on || null,
      role: o.role || null,
    })),
  }));
  return {
    field,
    label: spec.label,
    // ALWAYS one step quieter than the cross-report finding. One report listing a
    // house twice with different numbers is usually a grid the appraiser filled
    // in two places, not a dispute about what the building is.
    severity: spec.severity === 'high' ? 'medium' : 'low',
    within_report: true,
    reports_inconsistent: inconsistent.length,
    why: spec.why,
    tolerance: spec.kind === 'exact' ? 'none — any difference is a disagreement'
      : (spec.kind === 'fraction' ? `${Math.round(spec.tolerance * 100)}%` : `${spec.tolerance}`),
    values,
    note: inconsistent.length === 1
      ? 'One report describes this property two different ways. That is a question for whoever reads the report, not a disagreement between appraisers.'
      : `${inconsistent.length} reports each describe this property two different ways.`,
  };
}

/**
 * Compare a property's observations and report where they disagree.
 *
 * `observations` are the warehouse rows for ONE property — each carrying the
 * facts plus who said it and when. Returns one entry per FACT, never one per
 * pair, because "three reports and they all differ" is one question a person
 * answers once, not three.
 *
 * PURE. No database, no clock.
 */
function findConflicts(observations, { compared = COMPARED } = {}) {
  const obs = Array.isArray(observations) ? observations : [];
  if (obs.length < 2) return [];
  const out = [];
  for (const [field, spec] of Object.entries(compared)) {
    // Every DISTINCT stated value, with who stated it. A report that said
    // nothing is not represented at all — silence is not a competing opinion.
    const stated = obs.filter((o) => txt(o[field]) != null);
    if (stated.length < 2) continue;

    // ONE REPORT IS ONE OPINION — the unit of disagreement is the REPORT, not the
    // observation. One appraisal routinely describes the same address more than
    // once: as its comparable #3 and again as its comparable #4, or in the sales
    // grid and again in the rent schedule, or as the subject and again in its own
    // rent schedule. Treating each row as an independent voice made a report
    // disagree with ITSELF and reported it as "Two reports describe this property
    // differently" — measured on the real corpus, 3 of 21 conflicts, with 27% of
    // multi-observation properties exposed to it. The tolerance measurements this
    // module is built on counted REPORTS, so this is also the population they
    // describe.
    const byReport = new Map();
    stated.forEach((o, i) => {
      // A row with no appraisal id cannot be PROVEN to share a report with any
      // other, so it stands alone rather than being pooled with the rest.
      const key = o.appraisal_id ? `a:${o.appraisal_id}` : `x:${i}`;
      if (!byReport.has(key)) byReport.set(key, []);
      byReport.get(key).push(o);
    });

    // A report that contradicts ITSELF about this fact has no settled opinion, so
    // it takes no part in the comparison between the others. It is a DIFFERENT
    // question — "this one report says two things" — and it gets its own entry
    // and its own wording below rather than being reported as two reports
    // disagreeing.
    const opinions = []; const inconsistent = [];
    for (const rows of byReport.values()) {
      let internal = false;
      for (let i = 0; i < rows.length && !internal; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          if (disagrees(spec, rows[i][field], rows[j][field])) { internal = true; break; }
        }
      }
      if (internal) inconsistent.push(rows); else opinions.push(rows);
    }
    // NOT `continue` — that dropped the count entirely whenever the exclusions
    // left fewer than two opinions, which is exactly when a self-inconsistent
    // report is the ONLY thing to say. Measured on the real corpus, two
    // properties are in that state (one report reading year built 1950 AND 1926;
    // four reports each reading 4 AND 5 bedrooms) and the page went silent about
    // both — a regression against the version this replaced, which at least
    // showed them, if under the wrong sentence.
    if (opinions.length < 2) {
      if (inconsistent.length) out.push(selfEntry(field, spec, inconsistent));
      continue;
    }

    const seen = new Map();
    for (const rows of opinions) {
      // Every row of this report agrees about this fact, so any of them speaks
      // for it — but all of them are still listed, so the screen can show every
      // place the report said it. WHICH one speaks is chosen deterministically:
      // taking `rows[0]` let input order decide, and two rows of one report can
      // differ while staying inside tolerance, so the same property could report
      // a conflict or not depending on the order Postgres happened to return
      // (its ORDER BY is `observed_on DESC`, and one report's rows routinely
      // share that date, so the tie-break was arbitrary and could change between
      // two loads of the same page).
      const lead = spokesman(rows, field);
      const key = spec.kind === 'exact' ? exactKey(spec, lead[field]) : String(num(lead[field]));
      if (!seen.has(key)) seen.set(key, { value: lead[field], said_by: [] });
      for (const o of rows) {
        seen.get(key).said_by.push({
          observation_id: o.id || null,
          appraisal_id: o.appraisal_id || null,
          observed_on: o.observed_on || null,
          role: o.role || null,
          appraiser_id: o.appraiser_id || null,
        });
      }
    }
    const values = [...seen.values()];
    if (values.length < 2) continue;
    // Only report when at least one PAIR is outside tolerance. Three readings of
    // 1909 / 1910 / 1911 are three distinct values and zero disagreement.
    let worst = null;
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        if (!disagrees(spec, values[i].value, values[j].value)) continue;
        const a = num(values[i].value), b = num(values[j].value);
        const gap = (a != null && b != null) ? Math.abs(a - b) : null;
        if (!worst || (gap != null && worst.gap != null && gap > worst.gap)) {
          worst = { gap, a: values[i].value, b: values[j].value };
        }
      }
    }
    if (!worst) continue;
    out.push({
      field,
      label: spec.label,
      severity: spec.severity,
      why: spec.why,
      tolerance: spec.kind === 'exact' ? 'none — any difference is a disagreement'
        : (spec.kind === 'fraction' ? `${Math.round(spec.tolerance * 100)}%` : `${spec.tolerance}`),
      values,
      // Reports that could not take part because they contradicted themselves
      // about this fact. Never silently dropped.
      reports_inconsistent: inconsistent.length || undefined,
      widest_gap: worst.gap,
      // Said plainly so no screen can turn this into an accusation: two
      // appraisers disagreeing is normal and is a question, not a finding of
      // fault.
      note: 'Two reports describe this property differently. Neither is presumed wrong.',
    });
  }
  // The unit count first — it is the fact everything else keys on.
  const RANK = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => (RANK[a.severity] - RANK[b.severity])
    || String(a.field).localeCompare(String(b.field)));
}

/**
 * The same thing, read from the warehouse for one property. Never throws — a
 * review signal must never be the thing that breaks a page.
 */
async function conflictsForProperty(db, propertyId) {
  if (!propertyId) return { ok: false, conflicts: [] };
  try {
    const fields = Object.keys(COMPARED).join(', ');
    const r = await db.query(
      `SELECT id, appraisal_id, import_id, role, observed_on, appraiser_id, ${fields}
         FROM property_observations
        WHERE property_id = $1
        ORDER BY observed_on DESC NULLS LAST`, [propertyId]);
    return { ok: true, observations: r.rows.length, conflicts: findConflicts(r.rows) };
  } catch (_) {
    return { ok: false, conflicts: [] };
  }
}

module.exports = { findConflicts, conflictsForProperty, COMPARED, _internals: { disagrees } };
