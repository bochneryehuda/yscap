'use strict';
/**
 * LONG-TERM — IS THIS RULE ACTUALLY WORKING?
 *
 * Owner-directed 2026-09-04: *"open audit engines to make sure that every rule
 * is actually firing."*
 *
 * ── ONE SENTENCE PER RULE, AND THE ORDER OF THE QUESTIONS IS THE POINT ─────
 *
 * A list of forty rules can show one column. This module decides what that
 * column says, and the ORDER the questions are asked in is the whole design,
 * because several of them are true at once on a broken rule and only the FIRST
 * one is worth a person's attention:
 *
 *   1. Is it switched OFF?          — nothing else matters; it is not in force.
 *   2. Is it ARCHIVED?              — likewise, and it is not on the board.
 *   3. Is it BROKEN?                — it can never fire. Fix the RULE.
 *   4. Has it been ASKED at all?    — no boards yet. Nothing is wrong.
 *   5. Has it EVER fired?           — asked thousands of times, never matched.
 *   6. Is it firing NOW?            — the healthy answer.
 *
 * ⛔ ASKING 5 BEFORE 4 IS THE MISTAKE THIS WHOLE FEATURE EXISTS TO PREVENT.
 * "Matched 0 times" is the same sentence for a rule that is WRONG and a rule
 * that is simply on a board nobody has priced yet, and telling an officer to fix
 * a rule that is fine is the fastest way to make them stop reading this screen.
 *
 * ⛔ AND BROKEN IS ASKED BEFORE EITHER. A rule whose conditions name a field
 * that no longer exists has also "never fired", and reporting THAT is useless —
 * it sends somebody hunting for a loan that would match, when the answer is that
 * no loan can.
 *
 * PURE: no database, no network, no clock — the caller passes the facts in.
 */

const diagnose = require('./diagnose');

/** The verdicts, worst-first. A screen may sort on this and get the right order. */
const LEVEL = Object.freeze({
  broken: 0,
  never_fired: 1,
  stale: 2,
  not_asked: 3,
  off: 4,
  archived: 5,
  firing: 6,
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* ⛔ `store.shape` EXPOSES `archivedAt`, NOT `archived` — reading a boolean that
   the shape has never carried is silently false on every archived rule, so the
   centre would report a retired rule as live and, worse, as one that has stopped
   firing. Both spellings are accepted so a caller holding a hand-built rule
   (the `/test` door) behaves the same way. */
const isArchived = (r) => !!(r && (r.archivedAt || r.archived));

/**
 * ONE RULE'S STANDING.
 *
 * @param {object} rule    the rule document
 * @param {object} firing  its rolled-up counters ({total, engines, everFiredAt}), or null
 * @param {object} opts    {days} — the window the counters cover, for the wording
 */
function standing(rule, firing, opts = {}) {
  const r = rule || {};
  const days = Number.isFinite(Number(opts.days)) && Number(opts.days) > 0 ? Math.floor(Number(opts.days)) : 90;
  const t = (firing && firing.total) || {};
  const seen = num(t.boardsSeen);
  const matched = num(t.boardsMatched);
  const unreadable = num(t.unreadable);
  const everFiredAt = (firing && firing.everFiredAt) || null;

  /* THE RULE IS READ WITH NO FACTS, which answers exactly one question: can this
     rule ever match anything at all? `diagnose` with an empty fact bag reports
     every unreadable row (an unknown field, an operator its type does not take)
     and every action that cannot be read — and reports the ORDINARY rows as
     simply not met, which is correct and is not a fault. */
  const d = diagnose.diagnose(r, {});
  const brokenNow = d.broken;

  let verdict;
  let headline;
  if (isArchived(r)) {
    verdict = 'archived';
    headline = 'Archived — it is not on any board.';
  } else if (r.enabled === false) {
    verdict = 'off';
    headline = 'Switched off — it is not being asked.';
  } else if (brokenNow) {
    verdict = 'broken';
    headline = d.headline;
  } else if (unreadable > 0) {
    /* THE BOARD REFUSED IT EVEN THOUGH IT READS CORRECTLY NOW. Someone has
       fixed it since, or it names a field that comes and goes. Either way the
       ledger saw a board turn it down, and that is worth saying — quietly,
       because the rule is readable at this moment. */
    verdict = 'broken';
    headline = `A board could not read this rule ${unreadable === 1 ? 'once' : `${unreadable} times`}. It did not run those times.`;
  } else if (seen === 0) {
    verdict = 'not_asked';
    headline = everFiredAt
      ? 'No boards in this period. It has fired before.'
      : 'No boards have been priced with this rule in force yet.';
  } else if (matched === 0) {
    /* ⛔ "HAS NEVER FIRED" AND "HAS NOT FIRED LATELY" ARE DIFFERENT FINDINGS AND
       MUST NOT SHARE A VERDICT. The first is very likely a broken rule; the
       second is the ordinary shape of a rule that only applies to loans we have
       not seen this quarter, and ranking it alongside the first is how a real
       finding gets lost in a list of false ones. */
    verdict = everFiredAt ? 'stale' : 'never_fired';
    headline = everFiredAt
      ? `Asked on ${seen.toLocaleString()} ${seen === 1 ? 'board' : 'boards'} in the last ${days} days and matched none — it last fired before that.`
      : `Asked on ${seen.toLocaleString()} ${seen === 1 ? 'board' : 'boards'} and has never matched anything.`;
  } else {
    verdict = 'firing';
    headline = `Matched ${matched.toLocaleString()} of ${seen.toLocaleString()} ${seen === 1 ? 'board' : 'boards'}.`;
  }

  return {
    ruleId: r.id || null,
    name: r.name || null,
    enabled: r.enabled !== false,
    archived: isArchived(r),
    engine: r.engine || 'all',
    priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 100,
    verdict,
    level: LEVEL[verdict],
    headline,
    /* THE RULE'S OWN PROBLEMS, so the screen can print them under the headline
       without asking a second door. Empty on a healthy rule. */
    problems: d.problems,
    unreadableRows: d.unreadable.map((u) => u.why),
    says: d.says,
    does: d.does,
    firing: {
      windowDays: days,
      everFiredAt,
      boardsSeen: seen,
      boardsMatched: matched,
      quotesReached: num(t.quotesReached),
      quotesAdjusted: num(t.quotesAdjusted),
      quotesRefused: num(t.quotesRefused),
      rowsBlocked: num(t.rowsBlocked),
      unreadable,
      firstAt: t.firstAt || null,
      lastAt: t.lastAt || null,
      byEngine: (firing && firing.engines) || {},
    },
  };
}

/**
 * EVERY RULE'S STANDING, worst first — the screen's whole table.
 *
 * @param {Array}  rules   every rule the centre holds (archived included)
 * @param {Map}    byRule  ruleId -> its rolled-up counters
 */
function auditAll(rules, byRule, opts = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const map = byRule instanceof Map ? byRule : new Map();
  const rows = list.map((r) => standing(r, r && r.id ? map.get(r.id) : null, opts));

  /* WORST FIRST, then the rule's own order — so a broken rule can never be
     below the fold on a centre holding forty of them. */
  rows.sort((a, b) => (a.level - b.level) || (a.priority - b.priority) || String(a.name || '').localeCompare(String(b.name || '')));

  const counts = { broken: 0, never_fired: 0, stale: 0, not_asked: 0, off: 0, archived: 0, firing: 0 };
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] || 0) + 1;

  /* THE ONE SENTENCE AT THE TOP. It names the thing that needs doing, or says
     plainly that nothing does — never a count of rules, which says nothing. */
  const live = rows.filter((r) => !r.archived && r.enabled);
  let summary;
  if (!list.length) summary = 'No rules yet. The centre is empty, so every board is exactly what the rate sheets say.';
  else if (counts.broken) summary = `${counts.broken} ${counts.broken === 1 ? 'rule cannot run' : 'rules cannot run'} — read the reasons below and fix them.`;
  else if (counts.never_fired) summary = `${counts.never_fired} ${counts.never_fired === 1 ? 'rule has' : 'rules have'} been asked and never matched anything.`;
  else if (counts.stale) summary = `${counts.stale} ${counts.stale === 1 ? 'rule has' : 'rules have'} not matched anything lately, though ${counts.stale === 1 ? 'it has' : 'they have'} fired before.`;
  else if (!live.length) summary = 'No rules are switched on, so every board is exactly what the rate sheets say.';
  else if (counts.not_asked === live.length) summary = 'No boards have been priced with these rules in force yet — there is nothing to report.';
  else summary = `Every rule in force is either firing or waiting for a board it applies to.`;

  return { rows, counts, summary, windowDays: rows.length ? rows[0].firing.windowDays : (opts.days || 90) };
}

/**
 * WOULD EVERY RULE FIRE ON THIS SCENARIO? — the fire drill.
 *
 * The owner's *"make sure that every rule that you fire will actually work"* in
 * its most direct form: one loan, every rule, and for each one a plain answer
 * and, when it does not fire, WHICH condition stopped it.
 *
 * ⛔ IT JUDGES EVERY RULE, ARCHIVED AND SWITCHED-OFF INCLUDED, and says which
 * is which. A person testing a rule they have not turned on yet is the whole
 * reason this exists — refusing to judge it would answer the wrong question.
 */
function dryRun(rules, facts, opts = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const engine = opts.engine === 'combined' ? 'combined' : opts.engine === 'general' ? 'general' : null;

  const rows = list.map((r) => {
    const d = diagnose.diagnose(r, facts || {});
    /* GOVERNS IS SEPARATE FROM MATCHES, and reporting them together would hide
       the most confusing case there is: a rule whose conditions match perfectly
       and which is written for the OTHER engine, so the board never asks it. */
    const governs = !engine || r.engine === 'all' || r.engine === engine || !r.engine;
    return {
      ...d,
      archived: isArchived(r),
      priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 100,
      governs,
      wouldRun: d.fires && governs && r.enabled !== false && !isArchived(r) && !d.broken,
    };
  });

  rows.sort((a, b) => (Number(b.wouldRun) - Number(a.wouldRun)) || (a.priority - b.priority));

  const firing = rows.filter((r) => r.wouldRun).length;
  const broken = rows.filter((r) => r.broken).length;
  return {
    rows,
    counts: { total: rows.length, firing, broken },
    summary: !rows.length
      ? 'There are no rules to try.'
      : firing
        ? `${firing} of ${rows.length} ${rows.length === 1 ? 'rule' : 'rules'} would fire on this loan.`
        : `No rule would fire on this loan${broken ? ` — and ${broken} cannot run at all.` : '.'}`,
  };
}

module.exports = { standing, auditAll, dryRun, LEVEL };
