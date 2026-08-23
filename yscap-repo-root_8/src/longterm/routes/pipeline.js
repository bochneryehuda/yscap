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
const workspace = require('../workspace');
const locks = require('../locks');
const milestones = require('../milestones');
const purchased = require('../milestone-purchased');
const product = require('../product');
const pipelineColumns = require('../pipeline-columns');
const roster = require('../people/roster');
const ltFile = require('../file');
const stages = require('../stages');
const settingsStore = require('../settings/store');
const conditionRead = require('../conditions/read');
const dscrVerdict = require('../dscr-verdict');
const db = require('../db');

// GET /api/lt/pipeline — the viewer's long-term book.
router.get('/', async (req, res) => {
  try {
    // Which columns to draw comes from `pipeline.columns` (db/553) — a setting that
    // has existed since the pipeline shipped and that nothing read, so a buyer could
    // change it and nothing happened. The SCREEN renders what this resolves; the
    // QUERY is unchanged by it, deliberately (see pipeline-columns.js).
    const { settings } = await settingsStore.load().catch(() => ({ settings: {} }));
    const cols = pipelineColumns.resolveColumns(settings['pipeline.columns'], {
      conditionsEnabled: settings['conditions.enabled'] === true,
    });

    const out = await pipeline.loadPipeline(req.actor, {
      stage: req.query.stage,
      folder: req.query.folder,
      search: req.query.search,
      officerStaffId: req.query.officer,
      unassigned: String(req.query.unassigned || '') === 'true',
      // "Mine" is asked for as a flag and resolved from the SESSION, never from an
      // id in the query string — a viewer who sees the whole book could otherwise
      // ask for somebody else's personal queue by typing their id into the URL. The
      // `officer` filter is the deliberate, named way to look at another officer's
      // files, and it exists for exactly that.
      mine: String(req.query.mine || '') === 'true',
      // The screen asks for the whole (filtered) book in one answer so its
      // per-column search can be honest; the cap in pipeline.js still bounds it.
      limit: req.query.limit,
      offset: req.query.offset,
      // Which book — active (the default), closed, withdrawn, or all. The tenant's own list of
      // finished folders decides what those mean; with none configured all three are
      // the same book and the screen draws no control for it.
      book: req.query.book,
      sort: req.query.sort,
      dir: req.query.dir,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    // The outstanding count, and ONLY when the column is actually being drawn —
    // two more queries on every pipeline load for a column nobody is looking at is
    // a cost with no reader. It is attached per row rather than joined into the
    // pipeline query on purpose: the counts follow the Condition Center's OWN
    // rules for what "outstanding" means, and a SQL predicate here would be a
    // second copy of them (see conditions/read.js).
    if (cols.columns.some((c) => c.key === 'conditions')) {
      try {
        const counts = await conditionRead.outstandingForLoans((out.loans || []).map((r) => r.id), { settings });
        for (const row of out.loans || []) row.outstanding = counts.get(row.id) || null;
      } catch (e) {
        // A column that cannot be counted leaves its cells saying so; it never
        // costs the pipeline the loans themselves.
        console.error('[lt] pipeline condition counts failed:', (e && e.message) || e);
      }
    }

    // WHICH SIDE OF THIS COMPANY'S OWN DSCR LINES EACH LOAN FELL ON, on the same
    // terms as the count above: attached ONLY when the column is drawn, because a
    // field nothing renders is the exact shape this side keeps finding and fixing.
    //
    // Computed HERE rather than in the browser: `dscr-verdict.js` is the one rule,
    // the file screen already reads it, and a copy in the screen is how two
    // surfaces come to call the same loan different things. It is pure arithmetic
    // on settings this route has already loaded — no query, no failure mode — so a
    // loan with no ratio simply gets no verdict, which is the honest answer and
    // NOT the same as "below".
    if (cols.columns.some((c) => c.key === 'dscr')) {
      for (const row of out.loans || []) {
        // The SAME conversion the file screen's `num` makes, empty string included:
        // `dscr_ratio` is a numeric column, so the driver hands back a STRING, and
        // `Number('')` is a perfectly finite 0 — which would put a red "below" on a
        // loan whose ratio is blank. The two surfaces must read one column one way
        // or they will disagree about a loan in front of the same person.
        const raw = row.dscr_ratio;
        const r = (raw === null || raw === undefined || raw === '') ? null : Number(raw);
        row.dscrVerdict = dscrVerdict.dscrVerdict(Number.isFinite(r) ? r : null, settings);
      }
    }

    res.json({ ...out, ...cols });
  } catch (e) {
    console.error('[lt] pipeline failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load the long-term pipeline.' });
  }
});

/**
 * The file's team, in reading order: OUR roles first, then Encompass's in the order
 * the settings name them, then anything neither list carries.
 *
 * The last bucket is the one that matters. A role that is on the file and on neither
 * list still has to appear — a buyer who renames a role in Encompass must not watch a
 * contact vanish off the file screen while the sync happily keeps mirroring it.
 */
function orderTeam(team, settings) {
  const ours = contacts.pilotRoles(settings);
  const theirs = Array.isArray(settings['contacts.roles']) && settings['contacts.roles'].length
    ? settings['contacts.roles'].map(String)
    : contacts.DEFAULT_ROLES;
  const order = [...ours, ...theirs];
  const rank = (r) => {
    const i = order.indexOf(String(r));
    return i < 0 ? order.length : i;
  };
  return (team || []).slice().sort((a, b) => rank(a.role) - rank(b.role)
    || String(a.role || '').localeCompare(String(b.role || '')));
}

// GET /api/lt/pipeline/:loanId — one file's header and its team.
//
// The access check is `mayOpenLoan` against this loan's OWN contacts — the same
// rule the list applies, expressed for a single file, so a direct link can never
// reach further than the list does.
router.get('/:loanId', async (req, res) => {
  try {
    const { settings } = await settingsStore.load();
    const viewer = access.accessFor(req.actor, settings);

    // The lock joins here because the workspace's rail and its "Rate lock" section
    // both read `lock_status` / `lock_expiration_date` off the loan row. Without the
    // join those read as empty on every loan — a section permanently greyed with a
    // reason that is not true, which is worse than no section at all.
    const { rows } = await db.query(
      `SELECT l.*, b.full_name AS borrower_name,
              k.lock_status, k.expiration_date AS lock_expiration_date
         FROM lt_loans l
         LEFT JOIN borrowers b ON b.id = l.borrower_id
         LEFT JOIN lt_locks k ON k.loan_id = l.id
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

    // `override_by` rides along in the SAME lookup: naming who reassigned a file is
    // one more id in a query that was already being made, not a second round trip.
    const staffIds = [...new Set(team.flatMap((t) => [t.staff_id, t.override_staff_id, t.override_by]).filter(Boolean).map(String))];
    const names = new Map();
    if (staffIds.length) {
      const { rows: people } = await db.query(
        'SELECT id, full_name FROM staff_users WHERE id = ANY($1::uuid[])', [staffIds],
      );
      for (const p of people) names.set(String(p.id), p.full_name);
    }

    // The workspace's three regions, built from what we already read — the section
    // menu, the stepper, and the rail. The rail is assembled ONCE here so the screen
    // can mount it and not re-render it while somebody moves between sections.
    // db/547's columns are `milestone_name` and `sequence` — NOT name/sort_order.
    // Aliased to what the workspace expects rather than renamed there, so the
    // stepper stays a pure function of a plain shape. `is_archived` milestones are
    // excluded: a retired step must not sit in the middle of a live file's progress.
    // `expected_days` rides along so the workspace can say whether the loan has been
    // sitting where it is for longer than the TENANT's own expectation — the plan's
    // "a stalled file reads as stalled without a word of text".
    const { rows: encompassCatalog } = await db.query(
      `SELECT milestone_name AS name, sequence AS sort_order, expected_days
         FROM lt_encompass_milestones
        WHERE COALESCE(is_archived, false) = false
        ORDER BY sequence`,
    ).catch(() => ({ rows: [] }));

    // OUR OWN STEP, spliced in. Encompass has nineteen milestones and none of them
    // is "the investor bought this loan" (owner-directed 2026-08-23), so the
    // PURCHASED step is declared in settings and added to the ladder here rather
    // than stored in the tenant's catalog — where the catalog sync, which archives
    // anything Encompass stops listing, would retire it on its very first pass.
    //
    // A catalog we could not read stays EMPTY rather than becoming a one-step
    // ladder: a stepper showing "Purchased" alone would read as a loan that has
    // skipped its whole workflow, which is worse than the honest blank the file
    // already draws when the catalog is unreadable.
    const saleCfg = purchased.configFrom(settings);
    const catalog = encompassCatalog.length
      ? purchased.insertInto(encompassCatalog, saleCfg)
      : encompassCatalog;
    const sale = purchased.describePurchase(rows[0], saleCfg);

    // When PILOT watched this loan reach each milestone. Best-effort and EMPTY when
    // unreadable, which draws the stepper with no dates rather than with wrong ones.
    const reachedAt = await milestones.reachedAtByMilestone(rows[0].id).catch(() => ({}));
    // The movement history itself — what PILOT watched, in order. Best-effort.
    const milestoneHistory = await milestones.loadHistory(rows[0].id, 25).catch(() => []);
    const currentMs = catalog.find(
      (m) => String(m.name || '').trim().toLowerCase() === String(rows[0].milestone_name || '').trim().toLowerCase(),
    );

    // The lock's own detail — the posture, the countdown, and what PILOT watched
    // change. Best-effort: a loan still opens when its lock cannot be read.
    const lock = await locks.loadLock(rows[0].id).catch(() => null);

    // The sections themselves — the 1003 as this loan actually reads. Best-effort
    // like the lock: a file whose sections cannot be assembled still opens, with its
    // header, its stepper and its rail intact.
    // The settings ride along so the file can say which side of THIS COMPANY'S
    // own DSCR thresholds a loan fell on, rather than showing a bare ratio.
    const file = await ltFile.loadFile(rows[0].id, rows[0], { settings }).catch(() => null);

    const labels = settings['contacts.roleLabels'] || {};

    // May this viewer reassign a role on this file, and who could they pick? Both
    // are BEST-EFFORT: a file still opens when the roster cannot be read, and the
    // control simply stays off — a screen that fails to load a picker must not fail
    // to show the loan. The gate is re-asked on the write itself, so an over-generous
    // answer here could never become permission.
    let canReassign = false;
    let assignableStaff = [];
    try {
      canReassign = access.mayReassignLoan(req.actor, settings);
      if (canReassign) assignableStaff = await roster.pickableStaff();
    } catch (_) { canReassign = false; assignableStaff = []; }

    res.json({
      // The FILE HEADER's stamp (CLAUDE.md §7), carried on the loan itself so the
      // screen renders what the row says rather than what screen it is.
      ...product.stamp(),
      loan: product.tagRow(rows[0]),
      lock,
      file,
      sections: workspace.sectionMenu(rows[0], {
        conditionsEnabled: settings['conditions.enabled'] === true,
        // The SAME income block the rail renders, so the menu can never grey a
        // section whose figures are sitting on the screen beside it.
        income: file && file.income,
        // STAFF-ONLY, like everything on this route: whether Encompass names an
        // investor decides whether the section is drawn at all.
        investor: file && file.investor,
      }),
      stepper: workspace.milestoneStepper(rows[0], catalog, {
        reachedAt,
        // The purchase is reached from Encompass's own answer, never from where the
        // loan stands — and `undefined` (Encompass has not said) is carried through
        // as its own state rather than flattened into a no.
        pilotReached: { [purchased.PILOT_MILESTONE_ID]: sale.purchased === null ? undefined : sale.purchased },
        pilotReachedAt: { [purchased.PILOT_MILESTONE_ID]: sale.at },
        pilotNotes: { [purchased.PILOT_MILESTONE_ID]: sale.note },
      }),
      // The same fact in one place, so a screen can state it without re-reading the
      // stepper — and so the two can never disagree, because both come from here.
      sale,
      // How long it has been at this milestone — and, when the first sighting is all
      // we have, a plain sentence saying we do not know rather than a number we made up.
      milestoneHistory,
      milestoneClock: milestones.describeClock(rows[0], {
        expectedDays: currentMs ? currentMs.expected_days : null,
      }),
      // The rail's property figures come from the SAME sections the Property tab
      // renders, so the two can never state different values for one loan.
      rail: workspace.summaryRail(rows[0], {
        stageConfig: stages.configFrom(settings),
        property: file && file.property,
        income: file && file.income,
      }),
      // WHO IS ON THIS FILE, in the order the work happens — the person who SET IT UP
      // first, because she is the one who starts it (owner-directed 2026-08-23), then
      // the Encompass team in the order the settings list them. Sorting here rather
      // than in SQL keeps `lt_loan_contacts` a plain map and lets one settings list
      // decide the order everywhere it is read.
      contacts: orderTeam(team, settings).map((t) => contacts.describeContact(t, {
        staffName: t.staff_id ? names.get(String(t.staff_id)) : null,
        overrideName: t.override_staff_id ? names.get(String(t.override_staff_id)) : null,
        overrideByName: t.override_by ? names.get(String(t.override_by)) : null,
        labels,
        pilotRoleList: contacts.pilotRoles(settings),
      })),
      canReassign,
      assignableStaff,
    });
  } catch (e) {
    console.error('[lt] loan header failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load the loan.' });
  }
});

// POST /api/lt/pipeline/:loanId/contacts/:role/override — reassign one role on one
// file to a PILOT person, or clear the reassignment by naming nobody.
//
// ADMIN ONLY, and that is a security boundary rather than a courtesy. The pipeline
// scope matches `override_staff_id`, so writing one GRANTS somebody access to a file
// and clearing one TAKES it away; a scoped officer able to set their own could read
// any file in the book by naming themselves on it.
//
// NOTHING IS WRITTEN TO ENCOMPASS. The override sits beside Encompass's own columns,
// which are left exactly as they are so the file can keep showing both sides and say
// plainly when they disagree.
router.post('/:loanId/contacts/:role/override', async (req, res) => {
  try {
    const { settings } = await settingsStore.load();
    if (!access.mayReassignLoan(req.actor, settings)) {
      return res.status(403).json({
        error: 'Only an administrator can reassign a long-term file.',
      });
    }

    const body = req.body || {};
    const row = await contacts.reassign(
      req.params.loanId,
      req.params.role,
      // An explicitly empty person is a CLEAR, and must not be read as "missing".
      body.staffId || null,
      req.actor && req.actor.id,
      body.reason,
    );

    // Answer with the contact as the screen will now draw it, so the row updates
    // from what the server actually stored rather than from what was typed.
    const ids = [row.staff_id, row.override_staff_id, row.override_by].filter(Boolean).map(String);
    const names = new Map();
    if (ids.length) {
      const { rows: people } = await db.query(
        'SELECT id, full_name FROM staff_users WHERE id = ANY($1::uuid[])', [ids],
      );
      for (const p of people) names.set(String(p.id), p.full_name);
    }
    res.json({
      contact: contacts.describeContact(row, {
        staffName: row.staff_id ? names.get(String(row.staff_id)) : null,
        overrideName: row.override_staff_id ? names.get(String(row.override_staff_id)) : null,
        overrideByName: row.override_by ? names.get(String(row.override_by)) : null,
        labels: settings['contacts.roleLabels'] || {},
        pilotRoleList: contacts.pilotRoles(settings),
      }),
    });
  } catch (e) {
    if (e && e.status && e.plain) return res.status(e.status).json({ error: e.plain });
    console.error('[lt] reassign failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not reassign this file.' });
  }
});

module.exports = router;
