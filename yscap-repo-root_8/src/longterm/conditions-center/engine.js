'use strict';
/**
 * LONG-TERM — THE GENERAL CONDITION CENTER'S ENGINE.
 *
 * Decides which conditions belong on one loan, puts them there, and takes off
 * the ones that no longer apply. It is the ONE writer of `checklist_items`
 * rows whose `origin` is `auto`.
 *
 * ── SIX RULES, EACH OF WHICH COST SOMEBODY SOMETHING TO LEARN ───────────────
 *
 * 1. ONE CONDITION PER TEMPLATE PER FILE, AND THE DATABASE ENFORCES IT.
 *    The short-term side suppressed duplicates by READING the file, deciding a
 *    template had no instance, and THEN inserting — with nothing in between. Two
 *    passes at the same instant both read "not there" and both inserted, and
 *    ordinary traffic produced duplicates (db/401). Here the unique index is the
 *    guarantee and this pass takes a per-file advisory lock as well; the lock
 *    stops the churn, the index stops the duplicate.
 *
 * 2. THE LOCK FAILS OPEN. If it cannot be taken the pass still runs. A missed
 *    lock costs at most one row the index would refuse anyway; refusing to
 *    evaluate would silently stop conditions attaching, which nobody notices.
 *
 * 3. ONLY WHAT THE ENGINE PUT THERE MAY THE ENGINE TAKE AWAY, and only while
 *    NOBODY HAS TOUCHED IT. A condition somebody has worked — a note, a
 *    document, a status past `outstanding`, a waiver — is theirs. It is marked
 *    `not_applicable` at most, never deleted, because "we asked for this and
 *    then decided we did not need it" is part of the story of the loan.
 *
 * 4. A RULE THAT CANNOT BE READ ATTACHES NOTHING AND RETRACTS NOTHING.
 *    `rules.evaluateRule` answers `null` for "cannot say", and this pass treats
 *    that as leave-everything-alone. Reading it as false would silently strip a
 *    real requirement off files, which is the expensive direction: nobody
 *    notices a condition that is not there.
 *
 * 5. A BORROWER-FACING CONDITION WITH NO BORROWER WORDING IS APPLIED
 *    STAFF-ONLY. Showing a client an internal label is worse than not showing
 *    them the condition, and it is a mistake that reads as working.
 *
 * 6. IT NEVER THROWS AT ITS CALLER. Every door that changes a file calls this
 *    afterwards; a failure here must never turn somebody's successful save into
 *    an error. It reports what it did, including what it could not do.
 *
 * ── WHERE THE ROWS LIVE (db/652 + db/653) ───────────────────────────────────
 *
 * The conditions themselves are `checklist_items` in the ONE Condition Center,
 * owned by `lt_loan_id` with `scope='lt_loan'` — the owner's *"take that exact
 * Condition Center and make your conditions in that Condition Center follow
 * those rules"* (2026-08-30 share-the-code directive). The CONTEXT a rule is
 * evaluated against is still read from `lt_*` and nowhere else: what a rule
 * knows about a loan is Long-Term's own business.
 *
 * ENCOMPASS: reads OUR mirror of it; nothing here implies a write to Encompass.
 */

const db = require('../db');
const rules = require('./rules');
const registry = require('./field-registry');
const vocab = require('./vocabulary');
// WHO OWNS A CONDITION ROW — the one descriptor, shared with the short-term side
// (db/652 made the Long-Term loan the fourth owner scope; db/653 finished the
// vocabulary). Every statement below says who it is about through this rather
// than by hand-writing `lt_loan_id = $1`: the hand-written predicate is the one
// that drifts, and a drifted owner predicate is a condition from one loan
// answering for another.
const { ownerOf, ownerWhere, ownerCols } = require('../../lib/condition-owner');

/** A status past this means a human has been at it. */
const UNTOUCHED = 'outstanding';

/**
 * Everything a rule can ask about one loan, in one round trip per table.
 *
 * Each read is its OWN try/catch: a rule about the property must still be
 * answerable when the borrower's residences are unreadable, and a whole
 * evaluation must not be lost to one bad join. What could not be read is
 * REPORTED (`unreadable`) rather than silently treated as empty — the difference
 * between "this borrower has no other mortgages" and "we could not look" is the
 * difference between a correct answer and a confident wrong one.
 */
async function loadContext(loanId, client = db) {
  const ctx = { loanId: String(loanId), unreadable: [] };

  const one = async (name, sql, params, assign) => {
    try {
      const { rows } = await client.query(sql, params);
      assign(rows);
    } catch (e) {
      ctx.unreadable.push({ what: name, why: String((e && e.message) || e).slice(0, 200) });
      assign(null);
    }
  };

  await one('loan',
    `SELECT l.*, p.state, p.gse_property_type, p.unit_count, p.in_flood_zone,
            p.appraised_value, p.purchase_price, p.ltv_pct, p.occupancy_type,
            p.gross_monthly_rent
       FROM lt_loans l LEFT JOIN lt_properties p ON p.loan_id = l.id
      WHERE l.id = $1::uuid`,
    [ctx.loanId],
    (rows) => {
      const r = rows && rows[0];
      ctx.loan = r || null;
      // The property columns ride on the same row; splitting them here keeps
      // the registry's readers honest about which table a field came from.
      ctx.property = r
        ? {
          state: r.state, gse_property_type: r.gse_property_type, unit_count: r.unit_count,
          in_flood_zone: r.in_flood_zone, appraised_value: r.appraised_value,
          purchase_price: r.purchase_price, ltv_pct: r.ltv_pct,
          occupancy_type: r.occupancy_type, gross_monthly_rent: r.gross_monthly_rent,
        }
        : null;
    });

  await one('parties',
    `SELECT pa.* FROM lt_parties pa
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid`,
    [ctx.loanId], (rows) => { ctx.parties = rows || []; });

  await one('residences',
    `SELECT r.* FROM lt_residences r
       JOIN lt_parties pa ON pa.id = r.party_id
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid`,
    [ctx.loanId], (rows) => { ctx.residences = rows || []; });

  await one('liabilities',
    `SELECT li.* FROM lt_liabilities li
       JOIN lt_parties pa ON pa.id = li.party_id
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid`,
    [ctx.loanId], (rows) => { ctx.liabilities = rows || []; });

  await one('reo',
    `SELECT re.* FROM lt_reo_properties re
       JOIN lt_parties pa ON pa.id = re.party_id
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid`,
    [ctx.loanId],
    (rows) => {
      ctx.reo = rows || [];
      // `reoRead` is what lets the registry answer 0 rather than null: an empty
      // list after a SUCCESSFUL read is a real "none", and after a failed one it
      // is not. Without the flag the two are indistinguishable.
      ctx.reoRead = rows !== null;
    });

  ctx.values = registry.read(ctx);
  return ctx;
}

/**
 * The active, enabled library — the templates the engine may attach.
 *
 * `manual` templates are excluded: they exist so a person can add one by hand,
 * and attaching them automatically would be exactly the opposite of what the
 * word means.
 */
async function loadLibrary(client = db) {
  // The library seeds itself the first time anything asks for it — never at
  // boot, where it would race the migration that creates its table. Never
  // throws; a failed seed leaves whatever is already there.
  await require('./library').ensureSeeded(client);
  // `scope='lt_loan'` is the product separation here, by the table's own
  // original design: every RTL selector is already scope-filtered, so an
  // lt_loan template is invisible to the RTL engine by construction, and the
  // reverse.
  const { rows } = await client.query(
    `SELECT id, code, label, hint, borrower_label, borrower_hint,
            audience, item_kind, tool_key, category, auto_apply, rule_logic,
            is_required, slots, config, sort_order
       FROM checklist_templates
      WHERE scope = 'lt_loan' AND is_active = true AND auto_apply IN ('always','rules')
      ORDER BY sort_order, code`,
  );
  // Translated back into the wording the rules are written in, so `decide`,
  // `effectiveAudience` and the library's own vocabulary stay one language.
  return rows.map((r) => ({
    ...r,
    bucket_key: vocab.bucketOf(r.category),
    audience: vocab.audienceFromShared(r.audience),
    kind: vocab.kindFromShared(r),
    config: r.config || {},
    is_enabled: !(r.config && r.config.enabled === false),
    disabled_reason: (r.config && r.config.disabledReason) || null,
  }));
}

/**
 * Decide, for one loan and one template, whether the condition applies.
 *
 * PURE — it is handed the values rather than a database — so the whole decision
 * table is unit-testable, and so "why is this condition here?" can be answered
 * without a Postgres.
 *
 * @returns {{apply: true|false|null, why: string}}
 */
function decide(template, values, fields) {
  if (template.auto_apply === 'always') return { apply: true, why: 'This condition is on every long-term file.' };

  const verdict = rules.evaluateRule(template.rule_logic, values, fields);
  if (verdict === null) {
    return {
      apply: null,
      // NAMED, not vague. "We could not read this rule" and "this file does not
      // match" are different problems for different people.
      why: 'PILOT could not read this condition’s rule against this file, so it left the file as it found it.',
    };
  }
  return {
    apply: verdict,
    why: verdict
      ? `This file matches: ${rules.describeRule(template.rule_logic, fields)}`
      : `This file does not match: ${rules.describeRule(template.rule_logic, fields)}`,
  };
}

/**
 * Which audience a template actually gets on a file.
 *
 * Rule 5: a template that says it is borrower-facing but carries no borrower
 * wording is applied STAFF-ONLY. Showing a client a condition under an internal
 * label is worse than not showing it at all, and it is the kind of mistake that
 * reads as working.
 */
function effectiveAudience(template) {
  const wants = String(template.audience || 'internal');
  if (wants === 'internal') return { audience: 'internal', downgraded: false };
  const hasWording = !!String(template.borrower_label || '').trim();
  if (hasWording) return { audience: wants, downgraded: false };
  return { audience: 'internal', downgraded: true };
}

/**
 * Evaluate one loan and bring its conditions into line.
 *
 * NEVER THROWS. Returns
 *   `{ok, added:[], removed:[], unchanged, skipped:[], degraded}`
 * so a caller can report what happened — and so a pass that did nothing because
 * it could not read anything is distinguishable from one that had nothing to do.
 */
async function evaluateLoan(loanId, opts = {}) {
  const client = opts.db || db;
  const out = { ok: true, added: [], removed: [], unchanged: 0, skipped: [], degraded: null, locked: false };
  // FAILS CLOSED AND LOUDLY. `ownerOf` throws on a missing id rather than
  // building a statement around a NULL owner — which on `checklist_items` the
  // database would refuse, and on `documents` (no owner-count constraint there)
  // it would not. It is made here, once, and passed down.
  let owner;
  try {
    owner = ownerOf('lt_loan', loanId);
  } catch (e) {
    out.ok = false;
    out.degraded = String((e && e.message) || e).slice(0, 300);
    return out;
  }

  // THE LOCK IS PER FILE and lives on its own connection, so it is held for the
  // whole pass rather than being handed back to the pool between statements.
  // Database-wide, so it holds across the web process, the worker and every
  // instance — a JavaScript mutex would not.
  let lockClient = null;
  if (!opts.skipLock) {
    try {
      lockClient = await client.getClient();
      await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`lt-cond:${loanId}`]);
      out.locked = true;
    } catch (_) {
      // FAILS OPEN, deliberately (rule 2).
      if (lockClient) { try { lockClient.release(); } catch (_e) { /* nothing to do */ } }
      lockClient = null;
    }
  }

  try {
    const ctx = await loadContext(loanId, client);
    if (!ctx.loan) {
      out.ok = false;
      out.degraded = 'No such long-term loan, or it could not be read.';
      return out;
    }
    if (ctx.unreadable.length) out.degraded = ctx.unreadable.map((u) => u.what).join(', ');

    const library = await loadLibrary(client);
    const fields = registry.fieldMap();

    const where = ownerWhere(owner);
    const { rows: existing } = await client.query(
      `SELECT id, template_id, status, origin_kind, notes, field_key
         FROM checklist_items WHERE ${where.sql}`,
      where.params,
    );
    const byTemplate = new Map();
    for (const r of existing) if (r.template_id) byTemplate.set(String(r.template_id), r);

    for (const t of library) {
      const verdict = decide(t, ctx.values, fields);
      const have = byTemplate.get(String(t.id));

      if (verdict.apply === null) {
        // Rule 4: attach nothing, retract nothing, and SAY SO.
        out.skipped.push({ code: t.code, why: verdict.why });
        continue;
      }

      if (verdict.apply === true) {
        if (have) { out.unchanged += 1; continue; }
        const { audience, downgraded } = effectiveAudience(t);
        try {
          // ownerCols writes ONE owner column and NULLs every other, so
          // `chk_one_owner` holds by construction rather than by this call site
          // remembering which columns exist this month.
          const cols = ownerCols(owner);
          const { item_kind, tool_key } = vocab.kindToShared(t.kind);
          const { rows } = await client.query(
            `INSERT INTO checklist_items
               (scope, application_id, lt_loan_id, template_id, category,
                label, hint, borrower_label, borrower_hint, audience,
                item_kind, tool_key, is_required, slots, origin_kind, sort_order)
             VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5,
                     $6, $7, $8, $9, $10,
                     $11, $12, $13, $14::jsonb, 'auto', $15)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [owner.scope, cols.application_id, cols.lt_loan_id, t.id, vocab.categoryOf(t.bucket_key),
              t.label, t.hint, t.borrower_label, t.borrower_hint, vocab.audienceToShared(audience),
              item_kind, tool_key, t.is_required,
              // The per-instance required-slot list — the ONE column the shared
              // generic sign-off arm reads (db/653). The CONFIG deliberately
              // stays on the template and is read through the join: one config,
              // edited once, so a settings change reaches every open file rather
              // than only the next one.
              JSON.stringify(t.slots || []), t.sort_order],
          );
          // ON CONFLICT DO NOTHING returns no row when the unique index refused
          // a duplicate — which is the index doing its job, not a failure.
          if (rows.length) out.added.push({ code: t.code, label: t.label, bucket: t.bucket_key, downgraded });
          else out.unchanged += 1;
        } catch (e) {
          out.skipped.push({ code: t.code, why: `Could not add it: ${String((e && e.message) || e).slice(0, 160)}` });
        }
        continue;
      }

      // verdict.apply === false — the rule says it does not belong here.
      if (!have) continue;
      // Rule 3: only ours, and only untouched.
      const untouched = have.origin_kind === 'auto' && have.status === UNTOUCHED && !String(have.notes || '').trim();
      if (!untouched) { out.unchanged += 1; continue; }
      try {
        // THE WHOLE TEST IS INSIDE THE DELETE, deliberately: the read above is
        // only a cheap early exit, and a document landing between that read and
        // this statement must not be able to lose its condition. The short-term
        // side does this as read-then-write, which is the shape db/401 records
        // as having produced real duplicates under ordinary traffic.
        const { rows } = await client.query(
          `DELETE FROM checklist_items
            WHERE id = $1::uuid AND origin_kind = 'auto' AND status = $2
              AND COALESCE(notes,'') = ''
              AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = checklist_items.id)
          RETURNING id`,
          [have.id, UNTOUCHED],
        );
        if (rows.length) out.removed.push({ code: t.code, label: t.label });
        else out.unchanged += 1;
      } catch (e) {
        out.skipped.push({ code: t.code, why: `Could not remove it: ${String((e && e.message) || e).slice(0, 160)}` });
      }
    }
  } catch (e) {
    // Rule 6: never throw at the caller.
    out.ok = false;
    out.degraded = String((e && e.message) || e).slice(0, 300);
  } finally {
    if (lockClient) {
      try { await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`lt-cond:${loanId}`]); }
      catch (_) { /* the connection is being released either way */ }
      try { lockClient.release(); } catch (_) { /* nothing to do */ }
    }
  }

  return out;
}

module.exports = {
  UNTOUCHED,
  loadContext,
  loadLibrary,
  decide,
  effectiveAudience,
  evaluateLoan,
};
