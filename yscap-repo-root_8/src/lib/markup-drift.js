'use strict';
/**
 * WHICH FILES STILL PRICE AT A MARKUP THE COMPANY NO LONGER SETS — and, for
 * each one, WHY.
 *
 * Owner-reported 2026-08-26: *"I still see sometimes … automatic exception
 * requests that people want to move down the price from 0.5 to 0.4 markup. I
 * don't believe everybody requests the same thing. I think there's still a bug
 * in the system … maybe it's only on old files. The price in this plate is 0.4,
 * but the price in the back is 0.5."*
 *
 * READ-ONLY, AND DELIBERATELY SO. The 2026-08-20 fix already stopped the studio
 * freezing a default onto a file, and db/600 already released the frozen value
 * from every file whose economics are still open. What is left is the files
 * db/600 SPARED ON PURPOSE — clear to close, funded, declined, withdrawn, or a
 * live Term Sheet package out for signature — because raising those to today's
 * markup would change the rate a borrower has already been shown or SIGNED.
 * That is a decision about money on signed terms, so this module answers the
 * question and changes nothing.
 *
 * IT SEPARATES THE TWO THINGS THAT LOOK IDENTICAL ON A SCREEN:
 *   · a file frozen at the default IN FORCE THE DAY IT REGISTERED — nobody
 *     asked for a discount, the company simply moved afterwards; and
 *   · a file frozen at a number that was NEVER the default — somebody typed it,
 *     which is a real exception and correctly stays one.
 * Telling an owner "there are 40 stale files" without that split is the
 * confident wrong answer: half of them may be genuine approvals.
 */

const db = require('../db');
const pricingSettings = require('./pricing-settings');

const PROGRAMS = Object.freeze([
  { key: 'std', col: 'file_markup_std_pct', def: 'markupStdPct', label: 'Standard' },
  { key: 'gold', col: 'file_markup_gold_pct', def: 'markupGoldPct', label: 'Gold' },
  { key: 'silver', col: 'file_markup_silver_pct', def: 'markupSilverPct', label: 'Silver' },
]);

/* db/600's own spare rule, restated as a READ so the diagnosis can never
   disagree with what the migration actually did. Kept in step by hand — the
   migration is SQL and cannot be called from here; the test asserts the two
   still describe the same files. */
const SETTLED = Object.freeze(['clear_to_close', 'funded', 'declined', 'withdrawn']);

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;

/**
 * Every file still carrying a per-file markup, classified.
 *
 * Returns { rows, summary, today } — never throws; an unreadable history
 * classifies a row as `unknown` rather than guessing at it.
 */
async function report({ limit = 500 } = {}, client = db) {
  const today = {};
  try {
    const cur = pricingSettings.current() || {};
    for (const p of PROGRAMS) today[p.key] = num(cur[p.def]);
  } catch (_) { for (const p of PROGRAMS) today[p.key] = null; }

  const cols = PROGRAMS.map((p) => `a.${p.col}`).join(', ');
  const r = await client.query(
    `SELECT a.id, a.ys_loan_number, a.property_address, a.status, ${cols},
            pr.created_at AS registered_at,
            EXISTS (SELECT 1 FROM esign_envelopes e
                     WHERE e.application_id = a.id
                       AND e.purpose = 'term_sheet_package'
                       AND e.status IN ('sent','delivered','completed')) AS live_package
       FROM applications a
       LEFT JOIN product_registrations pr ON pr.application_id = a.id AND pr.is_current
      WHERE a.deleted_at IS NULL
        AND (${PROGRAMS.map((p) => `a.${p.col} IS NOT NULL`).join(' OR ')})
      ORDER BY pr.created_at DESC NULLS LAST
      LIMIT $1`, [Math.min(2000, Math.max(1, Number(limit) || 500))]);

  const rows = [];
  for (const f of r.rows) {
    /* The default IN FORCE THE DAY THIS FILE REGISTERED. Without it the two
       cases below cannot be told apart, and the whole report becomes a list of
       numbers that differ from today's — which says nothing about whether
       anybody asked for anything. */
    let then = null;
    if (f.registered_at) {
      try {
        const d = await pricingSettings.asOf(f.registered_at, client);
        if (d) { then = {}; for (const p of PROGRAMS) then[p.key] = num(d[p.def]); }
      } catch (_) { then = null; }
    }
    for (const p of PROGRAMS) {
      const frozen = num(f[p.col]);
      if (frozen == null) continue;
      const nowDef = today[p.key];
      if (same(frozen, nowDef)) continue;          // agrees with the company today — nothing to report
      const thenDef = then ? then[p.key] : null;
      let verdict; let why;
      if (!f.registered_at || then == null) {
        verdict = 'unknown';
        why = 'PILOT cannot read what the company default was when this file registered, so it cannot say whether anybody asked for this.';
      } else if (same(frozen, thenDef)) {
        const settled = SETTLED.includes(String(f.status || ''));
        verdict = 'historical';
        why = settled
          ? `Nobody asked for this — it was the company default the day this file registered. It was left alone because the file is ${String(f.status).replace(/_/g, ' ')}, so changing it would move terms that are already settled.`
          : (f.live_package
            ? 'Nobody asked for this — it was the company default the day this file registered. It was left alone because a Term Sheet package is out for signature, so changing it would move terms the borrower has already been shown.'
            : 'Nobody asked for this — it was the company default the day this file registered, and this file is still open, so it should have been released. Worth a look.');
      } else {
        verdict = 'deliberate';
        why = `Somebody set this on purpose: the company default the day this file registered was ${thenDef == null ? 'unreadable' : thenDef}, not ${frozen}.`;
      }
      rows.push({
        application_id: f.id, ys_loan_number: f.ys_loan_number, property_address: f.property_address,
        file_status: f.status, program: p.label, program_key: p.key,
        frozen, default_now: nowDef, default_then: thenDef,
        registered_at: f.registered_at, live_package: !!f.live_package,
        verdict, why,
      });
    }
  }

  const summary = { historical: 0, deliberate: 0, unknown: 0, files: new Set() };
  for (const x of rows) { summary[x.verdict] += 1; summary.files.add(x.application_id); }
  return { rows, today, summary: { ...summary, files: summary.files.size }, capped: r.rows.length >= Math.min(2000, limit) };
}

module.exports = { report, PROGRAMS, SETTLED, _internals: { same, num } };
