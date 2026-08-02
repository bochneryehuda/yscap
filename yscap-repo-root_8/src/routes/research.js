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
const V = require('../lib/research/valuation');
const K = require('../lib/research/property-key');
const ingest = require('../lib/research/ingest');

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
    if (!p) return res.status(404).json({ error: 'not found' });
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
    res.json({ property: p, observations: obs.rows, sales: sales.rows, photos: photos.rows });
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
              max(o.observed_on)                                        AS last_observed_on
         FROM property_observations o
         JOIN properties p ON p.id = o.property_id
        WHERE o.appraiser_id = $1
        GROUP BY p.id
        ORDER BY max(o.observed_on) DESC NULLS LAST, p.display_address
        LIMIT 2000`, [req.params.id]);

    // THE REPORTS THEY WROTE THAT ARE NOT ON A LOAN FILE — uploaded straight into
    // the research database (db/410). Without this the profile would show only the
    // deals we happened to write, and an appraiser's real body of work here would
    // read as smaller than it is.
    const imports = await db.query(
      `SELECT i.id, i.filename, i.form_type, i.effective_date, i.status,
              i.subject_address, i.subject_city, i.subject_state, i.subject_zip,
              i.subject_property_id, i.comparables_seen, i.observations_written, i.created_at
         FROM research_imports i
        WHERE i.appraiser_id = $1 AND i.status = 'ok'
        ORDER BY i.effective_date DESC NULLS LAST, i.created_at DESC
        LIMIT 500`, [req.params.id]);

    res.json({ appraiser: a, contacts: contacts.rows, licenses: licenses.rows,
      files: files.rows, imports: imports.rows, properties: properties.rows,
      work: work.rows[0] || {} });
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
            o.sale_date, o.sale_status
       FROM property_observations o JOIN properties p ON p.id = o.property_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.sale_date DESC
      LIMIT 4000`, params);
  return { rows: r.rows, rates: V.deriveMarketRates(r.rows, { today: todayNY() }) };
}

router.get('/rates', async (req, res, next) => {
  try {
    const { rates } = await ratesFor(req.query);
    res.json({ rates, market: { state: txt(req.query.state), city: txt(req.query.city),
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
        property_type: txt(req.query.property_type),
        latitude: K.num(req.query.lat), longitude: K.num(req.query.lng),
      };
    }
    // DEFAULTS THAT MAKE THE FIRST ANSWER USEFUL, all overridable from the query.
    // Same city, sold in the last 18 months, within a third to triple the subject's
    // size, and never the subject itself.
    const filters = Object.assign({
      state: subject.state, city: subject.city,
      has_sale: '1', sale_status: 'closed',
      sold_within_months: 18,
      sqft_min: subject.gla ? Math.round(subject.gla * 0.6) : undefined,
      sqft_max: subject.gla ? Math.round(subject.gla * 1.6) : undefined,
      limit: 60, sort: 'recent_sale',
    }, stripEmpty(req.query));
    if (subject.id) filters.exclude_property_id = subject.id;
    if (subject.latitude != null && subject.longitude != null && req.query.radius_miles) {
      filters.lat = subject.latitude; filters.lng = subject.longitude;
    }
    const page = await S.searchProperties(db, filters);
    const ranked = page.rows.map((c) => {
      const s = V.scoreComp(subject, c, { today });
      return Object.assign({}, c, { match_score: s.score, match_reasons: s.parts });
    }).sort((a, b) => b.match_score - a.match_score);
    res.json({ subject, rows: ranked, total: page.total, filters });
  } catch (e) { next(e); }
});

/** The subject property of a loan file, as the warehouse knows it. */
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
  return { valuation: v, comps, grid };
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
      sets.push(`subject_snapshot = ${P(JSON.stringify(subjectSnapshot(Object.assign({}, v.subject_snapshot, b.subject))))}`);
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

    const rates = req.body && req.body.suggest === false ? null
      : (await ratesFor({ state: v.subject_snapshot.state, city: v.subject_snapshot.city, months: 24 })).rates;
    let order = (await db.query(
      `SELECT COALESCE(max(comp_order), 0) AS n FROM property_valuation_comps WHERE valuation_id=$1`,
      [req.params.id])).rows[0].n;

    for (const pid of wanted) {
      const p = (await db.query(`SELECT * FROM properties WHERE id=$1`, [pid])).rows[0];
      if (!p) continue;
      // The comp's own most recent COMPARABLE observation carries the report-level
      // facts the roll-up does not (which grid it was on, how far it was from that
      // report's subject, what the appraiser adjusted). Stored with the snapshot.
      const o = (await db.query(
        `SELECT * FROM property_observations WHERE property_id=$1 AND role='comparable'
          ORDER BY observed_on DESC NULLS LAST, created_at DESC LIMIT 1`, [pid])).rows[0] || {};
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
        [req.params.id, pid, o.id || null, o.appraisal_id || null, ++order,
         JSON.stringify(snapshot), p.last_sale_price, p.last_sale_date,
         JSON.stringify(adj), a.adjustedPrice, a.netAdjustment, a.grossAdjustment,
         a.netAdjPct, a.grossAdjPct, null]);
    }
    await saveComputed(req.params.id);
    res.json(await loadValuation(req.params.id));
  } catch (e) { next(e); }
});

/** The comp facts a grid renders, frozen at the moment it was added. */
function compSnapshot(p, o) {
  const out = {
    property_id: p.id, display_address: p.display_address, city: p.city, state: p.state, zip: p.zip,
    latitude: p.latitude, longitude: p.longitude,
    property_type: p.property_type, units: p.units, year_built: p.year_built,
    gla: p.gla, lot_area: p.lot_area, beds: p.beds, baths_full: p.baths_full, baths_half: p.baths_half,
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
    if (o.sale_price != null) out.sale_price = o.sale_price;
    if (o.sale_date) out.sale_date = String(o.sale_date).slice(0, 10);
    if (o.sale_status) out.sale_status = o.sale_status;
    if (o.gla != null) out.gla = o.gla;
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
       snapshot.sale_price == null ? c.sale_price : snapshot.sale_price,
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
    const { rates } = await ratesFor({ state: v.subject_snapshot.state, city: v.subject_snapshot.city,
      months: req.body && req.body.months ? req.body.months : 24 });
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
    await db.query(`UPDATE property_valuations SET market_rates=$2, updated_at=now() WHERE id=$1`,
      [req.params.id, JSON.stringify(rates)]);
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
// UPLOAD AN APPRAISAL XML STRAIGHT INTO THE DATABASE — single or bulk (db/410)
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

module.exports = router;
