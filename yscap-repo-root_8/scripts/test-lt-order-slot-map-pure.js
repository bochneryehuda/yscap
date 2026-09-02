#!/usr/bin/env node
'use strict';
/**
 * LT — WHICH SLOT A RETURNED DOCUMENT FILES INTO, kind by kind, name by name.
 *
 * `orders/kinds.js` files a vendor's returned document into a named slot by its
 * FILENAME, and the rule it states for itself is that a wrong slot is worse than
 * no slot: a document filed into the wrong slot reads as that document having
 * arrived, and a condition whose required slots are all full reads as satisfied.
 *
 * The 2026-09-02 audit (S5) found five maps that guessed:
 *
 *   · ny_settlement_agent  /settlement|statement|hud|cd/   filed "Settlement Agent
 *                          E&O.pdf" and "Settlement Agent W9.pdf" as the statement
 *   · payoff               /payoff|demand|statement/       filed "Mortgage Statement
 *                          June.pdf" as the payoff
 *   · condo_questionnaire  /insur|master polic/            filed "Insurance Agent
 *                          Contact.pdf" as the master policy
 *   · vor                  /…|verification|rent/            filed "Rent Ledger.pdf"
 *                          as the completed verification
 *   · title                the invoice pattern ran LAST, so "Invoice - Title
 *                          Commitment.pdf" was the commitment
 *
 * and S4 found the New York settlement agent asked for neither the CPL nor the
 * E&O, with no slot for either. This is the TABLE: every kind, each of those
 * misfiles as a negative case, and each real document as a positive one, so a
 * pattern loosened later fails here by name.
 *
 * PURE. The proof that a slot which does not apply on a FILE is refused — a
 * "CD.pdf" on a New York title order — needs the live field values and is in
 * `test-lt-order-guards-db.js`.
 *
 * PROVEN TO FAIL: each of the five loosened patterns above was put back in turn
 * and this went red on the case it names, green again once restored; dropping
 * the `cpl` / `eo` slots from the library or the settlement agent's `wants`
 * fails section C.
 */
const assert = require('assert');
const kinds = require('../src/longterm/orders/kinds.js');
const library = require('../src/longterm/conditions-center/library.js');

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok - ${name}`); };
const byCode = new Map(library.library().map((c) => [c.code, c]));

/* ─────────────────────────────────────────────────────────────────────────────
   A. THE TABLE. [kind, filename, slot-or-null, why]
   ───────────────────────────────────────────────────────────────────────────── */
const TABLE = [
  // ── title ──
  ['title', 'Title Commitment.pdf', 'commitment', 'the commitment'],
  ['title', '2026 Title Commitment - 12 Oak St.pdf', 'commitment', 'the commitment, named with the address'],
  ['title', 'Invoice - Title Commitment.pdf', 'invoice', 'AN INVOICE NAMED FOR THE COMMITMENT IS AN INVOICE (S5)'],
  ['title', 'Bill for title work.pdf', 'invoice', 'a bill'],
  ['title', 'CPL.pdf', 'cpl', 'the CPL'],
  ['title', 'Closing Protection Letter.pDf', 'cpl', 'the CPL, in words'],
  ['title', 'Preliminary Settlement Statement.pdf', 'prelim_settlement', 'the preliminary statement'],
  ['title', 'CD.pdf', 'prelim_settlement', 'a closing disclosure by its initials'],
  ['title', 'HUD-1.pdf', 'prelim_settlement', 'a HUD-1'],
  ['title', 'Closing Disclosure draft.pdf', 'prelim_settlement', 'a closing disclosure in words'],
  ['title', 'Wiring instructions.pdf', 'wire_instructions', 'the wiring instructions'],
  ['title', 'Wire Info.pdf', 'wire_instructions', 'the wire, short'],
  ['title', 'scan001.pdf', null, 'a scan that says nothing'],
  ['title', 'Survey.pdf', null, 'a survey — no slot for it, so no guess'],

  // ── insurance / flood ──
  ['insurance', 'Binder - Oak Holdings.pdf', 'binder', 'the binder'],
  ['insurance', 'Declarations Page.pdf', 'binder', 'the declarations page'],
  ['insurance', 'Evidence of Insurance.pdf', 'binder', 'evidence of insurance'],
  ['insurance', 'Invoice 4471.pdf', 'invoice', 'the invoice'],
  ['insurance', 'Paid receipt.pdf', 'invoice', 'a paid receipt'],
  ['insurance', 'Quote.pdf', null, 'a quote is neither'],
  ['flood_insurance', 'Flood Binder.pdf', 'binder', 'the flood binder'],
  ['flood_insurance', 'Flood invoice.pdf', 'invoice', 'the flood invoice'],
  ['flood_insurance', 'Elevation Certificate.pdf', null, 'an elevation certificate has no slot'],

  // ── New York settlement agent ──
  ['ny_settlement_agent', 'Engagement Letter.pdf', 'engagement', 'the engagement letter'],
  ['ny_settlement_agent', 'Retainer.pdf', 'engagement', 'a retainer'],
  ['ny_settlement_agent', 'Wire instructions.pdf', 'wire_instructions', 'the wiring instructions'],
  ['ny_settlement_agent', 'Settlement Statement.pdf', 'settlement_statement', 'the settlement statement'],
  ['ny_settlement_agent', 'HUD.pdf', 'settlement_statement', 'a HUD'],
  ['ny_settlement_agent', 'CD.pdf', 'settlement_statement', 'a CD'],
  ['ny_settlement_agent', 'Closing Disclosure.pdf', 'settlement_statement', 'a closing disclosure'],
  ['ny_settlement_agent', 'Settlement Agent E&O.pdf', 'eo', 'THE AGENT\'S E&O IS THE E&O, NOT THE STATEMENT (S5, S4)'],
  ['ny_settlement_agent', 'Errors and Omissions policy.pdf', 'eo', 'the E&O in words'],
  ['ny_settlement_agent', 'Errors & Omissions.pdf', 'eo', 'the E&O with an ampersand'],
  ['ny_settlement_agent', 'CPL.pdf', 'cpl', 'THE CPL, ON THE SETTLEMENT AGENT IN NEW YORK (S4)'],
  ['ny_settlement_agent', 'Closing protection letter.pdf', 'cpl', 'the CPL in words'],
  ['ny_settlement_agent', 'Settlement Agent W9.pdf', null, 'THE AGENT\'S W-9 IS NOT THE STATEMENT (S5)'],
  ['ny_settlement_agent', 'Settlement Agent License.pdf', null, 'the agent\'s licence is not the statement'],

  // ── payoff ──
  ['payoff', 'Payoff Statement.pdf', 'payoff', 'the payoff statement'],
  ['payoff', 'Payoff Demand.pdf', 'payoff', 'a payoff demand'],
  ['payoff', 'Demand letter.pdf', 'payoff', 'a demand'],
  ['payoff', 'Mortgage Statement June.pdf', null, 'THE MONTHLY MORTGAGE STATEMENT IS NOT THE PAYOFF (S5)'],
  ['payoff', 'Escrow Statement.pdf', null, 'an escrow statement is not the payoff'],

  // ── condo questionnaire ──
  ['condo_questionnaire', 'HOA Questionnaire.pdf', 'questionnaire', 'the questionnaire'],
  ['condo_questionnaire', 'Condo Cert.pdf', 'questionnaire', 'a condo cert'],
  ['condo_questionnaire', '2026 Budget.pdf', 'budget', 'the budget'],
  ['condo_questionnaire', 'Bylaws.pdf', 'bylaws', 'the bylaws'],
  ['condo_questionnaire', 'By-Laws amended.pdf', 'bylaws', 'the bylaws, hyphenated'],
  ['condo_questionnaire', 'Master Policy.pdf', 'master_insurance', 'the master policy'],
  ['condo_questionnaire', 'Certificate of Insurance.pdf', 'master_insurance', 'a certificate of insurance'],
  ['condo_questionnaire', 'Insurance Agent Contact.pdf', null, 'THE AGENT\'S CONTACT DETAILS ARE NOT THE POLICY (S5)'],
  ['condo_questionnaire', 'Insurance Questionnaire.pdf', 'questionnaire', 'a questionnaire about insurance is still the questionnaire'],

  // ── verification of rent ──
  ['vor', 'Verification of Rent signed.pdf', 'vor', 'the completed verification'],
  ['vor', 'verification-of-rent.pdf', 'vor', 'our own filename for the form'],
  ['vor', 'verification-of-rent-signed.pdf', 'vor', 'the DocuSign-signed form'],
  ['vor', 'VOR.pdf', 'vor', 'the form by its initials'],
  ['vor', 'Rent Verification.pdf', 'vor', 'the form, words reversed'],
  ['vor', 'Verification of Mortgage.pdf', 'vom_primary', 'a verification of MORTGAGE stays out of the rent slot'],
  ['vor', 'VOM.pdf', 'vom_primary', 'the mortgage verification by its initials'],
  ['vor', 'Rent Free Letter.pdf', 'rent_free_letter', 'the rent-free letter'],
  ['vor', 'Living rent-free.pdf', 'rent_free_letter', 'the rent-free letter, hyphenated'],
  ['vor', 'Rent Ledger.pdf', null, 'A RENT LEDGER IS NOT THE COMPLETED VERIFICATION (S5)'],
  ['vor', 'Rent Receipts 2026.pdf', null, 'rent receipts are not the verification'],
  ['vor', 'Lease.pdf', null, 'a lease is not the verification'],
  ['vor', 'Verification.pdf', null, 'a bare "verification" says which of nothing'],
];

for (const [kind, file, slot, why] of TABLE) {
  assert.strictEqual(kinds.slotForFilename(kind, file), slot,
    `${kind}: "${file}" → ${JSON.stringify(slot)} (${why}) — got ${JSON.stringify(kinds.slotForFilename(kind, file))}`);
}
ok(`${TABLE.length} filenames file where they should, across every kind`);

// Every kind that files documents is in the table, positively AND negatively —
// a kind added later has to bring its own rows.
for (const k of kinds.ORDER_KIND_KEYS) {
  const def = kinds.orderKind(k);
  if (!def.docCondition) continue;
  const rows = TABLE.filter((r) => r[0] === k);
  assert.ok(rows.some((r) => r[2] !== null), `${k} has at least one positive case`);
  assert.ok(rows.some((r) => r[2] === null), `${k} has at least one negative case`);
}
ok('every kind that files documents is covered both ways');

/* ─────────────────────────────────────────────────────────────────────────────
   B. EVERY SLOT A MAP NAMES IS A SLOT ON THE CONDITION — including the two new
      ones — and every REQUIRED slot has some name that reaches it.
   ───────────────────────────────────────────────────────────────────────────── */
for (const k of kinds.ORDER_KIND_KEYS) {
  const def = kinds.orderKind(k);
  if (!def.docCondition) continue;
  const cond = byCode.get(def.docCondition);
  assert.ok(cond, `${k} files onto a condition the library has (${def.docCondition})`);
  const keys = new Set((cond.slots || []).map((s) => s.key));
  for (const [, slot] of def.slotMap) assert.ok(keys.has(slot), `${k}: slot "${slot}" exists on ${def.docCondition}`);
  const targets = new Set(def.slotMap.map((p) => p[1]));
  for (const s of cond.slots || []) {
    if (s.required) assert.ok(targets.has(s.key), `${k}: some filename reaches the required "${s.key}" slot`);
  }
}
ok('every slot a map names exists, and every required slot is reachable');

/* ─────────────────────────────────────────────────────────────────────────────
   C. THE OWNER'S NEW YORK RULE (S4): the CPL and the E&O are the settlement
      agent's — asked for, with a slot each — and the title company is no longer
      left holding a required wiring-instructions slot in New York.
   ───────────────────────────────────────────────────────────────────────────── */
{
  const ny = byCode.get('lt_ny_settlement_docs');
  const slot = (code, key) => (byCode.get(code).slots || []).find((s) => s.key === key);
  assert.ok(slot('lt_ny_settlement_docs', 'cpl') && slot('lt_ny_settlement_docs', 'cpl').required,
    'the settlement agent documents carry a required CPL slot');
  assert.ok(slot('lt_ny_settlement_docs', 'eo') && slot('lt_ny_settlement_docs', 'eo').required,
    'the settlement agent documents carry a required E&O slot');
  const asked = kinds.ORDER_KINDS.ny_settlement_agent.wants.join(' | ');
  assert.ok(/\bCPL\b|closing protection/i.test(asked), `the settlement agent is ASKED for the CPL (${asked})`);
  assert.ok(/E&O|errors and omissions/i.test(asked), `the settlement agent is ASKED for the E&O (${asked})`);
  assert.ok(/preliminary settlement statement/i.test(asked), 'and still for the preliminary settlement statement');
  assert.ok(JSON.stringify(ny.ruleLogic || null).includes('is_new_york'), 'and only in New York');

  for (const key of ['cpl', 'prelim_settlement', 'wire_instructions']) {
    const s = slot('lt_title_docs', key);
    assert.strictEqual(s && s.notWhenField, 'is_new_york', `title's "${key}" slot does not apply in New York`);
  }
  assert.strictEqual(slot('lt_title_docs', 'commitment').notWhenField, undefined, 'the commitment still applies everywhere');
  ok('New York: the CPL and the E&O are the settlement agent\'s, and title is not asked for the wiring instructions');
}

console.log(`\ntest-lt-order-slot-map-pure: ${checks} checks passed\n`);
