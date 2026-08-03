'use strict';

/**
 * The dashboards people land on, shipped as ORDINARY ROWS.
 *
 * They are seeded here rather than written into a screen because that is the whole point
 * of the design: the default dashboard is a dashboard. You can open any card's settings,
 * see the exact filter feeding it, change it, and save — and because there is no separate
 * hardcoded path, that is true of the standard cards on day one, not just of ones you
 * build yourself.
 *
 * Idempotent, by `slug`. Runs on every boot (previous AND future — an existing staffer
 * must get these, not only someone hired next week). A dashboard an admin has since
 * EDITED is left alone: the seeder inserts cards only when the dashboard has none, so a
 * deploy never overwrites somebody's work.
 *
 * FOUR HERO CARDS, NEVER MORE. An executive screen stops working past about five headline
 * numbers, and the top row is what the 5-second read depends on: are we on track, and is
 * anything on fire. Everything else is a scannable, clickable worklist below it — which is
 * how every real lending system's landing page is built.
 */

const db = require('../../db');

const money = (title, extra = {}) => ({ viz: 'number', metric_key: 'loan_volume', ...extra, title });

/** Funded work is always counted on the ACTUAL CLOSING date. */
const FUNDED = { combinator: 'and', rules: [{ field: 'status', operator: 'eq', value: 'funded' }] };
const LIVE = { combinator: 'and', rules: [{ field: 'is_active', operator: 'is_true' }] };

function mine(extra) {
  return { combinator: 'and', rules: [{ field: 'is_active', operator: 'is_true' }, ...extra] };
}

const ADMIN_CARDS = [
  // ---- hero: on track? and is anything on fire? ----
  { band: 'hero', title: 'Funded this month', subtitle: 'against last year',
    viz: 'number', metric_key: 'loan_volume', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'mtd' }, compare: { kind: 'prior_year' } },
  { band: 'hero', title: 'Live pipeline', subtitle: 'still in play',
    viz: 'number', metric_key: 'loan_volume', filter: LIVE, period: { kind: 'all' } },
  { band: 'hero', title: 'Leverage', subtitle: 'weighted ARV % of what we funded this year',
    viz: 'number', metric_key: 'wavg_arv', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'ytd' },
    target: { good: 65, warn: 70, direction: 'lower_is_better', unit: '%' } },
  { band: 'hero', title: 'Not moving', subtitle: 'live files nobody has touched in 7 days',
    viz: 'number', metric_key: 'file_count',
    filter: mine([{ field: 'days_since_touched', operator: 'gt', value: 7 }]),
    target: { good: 0, warn: 5, direction: 'lower_is_better' } },

  // ---- body ----
  { band: 'body', width: 'full', title: 'Funded by month', subtitle: 'click any month to see the files',
    viz: 'trend', metric_key: 'loan_volume', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'last_months', n: 12 }, grain: 'month' },
  { band: 'body', title: 'Pull-through', subtitle: 'of the files that reached a decision',
    viz: 'number', metric_key: 'pull_through',
    date_field: 'created_at', period: { kind: 'ytd' },
    target: { good: 70, warn: 65, direction: 'higher_is_better', unit: '%' } },
  { band: 'body', title: 'Time to fund', subtitle: 'typical, application to funding',
    viz: 'number', metric_key: 'days_to_fund_p50', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'ytd' },
    target: { good: 7, warn: 14, direction: 'lower_is_better', unit: ' days' } },
  { band: 'body', title: 'Average loan', subtitle: 'funded this year',
    viz: 'number', metric_key: 'avg_loan', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'ytd' } },
  { band: 'body', width: 'two', title: 'Where the money went', subtitle: 'funded this year, by state',
    viz: 'breakdown', metric_key: 'loan_volume', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'ytd' }, group_by: 'state' },
  { band: 'body', width: 'two', title: 'By officer', subtitle: 'funded this year',
    viz: 'table', metric_key: 'loan_volume', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'ytd' }, group_by: 'loan_officer' },
  { band: 'body', width: 'two', title: 'Maturity wall', subtitle: 'funded loans coming due',
    viz: 'breakdown', metric_key: 'file_count', filter: FUNDED, group_by: 'maturity_bucket' },
  { band: 'body', width: 'two', title: 'Pipeline age', subtitle: 'how long live files have been open',
    viz: 'breakdown', metric_key: 'file_count', filter: LIVE, group_by: 'age_bucket' },
  { band: 'body', width: 'two', title: 'By note buyer', subtitle: 'funded this year',
    viz: 'breakdown', metric_key: 'loan_volume', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'ytd' }, group_by: 'note_buyer' },
  { band: 'body', width: 'two', title: 'By deal type', subtitle: 'funded this year',
    viz: 'breakdown', metric_key: 'loan_volume', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'ytd' }, group_by: 'program' },
];

const OFFICER_CARDS = [
  { band: 'hero', title: 'My funded this month', subtitle: 'against last year',
    viz: 'number', metric_key: 'loan_volume', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'mtd' }, compare: { kind: 'prior_year' } },
  { band: 'hero', title: 'My pipeline', subtitle: 'still in play',
    viz: 'number', metric_key: 'loan_volume', filter: LIVE, period: { kind: 'all' } },
  { band: 'hero', title: 'My pull-through', subtitle: 'of my files that reached a decision',
    viz: 'number', metric_key: 'pull_through', date_field: 'created_at', period: { kind: 'ytd' },
    target: { good: 70, warn: 65, direction: 'higher_is_better', unit: '%' } },
  { band: 'hero', title: 'Waiting on the borrower', subtitle: 'my live files with something outstanding',
    viz: 'number', metric_key: 'file_count',
    filter: mine([{ field: 'open_conditions', operator: 'gt', value: 0 }]) },

  { band: 'body', width: 'full', title: 'My funded by month', subtitle: 'click a month to see the files',
    viz: 'trend', metric_key: 'loan_volume', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'last_months', n: 12 }, grain: 'month' },
  { band: 'body', width: 'two', title: 'My files by stage', subtitle: 'where my live book sits',
    viz: 'breakdown', metric_key: 'file_count', filter: LIVE, group_by: 'status' },
  { band: 'body', width: 'two', title: 'Not moving', subtitle: 'nobody has touched these in a week',
    viz: 'table', metric_key: 'file_count',
    filter: mine([{ field: 'days_since_touched', operator: 'gt', value: 7 }]), group_by: 'status' },
  { band: 'body', title: 'Closing this month', subtitle: 'expected to close',
    viz: 'number', metric_key: 'file_count', filter: LIVE,
    date_field: 'expected_closing', period: { kind: 'this_month' } },
  { band: 'body', title: 'My average loan', subtitle: 'funded this year',
    viz: 'number', metric_key: 'avg_loan', filter: FUNDED,
    date_field: 'actual_closing', period: { kind: 'ytd' } },
];

const PROCESSOR_CARDS = [
  { band: 'hero', title: 'Waiting on me to review', subtitle: 'documents in, not yet accepted',
    viz: 'number', metric_key: 'file_count',
    filter: mine([{ field: 'conditions_awaiting_review', operator: 'gt', value: 0 }]) },
  { band: 'hero', title: 'Waiting on the borrower', subtitle: 'not my queue',
    viz: 'number', metric_key: 'file_count',
    filter: mine([{ field: 'open_conditions', operator: 'gt', value: 0 }]) },
  { band: 'hero', title: 'Sent back for a fix', subtitle: 'conditions the borrower must redo',
    viz: 'number', metric_key: 'file_count',
    filter: mine([{ field: 'conditions_sent_back', operator: 'gt', value: 0 }]) },
  { band: 'hero', title: 'Not moving', subtitle: 'live files untouched for a week',
    viz: 'number', metric_key: 'file_count',
    filter: mine([{ field: 'days_since_touched', operator: 'gt', value: 7 }]),
    target: { good: 0, warn: 5, direction: 'lower_is_better' } },

  { band: 'body', width: 'two', title: 'My files by stage', viz: 'breakdown',
    metric_key: 'file_count', filter: LIVE, group_by: 'status' },
  { band: 'body', width: 'two', title: 'How long they have been open', viz: 'breakdown',
    metric_key: 'file_count', filter: LIVE, group_by: 'age_bucket' },
  { band: 'body', title: 'Open conditions', subtitle: 'across my live files',
    viz: 'number', metric_key: 'open_conditions_total', filter: LIVE },
  { band: 'body', title: 'Conditions per file', subtitle: 'average on my live files',
    viz: 'number', metric_key: 'avg_conditions_per_file', filter: LIVE },
];

const DASHBOARDS = [
  { slug: 'default_admin', role_default: 'admin', name: 'Company dashboard',
    description: 'Where the business stands today — volume, pipeline, leverage and what needs attention.',
    cards: ADMIN_CARDS },
  { slug: 'default_super_admin', role_default: 'super_admin', name: 'Company dashboard',
    description: 'Where the business stands today — volume, pipeline, leverage and what needs attention.',
    cards: ADMIN_CARDS },
  { slug: 'default_underwriter', role_default: 'underwriter', name: 'Underwriting dashboard',
    description: 'The book you are underwriting, and what is holding files up.',
    cards: ADMIN_CARDS },
  { slug: 'default_loan_officer', role_default: 'loan_officer', name: 'My dashboard',
    description: 'Your book: what you funded, what is still in play, and what needs you today.',
    cards: OFFICER_CARDS },
  { slug: 'default_processor', role_default: 'processor', name: 'My work',
    description: 'What is on your desk, what is waiting on the borrower, and what has stopped moving.',
    cards: PROCESSOR_CARDS },
  { slug: 'default_staff', role_default: null, name: 'Dashboard',
    description: 'Your files at a glance.', cards: OFFICER_CARDS },
];

/**
 * Seed the shipped dashboards. Best-effort and never throws — a seeding failure must not
 * stop the server booting.
 */
async function seedDefaults() {
  let made = 0;
  for (const spec of DASHBOARDS) {
    try {
      const d = await db.query(
        // `uq_dashboards_slug` is a PARTIAL unique index (… WHERE slug IS NOT NULL), and
        // Postgres can only infer a partial index when the statement repeats its predicate.
        // Without the WHERE this raises "no unique or exclusion constraint matching the
        // ON CONFLICT specification" — the same trap `borrowers_email_owner_uk` documents.
        `INSERT INTO dashboards (slug, role_default, name, description, is_system)
         VALUES ($1,$2,$3,$4,true)
         ON CONFLICT (slug) WHERE slug IS NOT NULL
         DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
         RETURNING id`,
        [spec.slug, spec.role_default, spec.name, spec.description]);
      const id = d.rows[0].id;
      // Cards are inserted ONLY into an empty dashboard. A system dashboard an admin has
      // since edited keeps their edits across every future deploy.
      const n = await db.query(`SELECT count(*)::int AS n FROM dashboard_cards WHERE dashboard_id=$1`, [id]);
      if (n.rows[0].n > 0) continue;
      let pos = 0;
      for (const c of spec.cards) {
        await db.query(
          `INSERT INTO dashboard_cards
             (dashboard_id, position, band, width, title, subtitle, viz, metric_key,
              filter, date_field, period, compare, group_by, grain, target)
           VALUES ($1,$2,COALESCE($3,'body'),COALESCE($4,'one'),$5,$6,COALESCE($7,'number'),$8,
                   $9,$10,$11,$12,$13,$14,$15)`,
          [id, pos++, c.band, c.width, c.title, c.subtitle || null, c.viz, c.metric_key,
            c.filter ? JSON.stringify(c.filter) : null, c.date_field || null,
            c.period ? JSON.stringify(c.period) : null,
            c.compare ? JSON.stringify(c.compare) : null,
            c.group_by || null, c.grain || null,
            c.target ? JSON.stringify(c.target) : null]);
      }
      made++;
    } catch (e) {
      console.warn('[dashboards] could not seed', spec.slug, '-', (e && e.message) || e);
    }
  }
  if (made) console.log(`[dashboards] seeded ${made} default dashboard(s)`);
  return made;
}

module.exports = { seedDefaults, DASHBOARDS, ADMIN_CARDS, OFFICER_CARDS, PROCESSOR_CARDS, money };
