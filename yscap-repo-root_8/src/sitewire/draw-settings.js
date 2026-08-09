'use strict';
/**
 * DRAW SETTINGS — the resolvers, in ONE place.
 *
 * A draw setting can be answered at more than one level (the company default in
 * `sitewire_settings`, the capital provider's rule row, this project's link row), and the answer
 * is read by the desk, the money routes, the reminders and the automatic ledger writer. Every one
 * of those used to carry its own copy of the fall-through, which is exactly how two surfaces end
 * up disagreeing about the same file.
 *
 * The two resolvers here were MOVED verbatim out of `src/routes/sitewire.js` (which now delegates
 * to them) so the automatic release path cannot drift from the manual one — the two write into the
 * same ledger, and a retainage % or a lien-waiver switch that differed between them would put two
 * different answers about one draw's money in front of the same person.
 *
 * Both FAIL CLOSED the way money code must: an unreadable setting reads as "no retainage" (holding
 * too little on one release is recoverable; double-withholding takes the borrower's money) and as
 * "waivers off" only when nothing anywhere says otherwise.
 */

const db = require('../db');

const clampPct = (n) => Math.min(100, Math.max(0, Number(n) || 0));

/**
 * The retainage % held back from each approved draw on this file.
 *
 * ZERO on a TrustPoint-administered file, and zero when the platform cannot be resolved: there the
 * ADMINISTRATOR owns retainage, and PILOT holding its own % on top would double-withhold from the
 * borrower. Killing it at this one chokepoint covers every caller (the manual release, the
 * automatic one, and the desk's overview).
 */
async function retainagePctFor(appId) {
  try {
    const rp = await require('./routing').resolveFilePlatform(appId);
    if (rp && (rp.platform === 'trustpoint' || rp.resolved === false)) return 0;
    const link = (await db.query(`SELECT retainage_pct FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0];
    if (link && link.retainage_pct != null) return clampPct(link.retainage_pct);
    const s = (await db.query(`SELECT value FROM sitewire_settings WHERE key='retainage_pct'`)).rows[0];
    return clampPct(s && s.value);
  } catch (_) { return 0; }
}

/**
 * Are lien waivers gating releases on this file? OFF by default. A specific PROJECT can turn them
 * on (the per-file override on the link), otherwise the company-wide `require_lien_waivers`
 * setting applies — most projects do not use them.
 *
 * The setting is compared to `true` / the STRING 'true' deliberately: `sitewire_settings.value` is
 * jsonb and has been written both ways, and a bare truthiness test would read the string "false"
 * as ON — turning a gate nobody asked for onto every release.
 */
async function lienGateEnabled(appId) {
  try {
    if (appId) {
      const link = (await db.query(`SELECT require_lien_waivers FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0];
      if (link && link.require_lien_waivers != null) return !!link.require_lien_waivers;
    }
    const s = (await db.query(`SELECT value FROM sitewire_settings WHERE key='require_lien_waivers'`)).rows[0];
    return !!(s && (s.value === true || s.value === 'true'));
  } catch (_) { return false; }
}

// ===========================================================================================
//  THE SETTINGS SCREEN — three levels, and WHICH ONE WON
//  (owner-directed 2026-08-09: "We should have a draw settings for the admin. We should be able
//  to set up each capital provider who releases their draws by default.")
//
//  Today a draw setting can live in three places — a company-wide row in `sitewire_settings`, a
//  per-capital-provider rule row, a per-project column on the link — and NOTHING anywhere tells a
//  coordinator which one decided the answer in front of them. So a $250 draw fee on one file and
//  $299 on the next looks arbitrary, and several knobs are unreachable without a database edit.
//
//  THE CATALOG BELOW IS THE ONE DESCRIPTION of every knob: where it can be answered, what it
//  means in plain words, and how to read its value. A screen renders from it; nothing hard-codes a
//  list of settings. Adding a knob is one entry here.
// ===========================================================================================

const LEVELS = ['company', 'capital_provider', 'project'];

const LEVEL_LABEL = {
  company: 'the company default',
  capital_provider: 'this capital provider',
  project: 'this project',
  none: 'nothing set — the built-in default',
};

/**
 * Every draw setting, most-specific level LAST.
 *
 *   key        the name a screen and an API use
 *   label      plain words a coordinator reads
 *   help       what it actually does, and whether it can refuse anything
 *   type       'money_cents' | 'pct' | 'int' | 'bool' | 'hours' | 'days' | 'choice' | 'text'
 *   choices    for 'choice'
 *   company    the sitewire_settings key, when it can be set company-wide
 *   rule       the sitewire_inspection_rules column, when it can be set per capital provider
 *   project    the sitewire_property_links column, when it can be set per project
 *   fallback   the built-in answer when no level has one
 *   advisory   true = it can only WARN. Nothing in this system refuses a draw over a setting the
 *              owner asked to be advisory, and the flag is what a screen reads to say so.
 */
const CATALOG = Object.freeze([
  // ── who releases the money ────────────────────────────────────────────────────────────────
  { key: 'investor_funding_mode', label: 'Who releases the money', type: 'choice',
    choices: ['reimbursement', 'investor_direct', 'manual'],
    help: 'Whether the investor wires the borrower directly, or we wire and the investor reimburses us.',
    company: 'investor_funding_mode_default', rule: 'investor_funding_mode', project: 'investor_funding_mode',
    fallback: 'investor_direct' },

  // ── inspection + fee ──────────────────────────────────────────────────────────────────────
  { key: 'inspection_method', label: 'How draws are inspected', type: 'choice', choices: ['mobile', 'traditional'],
    help: 'Virtual (mobile) or an on-site visit. The coordinator can switch a file when both are allowed.',
    rule: 'inspection_method', project: 'inspection_method', fallback: 'mobile' },
  { key: 'fee_cents_virtual', label: 'Draw fee — virtual inspection', type: 'money_cents',
    help: 'What we charge per draw when the inspection is virtual.', rule: 'fee_cents_virtual', fallback: 29900 },
  { key: 'fee_cents_physical', label: 'Draw fee — on-site inspection', type: 'money_cents',
    help: 'What we charge per draw when somebody visits. Blank falls back to the virtual fee.', rule: 'fee_cents_physical', fallback: null },
  { key: 'fee_cents_override', label: 'Draw fee for this project', type: 'money_cents',
    help: 'A fee just for this file, overriding the capital provider’s.', project: 'fee_cents_override', fallback: null },
  { key: 'require_sitewire_inspector', label: 'A platform inspector is required', type: 'bool',
    help: 'Whether the platform’s own inspector must sign off on a draw.', rule: 'require_sitewire_inspector', fallback: true },
  { key: 'require_capital_partner_approval', label: 'The capital partner must approve', type: 'bool',
    help: 'Whether the investor reviews each draw before we release it.', rule: 'require_capital_partner_approval', fallback: false },
  { key: 'draw_platform', label: 'Where draws are administered', type: 'choice', choices: ['sitewire', 'trustpoint', 'external'],
    help: 'Which system runs this provider’s draws. Changing it changes where approvals happen.',
    rule: 'draw_platform', fallback: 'sitewire' },

  // ── money ─────────────────────────────────────────────────────────────────────────────────
  { key: 'retainage_pct', label: 'Retainage held back', type: 'pct',
    help: 'A percentage held from every approved draw until the project is finished.',
    company: 'retainage_pct', project: 'retainage_pct', fallback: 0 },
  { key: 'require_lien_waivers', label: 'Lien waivers gate a release', type: 'bool',
    help: 'When on, a draw cannot be released until every required waiver is in.',
    company: 'require_lien_waivers', project: 'require_lien_waivers', fallback: false },
  { key: 'oop_floor_cents', label: 'Out-of-pocket rehab floor', type: 'money_cents',
    help: 'The first slice of rehab the borrower funds themselves and is never reimbursed for.',
    project: 'oop_floor_cents', fallback: 0 },
  { key: 'allow_reallocation', label: 'Budget can be moved between lines', type: 'bool',
    help: 'Whether a coordinator can shift budget between Scope-of-Work lines on this provider’s files.',
    rule: 'allow_reallocation', fallback: false },
  { key: 'variance_pct', label: 'Reallocation variance allowed', type: 'pct',
    help: 'How far a single line may move before a reallocation needs approval.', company: 'variance_pct', fallback: 10 },

  // ── how long things should take ───────────────────────────────────────────────────────────
  { key: 'wire_turnaround_hours', label: 'Wire turnaround', type: 'hours',
    help: 'How long we have to release after the borrower agrees. Drives the overdue alert.',
    company: 'wire_turnaround_hours', fallback: 48 },
  { key: 'inspection_sla_days', label: 'Inspection expected within', type: 'days',
    help: 'From ordering the inspection to the report arriving. Shown as an expected date; never refuses anything.',
    company: 'inspection_sla_days', fallback: 5, advisory: true },
  { key: 'decision_sla_days', label: 'Decision expected within', type: 'days',
    help: 'From the report arriving to the findings going to the borrower. Shown as an expected date and used by the chase reminder; it never refuses anything.',
    company: 'decision_sla_days', fallback: 2, advisory: true },
  { key: 'investor_funding_sla_days', label: 'Investor funding expected within', type: 'days',
    help: 'From sending a draw to the investor to the money moving. Shown as an expected date and used by the chase reminder; it never refuses anything.',
    company: 'investor_funding_sla_days', fallback: 3, advisory: true },
  { key: 'fee_owed_chase_days', label: 'Chase an unpaid fee after', type: 'days',
    help: 'How long an investor may owe us a draw fee before it is chased. It only ever triggers a reminder; it never refuses anything.',
    company: 'fee_owed_chase_days', fallback: 14, advisory: true },

  // ── advisory limits (they WARN, they never refuse) ────────────────────────────────────────
  { key: 'min_draw_cents', label: 'Minimum draw amount', type: 'money_cents',
    help: 'A draw under this warns the borrower before they submit. 0 turns it off. It never refuses a draw.',
    company: 'min_draw_cents', fallback: 0, advisory: true },
  { key: 'min_days_between_draws', label: 'Minimum days between draws', type: 'days',
    help: 'A draw sooner than this warns before submitting. 0 turns it off. It never refuses a draw.',
    company: 'min_days_between_draws', fallback: 0, advisory: true },
  { key: 'max_draws', label: 'Maximum number of draws', type: 'int',
    help: 'A warning once a project passes this many draws. 0 turns it off. It never refuses a draw.',
    company: 'max_draws', fallback: 0, advisory: true },

  // ── portfolio watch thresholds ────────────────────────────────────────────────────────────
  { key: 'stale_days', label: 'A draw is “stale” after', type: 'days', help: 'Used by the portfolio monitor.', company: 'stale_days', fallback: 30, advisory: true },
  { key: 'no_draw_days', label: 'No draw at all for', type: 'days', help: 'Flags a project that has gone quiet.', company: 'no_draw_days', fallback: 45, advisory: true },
  { key: 'pacing_gap_pct', label: 'Behind-pace gap', type: 'pct', help: 'How far behind schedule a project may drift before it is flagged.', company: 'pacing_gap_pct', fallback: 25, advisory: true },
  { key: 'front_load_pct', label: 'Front-loading threshold', type: 'pct', help: 'Flags a draw that pulls an unusually large share of the budget early.', company: 'front_load_pct', fallback: 40, advisory: true },
  { key: 'first_draw_max_pct', label: 'First draw cap', type: 'pct', help: 'Warns when a first draw exceeds this share of the budget.', company: 'first_draw_max_pct', fallback: 30, advisory: true },
]);

const BY_KEY = Object.freeze(CATALOG.reduce((m, e) => { m[e.key] = e; return m; }, {}));

/** A stored value that means "no answer at this level". Zero and false are REAL answers. */
function answered(v) { return !(v === null || v === undefined || v === ''); }

/**
 * Resolve ONE knob across the three levels, and say which one decided.
 * Returns { key, label, help, type, advisory, value, level, levelLabel, levels:{…} }.
 *
 * Most specific wins: project → capital provider → company → the built-in fallback. A level that
 * holds nothing is skipped; a level that holds a value the knob does not allow (a choice outside
 * its list) is treated as unanswered rather than honoured, so a bad row can never take effect.
 */
function resolveOne(entry, sources = {}) {
  // A destructuring default only fills in for `undefined`, so an explicit `null` source (which a
  // failed read hands back) would throw on the property lookup — and this renders a screen.
  const s = sources || {};
  const company = s.company || {}, rule = s.rule || {}, project = s.project || {};
  const levels = {
    company: entry.company && answered(company[entry.company]) ? company[entry.company] : null,
    capital_provider: entry.rule && answered(rule[entry.rule]) ? rule[entry.rule] : null,
    project: entry.project && answered(project[entry.project]) ? project[entry.project] : null,
  };
  const usable = (v) => {
    if (!answered(v)) return false;
    if (entry.type === 'choice') return (entry.choices || []).includes(String(v));
    return true;
  };
  let value = entry.fallback, level = 'none';
  for (const l of ['company', 'capital_provider', 'project']) {
    if (usable(levels[l])) { value = levels[l]; level = l; }
  }
  return {
    key: entry.key, label: entry.label, help: entry.help, type: entry.type,
    choices: entry.choices || null, advisory: !!entry.advisory,
    settable: { company: !!entry.company, capital_provider: !!entry.rule, project: !!entry.project },
    value, level, levelLabel: LEVEL_LABEL[level], levels, fallback: entry.fallback,
  };
}

/** Every knob resolved, in catalog order. PURE — the caller supplies the three levels. */
function resolveAll(sources) { return CATALOG.map((e) => resolveOne(e, sources)); }

/** A company settings row-set (key → value) from the `sitewire_settings` rows. */
function companyMapFrom(rows) {
  const out = {};
  for (const r of (rows || [])) {
    // jsonb comes back already parsed; a JSON string arrives as a JS string, which is what the
    // choice knobs want, and a number/boolean arrives as itself.
    out[r.key] = r.value;
  }
  return out;
}

/**
 * Read all three levels for one file and resolve every knob. Never throws — a settings card that
 * cannot be read simply does not render, and nothing downstream depends on it (the money paths
 * have their own dedicated resolvers above).
 */
async function resolvedFor(appId) {
  const q = async (sql, params) => { try { return (await db.query(sql, params)).rows; } catch (_) { return []; } };
  const company = companyMapFrom(await q(`SELECT key, value FROM sitewire_settings`));
  const project = (await q(`SELECT * FROM sitewire_property_links WHERE application_id=$1 AND matched_by='created'`, [appId]))[0] || {};
  let rule = {};
  try {
    const rp = await require('./routing').resolveFilePlatform(appId);
    rule = (rp && rp.rule) || {};
  } catch (_) { rule = {}; }
  return { settings: resolveAll({ company, rule, project }), levels: LEVELS, levelLabels: LEVEL_LABEL };
}

module.exports = {
  retainagePctFor, lienGateEnabled,
  CATALOG, BY_KEY, LEVELS, LEVEL_LABEL,
  resolveOne, resolveAll, companyMapFrom, resolvedFor,
  _internals: { clampPct, answered },
};
