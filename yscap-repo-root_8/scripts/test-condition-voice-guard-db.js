'use strict';
/**
 * IG-VOICE (#285) — guard that every ACTIVE posted condition stays in PILOT's own plain,
 * beginner-friendly voice on borrower-facing surfaces, and NEVER leaks a note-buyer /
 * capital-partner name to a borrower.
 *
 * The borrower-facing condition wording is written in our plain voice (each IG-W item did
 * this per-condition). This locks that in going forward so a future template — or a re-mined
 * note-buyer spec (#242) — can't quietly reintroduce a partner name or spreadsheet-style
 * wording onto a BORROWER field:
 *   (1) NO partner name (Blue Lake / CorrFirst / Fidelis / Temple View / Churchill / RCN) in
 *       any active borrower-facing template's borrower_label or borrower_hint. Partner names on
 *       STAFF fields are fine (allowed) and are NOT checked.
 *   (2) The EIN condition's borrower hint reads in plain language (no bare "SS-4 /" form-number
 *       jargon) — the one item #285's db/305 rewrote; proves the migration applied.
 *   (3) NO phantom borrower condition: every auto-posted (auto_apply rules/always) borrower/both
 *       template that is not a tool/e-sign (which render their own copy) has a real borrower_label
 *       — otherwise the engine silently downgrades it to staff-only and the borrower would see a
 *       meaningless item or nothing.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-condition-voice-guard-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-condition-voice-guard-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// The note-buyer / capital-partner names that must never reach a borrower surface (CLAUDE.md).
const PARTNER_RE = '(blue ?lake|corr ?first|fidelis|temple ?view|churchill|\\mRCN\\M)';

(async () => {
  await ensureSchema();

  // (1) No partner name on any borrower-facing template field.
  const leaks = (await db.query(
    `SELECT code, coalesce(borrower_label,'') AS bl, coalesce(borrower_hint,'') AS bh
       FROM checklist_templates
      WHERE is_active AND audience IN ('borrower','both')
        AND (coalesce(borrower_label,'') ~* $1 OR coalesce(borrower_hint,'') ~* $1)`,
    [PARTNER_RE])).rows;
  ok(leaks.length === 0,
    `no active borrower-facing condition names a note buyer on a borrower field${leaks.length ? ' → ' + leaks.map((r) => r.code).join(', ') : ''}`);

  // (2) The EIN condition's borrower hint reads plain (no bare form-number jargon).
  const ein = (await db.query(
    `SELECT borrower_hint FROM checklist_templates WHERE code = 'rtl_llc_ein'`)).rows[0];
  ok(ein && /tax id/i.test(ein.borrower_hint) && !/\bSS-4\s*\//i.test(ein.borrower_hint),
    'the EIN condition explains itself in plain language (says "tax ID", no bare "SS-4 /" form jargon)');

  // (3) No phantom borrower condition: every auto-posted borrower/both template that is not a
  //     tool/e-sign has borrower wording, so the engine never silently downgrades it staff-only.
  const phantoms = (await db.query(
    `SELECT code FROM checklist_templates
      WHERE is_active AND auto_apply IN ('rules','always') AND audience IN ('borrower','both')
        AND coalesce(borrower_label,'') = '' AND coalesce(tool_key,'') = '' AND coalesce(esign_doc,'') = ''`)).rows;
  ok(phantoms.length === 0,
    `every auto-posted borrower condition has borrower wording (no phantom)${phantoms.length ? ' → ' + phantoms.map((r) => r.code).join(', ') : ''}`);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  condition-voice-guard-db: borrower conditions are in our plain voice, name no note buyer, and never phantom — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
