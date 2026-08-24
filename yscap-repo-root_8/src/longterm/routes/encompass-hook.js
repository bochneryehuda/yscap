'use strict';
/**
 * LONG-TERM — the Encompass WEBHOOK receiver (#42, owner-directed 2026-08-23):
 * Encompass tells us "this loan changed" (a milestone finished, a new file was
 * started) and the mirror re-reads it on the next sync pass instead of waiting
 * its turn.
 *
 * NUDGE-ONLY, BY DESIGN. The body is written by an Encompass advanced-code
 * rule — an outside system — so NOTHING in it is ever applied to a loan. The
 * only thing read out of it is WHICH loan it is about (a GUID or a YSCAP loan
 * number, found by pattern anywhere in the payload so the exact body shape the
 * tenant's rule sends never matters), and the answer to a nudge is always the
 * same: clear that loan's sync stamp so the next pass re-reads it from
 * Encompass over the authenticated read-only connection. Encompass stays the
 * source of truth AND the only source of values.
 *
 * AUTHENTICATION: the shared-secret header the tenant's existing advanced-code
 * rule already knows how to send (X-Encompass-Secret). The value lives ONLY in
 * the environment (LT_ENCOMPASS_WEBHOOK_SECRET — never in code); with no
 * secret configured the endpoint refuses everything (fails closed). Constant-
 * time compare, so the secret cannot be guessed byte by byte.
 *
 * A NUDGE FOR A LOAN WE DO NOT KNOW YET is the new-file case: nothing is
 * created here (discovery owns creation, with its trash/duplicate guards) —
 * the endpoint answers honestly that the next discovery pass will pick it up.
 *
 * Mounted PUBLIC (no session) in src/server.js — the one permitted seam.
 * Setup instructions for the Encompass admin: docs/longterm/ENCOMPASS-WEBHOOK-SETUP.md
 */

const crypto = require('crypto');
const express = require('express');
const db = require('../db');

const router = express.Router();

const secret = () => String(process.env.LT_ENCOMPASS_WEBHOOK_SECRET || '').trim();

function secretOk(req) {
  const want = secret();
  if (!want) return false;
  const got = String(req.headers['x-encompass-secret'] || '').trim();
  if (!got) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Find the loan identity ANYWHERE in the payload — the tenant's rule decides
 * the body shape, not us. A GUID beats a loan number (it is the identity). */
function identityFrom(req) {
  const hay = [
    JSON.stringify(req.body || {}),
    String(req.query.loanGuid || ''),
    String(req.query.loanNumber || ''),
  ].join(' ');
  const guid = hay.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const num = hay.match(/\bYSCAP\d{6,}\b/i);
  return { guid: guid ? guid[0].toLowerCase() : null, loanNumber: num ? num[0].toUpperCase() : null };
}

router.post('/', async (req, res) => {
  if (!secret()) {
    return res.status(503).json({ ok: false, error: 'The webhook is not configured — set LT_ENCOMPASS_WEBHOOK_SECRET.' });
  }
  if (!secretOk(req)) {
    return res.status(403).json({ ok: false, error: 'wrong or missing X-Encompass-Secret' });
  }
  const id = identityFrom(req);
  if (!id.guid && !id.loanNumber) {
    // A RING WITH NO NAME ON IT. The tenant's advanced-code rule can POST but
    // cannot always name the loan (see sync/nudge-sweep.js for what is proven
    // and what is not), so rather than answer "I could not tell" and do nothing,
    // PILOT asks ENCOMPASS which loans just moved and nudges those.
    //
    // STILL NUDGE-ONLY: nothing in the body is read, believed or applied — the
    // sweep's single write clears `encompass_synced_at`, which makes the
    // ordinary sync re-read those loans over the authenticated read-only
    // connection. It FAILS CLOSED: an unreadable answer nudges nothing.
    //
    // Switchable off without a deploy; a ring is then answered exactly as before.
    if (String(process.env.LT_ENCOMPASS_HOOK_SWEEP_DISABLED || '').trim() === '1') {
      return res.status(200).json({ ok: true, nudged: false, note: 'no loan GUID or YSCAP loan number found in the payload' });
    }
    let sweep = null;
    try {
      const { sweepRecentlyChanged } = require('../sync/nudge-sweep');
      let client = null;
      try { client = require('../encompass/client'); } catch (_) { client = null; }
      sweep = await sweepRecentlyChanged({ client, db });
    } catch (e) {
      sweep = { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
    }
    if (sweep && sweep.ok) {
      console.log(`[lt-encompass-hook] unnamed ping — asked Encompass what moved: checked ${sweep.checked}, nudged ${sweep.nudged.length}, unchanged ${sweep.unchanged}${sweep.capped ? ' (capped — the rest come round on the rota)' : ''}`);
      return res.status(200).json({
        ok: true,
        nudged: sweep.nudged.length > 0,
        via: 'recently-changed sweep',
        checked: sweep.checked,
        count: sweep.nudged.length,
        capped: !!sweep.capped,
        note: 'the payload named no loan, so PILOT asked Encompass which loans changed',
      });
    }
    console.warn('[lt-encompass-hook] unnamed ping — could not ask Encompass what moved:', sweep && sweep.reason);
    return res.status(200).json({
      ok: true, nudged: false,
      note: 'no loan GUID or YSCAP loan number found in the payload, and Encompass could not be asked what changed',
      reason: (sweep && sweep.reason) || null,
    });
  }
  try {
    // Clearing encompass_synced_at is the whole nudge: the sync's own drain
    // (`needsRead`) re-reads the loan on its next pass — ladder, fields,
    // contacts and all — and the ClickUp push drain follows the fresh read.
    const { rows } = await db.query(
      `UPDATE lt_loans
          SET encompass_synced_at = NULL, updated_at = now()
        WHERE (LOWER(encompass_loan_guid) = LOWER($1) AND $1 IS NOT NULL)
           OR (UPPER(loan_number) = UPPER($2) AND $2 IS NOT NULL)
        RETURNING id, loan_number`,
      [id.guid, id.loanNumber]);
    if (rows.length) {
      console.log(`[lt-encompass-hook] nudged ${rows.length} loan(s) (${rows.map((r) => r.loan_number).join(', ')}) — re-read on the next sync pass`);
      return res.json({ ok: true, nudged: true, loans: rows.length });
    }
    // The NEW-FILE case: not mirrored yet — discovery picks it up on its own
    // pass (it owns creation, with the trash/duplicate guards).
    console.log(`[lt-encompass-hook] nudge for a loan not mirrored yet (${id.guid || id.loanNumber}) — the next discovery pass will pick it up`);
    return res.json({ ok: true, nudged: false, note: 'not mirrored yet — the next discovery pass will pick it up' });
  } catch (e) {
    console.warn('[lt-encompass-hook] nudge failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'could not record the nudge' });
  }
});

module.exports = router;
module.exports._internals = { identityFrom, secretOk };
