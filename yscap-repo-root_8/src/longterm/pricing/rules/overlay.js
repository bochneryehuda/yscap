'use strict';
/**
 * LONG-TERM — THE HOUSE RULES, LAID OVER A PRICED BOARD.
 *
 * Owner-directed 2026-09-04: *"this is going to be basically overlays on top of
 * all the engines that we have … even if the engine is giving it to you it
 * should be our own ineligible … it should come up an ineligible section and it
 * should say the ineligible reason is our own overlay."* And: *"it should
 * actually be wired in so it should not populate and it should add hold backs."*
 *
 * ── WHY AN OVERLAY AND NOT A CHANGE TO THE ENGINE ──────────────────────────
 *
 * The rate sheets price the loan. They do not know which states we are licensed
 * in, which programs we refuse, or that no investor of ours allows a prepayment
 * penalty on an individual borrower in New Jersey. Those are OUR rules, they
 * change when the business changes, and they are written by a person rather than
 * by a deploy. So they sit ON TOP: the sheets answer, this reads the answer, and
 * what the officer sees is the answer as our own book allows it.
 *
 * ── WITH NO RULES IT IS A NO-OP, AND THAT IS THE SAFETY PROPERTY ───────────
 *
 * *"I don't want you to pre-fill the rule — I want to put in the rules myself."*
 * The centre ships EMPTY, so `apply()` with no rules returns the board it was
 * given, by identity, and every board is byte-for-byte what it is today. That is
 * what makes this safe to deploy before anybody has written one.
 *
 * ── EVERY RULE IS READ AGAINST THE BOARD AS THE ENGINE PRICED IT ───────────
 *
 * A rule does NOT see another rule's adjustment. Two reasons, and this is a
 * decision rather than a shortcut: a board where a holdback pushes a price under
 * a threshold that arms a second rule is a board nobody can explain, and one
 * where the answer depends on which rule was typed first is a board that changes
 * when somebody re-orders the list. Nothing in the owner's rules needs it —
 * "reduce the margin holdback" is about the holdback the VENDOR-MARGIN step
 * already took, which is a fact on the row, not another rule's output.
 *
 * PRIORITY therefore decides two things and only two: which stopping reason a
 * row is refused with, and the order the adjustments are listed in.
 *
 * ── WHAT IT NEVER DOES ─────────────────────────────────────────────────────
 *
 * It never invents a price, never moves a rate, never touches the vendor's own
 * `vendorPrice` / `vendorBasePoints` trail (that is the margin step's record of
 * what the sheet said), and never runs twice on one board.
 *
 * PURE: no database, no network, no clock. The rules come in as data.
 */

const actions = require('./actions');
const logic = require('./logic');
const facts = require('./facts');

const r3 = actions.r3;
const nn = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** The order rules run in: priority, then when they were made, then id. */
function ordered(rules) {
  return [...(Array.isArray(rules) ? rules : [])].sort((a, b) => {
    const pa = Number.isFinite(Number(a && a.priority)) ? Number(a.priority) : 100;
    const pb = Number.isFinite(Number(b && b.priority)) ? Number(b.priority) : 100;
    if (pa !== pb) return pa - pb;
    const ca = String((a && a.createdAt) || '');
    const cb = String((b && b.createdAt) || '');
    if (ca !== cb) return ca < cb ? -1 : 1;
    return String((a && a.id) || '') < String((b && b.id) || '') ? -1 : 1;
  });
}

/** Does this rule govern this board? `all` governs both. */
function governs(rule, engine) {
  const e = rule && rule.engine ? String(rule.engine) : 'all';
  return e === 'all' || e === engine;
}

/**
 * The priced options a board row carries.
 *
 * A Lender Price program is `{..., options: [...]}` — one entry per rate and
 * lock — while a LoanNEX board row has already been flattened into one option
 * shape with its `priceBuild` at the top. Both are handled here rather than at
 * every call site, because a reader who has to remember which is which is a
 * reader who will one day price only half the board.
 */
function optionsOf(row) {
  if (row && Array.isArray(row.options)) return row.options;
  if (row && row.priceBuild) return [row];
  return [];
}

/**
 * MOVE ONE PRICE BUILD BY `net` POINTS ON THE CLIENT'S SIDE.
 *
 * Positive gives to the client (price up, points down); negative keeps it back.
 *
 * ⛔ IT IS ANCHORED ON ITS OWN FIGURES, so a second pass over one board cannot
 * take the adjustment twice — `housePrice` records the price BEFORE this overlay
 * touched it, and the move is always computed from that anchor rather than from
 * whatever is on the row now. `applyToBoard`'s own comment records that the
 * ladder's points lack such an anchor; this one has one from the start.
 *
 * ⛔ IT NEVER TOUCHES `vendorPrice`, `vendorBasePoints`, `basePoints`,
 * `priceFloor` or `priceCeiling`. Those are the rate sheet's own numbers and the
 * margin step's record of them; a house rule is OURS and rides beside them, so
 * the price-build panel still reconciles the sheet's arithmetic and simply shows
 * one more line at the end — the "Our own rules" row in `LtPricer.PriceBuild`,
 * fed by `houseAdjustPoints` below.
 *
 * ⛔ THAT LAST SENTENCE WAS ASPIRATIONAL UNTIL THE POST-MERGE AUDIT. Nothing in
 * the front end read `houseAdjustPoints`, so "Adjustments total" and "Adjusted
 * points" simply disagreed by whatever a house rule had moved, with no line
 * accounting for the gap. A safety note whose reason is wrong is worse than no
 * note, because the next reader budgets against it: if you change what this
 * stamps, change the row that renders it in the same commit.
 */
function movePriceBuild(pb, net) {
  if (!pb || !net) return pb;
  const anchorPrice = nn(pb.housePrice) ? Number(pb.housePrice) : (nn(pb.price) ? Number(pb.price) : null);
  if (anchorPrice === null) return pb;
  const next = { ...pb, housePrice: r3(anchorPrice), price: r3(anchorPrice + net), houseAdjustPoints: r3(net) };

  /* THE POINTS MOVE THE OPPOSITE WAY AND BY THE SAME AMOUNT — shifted from their
     own anchor, never re-derived from the rounded price. `100 − price` off a
     rounded price lands a thousandth away from the points the parser derived
     from the unrounded one, and a board whose price and points disagree by a
     thousandth is a board somebody spends an afternoon on. */
  for (const key of ['borrowerPaidPoints', 'adjustedPoints']) {
    if (!nn(pb[key])) continue;
    const anchorKey = `house${key[0].toUpperCase()}${key.slice(1)}`;
    const anchor = nn(pb[anchorKey]) ? Number(pb[anchorKey]) : Number(pb[key]);
    next[anchorKey] = r3(anchor);
    next[key] = r3(anchor - net);
  }
  return next;
}

/** An option with the house adjustment applied and its trace attached. */
function adjustOption(option, net, trace) {
  const base = option || {};
  const next = { ...base };
  if (net) next.priceBuild = movePriceBuild(base.priceBuild, net);
  next.houseRules = {
    adjustPoints: r3(net),
    /* WHAT MOVED AND WHY, in the order the rules ran. The board explanation and
       the audit both read this; nothing anywhere re-derives it from the numbers,
       because two readings of one adjustment is how a screen and a term sheet
       end up quoting different reasons for the same price. */
    applied: trace,
  };
  return next;
}

/** The client-safe name for a stopped row — never the investor's real name. */
function safeName(row) {
  return (row && (row.whiteLabel || row.consumerLabel)) || null;
}

/**
 * LAY THE RULES OVER A BOARD.
 *
 * @param {Array} programs   the board rows, exactly as `programsForBoard` built them
 * @param {object} opts
 *   - rules     the rules in force, as `store.liveRules` returns them
 *   - scenario  the search, for the facts every row shares
 *   - engine    'general' | 'combined' — which board this is
 * @returns {{programs:Array, ineligible:Array, blocked:Array, applied:Array,
 *            problems:Array, ran:boolean}}
 */
function apply(programs, opts) {
  const list = Array.isArray(programs) ? programs : [];
  const o = opts || {};
  const engine = o.engine === 'combined' ? 'combined' : 'general';
  const governing = ordered(o.rules).filter((r) => r && r.enabled !== false && governs(r, engine));

  /* A RULE WHOSE ACTIONS CANNOT BE READ IS REPORTED AND NEVER APPLIED — the
     same answer the condition side gives a tree it cannot read, and for the same
     reason: acting on half a rule is worse than not acting on it. It is judged
     ONCE PER BOARD by the SAME validator the door uses, so "saveable" and
     "appliable" can never drift into two different opinions; a rule that somehow
     reached the table before that validator did is caught here on the way out.
     Silently applying it would have meant a net of zero and no stop — a
     licensing block that looks armed and is not. */
  const unreadable = [];
  const rules = governing.filter((r) => {
    const bad = actions.validate(r.then);
    if (!bad.length) return true;
    unreadable.push({
      ruleId: r.id,
      name: r.name,
      problem: `This rule's actions could not be read, so it was not applied: ${bad[0]}`,
    });
    return false;
  });

  const empty = { programs: list, ineligible: [], blocked: [], applied: [], problems: unreadable, ran: false };
  if (!rules.length || !list.length) return empty;

  /* ⛔ ONCE PER BOARD. A board that already carries the overlay is returned
     untouched — the same refusal `vendor-margin.applyToBoard` makes, and for the
     same reason: a second pass would list every adjustment twice in the trace
     even though the anchors keep the arithmetic right. */
  if (list.some((p) => p && p.houseRulesRan)) return { ...empty, ran: true };

  const scFacts = facts.scenarioFacts(o.scenario);

  const ineligible = [];
  const blocked = [];
  const appliedRules = new Map();   // ruleId -> how many quotes it reached
  const problems = unreadable;

  /* WHICH INVESTORS A RULE HAS BLOCKED. Read on the second pass, because a block
     matched on one row of an investor removes ALL of that investor's rows — the
     owner's *"this investor should not populate if it's in this state"* is about
     the investor on this loan, not about one rate. */
  const blockedInvestors = new Map();

  const noteApplied = (rule, n) => appliedRules.set(rule.id, (appliedRules.get(rule.id) || 0) + n);

  /* ── PASS ONE: decide, per option, what every rule says about it ──────────
     Nothing is written to the board here; a stop found on the last rule must be
     able to remove an investor whose first row was already priced. */
  const verdicts = new Map();   // row index -> [{option, net, trace, stop}]

  list.forEach((row, ri) => {
    const opts2 = optionsOf(row);
    const per = [];
    for (const option of opts2) {
      const bag = facts.factsFor(scFacts, row, option, { engine });
      let net = 0;
      const trace = [];
      let stop = null;
      for (const rule of rules) {
        const m = logic.matches(rule.when, bag);
        if (m === null) {
          /* A RULE NOBODY CAN READ NEVER FIRES, AND IS NEVER SILENT. It is
             reported once per board rather than once per quote — a rule with a
             broken tree would otherwise fill the report with one line per rate. */
          if (!problems.some((p) => p.ruleId === rule.id)) {
            problems.push({ ruleId: rule.id, name: rule.name, problem: 'This rule could not be read, so it was not applied.' });
          }
          continue;
        }
        if (m !== true) continue;

        const stopper = actions.stopAction(rule.then);
        if (stopper && !stop) {
          /* THE FIRST STOPPING RULE WINS, which is what priority is for: two
             rules can both refuse a loan and the board prints one reason. */
          stop = {
            kind: stopper.spec.stops,
            ruleId: rule.id,
            rule: rule.name,
            reason: String(stopper.reason || rule.reason || '').trim() || null,
          };
        }
        const pts = actions.netPoints(rule.then);
        if (pts) net = r3(net + pts);
        trace.push({
          ruleId: rule.id,
          rule: rule.name,
          points: pts || 0,
          did: actions.summarize(rule.then),
          because: logic.summarize(rule.when),
        });
        noteApplied(rule, 1);
      }
      per.push({ option, net, trace, stop });

      if (stop && stop.kind === 'investor') {
        const key = row.investorKey || row.lender || safeName(row) || `row:${ri}`;
        if (!blockedInvestors.has(key)) blockedInvestors.set(key, stop);
      }
    }
    verdicts.set(ri, per);
  });

  /* ── PASS TWO: build the board the officer sees ───────────────────────── */
  const out = [];
  list.forEach((row, ri) => {
    /* PASS ONE IS NULL-SAFE AND PASS TWO WAS NOT — `optionsOf` guards the row,
       this read did not. A row that is not an object is passed through UNTOUCHED
       rather than dropped: the overlay's job is to refuse quotes by rule, never
       to quietly lose one it could not read. Not reachable from
       `programsForBoard` today, which only ever pushes objects. */
    if (!row || typeof row !== 'object') { out.push(row); return; }
    const per = verdicts.get(ri) || [];
    const key = row.investorKey || row.lender || safeName(row) || `row:${ri}`;
    const investorStop = blockedInvestors.get(key) || null;

    if (investorStop) {
      blocked.push({
        investorKey: row.investorKey || null,
        name: safeName(row),
        program: row.program || null,
        ruleId: investorStop.ruleId,
        rule: investorStop.rule,
        reason: investorStop.reason,
        why: 'house_rule',
      });
      return;   // the whole row is off the board
    }

    const kept = [];
    for (const v of per) {
      if (v.stop) {
        ineligible.push({
          investorKey: row.investorKey || null,
          name: safeName(row),
          program: row.program || null,
          product: row.product || null,
          noteRate: v.option && v.option.priceBuild ? v.option.priceBuild.noteRate : null,
          ruleId: v.stop.ruleId,
          rule: v.stop.rule,
          reason: v.stop.reason,
          why: 'house_rule',
        });
        continue;
      }
      kept.push(v.net || v.trace.length ? adjustOption(v.option, v.net, v.trace) : v.option);
    }

    /* A ROW WHOSE EVERY QUOTE WAS REFUSED IS OFF THE BOARD — it has no price
       left to show, and a program row with an empty options list reads as a
       lender that answered nothing rather than one we refused. Each refused
       quote is already named in `ineligible`, so nothing is lost. */
    if (!kept.length && per.length) return;

    if (Array.isArray(row.options)) {
      /* ⛔ `optionCount` MOVES WITH THE LIST IT COUNTS, and only when the row
         actually carried one — never invented. `bracket-board.js` keeps the pair
         in step for exactly this reason when it filters options; a row saying it
         has nine quotes while carrying seven is a number somebody spends an
         afternoon on. */
      const next = { ...row, options: kept, houseRulesRan: true };
      if (row.optionCount != null) next.optionCount = kept.length;
      out.push(next);
    } else if (per.length) {
      out.push({ ...kept[0], houseRulesRan: true });
    } else {
      /* A row with no priced option at all — nothing to judge, nothing to move.
         It rides through untouched rather than being dropped: this overlay
         refuses loans on RULES, never on a shape it did not recognise. */
      out.push({ ...row, houseRulesRan: true });
    }
  });

  const applied = rules
    .filter((r) => appliedRules.has(r.id))
    .map((r) => {
      const stopper = actions.stopAction(r.then);
      return {
        ruleId: r.id,
        name: r.name,
        quotes: appliedRules.get(r.id),
        did: actions.summarize(r.then),
        /* THE FACTS, so a screen never has to read the SENTENCE to work out what
           a rule did. The board decided "is this a price adjustment?" by testing
           `did` for the word "point" — so a rule that both REFUSES a loan and
           holds back margin (legal: `validate` forbids two STOPS, not a stop
           beside a holdback) was printed as "Priced with our own adjustment" on
           a row the same rule had just taken off the board. `stops` is the
           reason a stopping rule is never an adjustment, whatever its wording. */
        points: actions.netPoints(r.then),
        stops: stopper ? stopper.spec.stops : null,
      };
    });

  return { programs: out, ineligible, blocked, applied, problems, ran: true };
}

module.exports = { apply, ordered, governs, optionsOf, movePriceBuild, _internals: { adjustOption, safeName } };
