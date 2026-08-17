'use strict';

// HTTP for the long-term BOOK — the owner's census of every long-term file, with
// the folder, the status and the milestone each one sits in. Mounted at
// /api/lt/book by src/longterm/index.js; staff authentication is applied at the
// mount seam in src/server.js, so this router imports no RTL auth code.
//
// The viewer's scope is applied INSIDE the query by the pipeline's own access
// rule, so this list can never show a file the pipeline would hide.

const express = require('express');
const router = express.Router();

const access = require('../access');
const productBook = require('../product-book');
const settingsStore = require('../settings/store');

async function viewerFor(req) {
  const { settings } = await settingsStore.load().catch(() => ({ settings: {} }));
  return {
    access: access.accessFor(req.actor, settings),
    staffId: req.actor && req.actor.id,
  };
}

// GET /api/lt/book — every long-term file the viewer may see, plus the three
// buckets that account for everything this rule could not place.
router.get('/', async (req, res) => {
  try {
    const viewer = await viewerFor(req);
    const book = await productBook.longTermBook(viewer, { cap: req.query.cap });
    res.json({
      ...book,
      byFolder: productBook.groupBook(book.longTerm),
    });
  } catch (e) {
    console.error('[lt-book] failed:', e && e.message ? e.message : e);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/lt/book/export.csv — the same census as a spreadsheet.
//
// The columns are the owner's four, in the order they asked for them, then the
// two facts the mapping work is measured by. A CSV so it opens in Excel without
// anybody having to read a screen, since "give me a breakdown" is a thing people
// want to sort and hand around.
router.get('/export.csv', async (req, res) => {
  try {
    const viewer = await viewerFor(req);
    const book = await productBook.longTermBook(viewer, { cap: req.query.cap });

    // Every field is quoted and its own quotes doubled — a borrower name with a
    // comma in it must not become two columns, and a name starting with `=` must
    // not be read by Excel as a formula (the leading apostrophe is the standard
    // guard and is invisible in the cell).
    const cell = (v) => {
      const s = v == null ? '' : String(v);
      const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const head = ['File', 'Borrower', 'Folder', 'Status', 'Milestone',
      'Term (months)', 'Loan program', 'Loan amount',
      'Borrower profile linked', 'Loan officer linked', 'Loan officer'];
    const lines = [head.map(cell).join(',')];
    for (const r of book.longTerm) {
      lines.push([
        r.file, r.borrowerName, r.folder, r.status, r.milestone,
        r.termMonths, r.programName, r.loanAmount,
        r.borrowerLinked ? 'yes' : 'no', r.officerLinked ? 'yes' : 'no', r.officerName,
      ].map(cell).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="long-term-book.csv"');
    // A BOM so Excel reads it as UTF-8 rather than mangling an accented name.
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  } catch (e) {
    console.error('[lt-book] export failed:', e && e.message ? e.message : e);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
