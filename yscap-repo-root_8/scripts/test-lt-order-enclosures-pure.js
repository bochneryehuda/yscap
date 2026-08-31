#!/usr/bin/env node
/**
 * WHAT AN ORDER ASKS FOR, AND WHAT IT ENCLOSES.
 *
 * Owner-reported 2026-08-31: *"from the condo order You dropped certain stuff.
 * Please look back on my original message. I think we were also asking for
 * bylaws. Please look back and make sure you don't drop anything."*
 *
 * The original brief, quoted verbatim:
 *     Condo Documents Request - Please provide the following:
 *     -Completed condo questionnaire
 *     -Current HOA budget
 *     -Bylaws
 *     -Master insurance policy or insurance agent contact
 * …and *"we send out a template of the Fannie Mae condo questionnaire attached
 * as a PDF."*
 *
 * TWO THINGS ARE PINNED, and they are different failures:
 *   · the ASK  — every item the owner listed is in the letter;
 *   · the PLACE — every item has a slot on the condition that receives it.
 * An ask with no slot produces a document with nowhere to file it and a
 * condition that can never read as complete; a slot with no ask produces a
 * condition that can never be finished because nobody was asked for the thing.
 */
const kinds = require('../src/longterm/orders/kinds.js');
const enclosures = require('../src/longterm/orders/enclosures.js');
const letter = require('../src/longterm/orders/letter.js');
const lib = require('../src/longterm/conditions-center/library.js');

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fails.push(detail ? `${name} — ${detail}` : name);
};

const library = typeof lib.library === 'function' ? lib.library() : lib.library;
const byCode = (c) => library.find((x) => x.code === c);

// ── A. THE ASK ──────────────────────────────────────────────────────────────
{
  const condo = kinds.ORDER_KINDS.condo_questionnaire;
  const asked = condo.wants.join(' | ').toLowerCase();

  ok('the condo order asks for the questionnaire', /question/.test(asked));
  ok('the condo order asks for the current budget', /budget/.test(asked));
  ok('the condo order asks for the BYLAWS', /bylaw/.test(asked), asked);
  ok('the condo order asks for the master insurance policy', /master insurance/.test(asked));
  // The owner wrote it as an OR: an association that will not release the policy
  // will name the agent who can, and asking only for the policy is what stalls it.
  ok('…or the insurance agent, as the owner wrote it', /agent/.test(asked), asked);
}

// ── B. THE PLACE ────────────────────────────────────────────────────────────
{
  const docs = byCode('lt_condo_docs');
  ok('the condo documents condition exists', !!docs);
  const slots = (docs.slots || []).map((s) => s.key);
  for (const k of ['questionnaire', 'budget', 'bylaws', 'master_insurance']) {
    ok(`a slot exists for ${k}`, slots.includes(k), `slots: ${slots.join(', ')}`);
  }

  // Every slot the ORDER can route a document into must be a slot the CONDITION
  // actually has, or `slotMap` files a return against a key nothing renders.
  const mapped = kinds.ORDER_KINDS.condo_questionnaire.slotMap
    .map(([, key]) => key).filter(Boolean);
  for (const key of mapped) {
    ok(`slotMap target "${key}" is a real slot on the condition`, slots.includes(key));
  }
}

// ── C. THE ROUTING ORDER IS LOAD-BEARING ────────────────────────────────────
// "Certificate of insurance" contains BOTH an insurance word and `cert`, which
// the questionnaire pattern also matches. Whichever runs first wins, so the
// insurance test must come before the questionnaire test or a master policy is
// filed as the completed questionnaire — and the condition then reads as
// answered when the association has answered nothing.
{
  const map = kinds.ORDER_KINDS.condo_questionnaire.slotMap;
  const slotFor = (filename) => {
    for (const [re, key] of map) if (re.test(filename)) return key;
    return null;
  };
  /* THE FIXTURE HAS TO BE ONE THAT ACTUALLY DECIDES. "Certificate of Insurance"
     looks like the ambiguous case and is not: `cert(ification)?\b` cannot match
     "Certificate" (the `\b` fails against the following "i"), so that filename
     is unambiguous and an assertion on it passes whichever pattern runs first —
     proving nothing. "Certification" DOES match both patterns, so it is the
     only shape that can tell a correct order from a broken one. Verified by
     mutation: swapping the patterns leaves the "Certificate" assertion green
     and fails this one. */
  ok('a master insurance certification files as insurance, not as the questionnaire',
    slotFor('Master Insurance Certification 2025.pdf') === 'master_insurance',
    String(slotFor('Master Insurance Certification 2025.pdf')));
  ok('the completed questionnaire still files as the questionnaire',
    slotFor('Lender Questionnaire completed.pdf') === 'questionnaire');
  ok('bylaws file as bylaws', slotFor('Ocean Ave Bylaws.pdf') === 'bylaws');
  ok('a hyphenated by-law still files as bylaws', slotFor('By-Laws 2024.pdf') === 'bylaws');
  ok('the budget files as the budget', slotFor('2025 Operating Budget.pdf') === 'budget');
}

// ── D. THE ENCLOSURE ────────────────────────────────────────────────────────
{
  const e = enclosures.forKind('condo_questionnaire');
  ok('the condo order encloses one document', e.attachments.length === 1);
  ok('nothing was skipped', e.skipped.length === 0, JSON.stringify(e.skipped));
  const a = e.attachments[0] || {};
  ok('it is named for what it IS, not for our filename',
    /questionnaire/i.test(a.filename || '') && !/fannie-1076-condo/.test(a.filename || ''),
    a.filename);
  const bytes = a.content ? Buffer.from(a.content, 'base64') : Buffer.alloc(0);
  ok('the enclosure is a real, non-empty PDF',
    bytes.length > 1000 && bytes.slice(0, 4).toString() === '%PDF',
    `${bytes.length} bytes, magic ${JSON.stringify(bytes.slice(0, 4).toString())}`);

  // Every OTHER kind encloses nothing — the verification of rent's PDF is drawn
  // per file and passed in by its own desk, and an order that silently grew an
  // attachment is an order whose vendor gets a document nobody meant to send.
  for (const k of Object.keys(kinds.ORDER_KINDS)) {
    if (k === 'condo_questionnaire') continue;
    ok(`the ${k} order encloses nothing of its own`,
      enclosures.forKind(k).attachments.length === 0);
  }
  ok('an unknown kind encloses nothing rather than guessing',
    enclosures.forKind('nonsense').attachments.length === 0);
}

// ── E. THE LETTER SAYS THE FORM IS ATTACHED ─────────────────────────────────
// Enclosing a form and not mentioning it produced exactly one outcome the first
// time: a reply asking which form we meant.
{
  const out = letter.buildLetter('condo_questionnaire', {
    propertyLine: '55 Ocean Ave Apt 4B, Brooklyn, NY 11225',
    borrowerName: 'A Borrower', loanNumber: 'LT-1', transactionType: 'Refinance',
    vendors: { hoa: { company_name: 'Ocean Ave HOA' } },
  }, {});
  const text = String(out.text || '');
  ok('the letter says our form is attached', /attached/i.test(text), text.slice(0, 200));
  ok('the letter names the bylaws', /bylaw/i.test(text));
  ok('the letter carries the property address so the unit can be identified',
    /55 Ocean Ave Apt 4B/.test(text));
}

if (fails.length) {
  console.error(`\n${fails.length} FAILED:`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${pass} checks passed`);
