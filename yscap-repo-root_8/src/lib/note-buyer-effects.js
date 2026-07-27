'use strict';

/**
 * What a NOTE BUYER actually means for one loan file — computed, never hard-coded.
 *
 * The note buyer (`applications.lender`, the capital partner) quietly drives a lot:
 * rule-driven conditions attach and retract, the 5% Scope-of-Work contingency turns
 * on, the bank-statement month count can rise, and the data tape a non-admin may
 * export is gated on it. Until now the only way to SEE any of that was to change the
 * note buyer and watch what happened to the file, and the only way to change it was a
 * pencil icon on a muted line inside the ClickUp panel. The owner's report
 * (2026-07-27): "we need a better slot … right now I don't believe it's a clear path."
 *
 * This module is the read-only half of that slot: given a file and a candidate note
 * buyer, it answers "what would switching to this one do?" — BEFORE anything is
 * written. The write half stays where it already is (`complete-fields`, which sets
 * `lender`, re-runs the condition engine, re-enforces the SOW contingency and
 * re-derives liquidity) so there is still exactly ONE write path.
 *
 * DRIFT DISCIPLINE — everything here is derived from the same source the real
 * behavior runs on, never restated:
 *   · conditions      → the LIVE `checklist_templates.rule_logic` trees, evaluated by
 *                       the conditions engine's own `rules.evaluateRule` against the
 *                       file's own context with the note-buyer fields swapped. Only
 *                       templates whose rule actually MENTIONS the note buyer are
 *                       reported, so the preview is "what the note buyer does" and
 *                       not "what happens to be pending for other reasons".
 *   · SOW contingency → the same `bluelake` key + Gold-program branch as
 *                       `rehab-budget.sowContingencyRequired`.
 *   · bank statements → `liquidity.bankStatementMonths` itself.
 *   · data tapes      → `tapes/registry` + `tapes/program-provider` themselves.
 * Add a new note-buyer-driven behavior anywhere and it either shows up here on its
 * own (a rule) or gets one entry below (code) — never a second copy of the rule.
 *
 * STAFF-ONLY. A note buyer name is never exposed to a borrower (frozen rule), and
 * every caller of this module is behind the staff router.
 *
 * Best-effort by construction: every loader swallows its own error and the whole
 * function degrades to "no preview" rather than failing a file view.
 */

const db = require('../db');
const registry = require('./conditions/field-registry');
const rules = require('./conditions/rules');
const engine = require('./conditions/engine');

// The rule fields that ARE the note buyer. A template whose rule tree mentions one of
// these is note-buyer-driven; anything else is pending/retracting for its own reasons
// and must not be attributed to a note-buyer switch.
const NOTE_BUYER_FIELDS = ['note_buyer', 'note_buyer_is_fidelis'];

/** Does a rule tree reference any note-buyer field? Walks groups + rows. */
function mentionsNoteBuyer(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.rules)) return node.rules.some(mentionsNoteBuyer);
  return NOTE_BUYER_FIELDS.includes(node.field);
}

/**
 * The engine's own "untouched" test (engine.evaluateApplication) — only an auto
 * condition nobody has worked is ever retracted, so only those may be previewed as
 * dropping. Keep in lock-step with the engine.
 */
function isUntouched(inst) {
  return inst.origin_kind === 'auto' && inst.status === 'outstanding'
    && !inst.signed_off_at && !inst.reviewed_at && !inst.has_payload && !inst.has_docs && !inst.notes;
}

/** The file's registered program ('gold' | 'standard' | 'manual' | null). */
async function registeredProgram(appId, client = db) {
  try {
    const r = await client.query(
      `SELECT program, asset_months FROM product_registrations
        WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

/**
 * The standing requirements a note buyer brings to THIS file, in plain language.
 * Each line is derived from the module that enforces it — never a restatement.
 * `key` is stable so the UI can style/diff them; `text` is staff-facing (a note
 * buyer name here is fine — this whole surface is staff-only).
 */
function requirementsFor(label, { program, assetMonths }) {
  const key = registry.normNoteBuyer(label) || '';
  const out = [];
  const prog = String((program || '')).trim();

  // 5% Scope-of-Work contingency — rehab-budget.sowContingencyRequired: Gold program
  // OR a Blue Lake note buyer. Say WHICH of the two is carrying it so switching the
  // note buyer off Blue Lake on a Gold file doesn't read as "the rule went away".
  const isGold = /gold/i.test(prog);
  const isBlueLake = key === 'bluelake';
  if (isBlueLake || isGold) {
    out.push({
      key: 'sow_contingency',
      text: isBlueLake && isGold
        ? 'The Scope of Work must carry at least a 5% contingency (this note buyer requires it, and so does the Gold program this file is registered under).'
        : isBlueLake
          ? 'The Scope of Work must carry at least a 5% contingency — this note buyer requires it.'
          : 'The Scope of Work must carry at least a 5% contingency — the Gold program this file is registered under requires it (not the note buyer).',
      fromNoteBuyer: isBlueLake,
    });
  }

  // Bank statements — liquidity.bankStatementMonths is the authority (the stricter of
  // program and note buyer wins).
  try {
    const liq = require('./liquidity');
    const months = liq.bankStatementMonths(program, assetMonths, label);
    const withoutBuyer = liq.bankStatementMonths(program, assetMonths, null);
    if (Number.isFinite(months) && months > 0) {
      out.push({
        key: 'bank_statements',
        text: months > withoutBuyer
          ? `The borrower must provide ${months} months of bank statements — this note buyer asks for more than the program's ${withoutBuyer}.`
          : `The borrower must provide ${months} month${months === 1 ? '' : 's'} of bank statements (set by the program, not the note buyer).`,
        fromNoteBuyer: months > withoutBuyer,
      });
    }
  } catch (_) { /* liquidity unavailable — skip the line rather than guess */ }

  // Data tape — tapes/registry + program-provider own the pairing rule.
  try {
    const tapeReg = require('./tapes/registry');
    const pp = require('./tapes/program-provider');
    const tapes = key ? tapeReg.tapesForBuyer(key) : [];
    if (tapes.length) {
      const names = tapes.map((t) => t.name).join(', ');
      const wantProgram = pp.programForProvider(key);
      const lines = pp.programLabel ? pp.programLabel(wantProgram) : wantProgram;
      const progOk = !wantProgram || !prog || pp.normProgram(prog) === wantProgram;
      out.push({
        key: 'data_tape',
        text: progOk
          ? `The ${names} data tape becomes the one this file exports.`
          : `The ${names} data tape becomes the one this file exports — but only an admin can export it while the file is registered as ${pp.programLabel(prog)} instead of ${lines}.`,
        fromNoteBuyer: true,
      });
    } else if (key) {
      out.push({
        key: 'data_tape',
        text: 'No data tape is set up for this note buyer, so only an admin can export a tape for this file.',
        fromNoteBuyer: true,
      });
    }
  } catch (_) { /* tape registry unavailable — skip */ }

  return out;
}

/**
 * Everything the note-buyer slot needs for one file:
 *   { current:{label,key}, options:[{value,label}],
 *     effects: { <key>: { label, conditions:{adds[],drops[]}, requirements[] } } }
 *
 * `adds` = a rule-driven condition that would ATTACH under that note buyer and is not
 * on the file yet. `drops` = an untouched auto condition the engine would retract.
 * A condition someone has already worked is never previewed as dropping, because the
 * engine would not remove it either.
 *
 * Never throws. On any failure the caller gets the current value + options and an
 * empty `effects` map (the picker still works; it just can't explain itself).
 */
async function noteBuyerSlot(appId, client = db, opts = {}) {
  const out = { current: { label: null, key: null }, options: [], effects: {} };

  let app = null;
  try {
    app = (await client.query(`SELECT lender FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0] || null;
  } catch (_) { app = null; }
  if (!app) return out;
  out.current = { label: app.lender || null, key: registry.normNoteBuyer(app.lender) || null };

  try { out.options = await require('./note-buyers').listNoteBuyers(); } catch (_) { out.options = []; }
  // The file's own note buyer is always offerable, even if ClickUp has never heard of
  // it — and so is a name the caller is considering (a typed one that isn't in the
  // ClickUp dropdown), so a typed name gets a real preview instead of a shrug.
  const extra = [out.current.label, opts.candidate].filter((x) => x && String(x).trim());
  for (const label of extra) {
    const key = registry.normNoteBuyer(label);
    if (!key || out.options.some((o) => o.value === key)) continue;
    out.options.push({ value: key, label: String(label).trim() });
  }
  out.options.sort((a, b) => String(a.label).localeCompare(String(b.label)));

  const reg = await registeredProgram(appId, client);
  const program = reg ? reg.program : null;
  const assetMonths = reg ? reg.asset_months : null;

  // Requirements need no rule context — compute them for every option regardless of
  // whether the condition preview below succeeds.
  for (const o of out.options) {
    out.effects[o.value] = {
      label: o.label,
      conditions: { adds: [], drops: [] },
      requirements: requirementsFor(o.label, { program, assetMonths }),
      previewed: false,
    };
  }

  // Condition preview — the file's real rule context with only the note-buyer fields
  // swapped, run through the engine's own evaluator.
  let loaded = null;
  try { loaded = await engine.loadRuleContext(appId); } catch (_) { loaded = null; }
  if (!loaded) return out;
  const { ctx, app: full } = loaded;
  // A terminal / deleted file is frozen — the engine attaches nothing, so promising a
  // condition change would be a lie.
  if (full.deleted_at || !engine.OPEN_STATUSES.includes(full.status)) return out;

  let tpls = [];
  let fields = registry.BY_KEY;
  try {
    tpls = (await client.query(
      `SELECT id, code, label, audience, rule_logic FROM checklist_templates
        WHERE is_active = true AND scope = 'application' AND auto_apply = 'rules'
          AND rule_logic IS NOT NULL`)).rows;
    fields = await registry.fieldMap(client);
  } catch (_) { return out; }
  const driven = tpls.filter((t) => mentionsNoteBuyer(t.rule_logic));
  if (!driven.length) return out;

  let instances = new Map();
  try {
    const rows = (await client.query(
      `SELECT ci.id, ci.template_id, ci.status, ci.origin_kind, ci.label, ci.notes,
              ci.signed_off_at, ci.reviewed_at, (ci.tool_payload IS NOT NULL) AS has_payload,
              EXISTS(SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id) AS has_docs
         FROM checklist_items ci
        WHERE ci.application_id = $1 AND ci.template_id IS NOT NULL`, [appId])).rows;
    for (const r of rows) {
      if (!instances.has(r.template_id)) instances.set(r.template_id, []);
      instances.get(r.template_id).push(r);
    }
  } catch (_) { return out; }

  for (const o of out.options) {
    const eff = out.effects[o.value];
    const candidateCtx = Object.assign({}, ctx, {
      note_buyer: registry.normNoteBuyer(o.label),
      note_buyer_is_fidelis: registry.isFidelisNoteBuyer(o.label),
    });
    for (const tpl of driven) {
      let matches = false;
      try { matches = rules.evaluateRule(tpl.rule_logic, candidateCtx, fields); } catch (_) { matches = false; }
      const insts = instances.get(tpl.id) || [];
      if (matches && !insts.length) {
        eff.conditions.adds.push({ code: tpl.code || null, label: tpl.label, audience: tpl.audience });
      } else if (!matches && insts.length && insts.every(isUntouched)) {
        eff.conditions.drops.push({ code: tpl.code || null, label: insts[0].label || tpl.label, audience: tpl.audience });
      }
    }
    eff.previewed = true;
  }
  return out;
}

module.exports = { noteBuyerSlot, requirementsFor, _internals: { mentionsNoteBuyer, isUntouched } };
