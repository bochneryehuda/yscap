'use strict';

// HTTP for the long-term pipeline — an officer's own long-term book, the closer's
// and funder's whole book, the admin's everything. Mounted at /api/lt/pipeline by
// src/longterm/index.js; staff authentication is applied at the mount seam in
// src/server.js, so this router imports no RTL auth code.
//
// Every row a viewer may not see is excluded by the SCOPE inside the query
// (access.pipelineScopeSql), not by anything here — so the list, the count and the
// single-file check can never disagree about who may see what.

const express = require('express');
const router = express.Router();

const pipeline = require('../pipeline');
const access = require('../access');
const contacts = require('../people/contacts');
const settingsStore = require('../settings/store');
const db = require('../db');

// GET /api/lt/pipeline — the viewer's long-term book.
router.get('/', async (req, res) => {
  try {
    const out = await pipeline.loadPipeline(req.actor, {
      stage: req.query.stage,
      folder: req.query.folder,
      search: req.query.search,
      officerStaffId: req.query.officer,
      unassigned: String(req.query.unassigned || '') === 'true',
      sort: req.query.sort,
      dir: req.query.dir,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(out);
  } catch (e) {
    console.error('[lt] pipeline failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load the long-term pipeline.' });
  }
});

// GET /api/lt/pipeline/:loanId — one file's header and its team.
//
// The access check is `mayOpenLoan` against this loan's OWN contacts — the same
// rule the list applies, expressed for a single file, so a direct link can never
// reach further than the list does.
router.get('/:loanId', async (req, res) => {
  try {
    const { settings } = await settingsStore.load();
    const viewer = access.accessFor(req.actor, settings);

    const { rows } = await db.query(
      `SELECT l.*, b.full_name AS borrower_name
         FROM lt_loans l
         LEFT JOIN borrowers b ON b.id = l.borrower_id
        WHERE l.id = $1::uuid`,
      [String(req.params.loanId)],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such long-term loan.' });

    const { rows: team } = await db.query(
      'SELECT * FROM lt_loan_contacts WHERE loan_id = $1::uuid', [rows[0].id],
    );
    if (!access.mayOpenLoan(viewer, req.actor && req.actor.id, team)) {
      // Deliberately the same answer as a missing loan: telling somebody a file
      // exists but is not theirs is itself a disclosure about the book.
      return res.status(404).json({ error: 'No such long-term loan.' });
    }

    const staffIds = [...new Set(team.flatMap((t) => [t.staff_id, t.override_staff_id]).filter(Boolean).map(String))];
    const names = new Map();
    if (staffIds.length) {
      const { rows: people } = await db.query(
        'SELECT id, full_name FROM staff_users WHERE id = ANY($1::uuid[])', [staffIds],
      );
      for (const p of people) names.set(String(p.id), p.full_name);
    }

    const labels = settings['contacts.roleLabels'] || {};
    res.json({
      loan: rows[0],
      contacts: team.map((t) => contacts.describeContact(t, {
        staffName: t.staff_id ? names.get(String(t.staff_id)) : null,
        overrideName: t.override_staff_id ? names.get(String(t.override_staff_id)) : null,
        labels,
      })),
    });
  } catch (e) {
    console.error('[lt] loan header failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load the loan.' });
  }
});

module.exports = router;
