'use strict';
/**
 * THE RESEARCH DESK — the property / comparable / appraiser database. Mounted at
 * /api/research.
 *
 *   GET  /stats                       -> how big the database is, and how much of
 *                                        the appraisal corpus has been folded in
 *   GET  /properties                  -> the search engine (every filter, facets)
 *   GET  /properties/:id              -> one property: the roll-up, every report
 *                                        that ever mentioned it, its sales, its
 *                                        photos, and the files it appeared on
 *   GET  /photos/:documentId          -> the pixels of a property photo
 *   GET  /appraisers                  -> every appraiser who has ever filed with us
 *   GET  /appraisers/:id              -> their profile, contacts, licences, and
 *                                        EVERY file they appraised for us
 *   GET  /rates                       -> what our own sales say a square foot / a
 *                                        bedroom / a condition grade is worth here
 *   GET  /comps                       -> ranked comparable candidates for a subject
 *   ...  /valuations                  -> build-your-own valuations (see below)
 *   POST /backfill                    -> fold the whole appraisal corpus in
 *
 * WHO CAN SEE IT. Every staff user, with no per-file scoping — the owner's
 * instruction ("make it available for all the staff users to see all the things").
 * That is a deliberate departure from the loan-file rule, and it is defensible
 * because of what this data IS: property addresses, property characteristics and
 * recorded sale prices. It carries no borrower name, no loan amount, no contact
 * detail and no document. The one identity in here is the APPRAISER's, which is a
 * licensed professional's published business contact information, printed on
 * every report they sign.
 *
 * BORROWERS NEVER REACH ANY OF THIS. It is mounted behind requireStaff as a whole
 * router, not per-endpoint, so there is no path in without a staff session.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireStaff } = require('../auth');
const { can } = require('../lib/permissions');
const { serveDocument } = require('../lib/serve-document');
const S = require('../lib/research/search');
const MARKET = require('../lib/research/market');
const FLIPS = require('../lib/research/flips');
const V = require('../lib/research/valuation');
const QA = require('../lib/research/quick-answer');
const BR = require('../lib/research/bracketing');
const MA = require('../lib/research/market-area');
const K = require('../lib/research/property-key');
const ingest = require('../lib/research/ingest');
// db/438 — the UAD 3.6 exposure count, so "how many did we turn away?" is answerable.
const { formatRefusalCounts } = require('../lib/appraisal/import');
// Where two reports describe the same house differently — a review signal only
// a warehouse holding several appraisals of one property can compute.
const { findConflicts } = require('../lib/research/conflicts');
const VAR = require('../lib/research/variance');
const ADJ = require('../lib/research/adjustment-corpus');
// The most adjustment lines one market answer will read. Above this the answer
// says so rather than letting an arbitrary slice set the median.
const ROW_CAP = 20000;

router.use(requireAuth, requireStaff);

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
const txt = (v) => { const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; };

async function audit(actorId, action, entityId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('staff',$1,$2,'property',$3,$4)`,
      [actorId, action, entityId, JSON.stringify(detail || {})]);
  } catch (_) { /* audit is best-effort; never block the action */ }
}

/** Today in the same New York day the rest of the platform uses. */
function todayNY() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ---------------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// THE MARKET — what our appraisers have said about the areas we lend in (db/449)
// ---------------------------------------------------------------------------
/**
 * "How is this market moving?" — assembled from the 1004MC grid on every report
 * we hold for that area, with each report's relative windows resolved to real
 * dates so reports written months apart stack into one series.
 *
 * IT IS OPINION DATA AND THE RESPONSE SAYS SO. Every month carries the number of
 * REPORTS behind it, and the payload carries the note verbatim, because an
 * average over two reports and over two hundred must never look alike. A caller
 * that plots this without showing the count is misrepresenting it.
 */
router.get('/market', async (req, res, next) => {
  try {
    const out = await MARKET.summarize(db, {
      state: txt(req.query.state), city: txt(req.query.city), zip: txt(req.query.zip),
      months: K.int(req.query.months, { max: 120 }) || 24,
    });
    res.json(out);
  } catch (e) { next(e); }
});

/**
 * PROPERTIES BOUGHT AND RESOLD — the completed exits, out of the prior-sale line
 * of reports we already paid for. `properties` carries only the LATEST sale, so
 * until now the purchase a flip started from was invisible to every search.
 */
router.get('/flips', async (req, res, next) => {
  try {
    const found = await FLIPS.findFlips(db, {
      state: txt(req.query.state), city: txt(req.query.city), zip: txt(req.query.zip),
      propertyId: isUuid(req.query.property_id) ? req.query.property_id : null,
      months: K.int(req.query.months, { max: 120 }),
      soldWithinMonths: K.int(req.query.sold_within_months, { max: 240 }),
      // AN UNREADABLE NUMBER IS NOT A FILTER. `K.num('xyz')` answers null, not
      // undefined, and `Number(null)` is 0 — so a stray character in the URL
      // quietly applied "spread >= 0%" and deleted every loss-making flip from
      // the answer. Measured on the real corpus: 50 rows became 44 and all six
      // losses vanished, with a 200 and no hint anything had happened.
      minSpreadPct: (() => {
        const v = K.num(req.query.min_spread_pct);
        return v == null ? undefined : v;
      })(),
      limit: K.int(req.query.limit, { max: 200 }),
    });
    res.json(found);
  } catch (e) { next(e); }
});

/** The individual reads behind that series — who said it, when, and about where. */
router.get('/market/reports', async (req, res, next) => {
  try {
    const params = [];
    const P = (v) => { params.push(v); return '$' + params.length; };
    const where = [];
    if (txt(req.query.state)) where.push(`o.state = ${P(txt(req.query.state).toUpperCase())}`);
    if (txt(req.query.city)) where.push(`lower(o.city) = ${P(txt(req.query.city).toLowerCase())}`);
    if (txt(req.query.zip)) where.push(`o.zip = ${P(txt(req.query.zip))}`);
    if (isUuid(req.query.property_id)) where.push(`o.property_id = ${P(req.query.property_id)}`);
    const rows = (await db.query(
      `SELECT o.id, o.effective_date, o.form_type, o.state, o.city, o.zip, o.trends,
              o.nbhd_builtup, o.nbhd_growth, o.nbhd_value_trend, o.nbhd_demand_supply,
              o.nbhd_marketing_time, o.nbhd_price_low, o.nbhd_price_high, o.nbhd_price_predominant,
              o.present_land_use, o.market_conditions_comment,
              a.name AS appraiser_name, a.company AS appraiser_company
         FROM market_observations o
         LEFT JOIN appraisers a ON a.id = o.appraiser_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY o.effective_date DESC NULLS LAST, o.id
        LIMIT 100`, params)).rows;
    res.json({ rows, total: rows.length });
  } catch (e) { next(e); }
});

router.get('/stats', async (req, res, next) => {
  try {
    const status = await ingest.ingestStatus(db);
    const spread = (await db.query(
      `SELECT count(*) FILTER (WHERE last_sale_price IS NOT NULL)::int AS with_sale,
              count(*) FILTER (WHERE photo_count > 0)::int AS with_photo,
              count(DISTINCT state)::int AS states,
              count(DISTINCT (state || '|' || lower(coalesce(city,''))))::int AS cities,
              min(last_sale_date) AS earliest_sale, max(last_sale_date) AS latest_sale
         FROM properties`)).rows[0];
    const skipped = (await db.query(
      `SELECT COALESCE(sum(rows_skipped),0)::int AS n FROM property_ingest_log`)).rows[0].n;
    res.json({ ...status, ...spread, rows_skipped: skipped });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// PROPERTY SEARCH
// ---------------------------------------------------------------------------
router.get('/properties', async (req, res, next) => {
  try {
    const [page, facets] = await Promise.all([
      S.searchProperties(db, req.query),
      // Facets are the sidebar's counts; a failure there must not blank the results.
      S.facets(db, req.query).catch((e) => { console.error('[research] facets failed:', e && e.message); return null; }),
    ]);
    res.json({ ...page, facets });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// ONE PROPERTY — everything we know, and where each piece came from
// ---------------------------------------------------------------------------
router.get('/properties/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const p = (await db.query(`SELECT * FROM properties WHERE id=$1`, [req.params.id])).rows[0];
    if (!p) {
      // A MERGED PROPERTY'S LINK MUST NOT DIE. A bookmarked or emailed property page
      // whose row was folded into another one answers with where it went, rather
      // than a bare "not found" that reads as data loss.
      try {
        const to = await require('../lib/research/property-merge').survivorOf(db, req.params.id);
        if (to) return res.status(301).json({ error: 'merged', merged_into: to });
      } catch (_) { /* the redirect is a courtesy; the 404 below is still the truth */ }
      return res.status(404).json({ error: 'not found' });
    }
    const [obs, sales, photos] = await Promise.all([
      db.query(
        `SELECT o.*, ap.name AS appraiser_name, ap.company AS appraiser_company,
                a.form_type AS report_form, a.effective_date AS report_date,
                app.ys_loan_number, app.property_address AS file_address, app.status AS file_status
           FROM property_observations o
           LEFT JOIN appraisers ap ON ap.id = o.appraiser_id
           LEFT JOIN appraisals a ON a.id = o.appraisal_id
           LEFT JOIN applications app ON app.id = o.application_id
          WHERE o.property_id = $1
          ORDER BY o.observed_on DESC NULLS LAST, o.created_at DESC`, [req.params.id]),
      db.query(
        `SELECT sale_date, sale_price, sale_type, sale_status, source, times_seen
           FROM property_sales WHERE property_id=$1 ORDER BY sale_date DESC`, [req.params.id]),
      db.query(
        `SELECT pp.id, pp.document_id, pp.category, pp.caption, pp.sequence, pp.is_primary,
                pp.observation_id, d.content_type
           FROM property_photos pp JOIN documents d ON d.id = pp.document_id
          WHERE pp.property_id = $1 AND d.is_current
          ORDER BY pp.is_primary DESC, pp.sequence`, [req.params.id]),
    ]);
    // WHERE THE REPORTS DISAGREE ABOUT THIS HOUSE. The roll-up above picks one
    // answer per fact and necessarily discards the disagreement; this hands it
    // back. Advisory — it resolves nothing, and two appraisers are allowed to
    // differ. Computed from the observations already loaded, so it costs no
    // extra query, and it never throws.
    const conflicts = findConflicts(obs.rows);
    res.json({ property: p, observations: obs.rows, sales: sales.rows, photos: photos.rows, conflicts });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// PHOTO BYTES
// ---------------------------------------------------------------------------
// Authorization is by MEMBERSHIP: the document must be linked into the research
// database as a property photo. That is what stops this becoming a general
// "download any document by id" hole for a staffer with no access to the file the
// document belongs to.
router.get('/photos/:documentId', async (req, res, next) => {
  try {
    if (!isUuid(req.params.documentId)) return res.status(404).json({ error: 'not found' });
    const d = (await db.query(
      `SELECT d.id, d.filename, d.content_type, d.storage_ref
         FROM documents d
        WHERE d.id = $1 AND d.is_current
          AND EXISTS (SELECT 1 FROM property_photos pp WHERE pp.document_id = d.id)`,
      [req.params.documentId])).rows[0];
    if (!d) return res.status(404).json({ error: 'not found' });
    return serveDocument(res, d, { inline: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// APPRAISERS
// ---------------------------------------------------------------------------
router.get('/appraisers', async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    const P = (v) => { params.push(v); return '$' + params.length; };
    const q = txt(req.query.q);
    if (q) where.push(`(a.name ILIKE ${P('%' + q + '%')} OR a.company ILIKE ${P('%' + q + '%')}
                        OR a.license_id ILIKE ${P(q + '%')} OR a.email ILIKE ${P('%' + q + '%')})`);
    const state = txt(req.query.state);
    if (state) where.push(`a.license_state = ${P(state.toUpperCase())}`);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const SORTS = {
      files: 'a.file_count DESC, a.name', recent: 'a.last_report_date DESC NULLS LAST, a.name',
      name: 'a.name', company: 'a.company NULLS LAST, a.name',
    };
    const sort = SORTS[req.query.sort] || SORTS.files;
    const r = await db.query(
      `SELECT a.*, count(*) OVER () AS total_count
         FROM appraisers a
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${sort}
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
    const total = r.rows.length ? Number(r.rows[0].total_count) : 0;
    for (const x of r.rows) delete x.total_count;
    res.json({ rows: r.rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (e) { next(e); }
});

router.get('/appraisers/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const a = (await db.query(`SELECT * FROM appraisers WHERE id=$1`, [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'not found' });
    const [contacts, licenses, files, work] = await Promise.all([
      db.query(`SELECT kind, value, times_seen, first_seen_at, last_seen_at FROM appraiser_contacts
                 WHERE appraiser_id=$1 ORDER BY kind, last_seen_at DESC`, [req.params.id]),
      db.query(`SELECT license_state, license_id, license_type, license_exp, times_seen, first_seen_at, last_seen_at
                  FROM appraiser_licenses WHERE appraiser_id=$1 ORDER BY last_seen_at DESC`, [req.params.id]),
      // EVERY FILE THIS APPRAISER APPRAISED FOR US — the owner's core ask. The loan
      // file's own address and number are shown because this is a staff surface and
      // the appraiser is already on the file; nothing about the borrower is joined in.
      db.query(
        `SELECT ap.id AS appraisal_id, ap.application_id, ap.effective_date, ap.report_signed_date,
                ap.form_type, ap.appraised_value, ap.as_is_value, ap.arv_value, ap.superseded,
                ap.subject_address, ap.subject_city, ap.subject_state, ap.subject_zip,
                ap.property_category, ap.units, ap.gla, ap.condition_uad,
                app.ys_loan_number, app.status AS file_status, app.deleted_at IS NOT NULL AS file_deleted,
                (SELECT count(*)::int FROM appraisal_comparables c WHERE c.appraisal_id = ap.id AND c.is_subject=false) AS comp_count
           FROM appraisals ap
           LEFT JOIN applications app ON app.id = ap.application_id
          WHERE ap.appraiser_id = $1
          ORDER BY COALESCE(ap.effective_date, ap.report_signed_date) DESC NULLS LAST, ap.imported_at DESC`,
        [req.params.id]),
      // WHAT THEIR WORK LOOKS LIKE IN AGGREGATE — the thing only we can compute,
      // because we hold many reports from the same person: how many comparables
      // they typically use, how far out they reach, how hard they adjust.
      db.query(
        `SELECT count(*)::int AS observations,
                count(DISTINCT o.property_id)::int AS distinct_properties,
                count(*) FILTER (WHERE o.role='comparable')::int AS comps_used,
                round(avg(o.gross_adj_pct) FILTER (WHERE o.gross_adj_pct IS NOT NULL)::numeric, 1) AS avg_gross_adj_pct,
                round(avg(abs(o.net_adj_pct)) FILTER (WHERE o.net_adj_pct IS NOT NULL)::numeric, 1) AS avg_net_adj_pct,
                count(*) FILTER (WHERE o.role='comparable' AND o.sale_status <> 'closed')::int AS listings_used,
                min(o.observed_on) AS first_report, max(o.observed_on) AS last_report
           FROM property_observations o WHERE o.appraiser_id = $1`, [req.params.id]),
    ]);
    // EVERY PROPERTY THIS APPRAISER EVER TOUCHED, and how they touched it (the
    // owner's "after opening appraiser profile you can see all property and files
    // and reports he did"). One row per PROPERTY, not per observation — an
    // appraiser who used one house as a comparable on four reports is telling us
    // something about that house, and it belongs on one line, not four.
    const properties = await db.query(
      `SELECT p.id, p.display_address, p.city, p.state, p.zip,
              p.property_type, p.units, p.year_built, p.gla, p.beds, p.baths_total,
              p.condition_uad, p.last_sale_price, p.last_sale_date, p.photo_count,
              count(*)::int                                            AS times_seen,
              count(*) FILTER (WHERE o.role = 'subject')::int           AS as_subject,
              count(*) FILTER (WHERE o.role = 'comparable')::int        AS as_comparable,
              max(o.observed_on)                                        AS last_observed_on,
              -- THE REAL TOTAL, so the screen can say "showing 2000 of 2731"
              -- instead of presenting a capped array's length as the whole truth.
              -- A busy appraiser hits the cap and the page then reads "2000
              -- properties" forever, and the filter and Show-more underneath it
              -- operate inside a set the user was never told was truncated.
              count(*) OVER ()::int                                     AS total_properties
         FROM property_observations o
         JOIN properties p ON p.id = o.property_id
        WHERE o.appraiser_id = $1
        GROUP BY p.id
        ORDER BY max(o.observed_on) DESC NULLS LAST, p.display_address
        LIMIT 2000`, [req.params.id]);

    // THE REPORTS THEY WROTE THAT ARE NOT ON A LOAN FILE — uploaded straight into
    // the research database (db/411). Without this the profile would show only the
    // deals we happened to write, and an appraiser's real body of work here would
    // read as smaller than it is.
    const imports = await db.query(
      `SELECT i.id, i.filename, i.form_type, i.effective_date, i.status,
              i.subject_address, i.subject_city, i.subject_state, i.subject_zip,
              i.subject_property_id, i.comparables_seen, i.observations_written, i.created_at,
              count(*) OVER ()::int AS total_imports
         FROM research_imports i
        WHERE i.appraiser_id = $1 AND i.status = 'ok'
        ORDER BY i.effective_date DESC NULLS LAST, i.created_at DESC
        LIMIT 500`, [req.params.id]);

    res.json({ appraiser: a, contacts: contacts.rows, licenses: licenses.rows,
      files: files.rows, imports: imports.rows, properties: properties.rows,
      work: work.rows[0] || {},
      // The counts BEFORE the caps above, so the screen never presents a
      // truncated array's length as a total.
      totals: {
        properties: properties.rows[0] ? properties.rows[0].total_properties : 0,
        imports: imports.rows[0] ? imports.rows[0].total_imports : 0,
        files: files.rows.length,   // uncapped query — its length IS the total
      } });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// MARKET RATES — what our own sales say things are worth around here
// ---------------------------------------------------------------------------
/**
 * Pull the closed comparable observations that define a market and derive the
 * adjustment rates from them. The market is defined by the caller (a city, a ZIP
 * list, a radius) — deliberately, because "what is a square foot worth" has no
 * answer without saying where.
 */
async function ratesFor(query) {
  const params = [];
  const where = ["o.role = 'comparable'", "COALESCE(o.sale_status,'closed') = 'closed'",
    'o.sale_price IS NOT NULL'];
  const P = (v) => { params.push(v); return '$' + params.length; };
  // A MARKET HAS TO BE NAMED. Every geographic predicate below is appended only
  // when supplied, so with none of them the WHERE degrades to the three base
  // clauses and the rates are derived from sales in EVERY state — then offered as
  // a pre-filled "$/sq ft around here". A valuation started from the search
  // screen's "New valuation" button has an empty subject, which is exactly that
  // case. The engine's own rule is that "what is a square foot worth" has no
  // answer without saying where, so refuse rather than answer nationally.
  if (!txt(query.state) && !txt(query.city) && !txt(query.zip)) {
    return { rates: null, why: 'no market was named — set the subject’s town or state first, then the rates can be worked out from sales there' };
  }
  const state = txt(query.state);
  if (state) where.push(`p.state = ${P(state.toUpperCase())}`);
  const city = txt(query.city);
  if (city) where.push(`lower(p.city) = ${P(city.toLowerCase())}`);
  const zip = txt(query.zip);
  if (zip) where.push(`p.zip = ${P(zip)}`);
  const months = parseInt(query.months, 10);
  if (Number.isFinite(months) && months > 0) {
    where.push(`o.sale_date >= (CURRENT_DATE - ${P(months)}::int * INTERVAL '1 month')`);
  }
  const type = txt(query.property_type);
  if (type) where.push(`p.property_type = ${P(type)}`);
  const r = await db.query(
    `SELECT o.sale_price, o.gla, o.beds, o.baths_full, o.baths_half, o.condition_uad,
            o.sale_date, o.sale_status,
            -- \`sale_type\` IS WHAT THE DISTRESSED FILTER READS, and it was not
            -- selected — so \`deriveMarketRates\` saw \`undefined\` on every row and
            -- set aside nothing, ever, on the ONLY production path that calls it
            -- (this function backs both GET /rates and the valuation suggester).
            o.sale_type
       FROM property_observations o JOIN properties p ON p.id = o.property_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.sale_date DESC
      LIMIT 4000`, params);
  // WHAT APPRAISERS IN THIS MARKET ACTUALLY PAID PER FOOT (db/441) — evidence
  // from the grids of reports we paid for, which beats the national rule of
  // thumb the derivation falls back to. Best-effort by construction: it refuses
  // below its own sample floor and the convention takes over, so a thin market
  // degrades to exactly what it did before.
  const window = Number.isFinite(months) && months > 0 ? months : 36;
  // AND IT STEPS OUT ONE RUNG AT A TIME WHEN THE TOWN IS TOO THIN (`relax`).
  // Never past the state — a nationwide median of appraiser adjustments describes
  // no market anyone lends in, which is the very thing the guard above refuses.
  // The answer says where it came from and the screen prints it.
  const peerGlaRate = await ingest.adjustmentRate(db, { basis: 'sqft', state, city, zip, months: window, relax: true });
  // AND THE 2-4 UNIT POPULATION, asked for by name. db/443 split the corpus by
  // which foot each adjustment was measured on, which was right and left the
  // building-area half unreachable: 8 of the 18 markets that cleared the sample
  // floor hold their adjustments almost entirely on 1025 grids, so asking only
  // for living area dropped those towns to the national rule of thumb while we
  // held twenty real local adjustments in each. The suggester picks per
  // comparable; the two are never blended.
  const peerGlaRateGba = await ingest.adjustmentRate(db, { basis: 'sqft_gba', state, city, zip, months: window, relax: true });
  return { rows: r.rows,
    rates: V.deriveMarketRates(r.rows, { today: todayNY(), peerGlaRate, peerGlaRateGba }) };
}

router.get('/rates', async (req, res, next) => {
  try {
    const { rates, why } = await ratesFor(req.query);
    // `why` says WHY there is no answer — the engine already refuses a rate on too
    // small a sample and states its reason; "no market was named" is the same kind
    // of honest refusal and must travel the same way.
    res.json({ rates, why: why || null,
      market: { state: txt(req.query.state), city: txt(req.query.city),
        zip: txt(req.query.zip), months: req.query.months || null } });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// COMPARABLE CANDIDATES for a subject
// ---------------------------------------------------------------------------
/**
 * "Find me comparables for THIS property." Runs the ordinary search with sensible
 * comparable defaults around the subject, then RANKS what comes back by how good
 * a match each one is. The ranking is advisory: the list is ordered, nothing is
 * chosen, and the reasons behind each score are returned so the human can
 * disagree with it.
 */
router.get('/comps', async (req, res, next) => {
  try {
    const today = todayNY();
    let subject = null;
    if (isUuid(req.query.property_id)) {
      subject = (await db.query(`SELECT * FROM properties WHERE id=$1`, [req.query.property_id])).rows[0] || null;
    } else if (isUuid(req.query.application_id)) {
      subject = await subjectForApplication(req.query.application_id);
    }
    if (!subject) {
      // A typed subject: whatever the caller gave us, used as the yardstick.
      subject = {
        display_address: txt(req.query.address), city: txt(req.query.city), state: txt(req.query.state),
        zip: txt(req.query.zip), gla: K.num(req.query.gla), beds: K.int(req.query.beds, { max: 99 }),
        baths_full: K.int(req.query.baths_full, { max: 99 }), baths_half: K.int(req.query.baths_half, { max: 99 }),
        year_built: K.yearBuilt(req.query.year_built), condition_uad: txt(req.query.condition_uad),
        property_type: txt(req.query.property_type), units: K.int(req.query.units, { max: 999 }),
        // A COORDINATE THAT IS NOT ON EARTH IS NOT A COORDINATE. Unbounded, a
        // typed `?lat=1e9` reached the haversine — harmless in that it matches
        // nothing, but a filter that silently matches nothing is the shape of the
        // bug this whole area exists to close. Out of range reads as "no
        // position", which the search already answers honestly.
        latitude: K.num(req.query.lat, { min: -90, max: 90 }),
        longitude: K.num(req.query.lng, { min: -180, max: 180 }),
      };
    }
    // A 2-4 UNIT PROPERTY IS COMPARED WITH 2-4 UNIT PROPERTIES. The owner's first
    // rule, in his own words: "if there's a single family residence obviously all
    // the compatibles are single families and if it's a 2 to 4 then all the
    // compatibles are two to 4". The defaults below matched on town, sale and
    // SIZE and never on the kind of building, so a three-family was compared with
    // houses that merely happened to be about as big — measured over the corpus,
    // **21% of the candidates for a 2-4 unit subject were single families**, one
    // in five.
    //
    // BANDED ON THE UNIT COUNT, not the property type: `units` is stated on 951 of
    // our 955 properties while the type is not, and it is also the fact the rule
    // itself is phrased in. The bands are the owner's own — one, two-to-four, and
    // five-plus. A subject whose unit count we do not know bands nothing rather
    // than guessing, because guessing here silently hides real comparables.
    const unitBand = (n) => {
      const u = K.int(n, { max: 999 });
      if (!u || u < 1) return null;
      // `units_unknown_ok` because a property that never stated its count is not
      // proved to be the wrong kind, and dropping it would turn missing data into
      // an empty answer that reads as "this town is thin". The screens show an
      // unknown count in red, so it is never passed off as known.
      if (u === 1) return { units_min: 1, units_max: 1, units_unknown_ok: '1' };
      if (u <= 4) return { units_min: 2, units_max: 4, units_unknown_ok: '1' };
      return { units_min: 5, units_unknown_ok: '1' };
    };

    // DEFAULTS THAT MAKE THE FIRST ANSWER USEFUL, all overridable from the query.
    // Same city, sold in the last 18 months, within a third to triple the subject's
    // size, and never the subject itself.
    // A CALLER WHO NAMES EITHER BOUND OWNS BOTH. The band is spread in as a
    // DEFAULT and the caller's query is merged over it, so naming only one bound
    // used to inherit the band's other one and the two intersected: a 1-unit
    // subject asked for `units_min=2` ran `units >= 2 AND units <= 1` and
    // answered NOTHING, at every rung of the ladder, with the screen reporting
    // that the town was thin. Half a range is still an explicit instruction, and
    // the route's own rule is that a caller who asked for something explicitly is
    // never overridden — so the band stands down entirely rather than completing
    // a range nobody asked for.
    const namedUnits = ['units_min', 'units_max'].some((k) => {
      const v = req.query[k];
      return v != null && String(v).trim() !== '';
    });
    const filters = Object.assign({
      state: subject.state, city: subject.city,
      ...((namedUnits ? null : unitBand(subject.units)) || {}),
      has_sale: '1', sale_status: 'closed',
      sold_within_months: 18,
      sqft_min: subject.gla ? Math.round(subject.gla * 0.6) : undefined,
      sqft_max: subject.gla ? Math.round(subject.gla * 1.6) : undefined,
      // NO `sort` DEFAULT ON PURPOSE. The screen's promise is "every sale within
      // the distance you pick, NEAREST FIRST", and the SQL `LIMIT` decides which
      // rows survive before anything is re-ranked in JS. Naming a sort here made
      // `search.js`'s own "placed subject → sort by distance" fallback dead for
      // the only caller that supplies coordinates, so the 60 most RECENTLY SOLD
      // rows in the circle were taken and the genuinely nearest comps could be
      // absent from the answer entirely. Leaving it unset lets that fallback pick
      // `distance` when the subject is placed and `recent_sale` when it is not.
      // A caller that asks for a specific sort still wins — this is only a default.
      limit: 60,
      // WHAT NAMES THE SUBJECT IS NOT A FILTER ON THE ANSWER. `application_id`,
      // `property_id` and the typed-subject fields are read off `req.query` above
      // to work out WHICH property we are finding comps for — but they were then
      // merged into the search filters too, and `search.js` turns
      // `application_id` into `EXISTS (… o.application_id = $n)`. So the loan-file
      // entry point could only ever return the comps that file's OWN appraisal had
      // already used: measured 2 rows instead of 5, on the primary path. Worse, the
      // ladder then walked every rung and the screen reported "we looked as hard as
      // we could and this town is thin" — a filter bug wearing an honest face.
      //
      // `want` and `relaxable` steer the LADDER, not the SQL, and are stripped for
      // the same reason.
    }, (() => {
      const c = stripEmpty(req.query);
      for (const k of ['want', 'relaxable', 'application_id', 'property_id',
        'address', 'gla', 'beds', 'baths_full', 'baths_half', 'year_built',
        'condition_uad', 'property_type', 'units', 'lat', 'lng',
        // `market_area_id` names a SHAPE, not a column. It is resolved to the
        // properties inside it below and passed as `property_ids`; left here it
        // would reach `buildQuery` as an unknown key and be silently ignored,
        // which is a filter the screen claims to have applied and did not.
        'market_area_id']) delete c[k];
      return c;
    })());
    // A VALUE WE OFFER IS A VALUE WE ACCEPT. The screen offers "sold at any time",
    // which must beat the 18-month default above — otherwise the option silently
    // does nothing, which is exactly the bug this comment used to only half-fix.
    //
    // "No limit" arrives as `0`, NOT as an empty string. The client's query-string
    // builder drops an empty value before it reaches the wire (`qs()` skips
    // `v === ''`), so a `''` the route carefully looked for was never actually
    // sent and the default won anyway. `0` survives the builder, survives
    // `stripEmpty`, and `search.js` already declines to add a window clause for a
    // non-positive month count — so it means the same thing all the way down.
    // The empty form is still honoured for any caller that hand-writes the URL.
    for (const k of ['sold_within_months', 'radius_miles']) {
      if (!Object.prototype.hasOwnProperty.call(req.query, k)) continue;
      const v = req.query[k];
      if (v === '' || v === '0' || Number(v) === 0) delete filters[k];
    }
    if (subject.id) filters.exclude_property_id = subject.id;

    /* THE DRAWN NEIGHBOURHOOD, IF ONE WAS PICKED — and it is never relaxed.
     *
     * A radius is a bad model of a neighbourhood and every appraiser knows it: a
     * mile in one direction crosses a river or a town line, a mile in another is
     * the same houses on the same streets. When an officer has drawn the boundary
     * themselves, that judgement is the most specific thing the search has, so it
     * is honoured EXACTLY — it never appears on the relaxation ladder, for the
     * same reason `comp_set` does not. Widening past a boundary a person drew
     * would answer a different question than the one on screen.
     *
     * A shape that names nothing live is a REFUSAL, not a silently-dropped filter:
     * the screen said the search was cut to a neighbourhood, and answering with
     * the whole town instead is the class of bug this area exists to close.
     */
    let marketArea = null;
    if (req.query.market_area_id) {
      marketArea = await resolveMarketArea(String(req.query.market_area_id));
      if (!marketArea) {
        return res.json({
          rows: [], total: 0, subject, refused: 'market_area_not_found',
          why: 'That market area is not there any more — it may have been archived. Pick another, '
            + 'or search without one.',
        });
      }
      filters.property_ids = marketArea.ids;      // [] means "it contains none of ours"
    }
    // WHERE THE SUBJECT IS — the looked-up coordinate first, the appraiser's second
    // (db/412). A stored subject property has `eff_latitude`; a typed one carries
    // whatever the caller sent as lat/lng. Distance is always computed when we know
    // both ends, even with no radius asked for, because "how far is each of these
    // from my property" is the question the screen is there to answer.
    const sLat = K.num(subject.eff_latitude != null ? subject.eff_latitude : subject.latitude);
    const sLng = K.num(subject.eff_longitude != null ? subject.eff_longitude : subject.longitude);
    if (sLat != null && sLng != null) { filters.lat = sLat; filters.lng = sLng; }
    else if (req.query.radius_miles) {
      // A radius was asked for and we cannot place the subject. Answering with the
      // whole town silently would look like the radius worked, so the radius is
      // dropped and the answer SAYS the subject has not been placed yet.
      delete filters.radius_miles;
    }
    // THE RELAXATION LADDER — and it SAYS which rung produced the answer.
    //
    // A comp search that quietly returns three rows looks identical to one that
    // searched a market we have barely touched. So instead of one query, this
    // walks from the tightest sensible search outwards until it has enough to
    // work with, and reports every rung it tried and what each one found. The
    // screen can then say "nothing within a mile; nothing within two; here are
    // four in the town" instead of "4 properties" with no denominator.
    //
    // A caller that asked for something explicitly is never overridden: the rungs
    // only ever relax filters the DEFAULTS supplied, and `askedFor` freezes
    // anything that came in on the query string.
    // WHAT THE CALLER EXPLICITLY ASKED FOR is never relaxed. A screen that sends
    // its OWN defaults (so its controls cannot lie about what ran) names them in
    // `relaxable`, and those come back off this list — otherwise a default would
    // be indistinguishable from a deliberate choice and the ladder could never
    // widen anything.
    const askedFor = new Set(Object.keys(req.query || {}));
    for (const k of String(req.query.relaxable || '').split(',')) {
      const key = k.trim();
      if (key) askedFor.delete(key);
    }
    const want = Math.max(1, Math.min(25, K.int(req.query.want, { max: 25 }) || 6));
    // EVERY RUNG MUST STRICTLY WIDEN. A "relax" that replaces a caller's band with
    // its own can NARROW the search — measured: a 100–100000 sq ft request became
    // 600–3300 on a rung labelled "a wider size range", dropping three comparables
    // the first query had already found. Each rung therefore takes the UNION of
    // what is already there and what it proposes, so it is monotone by
    // construction and the ladder can only ever add.
    const widen = (cur, lo, hi) => ({
      sqft_min: Math.min(K.num(cur.sqft_min) == null ? Infinity : K.num(cur.sqft_min), lo),
      sqft_max: Math.max(K.num(cur.sqft_max) == null ? 0 : K.num(cur.sqft_max), hi),
    });
    const RUNGS = [
      { id: 'as_asked', label: 'as asked', relax: () => ({}) },
      { id: 'wider_size', label: 'a wider size range',
        relax: (f) => {
          if (!subject.gla || askedFor.has('sqft_min') || askedFor.has('sqft_max')) return null;
          const w = widen(f, Math.round(subject.gla * 0.4), Math.round(subject.gla * 2.2));
          // Nothing to do if the band already covers it — a rung that changes
          // nothing must not spend a query or claim a step on the ladder.
          if (w.sqft_min === K.num(f.sqft_min) && w.sqft_max === K.num(f.sqft_max)) return null;
          return w;
        } },
      { id: 'longer_window', label: 'a longer time window',
        relax: (f) => (!askedFor.has('sold_within_months') && K.num(f.sold_within_months) > 0
          && K.num(f.sold_within_months) < 36 ? { sold_within_months: 36 } : null) },
      { id: 'wider_radius', label: 'a wider distance',
        relax: (f) => {
          if (!f.radius_miles || askedFor.has('radius_miles')) return null;
          const cur = Number(f.radius_miles);
          const next = Math.min(10, cur * 3);
          return next > cur ? { radius_miles: next } : null;   // never shrink a radius over 10
        } },
      { id: 'whole_town', label: 'the whole town, any distance',
        relax: (f) => (f.radius_miles && !askedFor.has('radius_miles') ? { radius_miles: undefined } : null) },
      { id: 'any_time', label: 'any time',
        relax: (f) => (!askedFor.has('sold_within_months') && f.sold_within_months
          ? { sold_within_months: undefined } : null) },
      // THE LAST RUNG, AND IT IS ONLY EVER REACHED WITH NOTHING IN HAND.
      //
      // The unit band is a DEFAULT this route supplied, not something the officer
      // typed — there is no units control on any of the three screens that call
      // this, and there is no way to clear it from the UI. So when the band is
      // what emptied the answer, the screen said "we searched as far as the
      // settings allow and still found nothing", which was untrue: it stopped at
      // a filter the officer never set, cannot see and cannot lift.
      //
      // Measured over the real corpus: this fires for 1 of 132 lent-on subjects
      // and 17 of 955 properties — the towns where we hold houses and the subject
      // is a three-family. Showing those houses, LABELLED as a different kind of
      // building, is strictly better than an empty screen next to a coverage line
      // saying we hold nineteen properties in that town.
      //
      // Same-kind ALWAYS wins: this rung cannot be reached while any earlier one
      // found anything, and it stands down the moment the caller named a unit
      // range themselves. It is monotone like every other rung — it only ever
      // removes a predicate.
      // A RENOVATED SALE IS A DIFFERENT QUESTION FROM A DIFFERENT KIND OF
      // BUILDING, and it gives way FIRST. An after-repair value has to rest on
      // sales of FINISHED houses, and the appraiser told us which those are —
      // `comp_set='arv'` is the grid they put it on, not a guess about whether
      // somebody renovated it. But if a town holds none, a same-kind AS-IS sale
      // is a more useful answer than a renovated sale of the wrong kind of
      // building, so this rung is tried before the unit band gives way.
      // Same discipline as that band: only on an empty answer, never on a merely
      // short one, and never when the caller asked for the set themselves.
      { id: 'any_kind_of_sale', label: 'sales of any kind, not only renovated ones',
        relax: (f) => ((best && best.total > 0) || askedFor.has('comp_set') || !f.comp_set
          ? null : { comp_set: undefined }) },
      //
      // IT FIRES ONLY ON AN EMPTY ANSWER, not merely a short one. Every other rung
      // keeps widening until it has `want` (6) rows, and letting this one do that
      // would drop the band on any subject with five same-kind comps — which is
      // most of them — and quietly undo the whole thing. `best` is the best rung
      // so far; nothing found means nothing found.
      { id: 'any_kind_of_building', label: 'any kind of building',
        relax: (f) => ((best && best.total > 0) || namedUnits
          || (f.units_min == null && f.units_max == null)
          ? null
          : { units_min: undefined, units_max: undefined, units_unknown_ok: undefined }) },
    ];

    let active = Object.assign({}, filters);
    const ladder = [];
    // KEEP THE BEST RUNG, NOT THE LAST ONE. The rungs are monotone now, so a later
    // rung should never find less — but "should never" is not "cannot", and the
    // answer the officer reads must never be worse than one this same request
    // already had in hand. So the winner is tracked explicitly and the loop can
    // only improve on it.
    let best = null, bestRung = 'as_asked', bestFilters = Object.assign({}, active);
    for (const rung of RUNGS) {
      const change = rung.relax(active);
      if (rung.id !== 'as_asked' && !change) continue;      // nothing left to relax on this rung
      if (change) {
        for (const [k, v] of Object.entries(change)) {
          if (v === undefined) delete active[k]; else active[k] = v;
        }
      }
      const got = await S.searchProperties(db, active);
      /* "FOUND NOTHING" AND "COULD NOT MEASURE" ARE DIFFERENT ANSWERS, and a
         ladder that reports the second as the first tells an officer the town is
         thin when the truth is we never placed their subject. A rung whose
         radius could not run is marked, so the screen can say which happened. */
      ladder.push({ step: rung.id, label: rung.label, found: got.total,
        unmeasurable: got.refused === 'radius_without_position' || undefined });
      if (!best || got.total > best.total) {
        best = got; bestRung = rung.id; bestFilters = Object.assign({}, active);
      } else if (got.total === 0 && change) {
        // A RUNG THAT FOUND NOTHING PUTS BACK WHAT IT RELAXED. `active` is
        // mutated in place, so a fruitless "any kind of sale" left `comp_set`
        // deleted while the NEXT rung ran — and the answer was then reported
        // under one rung's name while two relaxations were in force. The comp
        // picker shows no ladder at all, so an officer would have been handed
        // as-is sales of a different kind of building with nothing saying so.
        for (const [k, v] of Object.entries(change)) {
          if (v === undefined) { if (k in filters) active[k] = filters[k]; } else delete active[k];
        }
      }
      if (best.total >= want) break;
    }
    const page = best;
    const usedRung = bestRung;
    active = bestFilters;

    const ranked = page.rows.map((c) => {
      const s = V.scoreComp(subject, c, { today });
      // `coverage` travels WITH the score, always. They say different things — the
      // score is how well it matches on what we know, the coverage is how much we
      // knew — and a screen showing one without the other overstates its confidence.
      return Object.assign({}, c, { match_score: s.score, match_coverage: s.coverage, match_reasons: s.parts });
    }).sort((a, b) => b.match_score - a.match_score);

    // HOW MUCH OF THIS MARKET WE HOLD AT ALL. Without it an empty answer reads as
    // "your filters are too tight" when the truth is usually "we have never lent
    // in this town". Cheap: one count, no joins.
    // EVERY PART OF IT OPTIONAL, and NULL when no locality was named at all.
    // `WHERE state = $1` with a NULL state matches zero rows, so a ZIP-only
    // subject — which this screen explicitly allows — was told "we hold no
    // properties at all in that area yet… nothing you change in the filters will
    // find anything here" while the warehouse held 147 in that very ZIP. A panel
    // built to stop the tool overstating itself must never itself state a false
    // zero: with nothing to scope by it returns null and the screen says nothing.
    let coverage = null;
    try {
      const town = subject.city || null, st = subject.state || null, zp = subject.zip || null;
      if (town || st || zp) {
        const c = (await db.query(
          `SELECT count(*)::int AS properties,
                  count(*) FILTER (WHERE last_sale_price IS NOT NULL)::int AS with_sale
             FROM properties
            WHERE ($1::text IS NULL OR state = $1)
              AND ($2::text IS NULL OR lower(city) = lower($2))
              AND ($3::text IS NULL OR zip = $3)`, [st, town, zp])).rows[0];
        coverage = { town, state: st, zip: zp,
          where: town || zp || st,
          properties: c ? c.properties : 0, with_sale: c ? c.with_sale : 0 };
      }
    } catch (_) { coverage = null; }

    res.json({
      subject, rows: ranked, total: page.total,
      // `filters` is WHAT WAS ASKED FOR — the defaults with the caller's query on
      // top, before the ladder touched anything. `applied_filters` is what the
      // search that produced these rows actually ran with. They differ exactly
      // when the ladder had to relax something, and `relaxed_to` names the rung.
      filters, applied_filters: active,
      // WHICH RUNG ANSWERED, and everything tried on the way — so the screen can
      // be honest about how hard it had to look.
      relaxed_to: usedRung, ladder, wanted: want,
      coverage,
      // Distance is only real when BOTH ends are placed. Saying so is the whole
      // difference between "there is nothing within half a mile" and "we do not
      // know where your property is yet".
      subject_located: sLat != null && sLng != null,
      radius_dropped: !!(req.query.radius_miles && (sLat == null || sLng == null)),
      // THE DRAWN BOUNDARY, AND WHAT IT ACTUALLY CUT. Both numbers, because "12 of
      // the 40 in its bounding box" is a boundary doing real work and "40 of the
      // 40" means the shape is a rectangle that is cutting nothing — which the
      // person relying on it should know. `truncated` says the box held more than
      // one reading holds, so the answer rests on a large sample rather than on
      // all of it; a silent cap would read as completeness.
      market_area: marketArea ? {
        id: marketArea.area.id, name: marketArea.area.name,
        inArea: marketArea.inArea, inBox: marketArea.inBox, truncated: marketArea.truncated,
      } : null,
    });
  } catch (e) { next(e); }
});

/** The subject property of a loan file, as the warehouse knows it. */
// ---------------------------------------------------------------------------
// WHAT OUR OWN APPRAISERS CHARGE — the adjustment corpus (item 5.3)
// ---------------------------------------------------------------------------
// ~9x more adjustment evidence than sale evidence, and until now nothing read a
// line of it. Every gate, refusal and wording lives in `research/adjustment-corpus`.
//
// GROUPED BY BASIS, NEVER POOLED. A 1004 states gross LIVING area and a 1025
// states gross BUILDING area; both land in this table with their own
// `unit_delta_basis`, and averaging the two produces a dollars-per-foot figure
// about no measurable thing. They are answered as separate markets, always.
//
// `?appraisal_id=` additionally places THAT report among the others — the actual
// deliverable, and the only form of this that is defensible: not "the rate should
// have been X" but "you used X, and here is what our other reports used".
router.get('/adjustment-rates', async (req, res, next) => {
  try {
    const state = txt(req.query.state);
    const city = txt(req.query.city);
    let scopeAppraisal = null;
    if (isUuid(req.query.appraisal_id)) {
      scopeAppraisal = (await db.query(
        'SELECT id, subject_state, subject_city FROM appraisals WHERE id = $1',
        [req.query.appraisal_id])).rows[0] || null;
      if (!scopeAppraisal) return res.status(404).json({ error: 'not found' });
    }
    const useState = state || (scopeAppraisal && scopeAppraisal.subject_state) || null;
    const useCity = city || (scopeAppraisal && scopeAppraisal.subject_city) || null;
    if (!useState && !useCity) {
      // A NATIONWIDE RATE IS NOT A RATE. The same refusal the valuation screen
      // makes: "what our appraisers charge" is only meaningful about a market.
      return res.status(400).json({ error: 'name a state or a city — a nationwide rate is about nowhere' });
    }

    // A LADDER, CITY FIRST — and it says which rung answered.
    //
    // A city is the right market for "what do our appraisers charge here", and in
    // most cities we hold too little to say. Falling silently back to the state
    // would report a state-wide habit as a local one; refusing outright would
    // waste evidence we have. So both are tried, in order, and the scope that
    // produced the answer is returned with it — the same honesty the comparable
    // search's relaxation ladder already applies.
    const fetchFor = async (scope) => {
      const params = [];
      const where = ['a.amount IS NOT NULL'];
      const P = (v) => { params.push(v); return '$' + params.length; };
      if (scope.state) where.push(`a.state = ${P(String(scope.state).toUpperCase())}`);
      if (scope.city) where.push(`lower(a.city) = ${P(String(scope.city).toLowerCase())}`);
      return (await db.query(
        `SELECT a.amount, a.unit_delta, a.unit_delta_basis, a.line_type,
                o.appraisal_id, o.appraiser_id
           FROM property_adjustments a
           JOIN property_observations o ON o.id = a.observation_id
          WHERE ${where.join(' AND ')}
          LIMIT ${ROW_CAP + 1}`, params)).rows;
    };

    // NO SILENT CAP. A truncated sample is a biased median — and the rows come
    // back in no particular order, so the bias is arbitrary rather than merely
    // conservative. One extra row is fetched so the truncation can be DETECTED,
    // and it is reported rather than quietly shaping the answer. NJ, the busiest
    // state in the corpus, holds ~5,700 lines, so this is a real boundary.
    const rungs = [];
    if (useCity) rungs.push({ state: useState, city: useCity, label: useState ? `${useCity}, ${useState}` : useCity });
    if (useState) rungs.push({ state: useState, city: null, label: `all of ${useState}` });

    // TWO KINDS OF EVIDENCE, ANSWERED SEPARATELY AND NEVER MIXED.
    //
    //  · PER-UNIT — a line with a measured delta, so `amount / delta` is a rate in
    //    dollars a square foot, grouped by BASIS (living area and gross building
    //    area are different measures and pooling them describes nothing).
    //  · FLAT — a garage, a porch, a finished basement, a condition grade. Most of
    //    the grid, and most of the evidence: 323 paid RoomCount lines against 358
    //    square-foot ones. No countable delta exists, so no rate can be formed;
    //    the claim is one step less precise and equally defensible.
    //
    // The difference that matters is what a ZERO means. With a delta, $0 provably
    // means the appraiser looked and declined. Without one it might equally mean
    // there was nothing to adjust for, and `summarizeAmounts` says so rather than
    // claiming a judgement nobody made.
    const summarize = (lines) => {
      const perUnit = lines.filter((l) => l.unit_delta != null);
      const byBasis = new Map();
      for (const r of perUnit) {
        const k = r.unit_delta_basis || 'unknown';
        if (!byBasis.has(k)) byBasis.set(k, []);
        byBasis.get(k).push(r);
      }
      return [...byBasis].map(([basis, rowsOf]) => {
        const summary = ADJ.summarizeRates(rowsOf);
        let thisReport = null;
        if (scopeAppraisal) {
          // The rate THIS report used, from its own lines in the same basis —
          // their MEDIAN, because one grid states several and they are one
          // opinion, not several.
          const mine = rowsOf
            .filter((l) => String(l.appraisal_id) === String(scopeAppraisal.id))
            .map((l) => ADJ.rateOf(l)).filter((v) => v.rate != null).map((v) => v.rate)
            .sort((x, y) => x - y);
          if (mine.length) thisReport = ADJ.compareRate(mine[Math.floor((mine.length - 1) / 2)], summary);
        }
        return { kind: 'per_unit', basis,
          line_types: [...new Set(rowsOf.map((l) => l.line_type).filter(Boolean))],
          summary, thisReport };
      }).sort((a, b) => (b.summary.n || 0) - (a.summary.n || 0));
    };

    /** The flat lines, one market per line type. */
    const summarizeFlat = (lines) => {
      const byType = new Map();
      for (const r of lines) {
        if (r.unit_delta != null) continue;
        const k = r.line_type || 'Other';
        if (!byType.has(k)) byType.set(k, []);
        byType.get(k).push(r);
      }
      return [...byType].map(([lineType, rowsOf]) => {
        const summary = ADJ.summarizeAmounts(rowsOf);
        let thisReport = null;
        if (scopeAppraisal && summary.available) {
          const mine = rowsOf
            .filter((l) => String(l.appraisal_id) === String(scopeAppraisal.id))
            .map((l) => Math.abs(Number(l.amount)))
            .filter((n) => Number.isFinite(n) && n > 0)
            .sort((x, y) => x - y);
          if (mine.length) thisReport = ADJ.compareRate(mine[Math.floor((mine.length - 1) / 2)], summary);
        }
        return { kind: 'flat', line_type: lineType, summary, thisReport };
      }).sort((a, b) => (b.summary.n || 0) - (a.summary.n || 0));
    };

    const tried = [];
    let markets = [];
    let answeredAt = null;
    let truncated = false;
    for (const rung of rungs) {
      const fetched = await fetchFor(rung);
      if (fetched.length > ROW_CAP) truncated = true;
      const lines = fetched.slice(0, ROW_CAP);
      const m = summarize(lines).concat(summarizeFlat(lines));
      tried.push({ scope: rung.label, answered: m.some((x) => x.summary.available) });
      if (m.some((x) => x.summary.available)) { markets = m; answeredAt = rung.label; break; }
      // Keep the narrowest attempt's refusals, so an unanswered request still
      // says what was actually there rather than an empty array.
      if (!markets.length) markets = m;
    }

    res.json({ state: useState, city: useCity || null,
      appraisal_id: scopeAppraisal ? scopeAppraisal.id : null,
      // WHICH market actually answered, and every rung that was tried — a
      // state-wide habit reported as a local one is the failure this prevents.
      scope: answeredAt, tried, truncated, markets });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// WHAT OUR OWN FILES SAY ABOUT AN APPRAISER'S VALUE
// ---------------------------------------------------------------------------
// The in-house analogue of the desk review a capital partner buys. Every gate
// and every refusal lives in `research/variance`; this route only assembles the
// evidence and hands it over.
//
// THE ASSEMBLY IS THE PART THAT MATTERS HERE: each candidate comparable is
// annotated with EVERY report and appraiser that ever described it, not just the
// newest. The independence rule needs that — a house our warehouse learned about
// from the report under review AND from somebody else's is corroboration, and
// attributing it to one source alone would throw the best rows away.
router.get('/variance', async (req, res, next) => {
  try {
    if (!isUuid(req.query.appraisal_id)) return res.status(400).json({ error: 'appraisal_id is required' });
    const a = (await db.query(
      `SELECT id, application_id, appraised_value, as_is_value, subject_address, subject_city,
              subject_state, subject_zip, units, property_type, gla, beds, baths_full, baths_half,
              year_built, condition_uad, effective_date
         FROM appraisals WHERE id = $1`, [req.query.appraisal_id])).rows[0];
    if (!a) return res.status(404).json({ error: 'not found' });

    // The subject as the warehouse knows it, falling back to what the report says.
    const stored = a.application_id ? await subjectForApplication(a.application_id) : null;
    const subject = stored || {
      display_address: a.subject_address, city: a.subject_city, state: a.subject_state,
      zip: a.subject_zip, gla: a.gla, beds: a.beds, baths_full: a.baths_full,
      baths_half: a.baths_half, year_built: a.year_built, condition_uad: a.condition_uad,
      property_type: a.property_type, units: a.units,
    };

    // The candidate set, through the SAME comparable search the screen uses, so a
    // reviewer can go and see exactly the rows this was built from.
    const picked = await S.searchProperties(db, stripEmpty({
      state: subject.state, city: subject.city,
      exclude_property_id: subject.id || undefined,
      sold_within_months: 18, limit: 25, sort: 'recent_sale',
    }));
    const rows = (picked && picked.rows) || [];
    const ids = rows.map((r) => r.id).filter(Boolean);

    // EVERY source, per property.
    const sources = new Map();
    if (ids.length) {
      const obs = (await db.query(
        `SELECT property_id, appraisal_id, appraiser_id FROM property_observations
          WHERE property_id = ANY($1::uuid[]) AND appraisal_id IS NOT NULL`, [ids])).rows;
      for (const o of obs) {
        const e = sources.get(o.property_id) || { r: new Set(), a: new Set() };
        if (o.appraisal_id) e.r.add(String(o.appraisal_id));
        if (o.appraiser_id) e.a.add(String(o.appraiser_id));
        sources.set(o.property_id, e);
      }
    }
    // THE GRID WANTS `sale_price` / `sale_date`; THE WAREHOUSE ROLL-UP CALLS THEM
    // `last_sale_price` / `last_sale_date`. Without the rename every comparable
    // arrives priceless, the reconcile produces nothing, and the route answers
    // "our own comparables did not produce a value" on a set that is perfectly
    // good — a refusal that reads as thin coverage and is actually a typo. The
    // valuation route does the same rename at its own snapshot; this is that one
    // line, and it is why the end-to-end check exists.
    const comps = rows
      .map((r) => Object.assign({}, r, {
        sale_price: r.last_sale_price,
        sale_date: r.last_sale_date ? String(r.last_sale_date).slice(0, 10) : null,
        source_appraisal_ids: [...((sources.get(r.id) || {}).r || [])],
        appraiser_ids: [...((sources.get(r.id) || {}).a || [])],
      }))
      // A COMPARABLE WITH NO PRICE IS NOT EVIDENCE, and counting it toward the
      // coverage gate would let three priceless rows clear a floor that exists
      // to mean three SALES.
      .filter((r) => r.sale_price != null);

    // The APPRAISED value is what the appraiser concluded; on a renovation report
    // that is the after-repair figure, so the as-is is used when it is the one the
    // comparables are actually about. Never averaged — one or the other.
    const value = a.appraised_value != null ? a.appraised_value : a.as_is_value;
    const result = VAR.assessVariance({
      appraisedValue: value, subject, comps, appraisalId: a.id, today: todayNY(),
    });
    res.json({ appraisal_id: a.id, appraised_value: value == null ? null : Number(value),
      variance: result, summary: VAR.describeVariance(result) });
  } catch (e) { next(e); }
});

async function subjectForApplication(appId) {
  const r = await db.query(
    `SELECT p.* FROM properties p
       JOIN property_observations o ON o.property_id = p.id
      WHERE o.application_id = $1 AND o.role = 'subject'
      ORDER BY o.observed_on DESC NULLS LAST LIMIT 1`, [appId]);
  return r.rows[0] || null;
}

function stripEmpty(q) {
  const out = {};
  for (const [k, v] of Object.entries(q || {})) if (v !== '' && v != null) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// BUILD-YOUR-OWN VALUATIONS
// ---------------------------------------------------------------------------
/**
 * Read a saved valuation back and re-run the grid over it.
 *
 * THE STORED NUMBERS ARE NOT TRUSTED AS THE ANSWER — they are re-derived from the
 * stored snapshots and adjustments every time, by the same engine the screen uses.
 * That way a saved valuation and a live one can never disagree about arithmetic,
 * and a fix to the engine reaches every draft. (The FINALIZED figures are stored
 * as well, so a finalized report still shows exactly what was signed off.)
 */
async function loadValuation(id) {
  const v = (await db.query(`SELECT * FROM property_valuations WHERE id=$1`, [id])).rows[0];
  if (!v) return null;
  const comps = (await db.query(
    `SELECT c.*, p.display_address AS live_address, p.photo_count
       FROM property_valuation_comps c LEFT JOIN properties p ON p.id = c.property_id
      WHERE c.valuation_id = $1 ORDER BY c.comp_order, c.created_at`, [id])).rows;
  const subject = Object.assign({}, v.subject_snapshot || {});
  const gridComps = comps.map((c) => Object.assign({}, c.snapshot || {}, {
    id: c.id, property_id: c.property_id, observation_id: c.observation_id,
    sale_price: c.sale_price, sale_date: c.sale_date ? String(c.sale_date).slice(0, 10) : null,
    distance_miles: c.distance_miles,
    adjustments: c.adjustments || [], weight: c.weight, include: c.included !== false,
    note: c.note, comp_order: c.comp_order,
  }));
  const grid = V.buildGrid(subject, gridComps, { today: todayNY(), method: v.method,
    roundTo: 1000 });
  /* BRACKETING is judged on the comparables ACTUALLY IN USE. A comparable
     somebody switched off supports nothing, so counting it would report a set as
     surrounding the subject on the strength of a sale the value does not rest
     on — the one way this check could mislead rather than warn. Advisory, and
     never allowed to break the screen it sits on. */
  let bracketing = null;
  try {
    bracketing = BR.assessBracketing(subject, (grid.comps || []).filter((c) => c.include !== false),
      { indicatedValue: grid.value && grid.value.indicatedValue });
  } catch (e) { bracketing = null; }
  return { valuation: v, comps, grid, bracketing };
}

router.get('/valuations', async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    const P = (x) => { params.push(x); return '$' + params.length; };
    if (isUuid(req.query.property_id)) where.push(`v.property_id = ${P(req.query.property_id)}`);
    if (isUuid(req.query.application_id)) where.push(`v.application_id = ${P(req.query.application_id)}`);
    if (req.query.mine === '1') where.push(`v.created_by = ${P(req.actor.id)}`);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const r = await db.query(
      `SELECT v.id, v.title, v.subject_address, v.purpose, v.status, v.indicated_value,
              v.value_low, v.value_high, v.confidence_label, v.created_at, v.updated_at,
              v.property_id, v.application_id, v.version,
              s.full_name AS created_by_name,
              (SELECT count(*)::int FROM property_valuation_comps c WHERE c.valuation_id = v.id) AS comp_count
         FROM property_valuations v LEFT JOIN staff_users s ON s.id = v.created_by
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY v.updated_at DESC LIMIT ${limit}`, params);
    res.json({ rows: r.rows });
  } catch (e) { next(e); }
});

router.post('/valuations', async (req, res, next) => {
  try {
    const b = req.body || {};
    let subject = null, propertyId = null;
    if (isUuid(b.property_id)) {
      subject = (await db.query(`SELECT * FROM properties WHERE id=$1`, [b.property_id])).rows[0] || null;
      propertyId = subject ? subject.id : null;
    } else if (isUuid(b.application_id)) {
      subject = await subjectForApplication(b.application_id);
      propertyId = subject ? subject.id : null;
    }
    // A typed subject is legitimate: valuing a property nobody has appraised yet is
    // one of the main reasons to open this tool.
    if (!subject) {
      subject = Object.assign({}, b.subject || {});
      if (!txt(subject.display_address) && txt(b.address)) subject.display_address = txt(b.address);
    }
    const address = txt(subject.display_address) || txt(b.address) || 'Untitled property';
    // THE SNAPSHOT IS THE POINT. The warehouse keeps learning and the roll-up keeps
    // moving; a valuation that re-read it would silently change its own answer, and
    // a printed report would stop reproducing. Copy the facts in, once.
    const snapshot = subjectSnapshot(subject);
    const r = await db.query(
      `INSERT INTO property_valuations (title, property_id, application_id, subject_address,
         subject_snapshot, purpose, effective_date, method, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [txt(b.title) || address, propertyId, isUuid(b.application_id) ? b.application_id : null,
       address, JSON.stringify(snapshot), ['as_is', 'arv', 'research'].includes(b.purpose) ? b.purpose : 'research',
       /^\d{4}-\d{2}-\d{2}$/.test(String(b.effective_date || '')) ? b.effective_date : todayNY(),
       ['weighted', 'median', 'mean'].includes(b.method) ? b.method : 'weighted', req.actor.id]);
    await audit(req.actor.id, 'valuation_created', r.rows[0].id, { address });
    res.status(201).json(await loadValuation(r.rows[0].id));
  } catch (e) { next(e); }
});

/** The subject facts a grid needs, copied out of whatever we were handed. */
function subjectSnapshot(s) {
  const keep = ['id', 'display_address', 'street', 'unit', 'city', 'state', 'zip', 'county', 'apn',
    'latitude', 'longitude', 'property_type', 'property_category', 'units', 'year_built', 'gla',
    // WHICH FOOT the subject's `gla` is, for the same reason the comparable
    // carries it. Rare on a subject — of the properties we have actually lent on,
    // 106 state living area, 25 say nothing and exactly ONE states gross building
    // area — but the peer rates are measured as the subject's LIVING area minus
    // the comparable's, so a building-area subject matches neither rate, and the
    // suggester has to be able to see that rather than quietly using one.
    'gla_basis',
    'lot_area', 'lot_sqft', 'beds', 'baths_full', 'baths_half', 'baths_text', 'total_rooms',
    'stories', 'design_style', 'condition_uad', 'condition_text', 'quality_uad', 'quality_text',
    'view_rating', 'location_rating', 'basement_sqft', 'below_grade_sqft', 'garage_type',
    'garage_spaces', 'neighborhood', 'flood_zone', 'market_rent', 'last_sale_price', 'last_sale_date'];
  const out = {};
  for (const k of keep) if (s[k] != null && s[k] !== '') out[k] = s[k];
  return out;
}

router.get('/valuations/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const out = await loadValuation(req.params.id);
    if (!out) return res.status(404).json({ error: 'not found' });
    res.json(out);
  } catch (e) { next(e); }
});

router.patch('/valuations/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const v = (await db.query(`SELECT * FROM property_valuations WHERE id=$1`, [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: 'not found' });
    if (v.status === 'final') return res.status(409).json({ error: 'This valuation was finalized. Duplicate it to make changes.' });
    const b = req.body || {};
    const sets = [], params = [req.params.id];
    const P = (x) => { params.push(x); return '$' + params.length; };
    if (b.title !== undefined) sets.push(`title = ${P(txt(b.title))}`);
    if (b.method !== undefined && ['weighted', 'median', 'mean'].includes(b.method)) sets.push(`method = ${P(b.method)}`);
    if (b.purpose !== undefined && ['as_is', 'arv', 'research'].includes(b.purpose)) sets.push(`purpose = ${P(b.purpose)}`);
    if (b.reconciliation_note !== undefined) sets.push(`reconciliation_note = ${P(txt(b.reconciliation_note))}`);
    if (b.subject !== undefined && b.subject && typeof b.subject === 'object') {
      const merged = subjectSnapshot(Object.assign({}, v.subject_snapshot, b.subject));
      sets.push(`subject_snapshot = ${P(JSON.stringify(merged))}`);
      // THE HEADING IS ITS OWN COLUMN, so the snapshot alone is not enough. The
      // page header and the valuations list both read `subject_address`; a
      // valuation started from the search screen is born "Untitled property", and
      // without this the address the user types into the Subject block updated the
      // summary three rows below the heading while the heading itself stayed
      // "Untitled property" forever — a 200 that did not save what was on screen.
      const addr = txt(merged.display_address);
      if (addr) sets.push(`subject_address = ${P(addr)}`);
    }
    if (!sets.length) return res.json(await loadValuation(req.params.id));
    await db.query(`UPDATE property_valuations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    await saveComputed(req.params.id);
    res.json(await loadValuation(req.params.id));
  } catch (e) { next(e); }
});

/**
 * Recompute and STORE the headline figures. Called after every edit so the list
 * screen and any later export do not have to re-run the grid to show a number.
 */
async function saveComputed(id) {
  const loaded = await loadValuation(id);
  if (!loaded) return;
  const g = loaded.grid;
  await db.query(
    `UPDATE property_valuations SET indicated_value=$2, value_low=$3, value_high=$4,
       likely_low=$5, likely_high=$6, price_per_sqft=$7, confidence_label=$8, confidence=$9,
       warnings=$10, updated_at=now()
     WHERE id=$1`,
    [id, g.value.indicatedValue, g.value.low, g.value.high, g.value.likelyLow, g.value.likelyHigh,
     g.value.pricePerSqft, g.value.confidence.label, JSON.stringify(g.value.confidence),
     JSON.stringify(g.warnings)]);
}

// ---- comps on a valuation --------------------------------------------------
router.post('/valuations/:id/comps', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const v = (await db.query(`SELECT * FROM property_valuations WHERE id=$1`, [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: 'not found' });
    if (v.status === 'final') return res.status(409).json({ error: 'This valuation was finalized. Duplicate it to make changes.' });
    const ids = Array.isArray(req.body && req.body.property_ids) ? req.body.property_ids
      : (req.body && req.body.property_id ? [req.body.property_id] : []);
    const wanted = ids.filter(isUuid).slice(0, 24);
    if (!wanted.length) return res.status(400).json({ error: 'pick at least one property' });

    // THE RATES ARE RECORDED, NOT JUST USED. `market_rates` exists so that "where
    // did $119 a square foot come from?" stays answerable after the underlying
    // sales have moved — and this is the path that actually pre-fills a grid (a
    // valuation is built by adding comparables; the explicit re-suggest is the
    // rarer second pass). It wrote the suggested numbers onto every comp and left
    // the column at `{}`, so on the ordinary route the grid was full of derived
    // adjustments with no record anywhere of what derived them, including on a
    // FINALIZED valuation. `suggestRefusal` carries the one refusal the rates
    // object cannot express — no town or state on the subject, so there is no
    // market to read — which is otherwise a silent dead end: the button runs, no
    // line changes, and nothing says why.
    const asked = !(req.body && req.body.suggest === false);
    const derived = asked
      ? await ratesFor({ state: v.subject_snapshot.state, city: v.subject_snapshot.city, months: 24 })
      : { rates: null };
    const rates = derived.rates;
    let order = (await db.query(
      `SELECT COALESCE(max(comp_order), 0) AS n FROM property_valuation_comps WHERE valuation_id=$1`,
      [req.params.id])).rows[0].n;

    for (const pid of wanted) {
      const p = (await db.query(`SELECT * FROM properties WHERE id=$1`, [pid])).rows[0];
      if (!p) continue;
      // The comp's own most recent COMPARABLE observation carries the report-level
      // facts the roll-up does not (which grid it was on, how far it was from that
      // report's subject, what the appraiser adjusted). Stored with the snapshot.
      // A CLOSED OBSERVATION IS PREFERRED OVER A MORE RECENT LISTING. The snapshot
      // lets the observation's own sale figures beat the roll-up, so taking the
      // newest comparable observation regardless of status put an ASKING price on
      // a property whose actual closed sale we hold: the grid then valued off the
      // asking price, and the same comp was down-weighted by half and warned
      // about as "an asking price, not a proven sale". A listing still wins when
      // it is all we have ever seen of that house.
      // (`sale_status IS NULL` means closed — db/157.)
      const o = (await db.query(
        `SELECT * FROM property_observations WHERE property_id=$1 AND role='comparable'
          ORDER BY (COALESCE(sale_status,'closed') = 'closed') DESC,
                   observed_on DESC NULLS LAST, created_at DESC LIMIT 1`, [pid])).rows[0] || {};
      const snapshot = compSnapshot(p, o);
      const suggested = rates ? V.suggestAdjustments(v.subject_snapshot, snapshot, rates, { today: todayNY() }) : [];
      const adj = V.normalizeAdjustments(suggested);
      const a = V.adjustComp(snapshot, adj);
      await db.query(
        `INSERT INTO property_valuation_comps (valuation_id, property_id, observation_id,
           source_appraisal_id, comp_order, snapshot, sale_price, sale_date, adjustments,
           adjusted_price, net_adjustment, gross_adjustment, net_adj_pct, gross_adj_pct, distance_miles)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (valuation_id, COALESCE(property_id::text, id::text)) DO NOTHING`,
        // THE COLUMN STORES THE PRICE THE GRID ACTUALLY COMPUTED FROM — the
        // snapshot's. Storing the roll-up's `last_sale_price` here instead made the
        // two legitimately different numbers: `adjusted_price` is derived from the
        // snapshot, `loadValuation` re-merges this column over it, and the screen
        // then showed an adjusted price that did not equal its own sale price plus
        // its own adjustment lines. They must be one number or they will drift.
        [req.params.id, pid, o.id || null, o.appraisal_id || null, ++order,
         JSON.stringify(snapshot),
         snapshot.sale_price != null ? snapshot.sale_price : p.last_sale_price,
         snapshot.sale_date || p.last_sale_date,
         JSON.stringify(adj), a.adjustedPrice, a.netAdjustment, a.grossAdjustment,
         a.netAdjPct, a.grossAdjPct, null]);
    }
    // Only when we actually asked. A caller passing `suggest:false` wants the
    // comparables raw, and blanking a record captured by an earlier pass would
    // destroy the provenance of the lines already on the grid.
    if (asked) await storeRates(req.params.id, derived);
    await saveComputed(req.params.id);
    res.json(await loadValuation(req.params.id));
  } catch (e) { next(e); }
});

/**
 * Record what the suggestions were derived from.
 *
 * A top-level `why` means "no rates at all, and here is the reason" — the shape
 * `deriveMarketRates` cannot produce (it refuses per RATE, each with its own
 * `why`), so the two can never be confused by a reader.
 */
async function storeRates(id, derived) {
  const value = derived.rates || (derived.why ? { why: derived.why } : null);
  if (!value) return;
  // A REFUSAL NEVER REPLACES A REAL RECORD. Reached by clearing the subject's town
  // and adding another comparable: the second pass has no market to read, and
  // writing its `why` over the rates the FIRST pass captured would destroy the
  // provenance of the suggested lines already sitting on the grid — the exact
  // loss the `suggest:false` guard exists to prevent, through a different door.
  // An empty record is not a record, so it is still filled — and "empty" has THREE
  // shapes here, not one. `COALESCE(x,'{}') = '{}'` catches a SQL NULL and an empty
  // object but NOT a jsonb `null`, which is a real stored value rather than an
  // absent one. Rows hold it: the previous version of this function ran
  // `JSON.stringify(rates)` unconditionally, and `JSON.stringify(null)` is the
  // string "null", which jsonb parses as a null VALUE. Keyed on the type instead,
  // so anything that is not a populated object counts as no record.
  const guard = derived.rates ? '' : ` AND (market_rates IS NULL
       OR jsonb_typeof(market_rates) <> 'object' OR market_rates = '{}'::jsonb)`;
  await db.query(
    `UPDATE property_valuations SET market_rates=$2, updated_at=now() WHERE id=$1${guard}`,
    [id, JSON.stringify(value)]);
}

/** The comp facts a grid renders, frozen at the moment it was added. */
function compSnapshot(p, o) {
  const out = {
    property_id: p.id, display_address: p.display_address, city: p.city, state: p.state, zip: p.zip,
    latitude: p.latitude, longitude: p.longitude,
    property_type: p.property_type, units: p.units, year_built: p.year_built,
    gla: p.gla,
    // WHICH FOOT `gla` IS. A 1025 (2-4 unit) grid states gross BUILDING area under
    // the same element a 1004 uses for living area, and db/427 records which. The
    // snapshot dropped it, so the grid could not tell the two apart — and the peer
    // adjustment rate is now measured per basis (db/443), so without this every
    // 2-4 unit comp would be adjusted at a living-area rate or, worse, at the
    // national rule of thumb because the local evidence sits under the other one.
    gla_basis: p.gla_basis || null,
    lot_area: p.lot_area, beds: p.beds, baths_full: p.baths_full, baths_half: p.baths_half,
    baths_text: p.baths_text, total_rooms: p.total_rooms,
    condition_uad: p.condition_uad, condition_text: p.condition_text,
    quality_uad: p.quality_uad, quality_text: p.quality_text,
    view_rating: p.view_rating, location_rating: p.location_rating,
    basement_sqft: p.basement_sqft, below_grade_sqft: p.below_grade_sqft,
    garage_type: p.garage_type, garage_spaces: p.garage_spaces,
    sale_price: p.last_sale_price, sale_date: p.last_sale_date ? String(p.last_sale_date).slice(0, 10) : null,
    sale_type: p.last_sale_type, sale_status: p.last_sale_status || 'closed',
    photo_count: p.photo_count,
  };
  if (o && o.id) {
    Object.assign(out, {
      observation_id: o.id, comp_set: o.comp_set, comp_set_confidence: o.comp_set_confidence,
      proximity: o.proximity, data_source: o.data_source, days_on_market: o.days_on_market,
      concession_amount: o.concession_amount, financing_type: o.financing_type,
      appraiser_net_adjustment: o.net_adjustment, appraiser_gross_adj_pct: o.gross_adj_pct,
      appraiser_adjustments: o.adjustments || [],
      observed_on: o.observed_on ? String(o.observed_on).slice(0, 10) : null,
    });
    // The OBSERVATION's own sale figures beat the roll-up when they exist: they are
    // what that report actually stated about this sale.
    //
    // A LISTING IS NOT A SALE. An active/pending observation's price is an ASKING
    // price, and the roll-up deliberately files it as `last_list_price` with
    // `last_sale_price` left NULL. Copying it into the snapshot's `sale_price`
    // would put an asking price into the grid as though it were a settled sale —
    // the same rule the warehouse enforces one layer down. The status still
    // travels, so the grid can flag it.
    const closed = (o.sale_status || 'closed') === 'closed';
    if (closed && o.sale_price != null) out.sale_price = o.sale_price;
    if (closed && o.sale_date) out.sale_date = String(o.sale_date).slice(0, 10);
    if (o.sale_status) out.sale_status = o.sale_status;
    // THE NUMBER AND ITS LABEL MUST COME FROM THE SAME ROW. The size is taken
    // from the OBSERVATION here while the basis above is the property ROLL-UP,
    // and the two are chosen by different rules — the roll-up prefers a living
    // area (db/436) while this picks the most recent CLOSED comparable — so when
    // they disagree the snapshot froze a building-area number labelled living
    // area. Real case: 98 Thompson St, New Haven, a 3-unit whose newest closed
    // observation is a 1025 stating 3,042 sq ft of BUILDING area while the
    // roll-up says living. Against a 2,500 sq ft subject that is -$38,500 at New
    // Haven's convention rate instead of -$27,100 at the 24 real local 2-4 unit
    // adjustments — $11,400 on one comparable, with no caveat, which is the exact
    // outcome the per-basis split exists to prevent.
    if (o.gla != null) { out.gla = o.gla; out.gla_basis = o.gla_basis || null; }
    if (o.condition_uad) out.condition_uad = o.condition_uad;
  }
  return out;
}

router.patch('/valuations/:id/comps/:compId', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id) || !isUuid(req.params.compId)) return res.status(404).json({ error: 'not found' });
    const v = (await db.query(`SELECT status FROM property_valuations WHERE id=$1`, [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: 'not found' });
    if (v.status === 'final') return res.status(409).json({ error: 'This valuation was finalized. Duplicate it to make changes.' });
    const c = (await db.query(
      `SELECT * FROM property_valuation_comps WHERE id=$1 AND valuation_id=$2`,
      [req.params.compId, req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    // THE ADJUSTMENTS ARE RE-NORMALIZED, NEVER STORED RAW. An unknown grid line is
    // dropped rather than silently summed into the total, and the adjusted price is
    // recomputed here so the stored figure can never drift from the lines.
    const adj = b.adjustments !== undefined ? V.normalizeAdjustments(b.adjustments) : (c.adjustments || []);
    const snapshot = c.snapshot || {};
    if (b.sale_price !== undefined) snapshot.sale_price = K.num(b.sale_price, { min: 0 });
    const a = V.adjustComp(snapshot, adj);
    const weight = b.weight === null || b.weight === '' ? null : (b.weight === undefined ? c.weight : K.num(b.weight, { min: 0, max: 100 }));
    await db.query(
      `UPDATE property_valuation_comps SET adjustments=$3, adjusted_price=$4, net_adjustment=$5,
         gross_adjustment=$6, net_adj_pct=$7, gross_adj_pct=$8, weight=$9, included=$10,
         note=$11, snapshot=$12, sale_price=$13, comp_order=$14, updated_at=now()
       WHERE id=$1 AND valuation_id=$2`,
      [req.params.compId, req.params.id, JSON.stringify(adj), a.adjustedPrice, a.netAdjustment,
       a.grossAdjustment, a.netAdjPct, a.grossAdjPct, weight,
       b.included === undefined ? c.included : !!b.included,
       b.note === undefined ? c.note : txt(b.note), JSON.stringify(snapshot),
       // ONLY WHEN THE REQUEST ACTUALLY SET A PRICE. Writing the snapshot's price
       // whenever it was non-null meant any unrelated edit — adding a note,
       // reordering — silently republished the snapshot figure into the column the
       // grid computes from, so a stale snapshot price could move the whole
       // valuation on a keystroke that had nothing to do with money.
       b.sale_price !== undefined ? snapshot.sale_price : c.sale_price,
       b.comp_order === undefined ? c.comp_order : (parseInt(b.comp_order, 10) || c.comp_order)]);
    await saveComputed(req.params.id);
    res.json(await loadValuation(req.params.id));
  } catch (e) { next(e); }
});

router.delete('/valuations/:id/comps/:compId', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id) || !isUuid(req.params.compId)) return res.status(404).json({ error: 'not found' });
    const v = (await db.query(`SELECT status FROM property_valuations WHERE id=$1`, [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: 'not found' });
    if (v.status === 'final') return res.status(409).json({ error: 'This valuation was finalized. Duplicate it to make changes.' });
    await db.query(`DELETE FROM property_valuation_comps WHERE id=$1 AND valuation_id=$2`,
      [req.params.compId, req.params.id]);
    await saveComputed(req.params.id);
    res.json(await loadValuation(req.params.id));
  } catch (e) { next(e); }
});

/**
 * Re-fill the SUGGESTED adjustment lines from the current market rates, keeping
 * every line the human typed. A user's number is never overwritten by a formula —
 * that is the whole contract of this tool.
 */
router.post('/valuations/:id/suggest', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const v = (await db.query(`SELECT * FROM property_valuations WHERE id=$1`, [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: 'not found' });
    if (v.status === 'final') return res.status(409).json({ error: 'This valuation was finalized. Duplicate it to make changes.' });
    const derived = await ratesFor({ state: v.subject_snapshot.state, city: v.subject_snapshot.city,
      months: req.body && req.body.months ? req.body.months : 24 });
    const rates = derived.rates;
    const comps = (await db.query(
      `SELECT * FROM property_valuation_comps WHERE valuation_id=$1`, [req.params.id])).rows;
    for (const c of comps) {
      const mine = (c.adjustments || []).filter((l) => l && l.source === 'user');
      const keys = new Set(mine.map((l) => l.key));
      const fresh = V.suggestAdjustments(v.subject_snapshot, c.snapshot || {}, rates, { today: todayNY() })
        .filter((l) => !keys.has(l.key));
      const adj = V.normalizeAdjustments(mine.concat(fresh));
      const a = V.adjustComp(c.snapshot || {}, adj);
      await db.query(
        `UPDATE property_valuation_comps SET adjustments=$2, adjusted_price=$3, net_adjustment=$4,
           gross_adjustment=$5, net_adj_pct=$6, gross_adj_pct=$7, updated_at=now() WHERE id=$1`,
        [c.id, JSON.stringify(adj), a.adjustedPrice, a.netAdjustment, a.grossAdjustment,
         a.netAdjPct, a.grossAdjPct]);
    }
    await storeRates(req.params.id, derived);
    await saveComputed(req.params.id);
    res.json(await loadValuation(req.params.id));
  } catch (e) { next(e); }
});

router.post('/valuations/:id/finalize', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const loaded = await loadValuation(req.params.id);
    if (!loaded) return res.status(404).json({ error: 'not found' });
    if (loaded.valuation.status === 'final') return res.json(loaded);
    // A valuation with no usable comparable is not an opinion of anything.
    if (!loaded.grid.value.compCount) {
      return res.status(400).json({ error: 'Add at least one comparable sale before finishing this valuation.' });
    }
    await saveComputed(req.params.id);
    await db.query(
      `UPDATE property_valuations SET status='final', finalized_at=now(), finalized_by=$2,
         reconciliation_note=COALESCE($3, reconciliation_note), updated_at=now()
       WHERE id=$1`,
      [req.params.id, req.actor.id, txt(req.body && req.body.note)]);
    await audit(req.actor.id, 'valuation_finalized', req.params.id,
      { value: loaded.grid.value.indicatedValue, comps: loaded.grid.value.compCount });
    res.json(await loadValuation(req.params.id));
  } catch (e) { next(e); }
});

/** Copy a valuation so a finalized one can be revised without losing the original. */
router.post('/valuations/:id/duplicate', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const v = (await db.query(`SELECT * FROM property_valuations WHERE id=$1`, [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: 'not found' });
    const r = await db.query(
      `INSERT INTO property_valuations (title, property_id, application_id, subject_address,
         subject_snapshot, purpose, effective_date, method, market_rates, created_by,
         version, supersedes_id)
       SELECT title || ' (revision)', property_id, application_id, subject_address,
              subject_snapshot, purpose, $2, method, market_rates, $3, version + 1, id
         FROM property_valuations WHERE id=$1 RETURNING id`,
      [req.params.id, todayNY(), req.actor.id]);
    const newId = r.rows[0].id;
    await db.query(
      `INSERT INTO property_valuation_comps (valuation_id, property_id, observation_id,
         source_appraisal_id, comp_order, included, weight, snapshot, sale_price, sale_date,
         adjustments, adjusted_price, net_adjustment, gross_adjustment, net_adj_pct, gross_adj_pct,
         distance_miles, note)
       SELECT $2, property_id, observation_id, source_appraisal_id, comp_order, included, weight,
              snapshot, sale_price, sale_date, adjustments, adjusted_price, net_adjustment,
              gross_adjustment, net_adj_pct, gross_adj_pct, distance_miles, note
         FROM property_valuation_comps WHERE valuation_id=$1`, [req.params.id, newId]);
    await saveComputed(newId);
    res.status(201).json(await loadValuation(newId));
  } catch (e) { next(e); }
});

router.delete('/valuations/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const v = (await db.query(`SELECT created_by, status FROM property_valuations WHERE id=$1`, [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: 'not found' });
    // Your own drafts are yours to throw away; anything finalized, or anyone else's,
    // needs an admin — a valuation somebody relied on should not vanish quietly.
    const mine = String(v.created_by || '') === String(req.actor.id);
    if (!(mine && v.status !== 'final') && !can(req.actor, 'platform_setup')) {
      return res.status(403).json({ error: 'Only the person who created this draft (or an admin) can delete it.' });
    }
    await db.query(`DELETE FROM property_valuations WHERE id=$1`, [req.params.id]);
    await audit(req.actor.id, 'valuation_deleted', req.params.id, {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// HOW MANY APPRAISALS WE HAVE HAD TO TURN AWAY (db/438)
// ---------------------------------------------------------------------------
/**
 * UAD 3.6 / MISMO 3.x becomes MANDATORY for Fannie and Freddie appraisals on
 * 2 NOVEMBER 2026, and PILOT reads UAD 2.6. From that date the appraisal desk
 * stops working on new reports unless a 3.6 reader exists.
 *
 * Recording the refusals was only half of it — a count nothing can read answers
 * nobody's question. `uad_3_6` above zero means real appraisals are ALREADY
 * arriving in a format the desk cannot read, and the reader has stopped being
 * optional. It is reported apart from `not_appraisal` (somebody attached a
 * loan-application export instead of the appraisal) because that is a different
 * problem with a different answer, and mixing them buries the number that matters.
 *
 * Staff-wide, like the rest of this router: it is a count of file formats, with
 * no borrower, no loan and no money in it.
 */
router.get('/appraisal-formats', async (req, res, next) => {
  try {
    const days = Math.min(3650, Math.max(1, parseInt(req.query.days, 10) || 365));
    res.json(await formatRefusalCounts(db, { sinceDays: days }));
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// BACK-FILL — fold the whole appraisal corpus in, on demand
// ---------------------------------------------------------------------------
router.post('/backfill', async (req, res, next) => {
  try {
    if (!can(req.actor, 'platform_setup')) return res.status(403).json({ error: 'You do not have access to that.' });
    const limit = Math.min(2000, Math.max(1, parseInt(req.body && req.body.limit, 10) || 500));
    const out = await ingest.backfill(db, { limit, force: !!(req.body && req.body.force) });
    await audit(req.actor.id, 'research_backfill', null, out);
    res.json({ ...out, status: await ingest.ingestStatus(db) });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// TWO ROWS, ONE HOUSE — the duplicates the address key cannot fold (db/419)
// ---------------------------------------------------------------------------
/**
 * The owner's rule is that the same comparable on two appraisals must never become
 * two properties. The address key already folds two SPELLINGS of one address, and
 * the roll-up already merges the facts — so this covers only what the key cannot
 * reach on its own, and it is ADVISORY: nothing here is ever merged without a person
 * saying so. Folding two DIFFERENT houses corrupts every price-per-foot reading in
 * the warehouse and no re-ingest undoes it, which is far worse than a duplicate.
 */
router.get('/duplicates', async (req, res, next) => {
  try {
    const M = require('../lib/research/property-merge');
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const propertyId = isUuid(req.query.property_id) ? req.query.property_id : null;
    res.json({ rows: await M.findDuplicates(db, { propertyId, limit }) });
  } catch (e) { next(e); }
});

/**
 * Merge one property into another. Gated on `platform_setup` like the other two
 * doors on this router that change the shape of the warehouse — it DELETES a row,
 * which is the most destructive thing anyone can do in here.
 */
router.post('/duplicates/merge', async (req, res, next) => {
  try {
    if (!can(req.actor, 'platform_setup')) return res.status(403).json({ error: 'You do not have access to that.' });
    const M = require('../lib/research/property-merge');
    const b = req.body || {};
    if (!isUuid(b.survivor_id) || !isUuid(b.merged_id)) {
      return res.status(400).json({ error: 'Two properties are needed: which one stays, and which one is folded into it.' });
    }
    const out = await M.mergeProperties(db, b.survivor_id, b.merged_id,
      { cause: txt(b.cause) || 'manual', by: req.actor.id });
    await audit(req.actor.id, 'research_property_merge', b.survivor_id, out);
    res.json(out);
  } catch (e) {
    // A merge refuses rather than half-completes; the reason is worth reading.
    if (/no longer exists|merged into itself|does not know what to do/i.test((e && e.message) || '')) {
      return res.status(409).json({ error: e.message });
    }
    next(e);
  }
});

/** "I checked — these are two different houses." Stops the pair coming back.
 *
 * `platform_setup`, like its two siblings (`/duplicates/merge`, `/backfill`).
 * This is a PERMANENT suppression: once a pair is marked, the detector stops
 * offering it, so getting it wrong hides a real duplicate from everyone for
 * good and the warehouse quietly counts one house as two forever. It was the
 * only warehouse-shape mutation left ungated. */
router.post('/duplicates/not-duplicate', async (req, res, next) => {
  try {
    if (!can(req.actor, 'platform_setup')) return res.status(403).json({ error: 'You do not have access to that.' });
    const M = require('../lib/research/property-merge');
    const b = req.body || {};
    if (!isUuid(b.property_id) || !isUuid(b.other_property_id)) {
      return res.status(400).json({ error: 'Two properties are needed.' });
    }
    await M.markNotDuplicate(db, b.property_id, b.other_property_id,
      { reason: txt(b.reason), by: req.actor.id });
    await audit(req.actor.id, 'research_property_not_duplicate', b.property_id, { other: b.other_property_id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// PUTTING PROPERTIES ON THE MAP — the distance search's fuel (db/412)
// ---------------------------------------------------------------------------
/** How many properties we can measure a distance to, and how many are still to do. */
router.get('/geocode/status', async (req, res, next) => {
  try {
    res.json((await require('../lib/research/geocode').geocodeStatus(db)) || { error: 'unavailable' });
  } catch (e) { next(e); }
});

/**
 * Place another batch by hand. The sweep runs on its own in the background; this is
 * for someone who wants to push it along, so it is capped small enough to answer
 * inside one request rather than leaving the screen hanging.
 */
router.post('/geocode/run', async (req, res, next) => {
  try {
    if (!can(req.actor, 'platform_setup')) return res.status(403).json({ error: 'You do not have access to that.' });
    const G = require('../lib/research/geocode');
    const limit = Math.min(200, Math.max(1, parseInt(req.body && req.body.limit, 10) || 50));
    const out = await G.backfillGeocodes(db, { limit });
    await audit(req.actor.id, 'research_geocode_run', null, out);
    res.json({ ...out, status: await G.geocodeStatus(db) });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// UPLOAD AN APPRAISAL XML STRAIGHT INTO THE DATABASE — single or bulk (db/411)
// ---------------------------------------------------------------------------
/**
 * The owner's "we should be able to manually add XML appraisal reports to build up
 * our database … single or bulk". The whole read is `lib/research/xml-import`; this
 * is only the door.
 *
 * OPEN TO EVERY STAFF USER, like the rest of this router. It is an ADD-ONLY action
 * into a database of addresses and recorded sale prices — it creates no loan file,
 * touches no borrower, and cannot delete anything — so gating it behind an admin
 * permission would only mean the people doing the research have to ask somebody
 * else to press the button.
 *
 * The bulk cap is deliberate and is REPORTED rather than silently applied: a
 * hundred reports is a minute of parsing, and a request that quietly dropped file
 * 101 would read as "all imported" when it was not.
 *
 * THE REAL CEILING IS USUALLY THE REQUEST SIZE, NOT THIS COUNT. A MISMO appraisal
 * carries the whole report PDF inside itself, so one file routinely runs to several
 * megabytes and the server's JSON body limit (~25 MB) is reached long before 100
 * files. The screen therefore sends a big drop in SIZE-BOUNDED batches and reports
 * the running total — which is also why the summary shape has to stay addable.
 */
const MAX_BULK = 100;

router.post('/imports', async (req, res, next) => {
  try {
    const XI = require('../lib/research/xml-import');
    const body = req.body || {};
    let files = [];
    if (Array.isArray(body.files)) {
      files = body.files.map((f) => ({ xml: f && f.xml, filename: txt(f && f.filename) }));
    } else if (body.xml != null) {
      files = [{ xml: body.xml, filename: txt(body.filename) }];
    }
    if (!files.length) return res.status(400).json({ error: 'Attach at least one appraisal data file (XML).' });

    let dropped = 0;
    if (files.length > MAX_BULK) { dropped = files.length - MAX_BULK; files = files.slice(0, MAX_BULK); }

    const out = await XI.importMany(db, files, { uploadedBy: req.actor.id });
    if (dropped) {
      out.summary.dropped = dropped;
      out.summary.note = `Only the first ${MAX_BULK} files were read this time — ${dropped} more were left out. Send them in another batch.`;
    }
    await audit(req.actor.id, 'research_xml_import', null, out.summary);
    res.json(out);
  } catch (e) { next(e); }
});

/** The upload history — what has been fed in, what landed, and what did not. */
router.get('/imports', async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const params = [];
    const where = [];
    const P = (v) => { params.push(v); return '$' + params.length; };
    const status = txt(req.query.status);
    if (status && ['ok', 'skipped', 'error', 'pending'].includes(status)) where.push(`i.status = ${P(status)}`);
    const r = await db.query(
      `SELECT i.id, i.filename, i.status, i.error, i.form_type, i.effective_date,
              i.subject_address, i.subject_city, i.subject_state, i.subject_zip,
              i.subject_property_id, i.appraiser_id, i.appraisal_id,
              i.comparables_seen, i.properties_written, i.observations_written, i.sales_written,
              i.rows_skipped, i.created_at, i.ran_at,
              ap.name AS appraiser_name,
              s.full_name AS uploaded_by_name,
              count(*) OVER ()::int AS total
         FROM research_imports i
         LEFT JOIN appraisers ap ON ap.id = i.appraiser_id
         LEFT JOIN staff_users s ON s.id = i.uploaded_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY i.created_at DESC
        LIMIT ${P(limit)}`, params);
    res.json({ rows: r.rows, total: r.rows.length ? r.rows[0].total : 0 });
  } catch (e) { next(e); }
});

/* ───────────────────────────────────────────────────────────────────────────
 * QUICK ANSWER — an address, a few basics, and roughly what properties like
 * that have been coming in at. BUILT TO REFUSE (see lib/research/quick-answer).
 *
 * It reuses `searchProperties`, so the quick answer and the full comparable
 * search can never disagree about which properties match — a second, "simpler"
 * query here would drift from the real one within a release and the two screens
 * would quietly contradict each other about the same town.
 * ─────────────────────────────────────────────────────────────────────────── */
router.get('/quick', async (req, res, next) => {
  try {
    const today = todayNY();
    let subject = null;
    if (isUuid(req.query.property_id)) {
      subject = (await db.query('SELECT * FROM properties WHERE id=$1', [req.query.property_id])).rows[0] || null;
    } else if (isUuid(req.query.application_id)) {
      subject = await subjectForApplication(req.query.application_id);
    }
    if (!subject) {
      subject = {
        display_address: txt(req.query.address), city: txt(req.query.city), state: txt(req.query.state),
        zip: txt(req.query.zip), gla: K.num(req.query.gla),
        condition_uad: txt(req.query.condition_uad), property_type: txt(req.query.property_type),
        units: K.int(req.query.units, { max: 999 }),
        // A COORDINATE THAT IS NOT ON EARTH IS NOT A COORDINATE. Unbounded, a
        // typed `?lat=1e9` reached the haversine — harmless in that it matches
        // nothing, but a filter that silently matches nothing is the shape of the
        // bug this whole area exists to close. Out of range reads as "no
        // position", which the search already answers honestly.
        latitude: K.num(req.query.lat, { min: -90, max: 90 }),
        longitude: K.num(req.query.lng, { min: -180, max: 180 }),
      };
    }
    // A QUICK ANSWER STILL NEEDS A MARKET. Nationwide is about nowhere — the same
    // refusal the adjustment rates and the market rates already make.
    const lat = K.num(subject.eff_latitude != null ? subject.eff_latitude : subject.latitude);
    const lng = K.num(subject.eff_longitude != null ? subject.eff_longitude : subject.longitude);
    if (!subject.city && !subject.state && !(lat != null && lng != null)) {
      return res.status(400).json({ error: 'name a town, a state or a position — a nationwide answer is about nowhere' });
    }

    const months = Math.min(60, Math.max(3, K.int(req.query.months, { max: 60 }) || 18));
    const radiusMiles = K.num(req.query.radius_miles) || (lat != null && lng != null ? 1 : null);
    // The owner's own unit bands: one, two-to-four, five-plus. A subject whose
    // count we do not know bands nothing rather than guessing.
    const u = K.int(subject.units, { max: 999 });
    const band = !u || u < 1 ? {}
      : u === 1 ? { units_min: 1, units_max: 1, units_unknown_ok: '1' }
        : u <= 4 ? { units_min: 2, units_max: 4, units_unknown_ok: '1' }
          : { units_min: 5, units_unknown_ok: '1' };

    const filters = Object.assign({
      state: subject.state, city: subject.city,
      has_sale: '1', sale_status: 'closed', sold_within_months: months,
      sqft_min: subject.gla ? Math.round(subject.gla * 0.75) : undefined,
      sqft_max: subject.gla ? Math.round(subject.gla * 1.25) : undefined,
      condition: subject.condition_uad || undefined,
      limit: 200,
    }, band,
    (lat != null && lng != null && radiusMiles) ? { lat, lng, radius_miles: radiusMiles } : {});

    const found = await S.searchProperties(db, filters);

    /* HOW MANY WE HOLD THERE AT ALL — so a refusal can say "3 of the 40 we hold
       nearby" instead of a bare "not enough". Without a denominator, "we found
       almost nothing" reads as a broken search rather than as thin coverage,
       which is the single most misread thing on every screen in this build. */
    let heldNearby = null;
    try {
      const wide = Object.assign({}, filters, {
        sold_within_months: undefined, has_sale: undefined, sale_status: undefined,
        sqft_min: undefined, sqft_max: undefined, condition: undefined, limit: 1,
      });
      heldNearby = (await S.searchProperties(db, wide)).total;
    } catch (_) { heldNearby = null; }   // a missing denominator is never fatal

    const answer = QA.quickAnswer({
      rows: found.rows, today, heldNearby,
      asked: {
        radiusMiles: (lat != null && lng != null && radiusMiles) ? radiusMiles : null,
        city: subject.city, state: subject.state, months,
        units: u || null, propertyType: subject.property_type || null,
        glaMin: filters.sqft_min || null, glaMax: filters.sqft_max || null,
        condition: subject.condition_uad || null,
      },
    });
    res.json({
      subject: {
        display_address: subject.display_address, city: subject.city, state: subject.state,
        units: u || null, gla: subject.gla || null, property_type: subject.property_type || null,
        condition_uad: subject.condition_uad || null, placed: lat != null && lng != null,
      },
      answer,
      matched: found.rows.slice(0, 25),
      disclaimer: V.DISCLAIMER,
    });
  } catch (e) { next(e); }
});

/* ───────────────────────────────────────────────────────────────────────────
 * MARKET AREAS — the boundary a person drew (db/454).
 *
 * A radius cannot say "this side of the highway". These can, and because the
 * shape decides which comparables an officer is shown, every one of them
 * records WHO drew it. The geometry — and every refusal — lives in
 * `lib/research/market-area`, pure and tested; these routes only store and
 * fetch.
 * ─────────────────────────────────────────────────────────────────────────── */
router.get('/market-areas', async (req, res, next) => {
  try {
    const params = [];
    const where = ['a.archived_at IS NULL'];
    const P = (v) => { params.push(v); return '$' + params.length; };
    if (txt(req.query.state)) where.push(`upper(a.state) = ${P(String(req.query.state).toUpperCase())}`);
    if (txt(req.query.city)) where.push(`lower(a.city) = ${P(String(req.query.city).toLowerCase())}`);
    const r = await db.query(
      `SELECT a.*, s.full_name AS created_by_name
         FROM market_areas a LEFT JOIN staff_users s ON s.id = a.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY a.updated_at DESC LIMIT 200`, params);
    res.json({ rows: r.rows });
  } catch (e) { next(e); }
});

router.post('/market-areas', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = txt(b.name);
    if (!name) return res.status(400).json({ error: 'give the area a name — a boundary nobody can refer to is a boundary nobody will use' });
    // THE GEOMETRY REFUSES, NOT THE ROUTE. One definition of what a usable shape
    // is, shared with the search that will later ask "is this house inside it".
    const shape = MA.describeArea(b.ring);
    if (!shape.ok) return res.status(400).json({ error: shape.why, problem: shape.problem });
    const ring = MA.cleanRing(b.ring);
    const kind = ['neighborhood', 'working', 'exclusion'].includes(b.kind) ? b.kind : 'neighborhood';
    const r = await db.query(
      `INSERT INTO market_areas (name, kind, state, city, ring,
         min_lat, max_lat, min_lng, max_lng, area_sq_mi, created_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [name, kind, txt(b.state) ? String(b.state).toUpperCase() : null, txt(b.city),
        JSON.stringify(ring), shape.bounds.minLat, shape.bounds.maxLat,
        shape.bounds.minLng, shape.bounds.maxLng, shape.areaSqMi, req.actor.id, txt(b.note)]);
    res.status(201).json({ area: r.rows[0], shape });
  } catch (e) {
    // The partial-unique index: two live shapes with one name in one town is a
    // filing mistake nobody can untangle later.
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'an area with that name already exists in that town — '
        + 'give this one its own name, or archive the old one' });
    }
    next(e);
  }
});

router.post('/market-areas/:id/archive', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    // ARCHIVED, NEVER DELETED. A valuation may have been built inside this
    // boundary, and deleting it would leave that work resting on a shape nobody
    // can look at.
    const r = await db.query(
      'UPDATE market_areas SET archived_at = now(), updated_at = now() WHERE id=$1 AND archived_at IS NULL RETURNING id',
      [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found, or already archived' });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

/** Which of a market's properties fall inside a drawn area. */
/**
 * A DRAWN MARKET AREA, RESOLVED TO THE PROPERTIES INSIDE IT.
 *
 * The owner's reason for drawing one in the first place: a mile in one direction
 * crosses a river, a rail line or a school-district boundary; a mile in another is
 * the same houses on the same streets. So the boundary decides which comparables
 * an officer is shown — which means resolving it has to be exact, and it has to be
 * the SAME exactness everywhere. `market-area.pointInRing` is that one definition
 * (68 assertions, including a 61x61 grid scan); nothing here re-implements it.
 *
 * The box comes first because it is indexed and throws away almost everything;
 * the exact test then runs on what survives, because the box includes the corners
 * a drawn shape deliberately cuts off. `truncated` is reported rather than
 * swallowed — a shape big enough to hit the cap has been answered from a large
 * sample rather than from all of it, and the screen says so.
 *
 * Returns null when the id names no live area, so a caller can tell "the shape
 * contains nothing" (ids: []) from "there is no such shape" (null). Those are
 * different answers and must never collapse into one.
 */
const MARKET_AREA_SCAN_CAP = 5000;
async function resolveMarketArea(id) {
  if (!isUuid(id)) return null;
  const a = (await db.query('SELECT * FROM market_areas WHERE id=$1 AND archived_at IS NULL', [id])).rows[0];
  if (!a) return null;
  const near = (await db.query(
    `SELECT p.id, p.eff_latitude, p.eff_longitude
       FROM properties p
      WHERE p.eff_latitude BETWEEN $1 AND $2
        AND p.eff_longitude BETWEEN $3 AND $4
      LIMIT ${MARKET_AREA_SCAN_CAP}`, [a.min_lat, a.max_lat, a.min_lng, a.max_lng])).rows;
  const ring = Array.isArray(a.ring) ? a.ring : [];
  const inside = near.filter((p) => MA.pointInRing(p.eff_latitude, p.eff_longitude, ring));
  return {
    area: { id: a.id, name: a.name, city: a.city, state: a.state, area_sq_mi: a.area_sq_mi },
    ids: inside.map((p) => p.id),
    inBox: near.length,
    inArea: inside.length,
    truncated: near.length >= MARKET_AREA_SCAN_CAP,
  };
}

router.get('/market-areas/:id/properties', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const a = (await db.query('SELECT * FROM market_areas WHERE id=$1', [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'not found' });
    // THE BOX FIRST, IN SQL — it is indexed and throws away almost everything.
    // Then the EXACT test in JavaScript on what survives, because the box
    // includes the corners a drawn shape deliberately cuts off.
    const near = (await db.query(
      `SELECT ${S.LIST_COLUMNS}
         FROM properties p
        WHERE p.eff_latitude BETWEEN $1 AND $2
          AND p.eff_longitude BETWEEN $3 AND $4
        LIMIT 5000`, [a.min_lat, a.max_lat, a.min_lng, a.max_lng])).rows;
    const ring = Array.isArray(a.ring) ? a.ring : [];
    const inside = near.filter((p) => MA.pointInRing(p.eff_latitude, p.eff_longitude, ring));
    res.json({
      area: a,
      rows: inside,
      // BOTH NUMBERS, because "we hold 40 in the box and 12 in your shape" is
      // the useful reading — it says how much the boundary actually cut.
      inBox: near.length,
      inArea: inside.length,
      truncated: near.length >= 5000,
    });
  } catch (e) { next(e); }
});

module.exports = router;
