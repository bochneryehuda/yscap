'use strict';
/**
 * LONG-TERM — the ClickUp SYNCING section of every LT file (#36, owner-directed
 * 2026-08-23): *"Every feature that we build up that should happen
 * automatically, we should have the option over there"* — every synced field
 * visible, the task link, a manual task-ID link, a push per field, a full push,
 * and Create New Task — plus the review queue the writer parks its blocked
 * PII/DOB questions in, finally readable and decidable.
 *
 * Mounted at /api/lt/clickup (staff-authenticated at the src/server.js seam).
 * Per-loan access mirrors the pipeline's one rule: `access.mayOpenLoan` over the
 * file's own contact rows, answering 404 for a loan outside the viewer's scope
 * (naming a file that exists but is not theirs is itself a disclosure).
 *
 * WHO MAY PRESS WHAT:
 *   · READ the section, PUSH fields, decide REVIEWS — anyone who can open the
 *     loan (the per-file work the section exists for; every write still goes
 *     through the writer's own guards + journal).
 *   · MANUAL LINK + CREATE NEW TASK — LT admins (`access.mayManagePeople`):
 *     changing WHICH card a loan is tied to, or minting a card in an officer's
 *     folder, is bigger than refreshing fields on the right one.
 *
 * EVERY ClickUp write goes through push.js (never a raw writer call from here),
 * so the shield, the DOB gate, the equivalence suppression, the breaker, the
 * journal and the dry-run switch all apply to a button exactly as they apply to
 * the background drain. A review approval re-pushes EXACTLY the approved field
 * (`only:[key]` / `subtaskOnly:[key]` + approvedReview) — never a full push
 * with the shield down (the pre-merge audit's footgun, closed by construction).
 *
 * The manual LINK is a PILOT-side record (no ClickUp write): the stamp pass
 * stamps the card and the push drain fills its fields on their own timers.
 */

const express = require('express');
const router = express.Router();

const db = require('../db');
const access = require('../access');
const settingsStore = require('../settings/store');
const trash = require('../trash');
const clickupPush = require('../clickup/push');
const mapper = require('../clickup/mapper');
const writer = require('../clickup/writer-client');
const T = require('../clickup/transforms');
const program = require('../clickup/program');

const P = clickupPush._internals;

// ── access: the pipeline's one per-loan rule, verbatim ───────────────────────
async function loadScopedLoan(req, res) {
  // A DATABASE failure is a 503, never the 404 disguise (audit round 2, obs 8):
  // "no such loan" is an ANSWER about the loan, and an outage is not one. A
  // malformed id, though, IS "no such loan" — refuse it before the query so a
  // garbage URL cannot masquerade as an outage.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.params.loanId || ''))) {
    res.status(404).json({ error: 'No such long-term loan.' });
    return null;
  }
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT l.*, ${trash.notTrashSql('l')} AS not_trash FROM lt_loans l WHERE l.id = $1::uuid`,
      [String(req.params.loanId)],
    ));
  } catch (e) {
    console.error('[lt-clickup] loan read failed:', (e && e.message) || e);
    res.status(503).json({ error: 'Could not read this loan just now. Try again in a moment.' });
    return null;
  }
  if (!rows.length) { res.status(404).json({ error: 'No such long-term loan.' }); return null; }
  const loan = rows[0];
  const { settings } = await settingsStore.load();
  const viewer = access.accessFor(req.actor, settings);
  const { rows: team } = await db.query(
    'SELECT * FROM lt_loan_contacts WHERE loan_id = $1::uuid', [loan.id],
  );
  if (!access.mayOpenLoan(viewer, req.actor && req.actor.id, team)) {
    res.status(404).json({ error: 'No such long-term loan.' });
    return null;
  }
  return { loan, settings, viewer };
}

async function requireLtAdmin(req, res, next) {
  try {
    const { settings } = await settingsStore.load();
    if (!access.mayManagePeople(req.actor, settings)) {
      return res.status(403).json({ error: 'Only an administrator can do that.' });
    }
    return next();
  } catch (e) {
    console.error('[lt-clickup] admin gate failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'Could not check your permissions just now. Try again in a moment.' });
  }
}

// ── the review key → FIELD_MAP key translation (parent-card reviews) ─────────
// The queue stores `PII_REVIEW_KEY[f.id] || f.key` for a parent-card block, so
// a stored 'ssn' must resolve back to the mapper key resolveOnly understands.
// GENERATED from the two maps, never typed: a typed copy is the drift that
// would make Approve silently push nothing.
const REVIEW_KEY_TO_FIELD_KEY = (() => {
  const out = new Map();
  for (const f of mapper.FIELD_MAP) out.set(f.key, f.key);           // stored verbatim
  for (const [cu, reviewKey] of Object.entries(mapper.PII_REVIEW_KEY)) {
    const f = mapper.FIELD_MAP.find((x) => x.cu === cu);
    if (f) out.set(reviewKey, f.key);
  }
  return out;
})();

// ── display helpers (the section is read by a person, not a machine) ─────────
function displayPlanValue(f, raw, bag) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (f.type === 'checkbox') return raw === true || raw === 'true' ? 'Yes' : null;
  if (f.type === 'users') {
    const person = f.key === 'processor' ? bag.processor : bag.officer;
    return (person && (person.name || person.email)) || String(raw);
  }
  return mapper.reviewPreview(f.cu, raw);
}

/** What the CARD currently holds, in words (reads come back as epochs /
 *  orderindexes / user arrays — the §4.3 asymmetry, rendered for a person). */
function displayCardValue(f, val, options) {
  if (val === undefined || val === null || val === '') return null;
  try {
    if (f.type === 'date') return T.fromEpochMs(val);
    if (f.type === 'dropdown') {
      const opts = options[f.cu] || [];
      if (typeof val === 'object' && val && val.name) return String(val.name);
      if (/^\d+$/.test(String(val))) return T.dropdownIndexToLabel(opts, val) || String(val);
      return T.dropdownIdToLabel(opts, val) || String(val);
    }
    if (f.type === 'location') return (val && val.formatted_address) || null;
    if (f.type === 'users') {
      const arr = Array.isArray(val) ? val : [];
      return arr.map((u) => (u && (u.email || u.username)) || '').filter(Boolean).join(', ') || null;
    }
    if (f.type === 'checkbox') return String(val) === 'true' ? 'Yes' : 'No';
    return mapper.reviewPreview(f.cu, typeof val === 'object' ? JSON.stringify(val) : val);
  } catch (_) { return null; }
}

const linkStateOf = (l) => ({
  taskId: l.clickup_task_id || null,
  customId: l.clickup_custom_id || null,
  url: l.clickup_url || null,
  linkedAt: l.clickup_linked_at || null,
  source: l.clickup_link_source || null,
  confidence: l.clickup_link_confidence || null,
  stampedAt: l.clickup_stamped_at || null,
  stampError: l.clickup_stamp_error || null,
  pushedAt: l.clickup_pushed_at || null,
  pushError: l.clickup_push_error || null,
});

const switchesOf = () => ({
  configured: writer.configured(),
  writeEnabled: clickupPush.writeEnabled(),
  dryRun: clickupPush.dryRun(),
  createSince: clickupPush.createSince(),
});

// ── GET /api/lt/clickup/status-reviews — the disagreement list ───────────────
// Owner-directed 2026-08-24: *"You can open up a general sync review … That
// should have every Encompass status that does not match with ClickUp status,
// which means that we need to go and maybe update Encompass, or we need to go
// manually and update ClickUp."*
//
// READS OUR OWN ROWS ONLY — never ClickUp. The rows are recorded by the push
// pass, which already reads each card before writing, so this list costs no API
// calls and cannot be rate-limited into being wrong. A file PILOT has not pushed
// since the disagreement began is therefore absent rather than guessed at, which
// is the honest failure: the list says what we have SEEN, not what we suppose.
router.get('/status-reviews', async (req, res) => {
  try {
    const { settings } = await settingsStore.load();
    const viewer = access.accessFor(req.actor, settings);

    // Scoped exactly like the pipeline: an officer sees the disagreements on
    // their own files and nobody else's. Never a wider list than the screen the
    // reader already has.
    const params = [];
    const scope = access.pipelineScopeSql(viewer && viewer.access, viewer && viewer.staffId, params.length + 1);
    params.push(...scope.params);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    params.push(limit);

    const { rows } = await db.query(
      `SELECT q.id, q.task_id, q.current_value AS clickup_status, q.proposed_value AS encompass_status,
              q.reason, q.created_at,
              l.id AS loan_id, l.loan_number, l.borrower_name, l.milestone_name
         FROM lt_clickup_review_queue q
         JOIN lt_loans l ON l.id = q.lt_loan_id
        WHERE q.status = 'open' AND q.field_key = '__status' AND q.direction = 'outbound'
          AND ${trash.notTrashSql('l')}
          ${scope.where ? `AND ${scope.where}` : ''}
        ORDER BY q.created_at DESC
        LIMIT $${params.length}`, params);

    res.json({
      ok: true,
      count: rows.length,
      truncated: rows.length >= limit,
      rows,
      // Said on the screen rather than assumed by the reader: this list is what
      // PILOT has observed, and it is not a live comparison of the whole book.
      note: 'Every file where the ClickUp status and the Encompass milestones disagree, as of the last time PILOT looked at that card. PILOT does not change these — update Encompass, or set the ClickUp status by hand.',
    });
  } catch (e) {
    console.warn('[lt-clickup] status-reviews failed:', (e && e.message) || e);
    res.status(500).json({ ok: false, error: 'could not read the status disagreements' });
  }
});

// ── GET /api/lt/clickup/loans/:loanId — the whole section ────────────────────
// ?compare=1 additionally reads the live card (ONE ClickUp read) and puts the
// card's current value beside each of ours, plus the status the engine would
// assert. The plain GET never touches ClickUp; it DOES read the live Encompass
// extras exactly as a push would (the blessed panel-read pattern), so the plan
// shows what a push would actually write — mirror-only when Encompass is off.
router.get('/loans/:loanId', async (req, res) => {
  try {
    const scoped = await loadScopedLoan(req, res);
    if (!scoped) return;
    const { loan } = scoped;

    const ex = await P.readExtras(loan.encompass_loan_guid);
    const bag = await P.loadBag(loan.id, { ex });
    if (!bag) return res.status(404).json({ error: 'No such long-term loan.' });

    // The PLAN: every mapped field, in the map's own order, as a person reads
    // it — the label the writer would resolve, never a UUID, and the SSN
    // masked to its last four exactly as the journal stores it.
    const fields = mapper.FIELD_MAP.map((f) => {
      let raw; try { raw = f.src(bag); } catch (_) { raw = null; }
      return { key: f.key, name: f.name, type: f.type, value: displayPlanValue(f, raw, bag) };
    });

    const co = bag.coborrower;
    const coName = co
      ? [co.first_name, co.middle_name, co.last_name, co.name_suffix].filter(Boolean).join(' ').trim()
      : null;

    const { rows: journal } = await db.query(
      `SELECT id, task_id, field_key, old_value, new_value, changed, blocked, source, created_at
         FROM lt_clickup_write_log
        WHERE lt_loan_id = $1::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT 40`, [loan.id],
    ).catch(() => ({ rows: [] }));

    const { rows: reviews } = await db.query(
      `SELECT id, task_id, direction, field_key, current_value, proposed_value, reason,
              status, resolved_by, resolved_at, created_at
         FROM lt_clickup_review_queue
        WHERE lt_loan_id = $1::uuid
        ORDER BY (status = 'open') DESC, created_at DESC
        LIMIT 30`, [loan.id],
    ).catch(() => ({ rows: [] }));

    const { rows: linkLog } = await db.query(
      `SELECT action, from_task_id, to_task_id, confidence, source, reason, created_at
         FROM lt_clickup_link_log
        WHERE lt_loan_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 10`, [loan.id],
    ).catch(() => ({ rows: [] }));

    const out = {
      link: linkStateOf(loan),
      switches: switchesOf(),
      plan: {
        fields,
        liveFieldsRead: ex ? Object.keys(ex).length : 0,
        coBorrower: { present: co === null ? false : (co ? true : null), name: coName },
      },
      journal,
      reviews: {
        open: reviews.filter((r) => r.status === 'open'),
        decided: reviews.filter((r) => r.status !== 'open').slice(0, 10),
      },
      linkLog,
      canAdmin: false,
      compare: null,
    };
    try { out.canAdmin = access.mayManagePeople(req.actor, scoped.settings); } catch (_) { /* buttons stay off */ }

    // The live card, side by side — only when asked, only when linked, and a
    // failed read degrades to "no comparison" rather than failing the section.
    if (String(req.query.compare || '') === '1' && loan.clickup_task_id && writer.configured()) {
      try {
        const task = await writer.getTask(loan.clickup_task_id, { includeSubtasks: true });
        const options = P.taskOptionsMap(task);
        const cmp = mapper.FIELD_MAP.map((f) => {
          let raw; try { raw = f.src(bag); } catch (_) { raw = null; }
          const wire = mapper.writeValue(f, raw, options);
          const cardVal = P.taskFieldValue(task, f.cu);
          let same = null;
          if (wire !== undefined && wire !== null && wire !== '') {
            try { same = mapper.fieldValueEquivalent(f.cu, cardVal, wire, options, {}); } catch (_) { same = null; }
          }
          return {
            key: f.key,
            ours: displayPlanValue(f, raw, bag),
            card: displayCardValue(f, cardVal, options),
            same,
          };
        });
        // The push's OWN derivation, shared — never a second copy (audit round 2, obs 7).
        const desired = clickupPush.desiredStatusFor(bag, loan);
        const subtask = coName
          ? (Array.isArray(task.subtasks) ? task.subtasks : []).find((st) => {
            try { return mapper._internals.sameNameLoose(String(st.name || ''), coName); } catch (_) { return false; }
          })
          : null;
        out.compare = {
          fields: cmp,
          status: {
            current: String((task.status && task.status.status) || '').trim() || null,
            desired: desired.status,
            reason: desired.reason,
          },
          cardProgram: P.cardProgramLabel(task),
          subtask: { found: !!subtask, name: subtask ? subtask.name : null },
        };
      } catch (e) {
        out.compare = { error: 'Could not read the ClickUp card just now.' };
        console.warn('[lt-clickup] compare read failed:', (e && e.message) || e);
      }
    }

    res.json(out);
  } catch (e) {
    console.error('[lt-clickup] section read failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not read the ClickUp syncing section.' });
  }
});

// ── the push doors ───────────────────────────────────────────────────────────
function pushAnswer(res, out) {
  if (out && out.ok) return res.json(out);
  const why = {
    not_configured: 'ClickUp is not connected — add the ClickUp credentials first.',
    off: 'The ClickUp writer is switched off (LT_CLICKUP_WRITE_ENABLED). Nothing was sent.',
    unlinked: 'This loan has no ClickUp card yet — link one, or use Create New Task.',
    link_not_confirmed: 'The link to this card is not confirmed yet, so nothing is written to it.',
    short_term_card: 'The linked card is a SHORT-TERM card — the long-term writer refuses it. Link the right card first.',
    trashed: 'This loan sits in the Encompass trash — nothing is pushed for it.',
    no_such_loan: 'No such long-term loan.',
  };
  const msg = (out && why[out.skipped]) || 'The push did not run.';
  return res.status(409).json({ error: msg, skipped: out && out.skipped });
}

// POST /loans/:loanId/push — the full card refresh, on demand.
router.post('/loans/:loanId/push', async (req, res) => {
  try {
    const scoped = await loadScopedLoan(req, res);
    if (!scoped) return;
    const out = await clickupPush.pushLoan(scoped.loan.id, { source: 'manual' });
    return pushAnswer(res, out);
  } catch (e) {
    console.error('[lt-clickup] manual push failed:', (e && e.message) || e);
    return res.status(502).json({ error: `The push failed: ${String((e && e.message) || e).slice(0, 300)}`, retryable: !!(e && e.retryable) });
  }
});

// POST /loans/:loanId/push-field { key } — one field, scoped (never status,
// never the subtask, never a create).
router.post('/loans/:loanId/push-field', async (req, res) => {
  try {
    const scoped = await loadScopedLoan(req, res);
    if (!scoped) return;
    const key = String((req.body || {}).key || '').trim();
    const known = mapper.FIELD_MAP.some((f) => f.key === key)
      || key === 'portal_stamp' || key === 'processor' || key === 'co_borrower';
    if (!key || !known) return res.status(400).json({ error: 'Say which field to push (an unknown field name was sent).' });
    const out = await clickupPush.pushLoan(scoped.loan.id, { only: [key], source: 'manual' });
    return pushAnswer(res, out);
  } catch (e) {
    console.error('[lt-clickup] field push failed:', (e && e.message) || e);
    return res.status(502).json({ error: `The push failed: ${String((e && e.message) || e).slice(0, 300)}`, retryable: !!(e && e.retryable) });
  }
});

// POST /loans/:loanId/create — mint the card (admin; deliberately ALSO for a
// back-book loan the automatic pass would never touch — choosing one by hand
// IS the owner's Create New Task button).
router.post('/loans/:loanId/create', requireLtAdmin, async (req, res) => {
  try {
    const scoped = await loadScopedLoan(req, res);
    if (!scoped) return;
    const out = await clickupPush.createForLoan(scoped.loan.id);
    if (out && out.created) return res.json(out);
    if (out && out.dryRun) return res.json(out);
    const why = {
      not_configured: 'ClickUp is not connected — add the ClickUp credentials first.',
      off: 'The ClickUp writer is switched off (LT_CLICKUP_WRITE_ENABLED). Nothing was created.',
      already_linked: 'This loan already has a ClickUp card.',
      trashed: 'This loan sits in the Encompass trash — no card is created for it.',
      placeholder_loan_number: 'This loan has no real loan number yet.',
      no_officer_folder: 'No ClickUp folder is known for this loan’s officer — add the officer to the routing map first.',
      no_borrower_name: 'The borrower’s name has not been read from Encompass yet.',
      no_list_in_folder: 'The officer’s ClickUp folder has no list to create the card in.',
    };
    const msg = (out && why[out.skipped]) || `Could not create the card${out && out.skipped ? ` (${out.skipped})` : ''}.`;
    return res.status(409).json({ error: msg, skipped: out && out.skipped });
  } catch (e) {
    console.error('[lt-clickup] manual create failed:', (e && e.message) || e);
    return res.status(502).json({ error: `Creating the card failed: ${String((e && e.message) || e).slice(0, 300)}` });
  }
});

// ── POST /loans/:loanId/link { taskId, confirm? } — the manual task-ID link ──
// A PILOT-side record only: nothing is written to ClickUp here. The card is
// READ first (it must exist, must not be a short-term card, must not belong to
// another loan), and a card whose YS loan number names a DIFFERENT loan needs
// an explicit confirm — that mismatch is usually WHY the automatic matcher
// left this loan unlinked.
router.post('/loans/:loanId/link', requireLtAdmin, async (req, res) => {
  try {
    const scoped = await loadScopedLoan(req, res);
    if (!scoped) return;
    const { loan } = scoped;
    const body = req.body || {};
    const taskId = String(body.taskId || '').trim();
    if (!taskId || !/^[a-z0-9]+$/i.test(taskId)) {
      return res.status(400).json({ error: 'Paste the ClickUp task id (the letters/numbers in the card’s URL).' });
    }
    if (loan.clickup_task_id) {
      return res.status(409).json({ error: 'This loan is already linked to a card. Unlinking is not offered here — ask an engineer if a link is genuinely wrong.' });
    }
    if (!writer.configured()) {
      return res.status(409).json({ error: 'ClickUp is not connected — the card cannot be verified, so nothing was linked.' });
    }

    // The card must be real, and readable — never linked blind.
    let task;
    try {
      task = await writer.getTask(taskId);
    } catch (e) {
      const status = e && e.status;
      const msg = status === 404 || status === 401
        ? 'No ClickUp card with that id (check the id — it is the token in the card’s URL).'
        : `Could not read that card just now (${String((e && e.message) || e).slice(0, 120)}).`;
      return res.status(status === 404 ? 404 : 502).json({ error: msg });
    }

    // §10.18 — never tie a long-term loan to a short-term card.
    const cls = program.classifyProgram(P.cardProgramLabel(task), {});
    if (cls.product === program.PRODUCT.SHORT) {
      return res.status(409).json({ error: 'That card is a SHORT-TERM card — a long-term loan is never linked to one.' });
    }

    // One card, one loan — say WHICH loan holds it rather than failing opaque.
    const { rows: claimed } = await db.query(
      'SELECT id, loan_number FROM lt_loans WHERE clickup_task_id = $1 AND id <> $2::uuid', [taskId, loan.id]);
    if (claimed.length) {
      return res.status(409).json({ error: `That card is already linked to loan ${claimed[0].loan_number || claimed[0].id}. One card, one loan.` });
    }

    // A DIFFERENT loan number on the card is answered with a question, not a
    // write: linking over a mismatch is exactly how the wrong borrower's data
    // lands on somebody's card.
    const norm = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cardYsField = ((task && task.custom_fields) || []).find((f) => f && f.id === mapper.CU.ysLoanNumber);
    const cardYs = cardYsField && cardYsField.value != null ? String(cardYsField.value).trim() : '';
    const ourYs = String(loan.loan_number || '').trim();
    if (cardYs && ourYs && norm(cardYs) !== norm(ourYs) && body.confirm !== true) {
      return res.status(409).json({
        error: `The card carries loan number ${cardYs}, but this file is ${ourYs}. If you are sure it is the same deal, confirm to link anyway.`,
        needsConfirm: true,
        cardLoanNumber: cardYs,
      });
    }

    const url = task.url ? String(task.url) : `https://app.clickup.com/t/${taskId}`;
    const customId = task.custom_id ? String(task.custom_id) : null;
    const { rowCount } = await db.query(
      `UPDATE lt_loans
          SET clickup_task_id = $2, clickup_custom_id = $3, clickup_url = $4,
              clickup_linked_at = now(), clickup_link_source = 'manual',
              clickup_link_confidence = 'confirmed', updated_at = now()
        WHERE id = $1::uuid AND clickup_task_id IS NULL`,
      [loan.id, taskId, customId, url]);
    if (!rowCount) return res.status(409).json({ error: 'The loan gained a link a moment ago — nothing was changed.' });

    await db.query(
      `INSERT INTO lt_clickup_link_log (id, lt_loan_id, action, from_task_id, to_task_id, confidence, source, reason)
       VALUES (gen_random_uuid(), $1::uuid, 'linked', NULL, $2, 'confirmed', 'manual', $3)`,
      [loan.id, taskId, `linked by hand${req.actor && req.actor.id ? ` (staff ${req.actor.id})` : ''}${cardYs && ourYs && norm(cardYs) !== norm(ourYs) ? ' — loan-number mismatch confirmed' : ''}`],
    ).catch((e) => console.warn('[lt-clickup] link log write failed:', (e && e.message) || e));

    return res.json({ ok: true, linked: true, taskId, url });
  } catch (e) {
    // 23505 = the one-card-one-loan index winning a race we pre-checked.
    if (/duplicate key|23505/.test(String((e && e.message) || ''))) {
      return res.status(409).json({ error: 'That card was linked to another loan at the same moment. One card, one loan.' });
    }
    console.error('[lt-clickup] manual link failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not link the card.' });
  }
});

// ── the review doors ─────────────────────────────────────────────────────────
async function loadScopedReview(req, res) {
  const scoped = await loadScopedLoan(req, res);
  if (!scoped) return null;
  const { rows } = await db.query(
    // Pinned to the loan in the URL — a review id from another file 404s even
    // for someone who could open both (the findingOnFile discipline).
    `SELECT * FROM lt_clickup_review_queue WHERE id = $1 AND lt_loan_id = $2::uuid`,
    [String(req.params.reviewId), scoped.loan.id],
  ).catch(() => ({ rows: [] }));
  if (!rows.length) { res.status(404).json({ error: 'No such review on this loan.' }); return null; }
  return { ...scoped, review: rows[0] };
}

// POST /loans/:loanId/reviews/:reviewId/approve — write EXACTLY this field.
router.post('/loans/:loanId/reviews/:reviewId/approve', async (req, res) => {
  try {
    const scoped = await loadScopedReview(req, res);
    if (!scoped) return;
    const { loan, review } = scoped;
    if (review.status !== 'open') return res.status(409).json({ error: `This review was already ${review.status}.` });
    if (review.direction !== 'outbound') return res.status(409).json({ error: 'Only outbound (PILOT → ClickUp) reviews are decided here.' });

    const onSubtask = String(review.task_id) !== String(loan.clickup_task_id || '');
    let out;
    if (onSubtask) {
      out = await clickupPush.pushLoan(loan.id, {
        subtaskOnly: [review.field_key], approvedReview: true, source: 'review_approval',
      });
    } else {
      const fieldKey = REVIEW_KEY_TO_FIELD_KEY.get(review.field_key);
      if (!fieldKey) return res.status(409).json({ error: `This review's field (${review.field_key}) is not one the writer can re-push.` });
      out = await clickupPush.pushLoan(loan.id, {
        only: [fieldKey], approvedReview: true, source: 'review_approval',
      });
    }
    if (!out || !out.ok) return pushAnswer(res, out);
    if (clickupPush.dryRun()) {
      return res.json({ ok: true, dryRun: true, plan: out.plan, note: 'Dry run — the write was rehearsed, nothing was sent and the review stays open.' });
    }
    // AN APPROVAL THAT LANDED NOTHING RESOLVES NOTHING (audit round 2, obs 6).
    // `wrote` means the value reached the card; `suppressed` means the card
    // already holds it (equally settled). Neither — the co-borrower's subtask
    // is gone, or the field no longer resolves on this card — means the
    // approved value is NOT on the card, and resolving the review would record
    // a decision as carried out when it was not. The review stays open.
    if (!(out.wrote > 0 || out.suppressed > 0)) {
      const why = out.subtaskSkipped === 'subtask_missing'
        ? 'the co-borrower subtask is no longer on this card'
        : out.subtaskSkipped === 'subtask_unreadable'
          ? 'the co-borrower subtask could not be read just now'
          : 'the approved field did not land on the card';
      return res.status(409).json({
        error: `Nothing was written — ${why}. The review stays open; re-check the card link and try again.`,
        subtaskSkipped: out.subtaskSkipped,
      });
    }

    const { rows } = await db.query(
      `UPDATE lt_clickup_review_queue
          SET status = 'resolved', resolved_by = $2::uuid, resolved_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [review.id, (req.actor && req.actor.id) || null]);
    return res.json({ ok: true, resolved: rows.length > 0, wrote: out.wrote, suppressed: out.suppressed, subtask: onSubtask || undefined, subtaskSkipped: out.subtaskSkipped });
  } catch (e) {
    console.error('[lt-clickup] review approve failed:', (e && e.message) || e);
    return res.status(502).json({ error: `The approved write failed: ${String((e && e.message) || e).slice(0, 300)} The review stays open.`, retryable: !!(e && e.retryable) });
  }
});

// POST /loans/:loanId/reviews/:reviewId/reject — keep the card as it is.
router.post('/loans/:loanId/reviews/:reviewId/reject', async (req, res) => {
  try {
    const scoped = await loadScopedReview(req, res);
    if (!scoped) return;
    const { review } = scoped;
    if (review.status !== 'open') return res.status(409).json({ error: `This review was already ${review.status}.` });
    const { rows } = await db.query(
      `UPDATE lt_clickup_review_queue
          SET status = 'rejected', resolved_by = $2::uuid, resolved_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [review.id, (req.actor && req.actor.id) || null]);
    return res.json({ ok: true, rejected: rows.length > 0 });
  } catch (e) {
    console.error('[lt-clickup] review reject failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not record the decision.' });
  }
});

module.exports = router;
module.exports._internals = { REVIEW_KEY_TO_FIELD_KEY, displayPlanValue, displayCardValue, linkStateOf, switchesOf };
