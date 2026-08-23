'use strict';
/**
 * THE LONG-TERM BOOK, FOR RECONCILIATION — secret-gated, read-only, match keys only.
 *
 * WHY IT EXISTS. Long-Term is about to become Encompass-first: an office opens the
 * file in Encompass and PILOT opens its ClickUp card. Before that can be switched on,
 * every loan already in the book has to be told which card is already its own, or the
 * first pass opens a second card for every deal the office has ever worked (the
 * owner, 2026-08-23: *"we're going to find ourselves with duplicate ClickUps"*). That
 * one-time match is made off PILOT, by hand and with judgement, against the two
 * sides' loan numbers, addresses and amounts — which means the two sides have to be
 * readable from outside a browser session, once.
 *
 * IT IS THE SIBLING OF `lenderprice-diag.js`, deliberately, and copies its shape
 * rather than inventing one: mounted before the staff-gated `/api/lt` mount, 404 on
 * every path unless a token this deployment's owner set is present, constant-time
 * compare, and no write path anywhere inside it.
 *
 * WHAT IT WILL NOT ANSWER WITH. Match keys only — loan number, Encompass id, the
 * borrower's NAME, the program, the amount, where the file has got to, the officer's
 * folder and the property address. Deliberately NOT: the borrower's email, phone or
 * Social, the rate, the DSCR, the fees, any document, anything about a condition.
 * None of that helps decide which ClickUp card a loan belongs to, and a diagnostic
 * that hands out more than its job needs is a diagnostic somebody will regret.
 *
 * IT IS OFF UNLESS SOMEBODY TURNS IT ON, AND IT IS REVOCABLE IN ONE MOVE. With
 * `LT_BOOK_DIAG_TOKEN` unset the router does not exist as far as a caller is
 * concerned — every path 404s, which is the honest answer for a feature that is not
 * switched on and gives a prober nothing to work with. Removing the variable turns it
 * off again with no deploy and no code change.
 *
 * PRODUCT SEPARATION: `lt_*` tables and `staff_users` (the shared identity zone,
 * read-only) only. No RTL table is read, and there is no write path of any kind.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

// The gate. Off unless the token is set; then a matching header, compared in
// constant time so a wrong guess tells the caller nothing about how wrong it was.
router.use((req, res, next) => {
  const token = process.env.LT_BOOK_DIAG_TOKEN || '';
  if (!token) return res.status(404).json({ error: 'not_found' });
  const got = String(req.get('x-lt-diag-token') || '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

/**
 * ONE READ. The join is the loan, its property and its officer's name — the three
 * places a match key can live — and nothing else.
 */
const BOOK_SQL = `
  SELECT l.loan_number,
         l.encompass_loan_guid,
         l.borrower_name,
         l.program_name,
         l.product_kind::text        AS product_kind,
         l.loan_purpose::text        AS loan_purpose,
         l.loan_amount,
         l.milestone_name,
         l.stage_key,
         l.loan_folder,
         s.full_name                 AS officer_name,
         p.street, p.city, p.state, p.zip, p.county,
         l.clickup_task_id,
         l.clickup_custom_id,
         l.clickup_link_confidence,
         l.encompass_synced_at
    FROM lt_loans l
    LEFT JOIN lt_properties p ON p.loan_id  = l.id
    LEFT JOIN staff_users   s ON s.id       = l.loan_officer_id
   ORDER BY l.loan_number NULLS LAST, l.created_at
`;

router.get('/', async (_req, res) => {
  try {
    const { rows } = await db.query(BOOK_SQL);
    const linked = rows.filter((r) => r.clickup_task_id).length;
    res.json({
      ok: true,
      count: rows.length,
      linkedToClickup: linked,
      unlinked: rows.length - linked,
      loans: rows,
    });
  } catch (e) {
    // Say what failed. A diagnostic that answers "server error" is not one.
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

/** The one-line answer, for checking the door works before pulling the whole book. */
router.get('/count', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS loans,
              count(*) FILTER (WHERE loan_number IS NOT NULL)::int AS with_loan_number,
              count(*) FILTER (WHERE clickup_task_id IS NOT NULL)::int AS linked,
              max(encompass_synced_at) AS last_encompass_read
         FROM lt_loans`);
    res.json({ ok: true, ...rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

module.exports = router;
