'use strict';
/**
 * LT PPE — THE RULE-AUTHORING STORE (db/577 `lt_ppe_rule_draft`). The durable half of
 * `rule-authoring.js`: it saves a rule somebody is working on, and it is the ONE place a draft can
 * become a rule that prices loans.
 *
 * ⛔ THIS IS WHERE "AUTHORING IS NOT PUBLISHING" IS ENFORCED, AND IT IS ENFORCED BY THE SHAPE OF THE
 * DATA, NOT BY ANYONE REMEMBERING IT. Drafts live in `lt_ppe_rule_draft`. The set an engine actually
 * evaluates is `rule-store.rulesForProgram`, which selects from `lt_ppe_rule` and has never heard of
 * the draft table. So every write in this file except `publishDraft` is, structurally, incapable of
 * changing a priced number — not "careful not to", incapable. The reason it is built that way rather
 * than as an `active=false` flag on the live table is written out in db/577's header; the short version
 * is that a boundary made of a boolean somebody has to set correctly is a boundary that fails silently
 * on a Friday, and the symptom is a wrong LLPA pricing real loans with nothing anywhere recording that
 * it was never reviewed.
 *
 * ⛔ `publishDraft` IS THE DELIBERATE, SEPARATE, RECORDED ACT. It is a differently named function that:
 *   · refuses without a named human (`publishedBy`) — the recording IS the authorization, the same
 *     discipline `store.publishRateSheetVersion` applies to a rate-sheet override, and db/577's own
 *     CHECK constraint refuses the published-with-nobody-named row at the database as well;
 *   · RE-RUNS the full authoring check against the ruleset AS IT IS NOW, not as it was when the draft
 *     was written. A draft can sit for a week while somebody else publishes a rule onto the same cell,
 *     so the set it was checked against is not the set it joins. Trusting the earlier check is how the
 *     double charge this service exists to prevent gets in through the back door;
 *   · does the whole thing in ONE transaction, so there is no state where the live rule exists and
 *     nothing records which draft it came from.
 *
 * ⛔ IT REFUSES BY RETURNING, NOT BY THROWING. `{ ok:false, refusals:[…] }` is a shape the caller must
 * look at, and it carries the same plain-language refusals a screen already knows how to render. A
 * throw would be indistinguishable at the route from a database being down, which is a different
 * problem with a different answer.
 *
 * ⛔ WHAT IS DELIBERATELY NOT HERE: RETIRING A LIVE RULE. `lt_ppe_rule.active` and its effective-dating
 * already express it, and nothing in this file writes them. That leaves one real gap, recorded rather
 * than half-solved: RENAMING a live rule. A draft that edits rule A under a NEW code publishes as a
 * SECOND rule, so if it covers A's cell the publish is refused as a double charge — correctly, because
 * publishing both WOULD be one. The way through is to retire A, and "who may switch off a rule that is
 * pricing loans, and does it retire or effective-date" is an owner decision with the same weight as who
 * may publish. Inventing an answer here would put a rule out of service on somebody's say-so with
 * nothing recording it, which is the failure this whole file is shaped against.
 *
 * `db` is a pg pool/client exposing `.query()` (and `.getClient()`/`.connect()` for the transaction) —
 * the same contract `rule-store.js` takes. LT-only. No RTL imports.
 */

const authoring = require('./rule-authoring');
const ruleStore = require('./rule-store');

function refusal(code, message, extra = {}) { return { code, message, ...extra }; }

/** The canonical rule a draft row holds. `rule` is stored verbatim (db/577) — nothing to re-assemble. */
function rowToDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    investorId: row.investor_id,
    programId: row.program_id,
    code: row.code,
    kind: row.kind,
    rule: row.rule,
    status: row.status,
    basedOnRuleId: row.based_on_rule_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedRuleId: row.published_rule_id,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
    publishNote: row.publish_note,
  };
}

/**
 * The rules a draft would JOIN — house rules plus this investor's plus this program's, effective-dated.
 *
 * ⛔ IT IS `rulesForProgram`, NOT `listRules`, FOR THE REASON `rule-store.coverageForProgram` GIVES:
 * two rules collide only if they can both fire on ONE loan, so the set to check against is exactly the
 * set that evaluates together. Checking against every row in the table instead would refuse a house
 * rule for colliding with another investor's rule — two rules that can never meet.
 */
async function targetRuleset(db, scope, investorId, programId) {
  return ruleStore.rulesForProgram(db, scope, investorId ?? null, programId ?? null);
}

/**
 * AUTHOR AND SAVE. Runs the intent through the service, and stores the result as a DRAFT if it passed.
 *
 *   intent — see `rule-authoring.applyIntent`
 *   opts   — { investorId, programId, rule (the rule being edited), basedOnRuleId, replacingCode,
 *              note, createdBy }
 *
 * Returns { ok:true, draft, render, warnings } or { ok:false, refusals, warnings }.
 */
async function saveDraft(db, scope, intent, opts = {}) {
  const ruleset = await targetRuleset(db, scope, opts.investorId, opts.programId);
  const out = authoring.applyIntent(intent, {
    rule: opts.rule,
    ruleset,
    // A draft that REPLACES a live rule must not be refused as a duplicate of the very rule it
    // replaces — that would make editing a live rule impossible, which is a dead end rather than a
    // guard. Defaults to the edited rule's own code, which is the ordinary case.
    replacingCode: opts.replacingCode !== undefined ? opts.replacingCode : (opts.rule && opts.rule.code),
  });
  if (!out.ok) return { ok: false, refusals: out.refusals, warnings: out.warnings };

  const rule = out.rule;
  let r;
  try {
    r = await db.query(
      `INSERT INTO lt_ppe_rule_draft
         (scope, investor_id, program_id, code, kind, rule, status, based_on_rule_id, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'draft',$7,$8,$9)
       RETURNING *`,
      [scope, opts.investorId ?? null, opts.programId ?? null, rule.code, rule.kind,
        JSON.stringify(rule), opts.basedOnRuleId ?? null, opts.note ?? null, opts.createdBy ?? null]);
  } catch (e) {
    // The partial unique index is the ONE place "somebody else is already drafting this" is decided —
    // two people saving at the same instant is a race a read-then-write cannot win, so the refusal is
    // read off the database's own answer rather than guessed at beforehand.
    if (e && e.code === '23505') {
      return { ok: false, warnings: out.warnings, refusals: [refusal('draft_exists',
        `Somebody is already drafting a rule called "${rule.code}" here. Open that draft and continue it, or publish or discard it first.`,
        { field: 'code' })] };
    }
    throw e;
  }
  const draft = rowToDraft(r.rows[0]);
  return { ok: true, draft, render: out.render, warnings: out.warnings };
}

/** Read one draft (any status), or null. */
async function getDraft(db, scope, id) {
  const r = await db.query('SELECT * FROM lt_ppe_rule_draft WHERE scope = $1 AND id = $2', [scope, id]);
  return rowToDraft(r.rows[0]);
}

/** List drafts. opts { status (default 'draft', 'all' for every status), investorId, programId }. */
async function listDrafts(db, scope, opts = {}) {
  const where = ['scope = $1'];
  const params = [scope];
  if (opts.status !== 'all') { params.push(opts.status || 'draft'); where.push(`status = $${params.length}`); }
  if (opts.investorId !== undefined) { params.push(opts.investorId); where.push(`investor_id IS NOT DISTINCT FROM $${params.length}`); }
  if (opts.programId !== undefined) { params.push(opts.programId); where.push(`program_id IS NOT DISTINCT FROM $${params.length}`); }
  const r = await db.query(`SELECT * FROM lt_ppe_rule_draft WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC`, params);
  return r.rows.map(rowToDraft);
}

/**
 * The draft as a screen would show it, WITH its findings re-computed against the ruleset as it is now.
 *
 * ⛔ THE FINDINGS ARE RE-RUN ON EVERY READ AND ARE NEVER STORED. A stored warning is a statement about
 * a rule set that has since moved, and it goes stale invisibly: the screen would keep showing a
 * collision that was resolved yesterday, or — far worse — keep showing a clean bill of health for a
 * collision that appeared this morning. They are cheap and pure, so the honest thing is to ask again.
 */
async function renderDraft(db, scope, id) {
  const draft = await getDraft(db, scope, id);
  if (!draft) return null;
  const ruleset = await targetRuleset(db, scope, draft.investorId, draft.programId);
  const checks = authoring.checkRule(draft.rule, { ruleset, replacingCode: draft.code });
  return {
    draft,
    render: authoring.renderRule(draft.rule, { warnings: checks.warnings }),
    warnings: checks.warnings,
    // A draft whose findings have turned into refusals since it was written is one that CANNOT be
    // published as it stands. Saying so on the screen is the difference between a person fixing it now
    // and a person pressing Publish and being refused with no idea why.
    blockedBy: checks.refusals,
    publishable: checks.refusals.length === 0,
  };
}

/** Discard a draft. Kept for the record — nothing here is deleted. */
async function discardDraft(db, scope, id, opts = {}) {
  const r = await db.query(
    `UPDATE lt_ppe_rule_draft
        SET status = 'discarded', note = COALESCE($3, note), updated_at = now()
      WHERE scope = $1 AND id = $2 AND status = 'draft'
      RETURNING *`, [scope, id, opts.note ?? null]);
  if (!r.rows.length) return { ok: false, refusals: [refusal('not_open', 'That draft is not open — it has already been published or discarded.')] };
  return { ok: true, draft: rowToDraft(r.rows[0]) };
}

/**
 * PUBLISH — the one act in this file that changes what a loan is priced at.
 *
 * It writes the draft's rule into `lt_ppe_rule`, where `rulesForProgram` will pick it up on the next
 * quote, and marks the draft published with who did it. ONE transaction, and every refusal happens
 * before anything is written.
 *
 * `opts` { publishedBy (REQUIRED), note, priority }.
 * Returns { ok:true, ruleId, draft } or { ok:false, refusals }.
 */
async function publishDraft(db, scope, id, opts = {}) {
  // ⛔ NO NAME, NO PUBLISH — checked first and outside the transaction, because a refusal must not
  // leave a BEGIN hanging. This is not a formality: a rule that starts pricing loans with nothing
  // recording who decided that is exactly the state the draft table exists to make impossible, and
  // db/577's CHECK refuses the row as well, so this cannot be bypassed by writing the row directly.
  const publishedBy = typeof opts.publishedBy === 'string' ? opts.publishedBy.trim() : '';
  if (!publishedBy) {
    return { ok: false, refusals: [refusal('publisher_required',
      'Publishing a rule makes it price real loans, so it has to record who decided that. Say who is publishing it.',
      { field: 'publishedBy' })] };
  }

  const client = await (typeof db.getClient === 'function' ? db.getClient() : db.connect());
  try {
    await client.query('BEGIN');
    const dres = await client.query('SELECT * FROM lt_ppe_rule_draft WHERE scope = $1 AND id = $2 FOR UPDATE', [scope, id]);
    const row = dres.rows[0];
    if (!row) { await client.query('ROLLBACK'); return { ok: false, refusals: [refusal('not_found', 'That draft no longer exists.')] }; }
    if (row.status !== 'draft') {
      await client.query('ROLLBACK');
      return { ok: false, refusals: [refusal('not_open', `That draft was already ${row.status}. Nothing was published a second time.`)] };
    }

    // ⛔ RE-CHECKED AGAINST THE SET AS IT IS NOW, INSIDE THE TRANSACTION. The set the draft was
    // authored against is not the set it joins: a draft can sit for a week while somebody else
    // publishes a rule onto the same cell. Re-running the checks here is the only point at which the
    // answer is about the world the rule is actually entering.
    const ruleset = await ruleStore.rulesForProgram(client, scope, row.investor_id ?? null, row.program_id ?? null);
    const checks = authoring.checkRule(row.rule, { ruleset, replacingCode: row.code });
    if (checks.refusals.length) {
      await client.query('ROLLBACK');
      return { ok: false, refusals: checks.refusals, warnings: checks.warnings };
    }

    const rule = row.rule;
    const rres = await client.query(
      `INSERT INTO lt_ppe_rule
         (scope, investor_id, program_id, code, kind, source, predicate, decline_reason,
          bound_target, bound_op, bound_value, adjustment, priority, description, origin, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13,$14,'manual',$15)
       ON CONFLICT (scope,
                    COALESCE(investor_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    COALESCE(program_id, '00000000-0000-0000-0000-000000000000'::uuid), code)
         DO UPDATE SET kind = EXCLUDED.kind, source = EXCLUDED.source, predicate = EXCLUDED.predicate,
                       decline_reason = EXCLUDED.decline_reason, bound_target = EXCLUDED.bound_target,
                       bound_op = EXCLUDED.bound_op, bound_value = EXCLUDED.bound_value,
                       adjustment = EXCLUDED.adjustment, priority = EXCLUDED.priority,
                       description = EXCLUDED.description, active = true, updated_at = now()
       RETURNING id`,
      [scope, row.investor_id ?? null, row.program_id ?? null, rule.code, rule.kind, rule.source || 'overlay',
        rule.when === undefined ? null : JSON.stringify(rule.when),
        rule.kind === 'eligibility' ? (rule.declineReason || null) : null,
        rule.kind === 'bound' ? (rule.target || null) : null,
        rule.kind === 'bound' ? (rule.op || null) : null,
        rule.kind === 'bound' ? (rule.value ?? null) : null,
        rule.kind === 'pricing' ? JSON.stringify(rule.adjustment || null) : null,
        opts.priority !== undefined ? opts.priority : (rule.priority || 0),
        rule.description || null, publishedBy]);
    const ruleId = rres.rows[0].id;

    const ures = await client.query(
      `UPDATE lt_ppe_rule_draft
          SET status = 'published', published_rule_id = $3, published_by = $4, published_at = now(),
              publish_note = $5, updated_at = now()
        WHERE scope = $1 AND id = $2
        RETURNING *`, [scope, id, ruleId, publishedBy, opts.note ?? null]);

    await client.query('COMMIT');
    return { ok: true, ruleId, draft: rowToDraft(ures.rows[0]), warnings: checks.warnings };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  saveDraft, getDraft, listDrafts, renderDraft, discardDraft, publishDraft,
  targetRuleset, rowToDraft,
};
