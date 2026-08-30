'use strict';
/**
 * LONG-TERM — THE REPORTING CENTRE (HTTP).
 *
 * Mounted at /api/lt/reports; staff authentication is applied at the seam in
 * src/server.js, so this router imports no RTL code.
 *
 * WHAT THE OWNER ASKED FOR (2026-08-30, in their own words):
 *
 *   "every status doesn't need to be displayed but it needs to have in the system
 *    not only a time stamp of the date, but also needs to have a time stamp of the
 *    actual time when the file is assigned to processor. When the file was changed
 *    to submitted and every other status like that."
 *
 *   "a full reporting center where I can see for every file how long it took
 *    between which and which step and who the processor was in that file, and then
 *    reporting per processor."
 *
 *   "one thing we need to track with the processor is from the submittal status is
 *    done until the CTC is done. That's the processor's job, and the loan setup guy,
 *    we need to track from the assign processor, which means LO setup done, LO prep
 *    completed, till the submittal is done. Set up a full reporting database on this
 *    so I can start scoring how many files each processor has and her efficiency."
 *
 * FOUR THINGS HERE ARE DELIBERATE, and none of them may be simplified away:
 *
 *   1. NOTHING THE CALLER TYPES REACHES THE STATEMENT. A saved report names catalog
 *      KEYS (`loan_number`, `span_processing_days`), never SQL. `query.compile` is
 *      the whole security boundary: it refuses a key the catalog does not carry and
 *      binds every value. This router's only job on the way in is to hand it the
 *      request and, on the way out, to turn a refusal into a sentence.
 *
 *   2. THE VIEWER'S OWN BOOK IS APPENDED, NEVER SUBSTITUTED. The scope clause is
 *      built from `access.pipelineScopeSql` — the SAME rule the pipeline applies —
 *      and ANDed into the report's WHERE, so a saved report an administrator wrote
 *      shows a scoped officer exactly their own files and can never widen anybody.
 *
 *   3. THE SCORECARD NEEDS THE WHOLE BOOK, so it is refused to a scoped viewer.
 *      It groups every file by the person who held the step; answering it from a
 *      partial book would print a processor's average over the slice of their work
 *      the reader happens to be on, under that processor's name. A wrong number
 *      with somebody's name on it is worse than no number.
 *
 *   4. THE AUDIENCE IS `internal`, and this is the one place it is stated. Every
 *      route here is behind the staff mount, so the reader is internal staff and
 *      the investor columns are theirs to see (CLAUDE.md rule 10 keeps them off
 *      every client surface, and `fields.fieldsFor` fails closed for anything that
 *      is not exactly 'internal'). A client-facing report would pass 'client' here
 *      and lose those columns; there is no such surface today.
 */

const express = require('express');

const router = express.Router();

const db = require('../db');
const access = require('../access');
const settingsStore = require('../settings/store');
const fields = require('../reporting/fields');
const query = require('../reporting/query');
const spans = require('../reporting/spans');
const scorecard = require('../reporting/scorecard');
const { loadScopedLoan } = require('./scoped-loan');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const staffId = (req) => (req.actor && req.actor.id ? String(req.actor.id) : null);

/**
 * The milestone-name overrides a buyer has configured, if any.
 *
 * The ladder's steps are the TENANT'S wording, so the span definitions read them
 * from settings rather than from a constant here. An unreadable setting falls back
 * to the shipped defaults — a reporting centre that refuses to draw because a
 * settings row could not be read is worse than one drawn on the defaults, and the
 * defaults are what the ladder sync itself uses.
 */
function milestoneOverridesFrom(settings) {
  const r = settings && settings.reporting;
  return r && typeof r === 'object' && r.milestones && typeof r.milestones === 'object'
    ? r.milestones
    : undefined;
}

/**
 * The viewer's own book, expressed the way the report compiler binds it.
 *
 * `access.pipelineScopeSql` writes ordinary `$n` placeholders because the pipeline
 * owns its own parameter arithmetic. The report compiler does not know how many
 * parameters the filters ahead of it will have spent, so it binds the scope itself
 * through a `$SCOPEn` marker. Re-keying here — rather than teaching the access
 * module a second placeholder dialect — keeps ONE definition of who sees what.
 *
 * Returns null when the viewer sees everything, which is what the compiler wants:
 * no clause at all, and therefore no parameter left unreferenced.
 */
function scopeClause(viewer, id) {
  const s = access.pipelineScopeSql(viewer, id, 1);
  if (!s.where) return null;
  return {
    sql: s.where.replace(/\$(\d+)/g, (_m, i) => `$SCOPE${i}`),
    params: s.params,
  };
}

/** The refusal a compiler error becomes: the reader's own words, never a stack. */
function reportProblem(res, e, tag) {
  if (e instanceof query.ReportError) {
    return res.status(400).json({ error: e.message });
  }
  console.error(`[lt] ${tag} failed:`, (e && e.message) || e);
  return res.status(500).json({ error: 'Could not run that report just now. Try again in a moment.' });
}

// ---------------------------------------------------------------------------
// GET /api/lt/reports/fields - the catalog this reader may build a report from.
//
// The screen draws its column picker, its filter operators and its sort options
// from THIS, so the browser never keeps a second copy of the field list. That is
// what stops a screen offering a column the compiler would then refuse.
// ---------------------------------------------------------------------------
router.get('/fields', async (req, res) => {
  try {
    const { settings } = await settingsStore.load();
    const overrides = milestoneOverridesFrom(settings);
    const list = fields.fieldsFor('internal', overrides);
    res.json({
      fields: list.map((f) => ({
        key: f.key,
        label: f.label,
        group: f.group,
        type: f.type,
        operators: query.OPERATORS_BY_TYPE[f.type] || [],
        options: f.options || null,
      })),
      groups: fields.GROUP_ORDER,
      operatorLabels: query.OPERATOR_LABEL,
      noValueOperators: query.NO_VALUE_OPS,
      rangeOperators: query.RANGE_OPS,
      listOperators: query.LIST_OPS,
      spans: spans.allSpans(overrides).map((s) => ({
        key: s.key,
        label: s.label,
        from: s.from,
        to: s.to,
        owner: s.ownerLabel || null,
      })),
      milestones: spans.milestoneNames(overrides),
      defaultRows: fields.DEFAULT_ROWS,
      maxRows: fields.MAX_ROWS,
    });
  } catch (e) {
    console.error('[lt] report fields failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load the report builder just now.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/lt/reports/run - compile a report definition and run it.
//
// THE CAP IS MEASURED, NEVER SILENT. The compiler asks for one row more than the
// limit; if that extra row comes back the answer is capped and says so, with the
// TOTAL the filters actually match (`count(*) OVER ()`) beside it. A report that
// quietly stops at 500 rows reads as "that is all there is", which is the confident
// wrong answer this whole module exists to avoid.
// ---------------------------------------------------------------------------
router.post('/run', async (req, res) => {
  let compiled;
  try {
    const { settings } = await settingsStore.load();
    const viewer = access.accessFor(req.actor, settings);
    compiled = query.compile(req.body && req.body.report ? req.body.report : req.body, {
      audience: 'internal',
      milestones: milestoneOverridesFrom(settings),
      scope: scopeClause(viewer, staffId(req)),
    });
  } catch (e) {
    return reportProblem(res, e, 'report compile');
  }

  try {
    const { rows } = await db.query(compiled.text, compiled.params);
    const capped = rows.length > compiled.limit;
    const page = capped ? rows.slice(0, compiled.limit) : rows;
    const total = rows.length ? Number(rows[0].total_rows) : 0;

    res.json({
      columns: compiled.columns.map((c) => ({
        key: c.key, label: c.label, type: c.type, group: c.group,
      })),
      rows: page.map((r) => {
        const cells = {};
        compiled.columns.forEach((c, i) => { cells[c.key] = r[`c${i}`]; });
        return { loanId: r.loan_id, cells };
      }),
      sort: compiled.sort,
      dir: compiled.dir,
      limit: compiled.limit,
      shown: page.length,
      // Measured, not inferred: `total` is what the filters match, `capped` says
      // whether this page is all of it.
      total: Number.isFinite(total) ? total : page.length,
      capped,
    });
  } catch (e) {
    return reportProblem(res, e, 'report run');
  }
});

// ---------------------------------------------------------------------------
// POST /api/lt/reports/describe - the report in plain words, without running it.
//
// A saved report is a set of keys and operators; a person about to run one over
// the whole book should be able to read what it will do first.
// ---------------------------------------------------------------------------
router.post('/describe', async (req, res) => {
  try {
    const { settings } = await settingsStore.load();
    const overrides = milestoneOverridesFrom(settings);
    const byKey = Object.create(null);
    for (const f of fields.fieldsFor('internal', overrides)) byKey[f.key] = f;
    const def = req.body && req.body.report ? req.body.report : req.body;
    res.json({ describe: query.describeFilter(def && def.filter, byKey) });
  } catch (e) {
    return reportProblem(res, e, 'report describe');
  }
});

// ---------------------------------------------------------------------------
// SAVED REPORTS - /api/lt/reports/saved
//
// A PRIVATE report is the person's own arrangement of their own screen and is
// anybody's to make. A SHARED one appears on every colleague's list, which is a
// small piece of authority, so it follows the same rule as a shared pipeline view:
// an administrator saves it. `canShare` failing to be READ is not permission to
// pass it - the gate fails closed.
// ---------------------------------------------------------------------------
async function canShare(req) {
  try {
    const { settings } = await settingsStore.load();
    return access.mayManagePeople(req.actor, settings);
  } catch (_) {
    return false;
  }
}

function cleanName(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 120) : null;
}

router.get('/saved', async (req, res) => {
  try {
    const id = staffId(req);
    const { rows } = await db.query(
      `SELECT r.id, r.name, r.description, r.visibility, r.owner_staff_id,
              r.definition, r.created_at, r.updated_at,
              s.full_name AS owner_name
         FROM lt_report_definitions r
         LEFT JOIN staff_users s ON s.id::text = r.owner_staff_id
        WHERE r.visibility = 'shared' OR r.owner_staff_id = $1
        ORDER BY r.updated_at DESC
        LIMIT 200`,
      [id],
    );
    res.json({
      reports: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        visibility: r.visibility,
        definition: r.definition || {},
        ownerName: r.owner_name || null,
        mine: !!(id && r.owner_staff_id === id),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      canShare: await canShare(req),
    });
  } catch (e) {
    console.error('[lt] list saved reports failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load your saved reports.' });
  }
});

router.post('/saved', async (req, res) => {
  try {
    const body = req.body || {};
    const name = cleanName(body.name);
    if (!name) return res.status(400).json({ error: 'Give the report a name.' });

    const shared = body.visibility === 'shared';
    const mayShare = await canShare(req);
    if (shared && !mayShare) {
      return res.status(403).json({
        error: 'Only an administrator can save a report for everybody. Save it for yourself instead.',
      });
    }

    // COMPILE IT BEFORE STORING IT. A report that cannot be compiled is a report
    // whose owner finds out it is broken the day they run it, in front of whoever
    // they were showing it to. The compile also proves every key it names exists,
    // so a stored definition can never smuggle anything past the catalog.
    const { settings } = await settingsStore.load();
    const def = body.definition && typeof body.definition === 'object' ? body.definition : {};
    try {
      query.compile(def, { audience: 'internal', milestones: milestoneOverridesFrom(settings) });
    } catch (e) {
      if (e instanceof query.ReportError) return res.status(400).json({ error: e.message });
      throw e;
    }

    const id = String(body.id || '');
    if (id) {
      if (!UUID_RE.test(id)) return res.status(404).json({ error: 'No such report.' });
      // Only the owner may rewrite their own report; an administrator may rewrite
      // a shared one, because a shared report belongs to the team.
      const { rows } = await db.query(
        `UPDATE lt_report_definitions
            SET name = $2, description = $3, visibility = $4, definition = $5::jsonb,
                updated_at = now()
          WHERE id = $1::uuid
            AND (owner_staff_id = $6 OR ($7 = true AND visibility = 'shared'))
        RETURNING id`,
        [id, name, cleanName(body.description), shared ? 'shared' : 'private',
          JSON.stringify(def), staffId(req), mayShare],
      );
      if (!rows.length) return res.status(404).json({ error: 'No such report.' });
      return res.json({ ok: true, id: rows[0].id });
    }

    const { rows } = await db.query(
      `INSERT INTO lt_report_definitions (name, description, visibility, owner_staff_id, definition)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [name, cleanName(body.description), shared ? 'shared' : 'private', staffId(req), JSON.stringify(def)],
    );
    return res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('[lt] save report failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not save that report just now.' });
  }
});

router.delete('/saved/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'No such report.' });
    const { rows } = await db.query(
      `DELETE FROM lt_report_definitions
        WHERE id = $1::uuid
          AND (owner_staff_id = $2 OR ($3 = true AND visibility = 'shared'))
      RETURNING id`,
      [id, staffId(req), await canShare(req)],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such report.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[lt] delete report failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not delete that report just now.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/lt/reports/scorecard - the owner's "reporting per processor".
//
// Refused to a scoped viewer, for the reason in the header: this groups the whole
// book by the person who held each step, and a partial book would print somebody's
// average over a slice of their work under their own name.
// ---------------------------------------------------------------------------
router.get('/scorecard', async (req, res) => {
  try {
    const { settings } = await settingsStore.load();
    const viewer = access.accessFor(req.actor, settings);
    if (!viewer.seesAll) {
      return res.status(403).json({
        error: 'The scorecard measures the whole long-term book, so it is only shown to somebody who can see all of it.',
      });
    }
    const out = await scorecard.scorecard(db, {
      milestones: milestoneOverridesFrom(settings),
      from: req.query.from ? String(req.query.from) : null,
      to: req.query.to ? String(req.query.to) : null,
      spanKey: req.query.span ? String(req.query.span) : null,
    });
    return res.json(out);
  } catch (e) {
    console.error('[lt] scorecard failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not build the scorecard just now.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/lt/reports/loans/:loanId/timeline - one file's own story.
//
// The owner's "for every file how long it took between which and which step and
// who the processor was in that file". Scoped through the SAME loader every other
// per-file route uses, so a timeline can never reach further than the file screen.
// ---------------------------------------------------------------------------
router.get('/loans/:loanId/timeline', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt');
  if (!scoped) return;
  try {
    const out = await scorecard.fileTimeline(db, scoped.loan.id, {
      milestones: milestoneOverridesFrom(scoped.settings),
    });
    res.json({
      loanId: scoped.loan.id,
      loanNumber: scoped.loan.loan_number || null,
      ...out,
    });
  } catch (e) {
    console.error('[lt] file timeline failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not read the timeline for this file just now.' });
  }
});

module.exports = router;
