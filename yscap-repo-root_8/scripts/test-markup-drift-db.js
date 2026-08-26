'use strict';
/*
 * WHICH FILES STILL PRICE AT A MARKUP THE COMPANY NO LONGER SETS — and the two
 * cases that look identical on a screen and must never be confused.
 *
 * Owner-reported 2026-08-26: *"automatic exception requests that people want to
 * move down the price from 0.5 to 0.4 … I think there's still a bug … maybe
 * it's only on old files."*
 *
 * THE WHOLE POINT IS THE SPLIT. Telling an owner "there are 40 stale files"
 * without separating
 *   · a file frozen at the default IN FORCE THE DAY IT REGISTERED (nobody asked
 *     for anything — the company moved afterwards), from
 *   · a file frozen at a number that was NEVER the default (somebody typed it,
 *     which is a real approval and correctly stays one)
 * is the confident wrong answer: half of them may be genuine.
 *
 * Requires DATABASE_URL; SKIPs otherwise. Runs in a transaction and ROLLS BACK.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-markup-drift-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const drift = require('../src/lib/markup-drift');

let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); ok(m); };
const yes = (v, m) => { assert.ok(v, m); ok(m); };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const tag = `md${process.pid}${Date.now() % 100000}`;

    /* A settings HISTORY: the company was at 0.4, then moved to 0.5. That is the
       owner's own story, and without it neither case below can be told apart. */
    await c.query(
      `INSERT INTO company_pricing_settings (markup_std_pct, markup_gold_pct, markup_silver_pct, is_current, created_at)
       VALUES (0.4,0.4,0.4,false, now() - interval '60 days')`);
    await c.query(
      `INSERT INTO company_pricing_settings (markup_std_pct, markup_gold_pct, markup_silver_pct, is_current, created_at)
       VALUES (0.5,0.5,0.5,false, now() - interval '5 days')`);

    const b = (await c.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Drift',$1,$2) RETURNING id`,
      [`Case${tag}`, `d.${tag}@example.test`])).rows[0].id;
    const mk = async (loanNo, frozen, status, regDaysAgo) => {
      const id = (await c.query(
        `INSERT INTO applications (borrower_id, ys_loan_number, loan_amount, status, file_markup_std_pct)
         VALUES ($1,$2,500000,$3,$4) RETURNING id`, [b, loanNo, status, frozen])).rows[0].id;
      await c.query(
        `INSERT INTO product_registrations (application_id, program, is_current, created_at, inputs, quote)
         VALUES ($1,'standard',true, now() - ($2 || ' days')::interval, '{}'::jsonb, '{}'::jsonb)`, [id, String(regDaysAgo)]);
      return id;
    };

    // Registered 30 days ago — when the company default WAS 0.4. Nobody asked.
    const historical = await mk(`YSCAP${tag}H`, 0.4, 'funded', 30);
    // Registered 2 days ago — the default was already 0.5, so 0.4 was TYPED.
    const deliberate = await mk(`YSCAP${tag}D`, 0.4, 'funded', 2);

    const r = await drift.report({}, c);
    const mine = (v) => r.rows.filter((x) => String(x.ys_loan_number || '').includes(tag) && x.verdict === v);
    const rowOf = (id) => r.rows.find((x) => x.application_id === id);

    eq(r.rows.filter((x) => String(x.ys_loan_number || '').includes(tag)).length, 2,
      'A1 both files are reported — each still prices at a markup the company no longer sets');

    // ── THE SPLIT ─────────────────────────────────────────────────────────
    eq(rowOf(historical).verdict, 'historical',
      'B1 the file registered while 0.4 WAS the default reads as historical — nobody asked for a discount');
    eq(rowOf(historical).default_then, 0.4, 'B2 and the report states the default that was in force that day');
    eq(rowOf(deliberate).verdict, 'deliberate',
      'B3 the file registered after the move reads as deliberate — somebody typed it');
    eq(rowOf(deliberate).default_then, 0.5, 'B4 naming the default it was typed against');
    yes(/Nobody asked/.test(rowOf(historical).why), 'B5 the historical row says so in plain words');
    yes(/on purpose/.test(rowOf(deliberate).why), 'B6 and the deliberate row says the opposite, just as plainly');
    yes(/funded/.test(rowOf(historical).why),
      'B7 the historical row names WHY it was left alone — its terms are settled');

    // ── IT NEVER REPORTS A FILE THAT AGREES WITH THE COMPANY ──────────────
    const agrees = await mk(`YSCAP${tag}A`, 0.5, 'underwriting', 1);
    const r2 = await drift.report({}, c);
    eq(r2.rows.filter((x) => x.application_id === agrees).length, 0,
      "C1 a file frozen at the CURRENT default is not reported at all — there is nothing to decide about it");

    // ── AN UNREADABLE HISTORY IS SAID, NOT GUESSED ────────────────────────
    const noReg = (await c.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, loan_amount, status, file_markup_std_pct)
       VALUES ($1,$2,500000,'underwriting',0.4) RETURNING id`, [b, `YSCAP${tag}N`])).rows[0].id;
    const r3 = await drift.report({}, c);
    eq((r3.rows.find((x) => x.application_id === noReg) || {}).verdict, 'unknown',
      'D1 a file with no registration behind it is UNKNOWN — never guessed into either camp');
    yes(/cannot say whether anybody asked/.test((r3.rows.find((x) => x.application_id === noReg) || {}).why || ''),
      'D2 and says exactly that, rather than implying a verdict');

    // ── IT CHANGES NOTHING ────────────────────────────────────────────────
    /* This module exists because the remaining files are ones db/600 spared ON
       PURPOSE — settled or signed — so touching them would move terms a borrower
       has already been shown. A diagnosis that quietly repaired them would be
       the exact opposite of what it is for. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'markup-drift.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    eq(/\b(UPDATE|INSERT|DELETE)\b/i.test(src), false, 'E1 the module contains no write of any kind');
    /* Its spare rule must keep describing the same files db/600 spared, or the
       report explains a decision the migration did not make. */
    const mig = fs.readFileSync(path.join(__dirname, '..', 'db', '600_clear_seeded_per_file_markup_that_only_restated_the_company.sql'), 'utf8');
    for (const st of drift.SETTLED) yes(mig.includes(st), `E2 db/600 spares "${st}" too — the two still describe the same files`);

    console.log(`\ntest-markup-drift-db: all ${n} checks passed.`);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
