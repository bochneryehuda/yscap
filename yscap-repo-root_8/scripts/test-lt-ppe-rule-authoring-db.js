#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the RULE-AUTHORING STORE against a REAL Postgres (db/577 `lt_ppe_rule_draft`).
 *
 * WHY THIS SUITE HAS TO EXIST BESIDE THE PURE ONE. The pure suite proves the DECISIONS. It cannot
 * prove a column exists, cannot prove a partial unique index bites, cannot prove a CHECK constraint
 * refuses a row, and — the one that matters most here — cannot prove that a rule which survives a
 * round trip through Postgres is still a rule the engine can run. That class of bug has bitten this
 * repository repeatedly: a query against a column that is not there, sitting inside a `catch`, which
 * reports a confident "nothing to do" forever.
 *
 * WHAT IS PROVEN HERE:
 *
 *  A. THE BOUNDARY IS STRUCTURAL. A saved draft is INVISIBLE to `rule-store.rulesForProgram` — the set
 *     an engine actually evaluates. This is the whole of "authoring is not publishing": not a flag
 *     somebody sets correctly, a table the pricing path does not read. It is asserted by pricing a
 *     scenario through the REAL evaluator with the draft saved and showing the price does not move.
 *
 *  B. THE ROUND TRIP IS THE PROOF. After a deliberate publish, the rule is read back out of Postgres
 *     by `rulesForProgram` (through `rowToRule`, the mapper the engine's own read uses) and handed to
 *     `rules.evaluateRules`, and the ANSWER is asserted — for all four result kinds. A service that
 *     authors rules the engine silently ignores is the defect this build exists to prevent, so the
 *     chain is exercised end to end rather than at either end.
 *
 *  C. PUBLISHING REFUSES WITHOUT A NAMED HUMAN, in two independent places: the store refuses, and the
 *     database's own CHECK refuses a published row with nobody named — so it cannot be got round by
 *     writing the row directly.
 *
 *  D. PUBLISH RE-CHECKS AGAINST THE SET AS IT IS NOW. A draft is authored cleanly, a colliding rule is
 *     published onto the same cell while it sits there, and the draft is then REFUSED. Trusting the
 *     check made at authoring time is how the double charge gets in through the back door, and no pure
 *     test can stage a world that moves underneath a stored row.
 *
 *  E. Two people cannot draft the same rule at once; nothing is deleted; a published draft cannot be
 *     published twice.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-rule-authoring-db.js
 *
 * LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

/**
 * A SECTION THAT THROWS IS A FAILURE TO REPORT, NOT A RUN TO END.
 *
 * ⛔ THIS IS NOT TIDINESS — IT IS THE DIFFERENCE BETWEEN A PROOF AND FALSE CONFIDENCE. A crashing
 * suite exits non-zero and therefore "fails", which looks exactly like a test that caught something.
 * It is not the same thing: everything after the throw silently never ran, so a mutation that both
 * breaks section B and would have been caught in section E reports one crash and hides the rest. Three
 * of the mutations this suite was proven against (a dropped adjustment column, a refusal that still
 * stored the row, a swallowed unique-index violation) throw rather than assert, and each one was
 * ending the run. Every section now names its own failure and the rest still execute.
 */
async function section(name, fn) {
  console.log(`\n${name}\n`);
  try { await fn(); } catch (e) {
    ok(false, `${name} — THREW instead of answering: ${(e && e.message) || e}`);
  }
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('(LT PPE rule-authoring store skipped — set DATABASE_URL to run it.)');
    process.exit(0);
  }

  const db = require('../src/longterm/db');
  const store = require('../src/longterm/ppe/store');
  const ruleStore = require('../src/longterm/ppe/rule-store');
  const authStore = require('../src/longterm/ppe/rule-authoring-store');
  const { evaluateRules } = require('../src/longterm/ppe/rules');

  const SCOPE = 'company';
  const stamp = `A${process.pid}${Date.now() % 100000}`;
  const INV_CODE = `ZZ${stamp}`.slice(0, 20);

  const cleanup = async () => {
    await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1 AND code LIKE $2', [SCOPE, `${INV_CODE}%`]).catch(() => {});
  };

  try {
    // The migrations this suite depends on, applied here so it proves the SHIPPED schema rather than
    // whatever a previous run happened to leave behind.
    for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql',
      '571_lt_ppe_rule_and_suggestion_store.sql', '577_lt_ppe_rule_draft_authoring_not_publishing.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    const inv = await store.createInvestor(db, SCOPE, { code: INV_CODE, name: `Authoring ${stamp}` });
    const prg = await store.createProgram(db, SCOPE, { investorId: inv.id, code: `P${stamp}`.slice(0, 20), name: 'DSCR authoring' });
    const where = { investorId: inv.id, programId: prg.id };

    // =========================================================================
    // 0. THE COLUMNS ARE REALLY THERE. A pure suite cannot say this, and every
    //    assertion below would otherwise be testing a table that does not exist.
    // =========================================================================
    await section('0. the shipped schema', async () => {
      const cols = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'lt_ppe_rule_draft'`);
      const have = new Set(cols.rows.map((r) => r.column_name));
      const want = ['id', 'scope', 'investor_id', 'program_id', 'code', 'kind', 'rule', 'status',
        'based_on_rule_id', 'note', 'created_by', 'created_at', 'updated_at',
        'published_rule_id', 'published_by', 'published_at', 'publish_note'];
      const missing = want.filter((c) => !have.has(c));
      ok(missing.length === 0, `lt_ppe_rule_draft carries every column the store writes${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
    });

    // =========================================================================
    // A. AUTHORING IS NOT PUBLISHING — the draft cannot move a price.
    // =========================================================================
    const intent = {
      op: 'add_llpa', code: `llpa_fico_640_${stamp}`, adjMilli: 250, dimension: 'fico',
      reason: 'FICO 640–659', when: { fact: 'fico', op: 'between', value: [640, 660] },
    };
    let saved = null;

    await section('A. a draft prices nothing', async () => {
      saved = await authStore.saveDraft(db, SCOPE, intent, { ...where, createdBy: 'author@ys', note: 'from the editor' });
      ok(saved.ok && saved.draft && saved.draft.id, 'a valid rule is authored and saved as a draft');
      ok(saved.draft.status === 'draft' && saved.draft.publishedAt == null, '…in the draft state, published by nobody');
      ok(saved.render && /FICO/.test(saved.render.headline) && saved.render.live === false,
        '…and comes back with a render that says plainly it is not live');

      const live = await ruleStore.rulesForProgram(db, SCOPE, inv.id, prg.id);
      ok(live.length === 0, 'the set the ENGINE evaluates is still empty — the draft is invisible to it');
      // Priced through the real evaluator: with the draft saved, a 645-FICO loan is charged nothing.
      const priced = evaluateRules(live, { fico: 645 });
      ok(priced.adjustments.length === 0,
        'a loan priced against the live set is not adjusted by the draft — the boundary is the table, not a flag anyone has to remember');

      // The draft is READABLE and re-checked on every read, without being live.
      const view = await authStore.renderDraft(db, SCOPE, saved.draft.id);
      ok(view && view.publishable === true && view.blockedBy.length === 0, 'the draft reads back as publishable, with nothing blocking it');
      ok(view.render.cell === 'fico [640, 660)', '…and reports the cell it covers');
      const list = await authStore.listDrafts(db, SCOPE, where);
      ok(list.length === 1 && list[0].id === saved.draft.id, 'it is listed as an open draft');
    });

    // =========================================================================
    // C. PUBLISHING REFUSES WITHOUT A NAMED HUMAN — in the store and in the DB.
    // =========================================================================
    await section('C. publishing records who decided it', async () => {
      const nobody = await authStore.publishDraft(db, SCOPE, saved.draft.id, {});
      ok(nobody.ok === false && nobody.refusals[0].code === 'publisher_required',
        'publishing with nobody named is REFUSED');
      ok(/who is publishing/i.test(nobody.refusals[0].message), '…in words that say what to do about it');
      const blank = await authStore.publishDraft(db, SCOPE, saved.draft.id, { publishedBy: '   ' });
      ok(blank.ok === false && blank.refusals[0].code === 'publisher_required', 'a blank name is not a name');

      const stillDraft = await authStore.getDraft(db, SCOPE, saved.draft.id);
      ok(stillDraft.status === 'draft', '…and the refusal left the draft exactly as it was');

      // The database refuses it too, so the rule cannot be got round by writing the row directly.
      let dbRefused = false;
      try {
        await db.query(`UPDATE lt_ppe_rule_draft SET status = 'published' WHERE id = $1`, [saved.draft.id]);
      } catch (e) { dbRefused = e && e.code === '23514'; }
      ok(dbRefused, 'the DATABASE refuses a published draft that names nobody — the guard is not only in the code');
    });

    // =========================================================================
    // B. THE ROUND TRIP — publish, read back through the engine's own mapper,
    //    and price it.
    // =========================================================================
    await section('B. the authored rule survives Postgres and the engine runs it', async () => {
      const pub = await authStore.publishDraft(db, SCOPE, saved.draft.id, { publishedBy: 'admin@ys', note: 'reviewed with the desk' });
      ok(pub.ok === true && pub.ruleId, 'the draft publishes when somebody is named');
      ok(pub.draft.status === 'published' && pub.draft.publishedBy === 'admin@ys' && pub.draft.publishedAt,
        '…and the draft records who published it, and when');

      const live = await ruleStore.rulesForProgram(db, SCOPE, inv.id, prg.id);
      ok(live.length === 1 && live[0].code === intent.code, 'the rule is NOW in the set the engine evaluates');

      // The stored row is asked DIRECTLY whether it kept the adjustment, before the engine is asked to
      // price it. Without this the only symptom of a dropped column is the interpreter throwing, which
      // reads as a broken test rather than as the round trip losing the money.
      const storedRow = await db.query('SELECT adjustment FROM lt_ppe_rule WHERE id = $1', [pub.ruleId]);
      ok(storedRow.rows[0] && storedRow.rows[0].adjustment && storedRow.rows[0].adjustment.adjMilli === 250,
        'the pricing rule\'s adjustment is stored on the row, at the authored amount');

      // ⛔ THE ASSERTION THIS WHOLE BUILD IS FOR. The rule went: authored by the service → stored as a
      // draft → published into lt_ppe_rule (shredded into columns) → read back by rowToRule → priced
      // by the real interpreter. Every one of those steps could quietly lose the adjustment.
      const at645 = evaluateRules(live, { fico: 645 });
      ok(at645.adjustments.length === 1 && at645.adjustments[0].adjMilli === 250 && at645.adjustments[0].unit === 'points',
        'the REAL engine charges exactly the authored 250 milli-points, after a full round trip through Postgres');
      ok(evaluateRules(live, { fico: 640 }).adjustments.length === 1, '…at the band\'s low edge');
      ok(evaluateRules(live, { fico: 660 }).adjustments.length === 0,
        '…and NOT at the high edge — the half-open band survives the database as well as the authoring');
      ok(evaluateRules(live, { fico: 700 }).adjustments.length === 0, '…and not above the band');
    });

    // The other three result kinds, each through the same full round trip. A `bound` and an
    // `eligibility` rule are shredded into DIFFERENT columns from a pricing rule, so proving one kind
    // survives proves nothing about the others.
    await section('B2. the other three result kinds survive the same round trip', async () => {
      const decline = await authStore.saveDraft(db, SCOPE, {
        op: 'add_eligibility', code: `no_ny_${stamp}`, declineReason: 'New York is not eligible on this program',
        when: { fact: 'state', op: 'eq', value: 'NY' },
      }, { ...where, createdBy: 'author@ys' });
      ok(decline.ok, 'an eligibility rule is authored');
      ok((await authStore.publishDraft(db, SCOPE, decline.draft.id, { publishedBy: 'admin@ys' })).ok, '…and published');

      const floor = await authStore.saveDraft(db, SCOPE, { op: 'add_price_bound', code: `floor_${stamp}`, bound: 'min', priceMilli: 99000 }, { ...where, createdBy: 'author@ys' });
      ok(floor.ok, 'a price floor is authored');
      ok((await authStore.publishDraft(db, SCOPE, floor.draft.id, { publishedBy: 'admin@ys' })).ok, '…and published');

      const hb = await authStore.saveDraft(db, SCOPE, { op: 'add_margin_holdback', code: `hb_${stamp}`, knob: 'holdback', milli: 375, when: { fact: 'dscr', op: 'lt', value: 1100 } }, { ...where, createdBy: 'author@ys' });
      ok(hb.ok, 'a holdback is authored');
      ok((await authStore.publishDraft(db, SCOPE, hb.draft.id, { publishedBy: 'admin@ys' })).ok, '…and published');

      const live = await ruleStore.rulesForProgram(db, SCOPE, inv.id, prg.id);
      const ny = evaluateRules(live, { state: 'NY', fico: 700, price: 100000, dscr: 1300 });
      ok(ny.eligible === false && ny.declines.some((d) => d.reason === 'New York is not eligible on this program'),
        'after the round trip the engine DECLINES a NY loan, quoting the reason the author typed');

      const tx = evaluateRules(live, { state: 'TX', fico: 700, price: 98000, dscr: 1300 });
      ok(tx.bounds['price:min'] && tx.bounds['price:min'].value === 99000 && tx.bounds['price:min'].satisfied === false,
        'the price FLOOR survives the round trip as a numeric bound and binds');

      const lowDscr = evaluateRules(live, { state: 'TX', fico: 700, price: 100000, dscr: 1000 });
      const holdbacks = lowDscr.adjustments.filter((a) => a.unit === 'holdback');
      ok(holdbacks.length === 1 && holdbacks[0].adjMilli === 375,
        'the HOLDBACK survives as a holdback — its unit was not flattened into points on the way through the database');
    });

    // =========================================================================
    // D. PUBLISH RE-CHECKS AGAINST THE SET AS IT IS NOW.
    // =========================================================================
    await section('D. the world can move while a draft sits', async () => {
      // Authored cleanly: at this moment there is no rule on the 700–720 cell.
      const later = await authStore.saveDraft(db, SCOPE, {
        op: 'add_llpa', code: `llpa_fico_700_${stamp}`, adjMilli: 100, dimension: 'fico',
        when: { fact: 'fico', op: 'between', value: [700, 720] },
      }, { ...where, createdBy: 'author@ys' });
      ok(later.ok, 'a second LLPA is authored with nothing in its way');

      // Somebody else publishes onto exactly that cell while the draft sits.
      const rival = await authStore.saveDraft(db, SCOPE, {
        op: 'add_llpa', code: `rival_${stamp}`, adjMilli: 175, dimension: 'fico',
        when: { fact: 'fico', op: 'between', value: [700, 720] },
      }, { ...where, createdBy: 'someone.else@ys' });
      ok(rival.ok && (await authStore.publishDraft(db, SCOPE, rival.draft.id, { publishedBy: 'admin@ys' })).ok,
        'meanwhile somebody else publishes a rule onto the very same cell');

      const now = await authStore.publishDraft(db, SCOPE, later.draft.id, { publishedBy: 'admin@ys' });
      ok(now.ok === false && now.refusals.some((r) => r.code === 'same_cell'),
        'the first draft is REFUSED at publish time — the set it was checked against is not the set it would join');
      ok(now.refusals.some((r) => new RegExp(`rival_${stamp}`).test(r.message)),
        '…naming the rule that got there first');
      ok((await authStore.getDraft(db, SCOPE, later.draft.id)).status === 'draft',
        '…and the refused draft is still a draft, not half-published');

      // The screen can see it coming, rather than only finding out on the button.
      const view = await authStore.renderDraft(db, SCOPE, later.draft.id);
      ok(view.publishable === false && view.blockedBy.some((r) => r.code === 'same_cell'),
        'reading the draft now says it is blocked and why — the findings are re-run on every read, never stored stale');
    });

    // =========================================================================
    // E. Two people, one rule; and nothing published twice.
    // =========================================================================
    await section('E. collisions between people, and no double publish', async () => {
      const first = await authStore.saveDraft(db, SCOPE, {
        op: 'add_llpa', code: `shared_${stamp}`, adjMilli: 50, dimension: 'ltv', when: { fact: 'ltv', op: 'lt', value: 60000 },
      }, { ...where, createdBy: 'a@ys' });
      ok(first.ok, 'one person starts a draft');
      const second = await authStore.saveDraft(db, SCOPE, {
        op: 'add_llpa', code: `shared_${stamp}`, adjMilli: 75, dimension: 'ltv', when: { fact: 'ltv', op: 'lt', value: 65000 },
      }, { ...where, createdBy: 'b@ys' });
      ok(second.ok === false && second.refusals[0].code === 'draft_exists',
        'a second person drafting the same rule is REFUSED — the partial unique index decides it, not whoever saved last');
      ok(/already drafting/i.test(second.refusals[0].message), '…in words that say what happened');

      const disc = await authStore.discardDraft(db, SCOPE, first.draft.id, { note: 'changed our mind' });
      ok(disc.ok && disc.draft.status === 'discarded', 'a draft can be discarded');
      const gone = await authStore.getDraft(db, SCOPE, first.draft.id);
      ok(gone && gone.status === 'discarded', '…and is KEPT for the record — nothing here is deleted');

      const third = await authStore.saveDraft(db, SCOPE, {
        op: 'add_llpa', code: `shared_${stamp}`, adjMilli: 75, dimension: 'ltv', when: { fact: 'ltv', op: 'lt', value: 65000 },
      }, { ...where, createdBy: 'b@ys' });
      ok(third.ok, '…and once discarded, the name is free again');

      ok((await authStore.publishDraft(db, SCOPE, third.draft.id, { publishedBy: 'admin@ys' })).ok, 'it publishes');
      const again = await authStore.publishDraft(db, SCOPE, third.draft.id, { publishedBy: 'admin@ys' });
      ok(again.ok === false && again.refusals[0].code === 'not_open',
        'publishing the SAME draft twice is refused — nothing is published a second time');
    });

    // =========================================================================
    // F. A draft that could never fire never reaches the table at all.
    // =========================================================================
    await section('F. a dead rule is refused before it is stored', async () => {
      const dead = await authStore.saveDraft(db, SCOPE, {
        op: 'create',
        rule: { code: `dead_${stamp}`, kind: 'pricing', adjustment: { adjMilli: 100, unit: 'points', category: 'fico' },
          when: { all: [{ fact: 'fico', op: 'gte', value: 700 }, { fact: 'fico', op: 'lt', value: 650 }] } },
      }, { ...where, createdBy: 'author@ys' });
      // `(dead.refusals || [])` on purpose: a store that ACCEPTED this rule returns no refusals at all,
      // and reading `[0]` off that throws — which would report this as a broken test rather than as the
      // guard being gone. The assertion has to survive being wrong.
      ok(dead.ok === false && (dead.refusals || []).some((r) => r.code === 'never_fires'), 'a rule that can never fire is refused');
      const rows = await db.query('SELECT count(*)::int AS n FROM lt_ppe_rule_draft WHERE scope = $1 AND code = $2', [SCOPE, `dead_${stamp}`]);
      ok(rows.rows[0].n === 0, '…and nothing was written — a refusal that still stored the row would be no refusal at all');
    });

    await cleanup();
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    failures += 1;
    await cleanup().catch(() => {});
  }

  console.log(`\n${failures ? `FAILURES: ${failures}` : 'all passed'}`);
  await db.pool.end().catch(() => {});
  process.exit(failures ? 1 : 0);
})();
