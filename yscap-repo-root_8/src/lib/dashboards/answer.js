'use strict';

/**
 * Answering a card: compile it, run it, and say plainly how the number was worked out.
 *
 * THE EXPLANATION IS NOT A NICE-TO-HAVE — it is the feature the owner actually asked for
 * ("you can see the settings in the back end which filters is using to populate this, you
 * can actually play around with the filters"). So `explain` is built by the SAME code path
 * that builds the query, from the same compiled objects. It cannot describe a filter the
 * query did not apply, because it is reading the query's own inputs.
 *
 * A card fails ALONE. One dead card renders "couldn't load this one" next to eleven live
 * ones; it never blanks the page and it never renders a confident 0. A zero that means
 * "the query broke" is the worst possible output for a reporting surface, because it is
 * indistinguishable from an answer.
 */

const registry = require('./registry');
const compile = require('./compile');
const run = require('./run');

/** The scope fragment for this viewer, or none at all when they see everything. */
function scopeFor(actor, seed) {
  const permissions = require('../permissions');
  if (permissions.can(actor, 'see_all_files')) return { sql: '', params: [] };
  // The placeholder is computed from the seed length so the bound value and its `$n`
  // can never drift — and the clause is only emitted when it is actually bound, because
  // an unreferenced parameter is a hard Postgres bind failure (42P18), not a no-op.
  return {
    sql: permissions.visibleOfficersSql('a', `$${seed.length + 1}`),
    params: [actor.id],
  };
}

const PERIOD_LABEL = {
  all: 'all time',
  mtd: 'this month so far',
  this_month: 'this month',
  last_month: 'last month',
  qtd: 'this quarter so far',
  ytd: 'this year so far',
  last_days: (n) => `the last ${n} days`,
  last_months: (n) => `the last ${n} months`,
  fixed: (n, f, t) => `${f} to ${t}`,
};

function periodLabel(period) {
  const kind = (period && period.kind) || 'all';
  const l = PERIOD_LABEL[kind];
  if (typeof l === 'function') return l(period && period.n, period && period.from, period && period.to);
  return l || 'all time';
}

/**
 * Run one card. Returns a shaped answer plus the explanation, or a shaped ERROR — this
 * never throws for a bad card, because one broken card must not take the dashboard down.
 */
async function answerCard(card, actor, { includeSql = false } = {}) {
  const base = {
    id: card.id,
    title: card.title,
    subtitle: card.subtitle,
    viz: card.viz,
    band: card.band,
    width: card.width,
    target: card.target || null,
  };
  try {
    const measure = registry.MEASURES[card.metric_key];
    if (!measure) throw new Error(`This card measures "${card.metric_key}", which no longer exists.`);

    // Validate the STORED filter on every read, not only on write. A field renamed in the
    // registry must surface as "this card needs attention", never as a silently dropped
    // condition — a card that quietly stops filtering by state shows the whole book and
    // nobody notices.
    const problems = compile.validateFilter(card.filter);
    if (problems.length) throw new Error(`This card needs attention: ${problems.join('; ')}`);

    const seed = [];
    const scope = scopeFor(actor, seed);
    const q = compile.buildAggregate({ ...card, filter: card.filter }, scope, { seed: scope.params });
    const r = await run.run(q, { staffId: actor && actor.id });

    const explain = {
      measure: measure.label,
      measureNote: measure.note || null,
      filter: compile.describeFilter(card.filter),
      dateField: card.date_field ? (registry.DATE_FIELDS[card.date_field] || {}).label : null,
      period: periodLabel(card.period),
      groupedBy: card.grain ? (registry.TIME_GRAINS[card.grain] || {}).label
        : card.group_by ? (registry.DIMENSIONS[card.group_by] || {}).label : null,
      scoped: !!scope.sql,
      cohort: !!measure.cohort,
      sql: includeSql ? q.text : undefined,
    };

    if (!q.grouped) {
      const row = r.rows[0] || {};
      const matched = Number(row.rows_matched || 0);
      const covered = row.covered == null ? null : Number(row.covered);
      return {
        ...base,
        ok: true,
        format: measure.format,
        value: row.value == null ? null : Number(row.value),
        numerator: row.numerator == null ? undefined : Number(row.numerator),
        denominator: row.denominator == null ? undefined : Number(row.denominator),
        matched,
        // "based on 214 of 390 files" — a card built on a partly-populated column says so
        // on its face rather than quietly averaging the half of the book that has data.
        coverage: covered == null ? null : { covered, of: matched, partial: covered < matched },
        explain,
      };
    }

    const dim = card.group_by ? registry.DIMENSIONS[card.group_by] : null;
    let series = r.rows.map((row) => ({
      key: row.bucket_label == null ? '—' : String(row.bucket_label),
      value: row.value == null ? null : Number(row.value),
      matched: Number(row.rows_matched || 0),
    }));
    // A dimension with a natural order (aging buckets, maturity buckets) is presented in
    // that order, not by size — "past maturity" belongs on the left whatever its count.
    if (dim && Array.isArray(dim.order)) {
      const pos = new Map(dim.order.map((k, i) => [k, i]));
      series = series.sort((x, y) => (pos.has(x.key) ? pos.get(x.key) : 999) - (pos.has(y.key) ? pos.get(y.key) : 999));
    }
    return {
      ...base, ok: true, format: measure.format, series,
      total: series.reduce((s, x) => s + (x.value || 0), 0),
      // Only an additive measure may be totalled. You cannot sum an average or a rate:
      // twelve monthly averages added together is not the year's average, and the wrong
      // total is worse than no total because it looks authoritative.
      totalMeaningful: measure.additive !== false && measure.kind !== 'ratio'
        && !['percent', 'days'].includes(measure.format),
      explain,
    };
  } catch (e) {
    return {
      ...base,
      ok: false,
      error: (e && e.message) || 'This card could not be loaded.',
      status: (e && e.status) || 500,
    };
  }
}

/** The files behind a card's number — the SAME predicate, enumerated. */
async function drillCard(card, actor, { limit = 200, offset = 0 } = {}) {
  const seed = [];
  const scope = scopeFor(actor, seed);
  const problems = compile.validateFilter(card.filter);
  if (problems.length) { const e = new Error(problems.join('; ')); e.status = 400; throw e; }
  const q = compile.buildDrillList({ ...card, filter: card.filter }, scope, {
    limit, offset, seed: scope.params,
  });
  const r = await run.run(q, { staffId: actor && actor.id });
  return r.rows;
}

module.exports = { answerCard, drillCard, scopeFor, periodLabel };
