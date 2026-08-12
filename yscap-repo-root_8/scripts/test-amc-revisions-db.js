'use strict';
/**
 * DB-gated test for the AMC revision / ROV service (src/amc/revisions.js) against a
 * real Postgres. Drives the network through an INJECTED transport: place a general
 * revision, place an ROV (structured detail stored), poll GetRevisions with dedupe,
 * and list. Also checks the ROV comps helper degrades gracefully when no appraisal is
 * on file. One transaction, rolled back.
 *
 * Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-amc-revisions-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const { Pool } = require('pg');
const revisions = require(path.join(ROOT, 'src/amc/revisions'));
const rov = require(path.join(ROOT, 'src/amc/rov'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// AddRevision ack carrying a revision id.
const addAck = (id) => ({ transport: { write: async () => ({ message: { products: [{ revisionId: id }] } }) }, authContext: { apiKey: 'K', subdomain: 'sub' } });
// GetRevisions listing R1 (known) + R2 (new).
const getDeps = { transport: { read: async () => ({ message: { products: [{ revisionId: 'R1' }, { revisionId: 'R2' }] } }) }, authContext: { apiKey: 'K', subdomain: 'sub' } };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  await ensureSchema();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const bo = await c.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Rev','Test',$1) RETURNING id`, [`amc-rev-${Date.now()}@example.com`]);
    const app = await c.query(`INSERT INTO applications (borrower_id, ys_loan_number) VALUES ($1,'YSCAP-REV-1') RETURNING id`, [bo.rows[0].id]);
    const ord = await c.query(
      `INSERT INTO amc_orders (application_id, client_order_number, cdg_order_number, sp_order_number, status)
       VALUES ($1,'YSCAP-REV-1','CLG200','SP-2','in_review') RETURNING *`, [app.rows[0].id]);
    const order = ord.rows[0];

    // ---- a general SOW-change revision ----
    const gen = await revisions.postRevision(c, order, { staffId: null, kind: 'sow_change', body: 'Please update the scope of work to reflect the corrected budget.' }, addAck('R0'));
    ok(gen.ok && gen.revision.kind === 'sow_change' && gen.revision.status === 'submitted', 'sow_change revision recorded + submitted');
    ok(gen.revision.amc_revision_id === 'R0', 'revision carries the AMC revision id from the ack');
    const j = await c.query(`SELECT count(*)::int n FROM amc_write_log WHERE order_id=$1 AND action='AddRevision' AND ok=true`, [order.id]);
    ok(j.rows[0].n === 1, 'the revision is journaled');
    // an empty body is refused
    const empty = await revisions.postRevision(c, order, { staffId: null, kind: 'revision', body: '  ' }, addAck('X'));
    ok(!empty.ok && empty.error === 'empty', 'an empty revision is refused');

    // ---- an ROV with structured detail ----
    // A value dispute (ROV) is only accepted once the report is IN — the SOW change above
    // deliberately worked mid-review, but a value dispute needs the finished report, so
    // advance the order to 'product_available' (Report ready) first.
    await c.query(`UPDATE amc_orders SET status='product_available' WHERE id=$1`, [order.id]);
    order.status = 'product_available';
    const detail = rov.buildRovDetail({ appraisedValue: 400000, opinionValue: 460000, comps: [
      { propertyId: 'p1', address: '10 Oak St', salePrice: 450000, saleDate: '2026-05-01', gla: 1800, beds: 3, bathsFull: 2 },
    ] });
    const narrative = rov.buildRovNarrative(detail);
    const rovRes = await revisions.postRevision(c, order, { staffId: null, kind: 'rov', body: narrative, rovDetail: detail }, addAck('R1'));
    ok(rovRes.ok && rovRes.revision.kind === 'rov', 'ROV revision recorded');
    ok(rovRes.revision.rov_detail && Number(rovRes.revision.rov_detail.opinionValue) === 460000, 'ROV structured detail stored');
    ok(/Reconsideration of Value/.test(rovRes.revision.body), 'ROV narrative stored as the body');

    // ---- poll GetRevisions: R1 known (skip), R2 new (insert) ----
    const s1 = await revisions.syncRevisions(c, order, getDeps);
    ok(s1.ok && s1.added === 1, 'sync files only the unknown revision (R2)');
    const s2 = await revisions.syncRevisions(c, order, getDeps);
    ok(s2.added === 0, 're-sync dedupes (nothing new)');

    // ---- list ----
    const list = await revisions.listRevisions(c, order.id);
    ok(list.length === 3, 'three revisions on the order (sow_change + rov + inbound R2)');

    // ---- ROV comps degrade gracefully with no appraisal on file ----
    const appId = app.rows[0].id;
    const sug = await rov.suggestComps(c, appId, {});
    ok(sug.subject === null && Array.isArray(sug.comps) && sug.comps.length === 0, 'suggestComps returns empty when no subject/appraisal is on file');

    // ---- seed a subject + a comparable sale, then exercise the REAL research search ----
    const ts = Date.now();
    const subj = await c.query(
      `INSERT INTO properties (address_key, display_address, city, state, units, gla)
       VALUES ($1,'100 Subject St, Brooklyn, NY','Brooklyn','NY',1,1800) RETURNING id`, [`subj-${ts}`]);
    await c.query(
      `INSERT INTO property_observations (property_id, role, application_id, adjustments, facts)
       VALUES ($1,'subject',$2,'[]'::jsonb,'{}'::jsonb)`, [subj.rows[0].id, appId]);
    // a closed comparable sale in the same town, similar size, recent
    await c.query(
      `INSERT INTO properties (address_key, display_address, city, state, units, gla, last_sale_price, last_sale_date, last_sale_status)
       VALUES ($1,'102 Comp St, Brooklyn, NY','Brooklyn','NY',1,1850,460000, (CURRENT_DATE - INTERVAL '2 months')::date, 'closed')`,
      [`comp-${ts}`]);

    const sug2 = await rov.suggestComps(c, appId, {});
    ok(sug2.subject && sug2.subject.address === '100 Subject St, Brooklyn, NY', 'suggestComps finds the file subject');
    ok(sug2.comps.length >= 1, 'suggestComps returns comparable sales from the research warehouse');
    ok(sug2.comps.some((x) => x.salePrice === 460000 && x.address === '102 Comp St, Brooklyn, NY'), 'the seeded comparable sale is returned with its price');
    ok(!sug2.comps.some((x) => String(x.propertyId) === String(subj.rows[0].id)), 'the subject itself is never returned as its own comp');

    // ---- the FREE ROV comp search (the picker behind the value dispute) ----
    const srch = await rov.searchComps(c, appId, {});
    ok(srch.subject && srch.subject.address === '100 Subject St, Brooklyn, NY', 'searchComps seeds the subject town and finds the file subject');
    ok(srch.comps.some((x) => x.address === '102 Comp St, Brooklyn, NY' && x.salePrice === 460000), 'searchComps returns the seeded comparable sale with its detail');
    ok(!srch.comps.some((x) => String(x.propertyId) === String(subj.rows[0].id)), 'searchComps never returns the subject as its own comp');
    const byText = await rov.searchComps(c, appId, { q: 'Comp St' });
    ok(byText.comps.some((x) => x.address === '102 Comp St, Brooklyn, NY'), 'searchComps finds a comp by typed address text');
    const none = await rov.searchComps(c, appId, { state: 'CA', city: 'Nowhereville' });
    ok(Array.isArray(none.comps) && none.comps.length === 0, 'searchComps returns an empty page for a place with no matches (never throws)');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    fail++; console.error('  FAIL (threw):', e.message);
  } finally {
    c.release();
    await pool.end();
  }

  console.log(`\n[test-amc-revisions-db] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
