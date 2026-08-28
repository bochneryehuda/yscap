'use strict';
/**
 * THE LINK PASS — which ClickUp card belongs to each long-term loan, decided by
 * the one key that is now decisive and written down where it can be trusted.
 *
 * WHY THE MATCH IS SIMPLE NOW when the reconciliation was not. The reconciliation
 * (run off PILOT, owner-confirmed row by row) had to weigh addresses, amounts,
 * names and typos, because most cards did not carry their loan number. That work
 * is DONE: every confirmed pair's card now carries the YS loan number in its own
 * field — the ones that had it kept it, the 38 that lacked it were filled and
 * verified on 2026-08-23. So the durable rule, the one this module enforces
 * forever, is the owner's own: THE CARD THAT CARRIES THIS LOAN'S NUMBER IS THIS
 * LOAN'S CARD. Anything short of that certainty is refused and reported, never
 * guessed — the wrong link is the expensive mistake here, because it teaches the
 * office that two unrelated deals are one deal.
 *
 * WHAT A PASS DOES. Page the pipeline's cards (READ-ONLY, PILOT's own client),
 * index them by normalised loan number, and for every long-term loan that has no
 * card yet: link it when EXACTLY ONE card carries its number and no other loan
 * claims the same key. Write the link onto the loan (db/618), write the trail row,
 * and — only when the stamp switch is on — write PILOT's file id back onto the
 * card through stamp.js, the one sanctioned ClickUp write.
 *
 * WHAT A PASS REFUSES, each with its reason in the log:
 *   · no card carries the number         → the "needs a card" case; creation's job
 *   · two cards carry the same number    → a duplicate card; a person untangles it
 *   · two unlinked loans share a number  → duplicate Encompass records (they exist:
 *     six were found in reconciliation); linking either would be a coin flip
 *   · the loan is already linked         → NEVER overwritten here. Re-pointing a
 *     loan at a different card is a person's decision ('manual'), not a pass's.
 *
 * WHY IT RUNS IN THE SYNC TICK. The owner, 2026-08-23: *"in the future once you
 * open up the file, everything should stamp automatically. Every file that is
 * already in the system should be stamped already."* One code path serves both:
 * the first pass links the reconciled book, every later pass links whatever new
 * file gained a card since — and a caught-up book costs one ClickUp page-through
 * and writes nothing.
 *
 * OFF SWITCH, same shape as the sync's own: LT_CLICKUP_LINK_ENABLED=0 stops it
 * with no deploy. Writes go to PILOT'S OWN lt_loans only; the sole ClickUp write
 * stays inside stamp.js behind its own separate switch.
 */

const db = require('../db');
const trash = require('../trash');
const clickup = require('./client');
const stamp = require('./stamp');
const { PIPELINE } = require('../../clickup/fields');

/**
 * HOW MANY STAMPS ONE PASS MAY SEND, AND HOW FAR APART. ClickUp's public limit is
 * about a hundred requests a minute, and a stamp costs up to three (the
 * read-before-write inside stampTask, then one write per field). The first pass
 * after go-live has four hundred stamps to make; sent back-to-back they would trip
 * the limit, fail, and — before the retry sweep below existed — never be tried
 * again. So a pass sends a BOUNDED number with a breath between each, and the
 * backlog CONVERGES over the next passes instead of failing loudly on the first.
 */
// Read at CALL time, not load time — so a Render var change takes effect on the
// next pass rather than the next restart, and a test can set them per case.
const stampPerPass = () => {
  const raw = Number(process.env.LT_CLICKUP_STAMP_PER_PASS);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 40;
};
const stampGapMs = () => {
  const raw = Number(process.env.LT_CLICKUP_STAMP_GAP_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 600;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same OFF-value grammar as LT_SYNC_ENABLED, so one habit works everywhere. */
function enabled() {
  const raw = String(process.env.LT_CLICKUP_LINK_ENABLED == null ? '' : process.env.LT_CLICKUP_LINK_ENABLED).trim();
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase());
}

/** A YS loan number as a KEY: case and punctuation are typing noise, digits are not. */
const ysKey = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || null;

/** The ys field off one raw ClickUp task. Short text — no orderindex to resolve. */
function cardYs(task) {
  const list = (task && Array.isArray(task.custom_fields)) ? task.custom_fields : [];
  const f = list.find((x) => x && x.id === PIPELINE.ysLoanNumber);
  const v = f && f.value != null ? String(f.value).trim() : '';
  return v || null;
}

/**
 * Index cards by loan-number key. A key two cards share is poisoned — kept, but
 * marked, so the planner can refuse it WITH the pair of card ids in the reason
 * instead of silently linking whichever card the page order favoured.
 */
function indexCards(cards) {
  const byKey = new Map();
  for (const c of cards) {
    const k = ysKey(c.ys);
    if (!k) continue;
    const cur = byKey.get(k);
    if (cur) { cur.dup.push(c); continue; }
    byKey.set(k, { card: c, dup: [] });
  }
  return byKey;
}

/**
 * Decide every link a pass may make. PURE — no I/O, fully testable. Loans and
 * cards come in as plain rows; out come the links to write and the refusals with
 * their reasons.
 */
function planLinks(loans, cards) {
  const byKey = indexCards(cards);

  // Two UNLINKED loans sharing a number is the duplicate-Encompass case: linking
  // either would be a guess, so the key is refused for both.
  const loanKeyCount = new Map();
  for (const l of loans) {
    if (l.clickup_task_id) continue;
    const k = ysKey(l.loan_number);
    if (k) loanKeyCount.set(k, (loanKeyCount.get(k) || 0) + 1);
  }

  const links = [];
  const skipped = [];
  for (const l of loans) {
    const k = ysKey(l.loan_number);
    if (!k) { skipped.push({ loan: l, reason: 'the loan has no loan number to match on' }); continue; }
    const hit = byKey.get(k);
    if (l.clickup_task_id) {
      if (hit && !hit.dup.length && hit.card.id !== l.clickup_task_id) {
        // Visible, never acted on: the book says one card, the loan says another.
        skipped.push({ loan: l, reason: `already linked to ${l.clickup_task_id}; the card carrying this number is ${hit.card.id} — a person decides re-pointing` });
      }
      continue;                                   // an existing link is never touched here
    }
    if (!hit) { skipped.push({ loan: l, reason: 'no card carries this loan number' }); continue; }
    if (hit.dup.length) {
      skipped.push({ loan: l, reason: `two or more cards carry this number (${[hit.card, ...hit.dup].map((c) => c.custom_id || c.id).join(', ')}) — a person picks` });
      continue;
    }
    if ((loanKeyCount.get(k) || 0) > 1) {
      skipped.push({ loan: l, reason: 'two Encompass records share this loan number — a person picks which one owns the card' });
      continue;
    }
    links.push({ loan: l, card: hit.card, reason: 'the card carries this loan number' });
  }
  return { links, skipped };
}

/** Page every pipeline card once, extracting only what linking needs. READ-ONLY. */
async function pullCards(deps = {}) {
  const client = deps.client || clickup;
  const cards = [];
  for (let page = 0; page < 30; page += 1) {
    /* eslint-disable no-await-in-loop */ // serial paging is the point
    const out = await client.pipelineTasksPage(page, { includeClosed: true });
    const tasks = (out && out.tasks) || [];
    for (const t of tasks) {
      cards.push({ id: t.id, custom_id: t.custom_id || null, url: t.url || null, ys: cardYs(t) });
    }
    if (!tasks.length || (out && out.last_page)) break;
  }
  return cards;
}

/**
 * Write ONE planned link, atomically with its trail row. The WHERE repeats the
 * "still unlinked" condition so a concurrent pass cannot double-write, and the
 * partial unique index (one card, one loan) turns a race into a per-row refusal
 * rather than a corrupt book.
 */
async function applyLink(plan, dbc = db) {
  const { loan, card, reason } = plan;
  try {
    const { rowCount } = await dbc.query(
      `UPDATE lt_loans
          SET clickup_task_id = $2,
              clickup_custom_id = $3,
              clickup_url = $4,
              clickup_linked_at = now(),
              clickup_link_source = 'reconciliation',
              clickup_link_confidence = 'confirmed',
              updated_at = now()
        WHERE id = $1::uuid AND clickup_task_id IS NULL`,
      [loan.id, card.id, card.custom_id, card.url],
    );
    if (!rowCount) return { ok: false, reason: 'the loan gained a link mid-pass; left alone' };
    await dbc.query(
      `INSERT INTO lt_clickup_link_log (id, lt_loan_id, action, from_task_id, to_task_id, confidence, source, reason)
       VALUES (gen_random_uuid(), $1::uuid, 'linked', NULL, $2, 'confirmed', 'reconciliation', $3)`,
      [loan.id, card.id, reason],
    );
    return { ok: true };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    // 23505 = the card is already claimed by another loan — the one-card-one-loan
    // index doing its job at the exact moment it matters.
    const reasonOut = /duplicate key|23505/.test(msg)
      ? `the card is already linked to another loan (one card, one loan)` : msg.slice(0, 300);
    return { ok: false, reason: reasonOut };
  }
}

/**
 * RECORD WHAT A STAMP ATTEMPT DID, on the loan row and in the trail. stampTask is
 * deliberately ClickUp-side only, so the book's own record — clickup_stamped_at,
 * or the error a person reads — is the caller's job, and a stamp that happened
 * but was never recorded would be re-sent forever by the retry sweep.
 *
 * "Already stamped" IS stamped: the card carries our id, however it got there,
 * and the tie the owner asked for holds from both sides.
 */
async function recordStamp(loanId, result, dbc = db) {
  const stampedNow = !!(result && result.ok && (result.wrote.length || result.skipped === 'already_stamped'));
  if (stampedNow) {
    await dbc.query(
      `UPDATE lt_loans SET clickup_stamped_at = now(), clickup_stamp_error = NULL, updated_at = now()
        WHERE id = $1::uuid`, [loanId]);
    await dbc.query(
      `INSERT INTO lt_clickup_link_log (id, lt_loan_id, action, to_task_id, confidence, source, reason)
       VALUES (gen_random_uuid(), $1::uuid, 'stamped', $2, 'confirmed', 'reconciliation', $3)`,
      [loanId, result.taskId || null, result.skipped === 'already_stamped' ? 'the card already carried this id' : 'portal file id written']);
    return true;
  }
  const reason = String((result && result.reason) || 'unknown').slice(0, 300)
    + (result && result.heldBy ? ` (held by ${result.heldBy})` : '');
  await dbc.query(
    `UPDATE lt_loans SET clickup_stamp_error = $2, updated_at = now() WHERE id = $1::uuid`,
    [loanId, reason]);
  await dbc.query(
    `INSERT INTO lt_clickup_link_log (id, lt_loan_id, action, to_task_id, reason)
     VALUES (gen_random_uuid(), $1::uuid, 'stamp_failed', $2, $3)`,
    [loanId, (result && result.taskId) || null, reason]);
  return false;
}

/**
 * The whole pass: pull, plan, apply, stamp what it can afford, and RETRY what an
 * earlier pass could not — so the stamp side converges instead of depending on
 * every write succeeding the first time. Returns the run-log shape.
 */
async function linkPass(deps = {}) {
  if (!enabled()) return { ok: true, reason: 'linking is switched off (LT_CLICKUP_LINK_ENABLED=0)', discovered: 0, read: 0 };
  const dbc = deps.db || db;
  const client = deps.client || clickup;
  const stamper = deps.stamp || stamp;
  if (!client.configured()) return { ok: false, reason: 'ClickUp is not connected on this deployment' };

  const cards = await pullCards({ client });
  const { rows: loans } = await dbc.query(
    `SELECT id, loan_number, clickup_task_id FROM lt_loans l
      -- A DELETED LOAN NEVER CLAIMS A CARD (owner-directed 2026-08-23). Encompass's
      -- trash used to ride into this selection, where it did two kinds of damage: a
      -- trashed loan could take a live card's stamp, and a trashed twin made a real
      -- loan read as "duplicate Encompass records" and held its link — six of the
      -- seven held numbers on the live book were exactly that.
      WHERE ${trash.notTrashSql('l')}`);
  const { links, skipped } = planLinks(loans, cards);

  let linked = 0; let refused = 0; let stamped = 0; let stampFailed = 0;
  let stampBudget = stampPerPass();
  const gap = stampGapMs();
  const problems = [];
  for (const p of links) {
    /* eslint-disable no-await-in-loop */ // serial: each write is tiny and ordered
    const r = await applyLink(p, dbc);
    if (!r.ok) { refused += 1; problems.push({ loan: p.loan.loan_number, reason: r.reason }); continue; }
    linked += 1;
    // The ClickUp-side stamp rides along ONLY when its own switch is on, and only
    // while this pass's budget lasts — what overflows is picked up by the retry
    // sweep on later passes, because an unstamped link stays visible as
    // clickup_stamped_at IS NULL. A stamp failure never unwinds a link: the link
    // is PILOT's own truth, the stamp is a convenience copy of it.
    if (stamper.enabled() && stampBudget > 0) {
      stampBudget -= 1;
      const s = await stamper.stampTask({ taskId: p.card.id, ltLoanId: p.loan.id, fileUrl: null });
      if (await recordStamp(p.loan.id, { ...s, taskId: p.card.id }, dbc)) stamped += 1; else stampFailed += 1;
      if (gap) await sleep(gap);
    }
  }

  // THE RETRY SWEEP — every confirmed link still waiting for its stamp, oldest
  // first, the ones that have never failed before the ones that have. This is what
  // lets four hundred stamps land safely across a handful of passes, and what
  // gives a transient ClickUp failure a second chance instead of a permanent gap.
  if (stamper.enabled() && stampBudget > 0) {
    const { rows: pending } = await dbc.query(
      `SELECT id, clickup_task_id
         FROM lt_loans
        WHERE clickup_task_id IS NOT NULL
          AND clickup_link_confidence = 'confirmed'
          AND clickup_stamped_at IS NULL
          -- Same rule as the selection above: no stamp is spent on a deleted loan.
          AND ${trash.notTrashSql('lt_loans')}
        ORDER BY (clickup_stamp_error IS NOT NULL), clickup_linked_at NULLS LAST
        LIMIT $1`, [stampBudget]);
    for (const row of pending) {
      const s = await stamper.stampTask({ taskId: row.clickup_task_id, ltLoanId: row.id, fileUrl: null });
      if (await recordStamp(row.id, { ...s, taskId: row.clickup_task_id }, dbc)) stamped += 1; else stampFailed += 1;
      if (gap) await sleep(gap);
    }
  }
  return {
    ok: true,
    discovered: cards.length,
    read: linked,                     // run-log column: what the pass actually wrote
    failed: refused,
    skipped: skipped.length,
    stamped,
    stampFailed,
    // The first refusals, in words, so the sync screen can show WHY without a
    // second query. Bounded: a book-wide problem repeats one reason 400 times.
    problems: problems.slice(0, 20),
    skippedReasons: summarise(skipped),
  };
}

/** Fold 400 identical refusals into one line with a count — for the log's jsonb. */
function summarise(skipped) {
  const byReason = new Map();
  for (const s of skipped) {
    const key = s.reason.replace(/\(.*\)/, '').trim();  // fold the per-row ids away
    byReason.set(key, (byReason.get(key) || 0) + 1);
  }
  return [...byReason.entries()].map(([reason, n]) => ({ reason, n }));
}

module.exports = { enabled, ysKey, cardYs, indexCards, planLinks, pullCards, applyLink, recordStamp, linkPass,
  _pacing: { stampPerPass, stampGapMs } };
