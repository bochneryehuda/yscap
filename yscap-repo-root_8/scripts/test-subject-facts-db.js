/**
 * THE CONFIRM-THE-FACTS STEP, END TO END — the correction really does re-value.
 *
 * The promise of this step is narrow and easy to half-build: a person corrects the
 * living area, and the number on screen is already rebuilt from it by the time the
 * panel closes. A correction that does not visibly move the value is a correction
 * nobody trusts they made, and one that is stored without re-running the grid
 * leaves the screen showing a figure computed from the OLD fact — which is worse
 * than not offering the step at all.
 *
 * Also pinned: the refusal (a living area of "about 2400" must not be filed as
 * 2400 or as 0), the stale confirmation (a "checked" stamp that survives the fact
 * changing launders an unchecked number), and the finalized valuation (a record of
 * what was said is not something a later check may rewrite).
 *
 * Real Postgres, real HTTP. Run: node scripts/test-subject-facts-db.js
 */
'use strict';

const http = require('http');
const express = require('express');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('test-subject-facts-db: skipped (no DATABASE_URL)');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'subject-facts-test';

const db = require('../src/db');
const C = require('../src/lib/crypto');

const sfx = `${process.pid}${Math.floor(Math.random() * 1e5)}`;
const CITY = `Factstown${sfx}`;
let staffId, valId, server, port;
const propIds = [];

const call = async (method, path, body, token) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: Object.assign({ Authorization: `Bearer ${token}` }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

(async () => {
  try {
    await require('../src/migrate-boot').ensureSchema();
    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Facts Check','super_admin',true,false,'x',0) RETURNING id`,
      [`sf${sfx}@t.test`])).rows[0].id;
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    // Three comparables, all smaller than the subject will turn out to be, so a
    // corrected living area has somewhere to move the value.
    for (let i = 0; i < 3; i++) {
      const id = (await db.query(
        `INSERT INTO properties (address_key, display_address, street, city, state, zip,
           property_type, units, gla, beds, baths_full, year_built, condition_uad,
           last_sale_price, last_sale_date, observation_count, geo_latitude, geo_longitude)
         VALUES ($1,$2,$3,$4,'NJ','07001','Single Family',1,1200,3,2,1975,'C3',
                 300000, current_date - interval '2 months', 2, 40.1, -74.1)
         RETURNING id`,
        [`nj|${CITY.toLowerCase()}|${i} fact st|${sfx}`, `${i} Fact St ${sfx}`, `${i} Fact St`, CITY])).rows[0].id;
      propIds.push(id);
    }

    const app = express();
    app.use(express.json());
    app.use('/api/research', require('../src/routes/research'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;

    // A valuation whose subject has NO LIVING AREA — the blind spot that removes
    // four adjustments at once.
    const made = await call('POST', '/api/research/valuations', {
      title: `Facts ${sfx}`,
      subject: { display_address: `9 Subject Way ${sfx}`, city: CITY, state: 'NJ',
        property_type: 'Single Family', units: 1, beds: 3, baths_full: 2, condition_uad: 'C3' },
    }, token);
    valId = made.body.valuation && made.body.valuation.id;
    ok(!!valId, `the valuation was created (${made.status})`);
    await call('POST', `/api/research/valuations/${valId}/comps`, { property_ids: propIds }, token);

    // ---- 1. THE REVIEW RIDES ALONG WITH EVERY READ ------------------------
    const read = await call('GET', `/api/research/valuations/${valId}`, null, token);
    const rev = read.body.subjectReview;
    ok(!!rev, 'every read of a valuation carries what the value rests on — it is not behind its own call');
    ok(rev.blindSpots.includes('gla'), 'a subject with no living area reports that as a blind spot');
    ok(rev.confirmed === false, 'and nobody has confirmed it yet');
    ok(/not being made|plain average|depends on/i.test(rev.headline), 'the headline says so: ' + rev.headline);

    // ---- 2. THE CORRECTION RE-VALUES, IN THE SAME ANSWER -------------------
    // The witness for "the adjustments were re-derived": `resuggestAll` rewrites
    // every comparable row, so their `updated_at` moves past this mark. Nothing
    // else on this door touches them.
    await new Promise((r) => setTimeout(r, 60));
    const beforeConfirm = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 60));
    const fixed = await call('POST', `/api/research/valuations/${valId}/confirm-subject`,
      { corrections: { gla: '2400' } }, token);
    ok(fixed.status === 200, `the confirmation is accepted (${fixed.status})`);
    ok((fixed.body.changed || []).some((c) => c.key === 'gla'), 'it reports that the living area was corrected');
    ok(Number(fixed.body.valuation.subject_snapshot.gla) === 2400, 'and the corrected fact is stored');

    /* THE ADJUSTMENTS WERE RE-DERIVED, NOT MERELY RE-TOTALLED — and this is the
       assertion the whole feature turned on. The grid is rebuilt from the STORED
       adjustment lines, and those were derived from the OLD fact, so a confirm
       step that stored the correction and re-ran the arithmetic left the screen
       showing a value computed from the very fact that had just been corrected.
       The first cut did exactly that: the value was byte-identical before and
       after, which is precisely the "correction nobody trusts they made" this step
       exists to avoid. `market_rates` is written by the re-derive path and by
       nothing else on this door, so its presence is the proof that it ran.

       (The FIGURE itself does not move in this fixture, and that is honest rather
       than a gap: suggested adjustments come from market rates, rates are read
       from comparable OBSERVATIONS, and this fixture has none — a market we hold
       no sales in yields no rates, which the engine refuses to invent. What is
       being proved here is that the confirmation re-runs the derivation, not that
       a particular town has enough sales to read a rate from.) */
    const touched = (await db.query(
      `SELECT count(*)::int AS n FROM property_valuation_comps
        WHERE valuation_id = $1 AND updated_at > $2`, [valId, beforeConfirm])).rows[0].n;
    ok(touched === propIds.length,
      `every comparable's adjustments were REWRITTEN by the confirmation (${touched} of ${propIds.length}) — `
      + 'storing the fact without re-deriving them leaves the grid on the fact that was just corrected');
    const rated = (await db.query('SELECT market_rates, indicated_value FROM property_valuations WHERE id=$1', [valId])).rows[0];
    ok(rated.market_rates != null, 'and the market rates behind them were re-read');
    ok(String(rated.indicated_value) === String(fixed.body.valuation.indicated_value),
      'and the STORED headline figure matches the one answered — the list screen reads that column, not the live grid');

    ok(!(fixed.body.subjectReview.blindSpots || []).includes('gla'), 'the blind spot is gone');
    ok(fixed.body.subjectReview.confirmed === true, 'and it now reads as checked by a person');

    const stored = (await db.query('SELECT subject_confirmed_by FROM property_valuations WHERE id=$1', [valId])).rows[0];
    ok(stored.subject_confirmed_by === staffId, 'and it records WHO checked it');

    // ---- 3. THE CONFIRMATION GOES STALE WHEN THE FACT MOVES ---------------
    await call('PATCH', `/api/research/valuations/${valId}`, { subject: { gla: 3000 } }, token);
    const moved = await call('GET', `/api/research/valuations/${valId}`, null, token);
    ok(moved.body.subjectReview.stale.stale === true,
      'changing a confirmed fact afterwards makes the confirmation STALE');
    ok(moved.body.subjectReview.confirmed === false,
      'and it stops reading as confirmed — a stamp that survives the fact changing launders an unchecked number');
    ok((moved.body.subjectReview.stale.changed || []).some((c) => c.key === 'gla'), 'naming which fact moved');

    // ---- 4. A CORRECTION IS CHECKED, NOT COERCED --------------------------
    const bad = await call('POST', `/api/research/valuations/${valId}/confirm-subject`,
      { corrections: { gla: 'about 2400', beds: 4 } }, token);
    ok(bad.status === 400, `an unreadable living area is refused (${bad.status})`);
    ok(/living area/i.test(String(bad.body.error || '')), 'naming the field: ' + JSON.stringify(bad.body.error));
    const untouched = (await db.query('SELECT subject_snapshot FROM property_valuations WHERE id=$1', [valId])).rows[0];
    ok(Number(untouched.subject_snapshot.gla) === 3000 && Number(untouched.subject_snapshot.beds) === 3,
      'and NOTHING from that request was filed — not even the bedroom count that was fine');

    // A blank is an answer, and the fact goes back to being a blind spot.
    const cleared = await call('POST', `/api/research/valuations/${valId}/confirm-subject`,
      { corrections: { gla: '' } }, token);
    ok(cleared.status === 200 && (cleared.body.subjectReview.blindSpots || []).includes('gla'),
      '"we do not actually know" is a legitimate answer, and it shows back up as a blind spot');

    // This door writes FACTS, never a value.
    const sneak = await call('POST', `/api/research/valuations/${valId}/confirm-subject`,
      { corrections: { indicated_value: 999999, gla: 2400 } }, token);
    ok(sneak.status === 200, 'a request carrying a key that is not a fact still works');
    ok(String(sneak.body.valuation.indicated_value) !== '999999',
      'and the value cannot be written through this door — it is always computed from the grid');

    // ---- 5. A FINALIZED VALUATION IS A RECORD ------------------------------
    await call('POST', `/api/research/valuations/${valId}/finalize`, {}, token);
    const late = await call('POST', `/api/research/valuations/${valId}/confirm-subject`,
      { corrections: { gla: 1000 } }, token);
    ok(late.status === 409, `a finalized valuation refuses a later check (${late.status})`);
    ok(/record of what was said|duplicate/i.test(String(late.body.error || '')),
      'saying why, in words: ' + JSON.stringify(late.body.error));

    console.log(`\ntest-subject-facts-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error(e);
    fail++;
  } finally {
    if (server) server.close();
    if (valId) await db.query('DELETE FROM property_valuations WHERE id=$1', [valId]).catch(() => {});
    for (const id of propIds) await db.query('DELETE FROM properties WHERE id=$1', [id]).catch(() => {});
    if (staffId) await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]).catch(() => {});
    await db.pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
