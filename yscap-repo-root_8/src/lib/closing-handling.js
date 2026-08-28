'use strict';
/**
 * WHO HANDLES THE CLOSING — the three-way switch (owner-directed 2026-08-28).
 *
 * "There should be three options: internally … attorney … and lender directly.
 *  Right now you can pre-fill that TempleView and RCN is lender directly.
 *  Everything else should be attorney. … If an option is disabled, it should
 *  always say why this option is disabled."
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE THREE ANSWERS, and what each one does to the file's workflows
 * ────────────────────────────────────────────────────────────────────────────
 *   attorney       Exactly what every file did before this existed: the
 *                  attorney closing prep runs the closing. The settlement-agent
 *                  order stays a prepped-but-dormant draft.
 *   internal       WE run the closing: the attorney closing prep is DISABLED
 *                  (there is no attorney to prep), the New-York settlement-agent
 *                  order comes LIVE (NY files only — title does not do the
 *                  settlement in New York), and the title condition is set up
 *                  with a slot per item we ask title for, instead of one slot
 *                  for everything.
 *   lender_direct  The NOTE BUYER runs the closing (Templeview, RCN): both the
 *                  attorney prep and the settlement-agent order are disabled,
 *                  and the reason names the buyer.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE LAYERS, NARROWEST WINS (db/638) — resolved ONLY here
 * ────────────────────────────────────────────────────────────────────────────
 *   the FILE's own override  (applications.closing_handling — the closing
 *                             section's per-file flip)
 * → the NOTE BUYER's default (closing_handling_settings scope='note_buyer',
 *                             keyed on the normalized buyer name)
 * → the COMPANY default      (scope='company' — the API-health settings page)
 * → 'attorney'               (no row anywhere = today's behavior, unchanged)
 *
 * Buyer matching is the prefix discipline the note-buyer helpers use (the
 * db/337 lesson: a human types "RCN Capital, LLC" and an exact key never
 * matches): the file's normalized key and the setting's key match when one is
 * a prefix of the other (shorter side ≥ 3 chars), longest match wins. The
 * blast radius is which closing workflow a STAFF screen offers — visible,
 * reversible, and every disabled control names the buyer it decided on.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NEW YORK (owner-directed, applies WHATEVER the handling is)
 * ────────────────────────────────────────────────────────────────────────────
 * "No matter how it is, when you order title, if it's New York, you need to
 *  cut a few things from the order" — title does not do the settlement in New
 * York, so a NY title order (and its follow-up wants list) never asks title
 * for the CPL, the wiring instructions, or the preliminary settlement /
 * closing statement. Those items belong to the SETTLEMENT AGENT — a separate
 * NY-only order this module also builds, live only under 'internal' handling
 * and clearly marked as prepped-but-dormant everywhere else.
 */
const db = require('../db');
const { normNoteBuyer } = require('./conditions/field-registry');

const HANDLINGS = Object.freeze(['internal', 'attorney', 'lender_direct']);
const HANDLING_LABEL = Object.freeze({
  internal: 'We close it in house',
  attorney: 'The attorney handles the closing',
  lender_direct: 'The lender closes directly',
});
const DEFAULT_HANDLING = 'attorney';

/* ── THE NEW-YORK TITLE CUT ─────────────────────────────────────────────────
   The full title wants-list lives in lib/orders.js (the follow-up's deliverables).
   These are the items title never handles in New York; `titleWants` applies the
   cut so the order email and the itemized title slots agree. */
const NY_TITLE_CUT = Object.freeze(['CPL', 'Wiring Instructions', 'Preliminary Settlement Statement']);
const TITLE_WANTS_FULL = Object.freeze(['Title Commitment', 'CPL', 'Tax Certificate', 'Wiring Instructions', 'Preliminary Settlement Statement']);

function isNyState(state) { return String(state || '').trim().toUpperCase() === 'NY'; }

/** The deliverables a TITLE order may ask for in this state. */
function titleWants(state) {
  return isNyState(state) ? TITLE_WANTS_FULL.filter((w) => !NY_TITLE_CUT.includes(w)) : [...TITLE_WANTS_FULL];
}

/* What the SETTLEMENT AGENT is ordered to produce on a NY file (the owner:
   "you need to send your errors and omissions insurance, your preliminary
   settlement statement, your wiring instructions"). */
const SETTLEMENT_ASKS = Object.freeze([
  'Errors & Omissions insurance certificate',
  'Preliminary settlement statement',
  'Wiring instructions',
]);

/* The itemized title slots an INTERNAL closing sets up — a slot per item we ask
   title for, in this state (the NY cut applies here too, so a NY file never
   grows a CPL slot title was never asked for). */
function internalTitleSlots(state) { return titleWants(state); }

// ---------------------------------------------------------------------------
// Settings (db/638)
// ---------------------------------------------------------------------------

/** Every stored setting: { company: 'attorney'|…|null, buyers: [{key, handling}] }. */
async function readSettings(client = db) {
  try {
    const r = await client.query(
      `SELECT scope, note_buyer_key, handling FROM closing_handling_settings`);
    const out = { company: null, buyers: [] };
    for (const row of r.rows) {
      if (row.scope === 'company') out.company = row.handling;
      else out.buyers.push({ key: row.note_buyer_key, handling: row.handling });
    }
    out.buyers.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  } catch (_) { return { company: null, buyers: [] }; }
}

/** Set (or clear, handling=null) the company default. */
async function setCompanyDefault(handling, staffId, client = db) {
  if (handling == null) {
    await client.query(`DELETE FROM closing_handling_settings WHERE scope='company'`);
    return null;
  }
  if (!HANDLINGS.includes(handling)) { const e = new Error('unknown handling'); e.status = 400; throw e; }
  await client.query(
    `INSERT INTO closing_handling_settings (scope, handling, updated_by)
     VALUES ('company', $1, $2)
     ON CONFLICT ((1)) WHERE scope='company'
     DO UPDATE SET handling=$1, updated_by=$2, updated_at=now()`,
    [handling, staffId || null]);
  return handling;
}

/** Set (or clear, handling=null) a note buyer's default. `buyer` may be any
    spelling — it is stored under the normalized key. */
async function setBuyerDefault(buyer, handling, staffId, client = db) {
  const key = normNoteBuyer(buyer);
  if (!key) { const e = new Error('a note buyer name is required'); e.status = 400; throw e; }
  if (handling == null) {
    await client.query(`DELETE FROM closing_handling_settings WHERE scope='note_buyer' AND note_buyer_key=$1`, [key]);
    return { key, handling: null };
  }
  if (!HANDLINGS.includes(handling)) { const e = new Error('unknown handling'); e.status = 400; throw e; }
  await client.query(
    `INSERT INTO closing_handling_settings (scope, note_buyer_key, handling, updated_by)
     VALUES ('note_buyer', $1, $2, $3)
     ON CONFLICT (note_buyer_key) WHERE scope='note_buyer'
     DO UPDATE SET handling=$2, updated_by=$3, updated_at=now()`,
    [key, handling, staffId || null]);
  return { key, handling };
}

/** The buyer setting matching a file's note-buyer label, or null. Prefix match
    either way (shorter side ≥ 3), longest overlap wins — pure, for the test. */
function buyerMatch(buyers, lenderLabel) {
  const fileKey = normNoteBuyer(lenderLabel);
  if (!fileKey) return null;
  let best = null;
  for (const b of buyers || []) {
    const k = String(b.key || '');
    if (!k) continue;
    const shorter = Math.min(k.length, fileKey.length);
    if (shorter < 3) continue;
    if (!(fileKey.startsWith(k) || k.startsWith(fileKey))) continue;
    if (!best || k.length > best.key.length) best = b;
  }
  return best;
}

/**
 * WHO HANDLES THIS FILE'S CLOSING — the one resolver.
 * @returns {{ handling, source: 'file'|'note_buyer'|'company'|'default',
 *             label, noteBuyer, buyerKey, propertyState, isNY, fileOverride }}
 */
async function resolve(appId, client = db) {
  const a = (await client.query(
    `SELECT closing_handling, lender, property_address FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!a) return null;
  const propertyState = ((a.property_address || {}).state || '').toUpperCase() || null;
  const base = {
    noteBuyer: a.lender || null,
    buyerKey: normNoteBuyer(a.lender),
    propertyState,
    isNY: isNyState(propertyState),
    fileOverride: a.closing_handling || null,
  };
  if (a.closing_handling && HANDLINGS.includes(a.closing_handling)) {
    return { ...base, handling: a.closing_handling, source: 'file', label: HANDLING_LABEL[a.closing_handling] };
  }
  const settings = await readSettings(client);
  const buyer = buyerMatch(settings.buyers, a.lender);
  if (buyer) return { ...base, handling: buyer.handling, source: 'note_buyer', label: HANDLING_LABEL[buyer.handling] };
  if (settings.company) return { ...base, handling: settings.company, source: 'company', label: HANDLING_LABEL[settings.company] };
  return { ...base, handling: DEFAULT_HANDLING, source: 'default', label: HANDLING_LABEL[DEFAULT_HANDLING] };
}

/**
 * WHAT THE HANDLING ENABLES AND DISABLES — with the reason on every disabled
 * option, because "if an option is disabled, it should always say why".
 * PURE over a resolution; never throws.
 */
function capabilities(resolution) {
  const r = resolution || { handling: DEFAULT_HANDLING, isNY: false };
  const buyerName = r.noteBuyer || 'the lender';
  const out = {
    handling: r.handling,
    source: r.source || 'default',
    label: HANDLING_LABEL[r.handling] || r.handling,
    // The attorney closing prep — live only under 'attorney' handling.
    attorneyPrep: { enabled: r.handling === 'attorney', reason: null },
    // The NY settlement-agent order — live only under 'internal' handling on a NY file.
    settlementAgent: { enabled: r.handling === 'internal' && !!r.isNY, reason: null, dormant: false },
    // The title condition's shape: one slot for everything (as today), or a slot
    // per requested item when we close in house.
    titleSlots: r.handling === 'internal' ? 'itemized' : 'single',
  };
  if (r.handling === 'internal') {
    out.attorneyPrep.reason = 'This file closes IN HOUSE — there is no attorney running the closing, so the attorney closing prep is off. Flip “Who handles the closing” back to Attorney to use it.';
    if (!r.isNY) {
      out.settlementAgent.reason = `The settlement-agent order is a New York workflow — this property is in ${r.propertyState || 'another state'}, where title handles the settlement itself.`;
    }
  } else if (r.handling === 'lender_direct') {
    out.attorneyPrep.reason = `You’re closing with ${buyerName} — ${buyerName} handles the closing directly (lender-direct), so the attorney closing prep is off.`;
    out.settlementAgent.reason = `You’re closing with ${buyerName} — ${buyerName} handles the closing directly (lender-direct), so there is no settlement agent to order.`;
  } else {
    // attorney — today's world. The settlement-agent order exists as a PREPPED
    // DRAFT so the desk can see the workflow that takes over when closings come
    // in house, without being able to send it by accident.
    out.settlementAgent.dormant = true;
    out.settlementAgent.reason = 'Not in use yet — the attorney handles the settlement today. This order comes live when the file’s closing handling is flipped to “We close it in house” (New York files only).';
  }
  return out;
}

// ---------------------------------------------------------------------------
// The settlement-agent ORDER EMAIL (New York, internal handling only)
// ---------------------------------------------------------------------------

/**
 * "We hired you as the settlement agent for this New York file" — the order.
 * Modeled on the title/insurance order emails (the same branded template, the
 * same mortgagee clause with the loan number, the officer card, replyable), and
 * asking for exactly the three things the owner named. `data` is
 * orders.getOrderData's shape; `vendor` is the settlement_agent service contact.
 */
function buildSettlementOrderEmail(data, vendor, { note } = {}) {
  const tpl = require('./email/template');
  const quote = require('./email/quote');
  const orders = require('./orders');
  const clause = orders.mortgageeClauseFor
    ? [...orders.mortgageeClauseFor(data.lender), `Loan #: ${data.loanNumber}`].join('\n')
    : `Loan #: ${data.loanNumber}`;
  const greetName = (vendor && (vendor.contact_name || vendor.company_name)) || 'there';
  return tpl.render({
    title: 'Settlement Agent Engagement — New York',
    subjectTag: data.loanNumber || undefined,
    kicker: 'Settlement agent order',
    preheader: `Settlement agent engagement for ${data.propertyLine}`,
    greeting: `Hi ${greetName},`,
    intro: (note && String(note).trim())
      || `We’ve engaged you as the settlement agent for the New York transaction below. Please confirm receipt and send the items listed so we can proceed to closing.`,
    lines: [
      'Please provide the following:',
      ...SETTLEMENT_ASKS.map((a, i) => `${i + 1}. ${a}`),
      '',
      'Please let us know if you need anything else to complete the engagement.',
      '',
      'Thank you,',
    ],
    meta: [
      { label: 'Property', value: data.propertyLine || '—' },
      { label: 'Borrower', value: data.borrowerName || '—' },
      data.loanNumber ? { label: 'Loan Number', value: data.loanNumber } : null,
      data.transactionType ? { label: 'Transaction Type', value: data.transactionType } : null,
      data.entityName ? { label: 'Vesting Entity', value: data.entityName } : null,
      data.loanAmount ? { label: 'Loan Amount', value: data.loanAmount } : null,
    ].filter(Boolean),
    callout: { title: 'Mortgagee Clause', body: clause },
    officer: data.officer ? {
      name: data.officer.name, title: data.officer.title, email: data.officer.email,
      phone: data.officer.phone, nmls: data.officer.nmls,
    } : undefined,
    note: 'Reply to this email and it reaches the whole loan team.',
    replyable: true,
    replyMarker: quote.replyMarker('and it reaches the whole loan team'),
    audience: 'staff',
  });
}

module.exports = {
  HANDLINGS, HANDLING_LABEL, DEFAULT_HANDLING,
  NY_TITLE_CUT, TITLE_WANTS_FULL, SETTLEMENT_ASKS,
  isNyState, titleWants, internalTitleSlots,
  readSettings, setCompanyDefault, setBuyerDefault, buyerMatch,
  resolve, capabilities, buildSettlementOrderEmail,
};
