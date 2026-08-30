'use strict';
/**
 * THE REPORTING DATABASE (owner-directed 2026-08-28) — real Postgres, real
 * HTTP. Skips with no DATABASE_URL.
 *
 * Pins:
 *   1. THE DOOR IS ADMIN + SUPER-ADMIN ONLY — a loan officer gets 403 on every
 *      route, fields included.
 *   2. THE GRAMMAR: filters AND-combine, values are typed and BOUND, an
 *      unknown field / wrong operator / junk value is a plain 400 in words —
 *      never a 500, never an unchecked query.
 *   3. A TYPED % OR _ IS A LITERAL (the shared likeParam escaping).
 *   4. A SOFT-DELETED FILE NEVER REPORTS, whatever the filters say.
 *   5. THE JOINED FIELDS ANSWER: deal FICO (the ONE higher-middle rule),
 *      the registered program, the investor, the officer, the composed
 *      address, the confirmed-else-estimate closing date.
 *   6. SAVED REPORTS round-trip (a junk definition is refused AT SAVE), and
 *      the Excel export is a real workbook with an audit row behind it.
 *   7. Total / cap honesty: limit 1 on a 2-row match says total 2, capped.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-reporting-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';

const db = require('../src/db');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `rpt-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Rita Reports','admin',true) RETURNING id`,
    [`${uniq}-admin@example.test`])).rows[0].id;
  const officer = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Larry Officer','loan_officer',true) RETURNING id`,
    [`${uniq}-lo@example.test`])).rows[0].id;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Rex','Reporter',$1,700) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const cob = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,fico,shares_email) VALUES ('Cora','Reporter',$1,680,false) RETURNING id`,
    [`${uniq}-cb@example.test`])).rows[0].id;
  const LENDER = `${uniq} RCN Capital`;
  const mkApp = async ({ status = 'underwriting', lender = null, amount = null, est = null, cb = null, ln } = {}) => (await db.query(
    `INSERT INTO applications (borrower_id, co_borrower_id, loan_officer_id, status, lender, loan_amount, est_closing_date,
                               ys_loan_number, property_address, loan_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{"line1":"12 Report Rd","city":"Troy","state":"NY","zip":"12180"}','Purchase') RETURNING id`,
    [borrower, cb, officer, status, lender, amount, est, ln])).rows[0].id;

  const funded = await mkApp({ status: 'funded', lender: LENDER, amount: 250000, est: '2026-09-15', cb: cob, ln: `${uniq}-A` });
  const small = await mkApp({ status: 'funded', lender: LENDER, amount: 90000, ln: `${uniq}-B` });
  const other = await mkApp({ status: 'underwriting', ln: `${uniq}-C` });
  const deleted = await mkApp({ status: 'funded', lender: LENDER, amount: 400000, ln: `${uniq}-D` });
  await db.query(`UPDATE applications SET deleted_at=now() WHERE id=$1`, [deleted]);
  await db.query(
    `INSERT INTO product_registrations (application_id, program, status, note_rate, total_loan, is_current, inputs, quote)
     VALUES ($1,'gold','ELIGIBLE',10.25,250000,true,'{}','{}')`, [funded]);

  const tok = (id, role) => signJwt({ sub: id, kind: 'staff', role, tv: 0, sid: 'test' });
  const call = async (method, p, body, who) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${who || tok(admin, 'admin')}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; const ct = r.headers.get('content-type') || '';
    if (/json/.test(ct)) { try { j = await r.json(); } catch (_) { /* not json */ } }
    return { status: r.status, body: j, res: r };
  };
  const ids = (out) => new Set((out.body?.rows || []).map((x) => x._id));

  // ── 1. the door ────────────────────────────────────────────────────────────
  {
    const f = await call('GET', '/api/admin/reports/fields');
    ok(f.status === 200 && Array.isArray(f.body.fields) && f.body.fields.length > 40, 'the field dictionary answers for an admin');
    ok(f.body.fields.some((x) => x.key === 'deal_fico') && f.body.fields.every((x) => !x.sql),
      'it carries the deal FICO and never exposes a SQL expression');
    for (const [m, p, b] of [['GET', '/api/admin/reports/fields'], ['POST', '/api/admin/reports/run', {}], ['GET', '/api/admin/reports/saved']]) {
      const r = await call(m, p, b, tok(officer, 'loan_officer'));
      ok(r.status === 403, `${p} refuses a loan officer (403)`);
    }
    const sup = await call('GET', '/api/admin/reports/fields', null, tok(admin, 'super_admin'));
    ok(sup.status === 200, 'a super_admin passes the same gate');
  }

  // ── 2 + 5. the grammar over the real join ──────────────────────────────────
  {
    const out = await call('POST', '/api/admin/reports/run', {
      filters: [
        { field: 'file_status', op: 'in', value: ['funded'] },
        { field: 'investor', op: 'contains', value: uniq },
        { field: 'loan_amount', op: 'gte', value: 100000 },
      ],
      columns: ['ys_loan_number', 'borrower_name', 'co_borrower_name', 'deal_fico', 'registered_program',
        'note_rate', 'investor', 'loan_officer', 'property_address', 'expected_closing_any', 'file_status'],
    });
    ok(out.status === 200, 'a combined run answers');
    const got = ids(out);
    ok(got.has(funded) && !got.has(small) && !got.has(other), 'filters AND-combine: the $250k funded file alone');
    const row = (out.body.rows || []).find((x) => x._id === funded) || {};
    ok(row.borrower_name === 'Rex Reporter' && row.co_borrower_name === 'Cora Reporter', 'both borrowers read off the join');
    ok(Number(row.deal_fico) === 700, 'deal FICO is the ONE higher-middle rule (700 over 680)');
    ok(row.registered_program === 'gold' && Number(row.note_rate) === 10.25, 'the CURRENT registration rides the row');
    ok(row.loan_officer === 'Larry Officer' && /RCN/.test(row.investor), 'the officer and the investor answer');
    ok(/12 Report Rd/.test(row.property_address) && /Troy/.test(row.property_address), 'the address is the composed haystack, parts included');
    ok(String(row.expected_closing_any).slice(0, 10) === '2026-09-15', 'expected closing falls back to the term-sheet estimate');

    const dr = await call('POST', '/api/admin/reports/run', {
      filters: [{ field: 'investor', op: 'contains', value: uniq },
        { field: 'expected_closing_any', op: 'between', value: ['2026-09-01', '2026-09-30'] }],
      columns: ['ys_loan_number'],
    });
    ok(ids(dr).has(funded) && !ids(dr).has(small), 'a date-between filter binds both ends');
  }

  // ── refusals — plain 400s, never a 500 ─────────────────────────────────────
  {
    const cases = [
      [{ field: 'no_such_field', op: 'eq', value: 'x' }, /unknown report field/],
      [{ field: 'loan_amount', op: 'contains', value: 'x' }, /does not support/],
      [{ field: 'loan_amount', op: 'gte', value: 'twelve' }, /needs a number/],
      [{ field: 'funded_date', op: 'on', value: 'not-a-date' }, /needs a date/],
    ];
    for (const [f, re] of cases) {
      const r = await call('POST', '/api/admin/reports/run', { filters: [f], columns: ['ys_loan_number'] });
      ok(r.status === 400 && re.test(r.body.error || ''), `refused in words: ${r.body && r.body.error}`);
    }
  }

  // ── 3. a typed wildcard is a literal ───────────────────────────────────────
  {
    const r = await call('POST', '/api/admin/reports/run', {
      filters: [{ field: 'investor', op: 'contains', value: uniq },
        { field: 'ys_loan_number', op: 'contains', value: '%' }],
      columns: ['ys_loan_number'],
    });
    ok(r.status === 200 && (r.body.rows || []).length === 0, 'contains "%" matches only a literal percent — never everything');
  }

  // ── 4. a soft-deleted file never reports ───────────────────────────────────
  {
    const r = await call('POST', '/api/admin/reports/run', {
      filters: [{ field: 'investor', op: 'contains', value: uniq }], columns: ['ys_loan_number'], limit: 1000,
    });
    ok(!ids(r).has(deleted), 'the soft-deleted file is invisible, whatever the filters say');
  }

  // ── 7. total / cap honesty + sort ──────────────────────────────────────────
  {
    const r = await call('POST', '/api/admin/reports/run', {
      filters: [{ field: 'investor', op: 'contains', value: uniq }, { field: 'file_status', op: 'eq', value: 'funded' }],
      columns: ['loan_amount'], sort: { field: 'loan_amount', dir: 'desc' }, limit: 1,
    });
    ok(r.body.total === 2 && r.body.rows.length === 1 && r.body.capped === true, 'limit 1 on a 2-row match: total 2, capped, one row');
    ok(Number(r.body.rows[0].loan_amount) === 250000, 'the sort is the catalog sort (biggest first)');
  }

  // ── 6. saved reports + the Excel export ────────────────────────────────────
  {
    const def = {
      filters: [{ field: 'investor', op: 'contains', value: uniq }],
      columns: ['ys_loan_number', 'borrower_name', 'loan_amount'],
      sort: { field: 'loan_amount', dir: 'desc' },
    };
    const bad = await call('POST', '/api/admin/reports/saved', { name: 'Bad', definition: { filters: [{ field: 'nope', op: 'eq', value: 1 }] } });
    ok(bad.status === 400, 'a junk definition is refused AT SAVE — a saved report is always runnable');
    const noName = await call('POST', '/api/admin/reports/saved', { definition: def });
    ok(noName.status === 400 && /name/.test(noName.body.error || ''), 'a save needs a name');

    const s1 = await call('POST', '/api/admin/reports/saved', { name: `${uniq} funded RCN`, description: 'test', definition: def });
    ok(s1.status === 201 && s1.body.report && s1.body.report.id, 'a report saves');
    const rid = s1.body.report.id;
    const list = await call('GET', '/api/admin/reports/saved');
    const mine = (list.body.reports || []).find((x) => x.id === rid);
    ok(!!mine && mine.created_by_name === 'Rita Reports', 'the saved list carries it, with attribution');
    const rerun = await call('POST', '/api/admin/reports/run', mine.definition);
    ok(rerun.status === 200 && ids(rerun).has(funded), 'the saved definition re-runs as stored');
    const up = await call('PUT', `/api/admin/reports/saved/${rid}`, { name: `${uniq} renamed`, definition: def });
    ok(up.status === 200 && up.body.report.name === `${uniq} renamed`, 'an update lands');

    const ex = await call('POST', '/api/admin/reports/export.xlsx', { ...def, name: 'Funded RCN' });
    ok(ex.status === 200 && /spreadsheetml/.test(ex.res.headers.get('content-type') || ''), 'the export answers as a spreadsheet');
    const buf = Buffer.from(await ex.res.arrayBuffer());
    ok(buf.slice(0, 2).toString() === 'PK' && buf.length > 1000, 'a real .xlsx workbook (PK zip)');
    const aud = (await db.query(
      `SELECT count(*)::int c FROM audit_log WHERE action='report_exported' AND actor_id=$1`, [admin])).rows[0].c;
    ok(aud >= 1, 'the export is audited');

    const del = await call('DELETE', `/api/admin/reports/saved/${rid}`);
    ok(del.status === 200, 'a saved report deletes');
    const gone = await call('GET', '/api/admin/reports/saved');
    ok(!(gone.body.reports || []).some((x) => x.id === rid), '…and is gone from the list');
  }

  // ═══════════════ LAYER 2 (owner-directed 2026-08-29) ═══════════════════════

  // ── 8. OR-groups: AND within a group, OR between groups ────────────────────
  {
    const r = await call('POST', '/api/admin/reports/run', {
      groups: [
        [{ field: 'investor', op: 'contains', value: uniq }, { field: 'loan_amount', op: 'gte', value: 200000 }],
        [{ field: 'ys_loan_number', op: 'eq', value: `${uniq}-C` }],
      ],
      columns: ['ys_loan_number', 'loan_amount'], limit: 1000,
    });
    const got = ids(r);
    ok(r.status === 200 && got.has(funded) && got.has(other) && !got.has(small),
      'OR-groups: the big funded file OR the underwriting file — the small funded file matches neither group');
    const flat = await call('POST', '/api/admin/reports/run', {
      filters: [{ field: 'investor', op: 'contains', value: uniq }], columns: ['ys_loan_number'], limit: 1000,
    });
    ok(flat.status === 200 && ids(flat).has(funded) && ids(flat).has(small),
      'the layer-1 flat filters shape still runs as one group (saved reports keep working)');
  }

  // ── 9. totals — same filters, aggregated ───────────────────────────────────
  {
    const t = await call('POST', '/api/admin/reports/run', {
      groups: [[{ field: 'investor', op: 'contains', value: uniq }]],
      summarize: { groupBy: ['file_status'], metrics: [{ fn: 'count' }, { fn: 'sum', field: 'loan_amount' }] },
    });
    ok(t.status === 200 && t.body.mode === 'summary', 'a totals run answers in the summary shape');
    const row = (t.body.rows || []).find((x) => x.g0 === 'funded');
    ok(!!row && Number(row.m0) === 2 && Number(row.m1) === 340000,
      `totals agree with the rows: 2 funded files, $340,000 together (got ${row && row.m0}/${row && row.m1})`);
    ok(t.body.metrics.map((m) => m.label).join('|') === 'Files|Total loan amount',
      'the metric labels read in words');
    const x = await call('POST', '/api/admin/reports/export.xlsx', {
      name: 'Totals', groups: [[{ field: 'investor', op: 'contains', value: uniq }]],
      summarize: { groupBy: ['file_status'], metrics: [{ fn: 'count' }] },
    });
    const xbuf = Buffer.from(await x.res.arrayBuffer());
    ok(x.status === 200 && xbuf.slice(0, 2).toString() === 'PK', 'a totals run exports as a real workbook too');
    for (const [bad, re] of [
      [{ summarize: { groupBy: ['file_status'], metrics: [{ fn: 'sum', field: 'borrower_name' }] } }, /not a number/],
      [{ summarize: { groupBy: ['file_status'], metrics: [{ fn: 'median', field: 'loan_amount' }] } }, /unknown total/],
      [{ summarize: { groupBy: ['file_status', 'program', 'investor'] } }, /at most two/],
    ]) {
      const r = await call('POST', '/api/admin/reports/run', bad);
      ok(r.status === 400 && re.test(r.body.error || ''), `totals refusal in words: ${r.body && r.body.error}`);
    }
  }

  // ── 10. the value dropdown ─────────────────────────────────────────────────
  {
    const r = await call('GET', '/api/admin/reports/field-values?field=investor');
    ok(r.status === 200 && (r.body.values || []).some((x) => x.v === LENDER && x.n === 2),
      'a faceted field lists its LIVE values with counts — 2 ACTIVE files (the soft-deleted third never counted)');
    const en = await call('GET', '/api/admin/reports/field-values?field=file_status');
    ok(en.status === 200 && (en.body.values || []).some((x) => x.v === 'funded'), 'an enum field lists its options');
    const bad = await call('GET', '/api/admin/reports/field-values?field=property_address');
    ok(bad.status === 400 && /no value list/.test(bad.body.error || ''), 'a free-form field refuses — type the value');
    const forb = await call('GET', '/api/admin/reports/field-values?field=investor', null, tok(officer, 'loan_officer'));
    ok(forb.status === 403, 'the dropdown door is admin-gated like everything else here');
  }

  // ── 11. schedules: the route validates, the sweep claims + sends ───────────
  {
    const scheduler = require('../src/lib/report-scheduler');
    const def = { groups: [[{ field: 'investor', op: 'contains', value: uniq }]], columns: ['ys_loan_number', 'loan_amount'] };
    const sv = await call('POST', '/api/admin/reports/saved', { name: `${uniq} sched`, definition: def });
    const rid = sv.body.report.id;

    const badRec = await call('PUT', `/api/admin/reports/saved/${rid}/schedule`, {
      schedule: { cadence: 'daily', hour: 0, recipients: [`${uniq}-nobody@example.test`] },
    });
    ok(badRec.status === 400 && /not on the active internal team/.test(badRec.body.error || ''),
      'a recipient outside the active internal team is refused AT SAVE, named');
    const badCad = await call('PUT', `/api/admin/reports/saved/${rid}/schedule`, {
      schedule: { cadence: 'fortnightly', hour: 0, recipients: [`${uniq}-admin@example.test`] },
    });
    ok(badCad.status === 400 && /cadence/.test(badCad.body.error || ''), 'a junk cadence is refused in words');
    const okSet = await call('PUT', `/api/admin/reports/saved/${rid}/schedule`, {
      schedule: { cadence: 'daily', hour: 0, recipients: [`${uniq}-admin@example.test`] },
    });
    ok(okSet.status === 200 && okSet.body.report.schedule.cadence === 'daily', 'a valid schedule stores');

    // isDue truth table (pure)
    ok(scheduler.isDue({ enabled: true, cadence: 'daily', hour: 3 }, { hour: 3, dow: 2, dom: 15 }) === true, 'isDue: daily at its hour');
    ok(scheduler.isDue({ enabled: true, cadence: 'daily', hour: 9 }, { hour: 3, dow: 2, dom: 15 }) === false, 'isDue: not before its hour');
    ok(scheduler.isDue({ enabled: true, cadence: 'weekly', hour: 0, dow: 5 }, { hour: 8, dow: 2, dom: 15 }) === false, 'isDue: weekly waits for its weekday');
    ok(scheduler.isDue({ enabled: true, cadence: 'monthly', hour: 0, dom: 15 }, { hour: 8, dow: 2, dom: 15 }) === true, 'isDue: monthly on its day');
    ok(scheduler.isDue({ enabled: false, cadence: 'daily', hour: 0 }, { hour: 8, dow: 2, dom: 15 }) === false, 'isDue: disabled never fires');

    // Sneak a deactivated + an unknown recipient into the STORED schedule (the
    // route refuses them; the sweep must ALSO drop them at send time).
    await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Gone Person','processor',false)`,
      [`${uniq}-gone@example.test`]);
    await db.query(
      `UPDATE report_definitions SET schedule = jsonb_set(schedule, '{recipients}', $2::jsonb) WHERE id=$1`,
      [rid, JSON.stringify([`${uniq}-admin@example.test`, `${uniq}-gone@example.test`, `${uniq}-stranger@example.test`])]);

    const email = require('../src/lib/email');
    const real = email.sendMail; const outbox = [];
    email.sendMail = async (opts) => { outbox.push(opts); return { ok: true, id: `m${outbox.length}` }; };
    try {
      const s1 = await scheduler.sweepOnce(db, new Date());
      ok(s1.sent === 1 && outbox.length === 1, 'the sweep sends the due report exactly once');
      const wire = outbox[0];
      ok(Array.isArray(wire.to) && wire.to.length === 1 && wire.to[0] === `${uniq}-admin@example.test`,
        'send-time re-validation: only the ACTIVE INTERNAL recipient is on the wire — the deactivated and unknown ones dropped');
      const att = (wire.attachments || [])[0] || {};
      ok(/\.xlsx$/.test(att.filename || '') && Buffer.from(att.content || '', 'base64').slice(0, 2).toString() === 'PK',
        'the Excel workbook rides as a real attachment');
      const s2 = await scheduler.sweepOnce(db, new Date());
      ok(s2.sent === 0 && outbox.length === 1, 'the SAME period never sends twice (the last_sent_at claim)');

      // A failed send releases the claim so the next sweep retries.
      await db.query(`UPDATE report_definitions SET last_sent_at = NULL WHERE id=$1`, [rid]);
      email.sendMail = async () => { throw new Error('provider down'); };
      const s3 = await scheduler.sweepOnce(db, new Date());
      ok(s3.failed === 1, 'a provider failure is counted as failed');
      const after = (await db.query(`SELECT last_sent_at FROM report_definitions WHERE id=$1`, [rid])).rows[0];
      ok(after.last_sent_at === null, '…and the claim is RELEASED, so the next sweep retries instead of skipping the day');
      email.sendMail = async (opts) => { outbox.push(opts); return { ok: true }; };
      const s4 = await scheduler.sweepOnce(db, new Date());
      ok(s4.sent === 1 && outbox.length === 2, 'the retry sweep sends it');
    } finally { email.sendMail = real; }

    const un = await call('PUT', `/api/admin/reports/saved/${rid}/schedule`, { schedule: null });
    ok(un.status === 200 && un.body.report.schedule === null, 'a schedule clears with schedule: null');
    await call('DELETE', `/api/admin/reports/saved/${rid}`);
  }

  // ── 12. the new fields answer over the real join ───────────────────────────
  {
    const r = await call('POST', '/api/admin/reports/run', {
      groups: [[{ field: 'ys_loan_number', op: 'eq', value: `${uniq}-A` }]],
      columns: ['open_conditions', 'co_borrower_fico', 'tpo_firm', 'closing_stage', 'registration_stale'],
    });
    const row = (r.body.rows || [])[0] || {};
    ok(r.status === 200 && Number.isInteger(Number(row.open_conditions)), 'open_conditions counts (a real number, never an error)');
    ok(Number(row.co_borrower_fico) === 680, 'the co-borrower FICO reads off the join');
  }

  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll reporting checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
