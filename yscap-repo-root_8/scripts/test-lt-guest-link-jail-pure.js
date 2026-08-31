'use strict';
// =============================================================================
// THE LONG-TERM GUEST LINK'S PATH JAIL — what an emailed link may reach
// =============================================================================
//
// The guest condition link hands an emailed, forwardable token a REAL borrower
// session. That is only safe because of the jail: a guest may reach a handful
// of named endpoints, for ONE file, and nothing else — default-deny, so an
// endpoint added next year is closed until somebody lists it.
//
// Sharing that mechanism with Long-Term adds the one thing a jail must never
// get wrong: there are now TWO products behind it. A long-term guest must not
// be able to name a short-term application and walk into `/api/borrower/...`,
// and the reverse. This proves both directions, and proves the short-term side
// is BYTE-IDENTICAL to before — the sharing directive's own standard: *"watch
// what you're doing not to break the other side of the business."*
//
// PURE. No database, no network. In `npm test`.
// =============================================================================

const assert = require('assert');
const link = require('../src/lib/condition-link');
// THE LONG-TERM DOORS ARE REGISTERED, NOT BUILT IN — shared back-end code may
// not name `/api/lt`, so the product declares its own and hands them over. This
// require is what a boot that mounts Long-Term does; a boot that does not is
// covered by section H below.
const ltJail = require('../src/longterm/guest/jail');
ltJail.register();

/** A pristine copy of a module, with no registration another test performed. */
function requireFresh(rel) {
  const key = require.resolve(rel);
  delete require.cache[key];
  const m = require(rel);
  delete require.cache[key];          // leave the cache as we found it
  return m;
}

/* A FAILURE MUST NAME ITSELF AND LET THE BATTERY FINISH. `assert.strictEqual`
   THROWS, so the first failure stopped this suite where it stood and printed a
   stack — which reads as "the suite crashed" rather than "these four checks
   failed", and hides every check after it. That is the repo's own recorded trap
   (a crashing test also "fails" and looks like proof). Counted and reported
   instead, so a mutation run says exactly which properties stopped holding. */
let n = 0;
let failed = 0;
const record = (pass, m) => {
  n++;
  if (!pass) { failed++; console.log(`FAIL ${m}`); }
};
const ok = (c, m) => record(!!c, m);
const eq = (a, b, m) => record(Object.is(a, b), `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

const APP = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const LOAN = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const OTHER = 'cccccccc-3333-4333-8333-cccccccccccc';
const COND = 'dddddddd-4444-4444-8444-dddddddddddd';
const LINKID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

const rtlGuest = { linkId: LINKID, applicationId: APP, ltLoanId: null };
const ltGuest = { linkId: LINKID, applicationId: null, ltLoanId: LOAN };
const may = (guest, method, fullPath, body, headers) =>
  link.allowedRequest({ method, fullPath, body, headers }, guest);

// ---------------------------------------------------------------------------
// A. THE SHORT-TERM SIDE IS UNCHANGED
// ---------------------------------------------------------------------------
// Every door the short-term jail had, still open; everything else, still shut.
ok(may(rtlGuest, 'GET', `/api/borrower/applications/${APP}`), 'A1 the file still opens');
ok(may(rtlGuest, 'GET', `/api/borrower/applications/${APP}/checklist`), 'A2 the checklist still opens');
ok(may(rtlGuest, 'POST', `/api/borrower/applications/${APP}/checklist/${COND}/info`), 'A3 an info answer still saves');
ok(may(rtlGuest, 'POST', `/api/borrower/applications/${APP}/checklist/${COND}/tool`), 'A4 a tool still submits');
ok(may(rtlGuest, 'POST', `/api/borrower/applications/${APP}/appraisal-card`), 'A5 the card still saves');
ok(may(rtlGuest, 'POST', '/api/borrower/documents', { applicationId: APP }), 'A6 a document still uploads');
ok(may(rtlGuest, 'POST', '/api/borrower/documents/binary', null,
  { 'x-upload-meta': JSON.stringify({ applicationId: APP }) }), 'A7 …and through the streaming door');

eq(may(rtlGuest, 'GET', `/api/borrower/applications/${OTHER}`), false,
  'A8 another file is still refused');
eq(may(rtlGuest, 'POST', '/api/borrower/documents', { applicationId: APP, llcId: OTHER }), false,
  'A9 an entity upload is still refused');
eq(may(rtlGuest, 'GET', '/api/borrower/applications'), false,
  'A10 the file LIST is still refused — a forwarded link never enumerates a borrower');

// ---------------------------------------------------------------------------
// B. THE LONG-TERM DOORS — exactly three, for one loan
// ---------------------------------------------------------------------------
ok(may(ltGuest, 'GET', `/api/lt/my/loans/${LOAN}/conditions`), 'B1 the loan’s conditions open');
ok(may(ltGuest, 'POST', `/api/lt/my/loans/${LOAN}/conditions/${COND}/documents`), 'B2 a document uploads to a condition');
ok(may(ltGuest, 'POST', `/api/lt/my/loans/${LOAN}/conditions/${COND}/documents/binary`), 'B3 …and through the streaming door');

eq(may(ltGuest, 'GET', `/api/lt/my/loans/${OTHER}/conditions`), false,
  'B4 ANOTHER loan is refused — the id in the path must be the one the link was minted for');
eq(may(ltGuest, 'POST', `/api/lt/my/loans/${OTHER}/conditions/${COND}/documents`), false,
  'B5 …including on the upload door');
eq(may(ltGuest, 'GET', '/api/lt/my/loans'), false,
  'B6 the LOAN LIST is refused — an emailed link must never enumerate the borrower’s other loans');

// A door nobody listed is shut, which is the property the whole jail rests on.
for (const [m, p] of [
  ['GET', `/api/lt/my/loans/${LOAN}`],
  ['POST', `/api/lt/my/loans/${LOAN}/conditions/${COND}/answer`],
  ['GET', `/api/lt/condition-center/loans/${LOAN}/profile-links`],
  ['POST', `/api/lt/condition-center/loans/${LOAN}/appraisal-card`],
  ['GET', `/api/lt/loans/${LOAN}`],
  ['GET', '/api/staff/applications'],
  ['POST', '/auth/logout'],
]) {
  eq(may(ltGuest, m, p), false, `B7 default-deny: ${m} ${p}`);
}

// ---------------------------------------------------------------------------
// C. THE TWO PRODUCTS CANNOT REACH EACH OTHER
// ---------------------------------------------------------------------------
// This is the whole reason the rule lists are separate.
eq(may(ltGuest, 'GET', `/api/borrower/applications/${LOAN}`), false,
  'C1 a long-term guest cannot walk into the short-term doors, even naming its own id');
eq(may(ltGuest, 'POST', '/api/borrower/documents', { applicationId: LOAN }), false,
  'C2 …nor the short-term upload door');
eq(may(rtlGuest, 'GET', `/api/lt/my/loans/${APP}/conditions`), false,
  'C3 and a short-term guest cannot reach the long-term doors');

// ---------------------------------------------------------------------------
// D. FAIL CLOSED on a token that names both owners, or neither
// ---------------------------------------------------------------------------
eq(may({ linkId: LINKID, applicationId: APP, ltLoanId: LOAN }, 'GET',
  `/api/borrower/applications/${APP}`), false,
  'D1 a guest naming BOTH owners gets no doors at all — not the first list that matches');
eq(may({ linkId: LINKID, applicationId: APP, ltLoanId: LOAN }, 'GET',
  `/api/lt/my/loans/${LOAN}/conditions`), false, 'D2 …in either product');
eq(may({ linkId: LINKID }, 'GET', `/api/borrower/applications/${APP}`), false,
  'D3 a guest naming NEITHER owner gets nothing');
eq(may(null, 'GET', `/api/borrower/applications/${APP}`), false, 'D4 and no guest at all gets nothing');
eq(link.rulesFor(null), null, 'D5 rulesFor is fail-closed on its own');

// ---------------------------------------------------------------------------
// E. THE ENTITY DOOR IS SHUT ON THE LONG-TERM UPLOADS TOO
// ---------------------------------------------------------------------------
// The shared upload module files onto a COMPANY when handed an llcId. An
// emailed link must never put a document on the borrower's company record.
eq(may(ltGuest, 'POST', `/api/lt/my/loans/${LOAN}/conditions/${COND}/documents`, { llcId: OTHER }), false,
  'E1 an llcId in the body is refused');
eq(may(ltGuest, 'POST', `/api/lt/my/loans/${LOAN}/conditions/${COND}/documents/binary`, null,
  { 'x-upload-meta': JSON.stringify({ llcId: OTHER }) }), false,
  'E2 …and in the streaming door’s metadata header');
eq(may(ltGuest, 'POST', `/api/lt/my/loans/${LOAN}/conditions/${COND}/documents/binary`, null,
  { 'x-upload-meta': '{ not json' }), false,
  'E3 …and metadata we cannot read is refused rather than assumed harmless');
ok(may(ltGuest, 'POST', `/api/lt/my/loans/${LOAN}/conditions/${COND}/documents/binary`, null,
  { 'x-upload-meta': JSON.stringify({ filename: 'statement.pdf' }) }),
  'E4 …while ordinary metadata still uploads');

// ---------------------------------------------------------------------------
// F. THE ENVELOPE — exactly one owner, minted and read
// ---------------------------------------------------------------------------
eq(link.readGuest({ gcl: 1, kind: 'borrower', gclId: LINKID, gclApp: APP }).applicationId, APP,
  'F1 a short-term envelope reads its application');
eq(link.readGuest({ gcl: 1, kind: 'borrower', gclId: LINKID, gclApp: APP }).ltLoanId, null,
  'F2 …and names no loan');
eq(link.readGuest({ gcl: 1, kind: 'borrower', gclId: LINKID, gclLt: LOAN }).ltLoanId, LOAN,
  'F3 a long-term envelope reads its loan');
eq(link.readGuest({ gcl: 1, kind: 'borrower', gclId: LINKID, gclLt: LOAN }).applicationId, null,
  'F4 …and names no application');
eq(link.readGuest({ gcl: 1, kind: 'borrower', gclId: LINKID, gclApp: APP, gclLt: LOAN }), null,
  'F5 an envelope naming BOTH is not a guest session — a forged claim never reaches the jail');
eq(link.readGuest({ gcl: 1, kind: 'borrower', gclId: LINKID }), null, 'F6 nor one naming neither');
eq(link.readGuest({ gcl: 1, kind: 'staff', gclId: LINKID, gclApp: APP }), null,
  'F7 nor a staff-kind token wearing the envelope');
eq(link.readGuest({ kind: 'borrower', gclId: LINKID, gclApp: APP }), null,
  'F8 nor an ordinary borrower token with no gcl marker');
eq(link.readGuest(null), null, 'F9 and no claims at all is not a guest');

// ---------------------------------------------------------------------------
// G. THE STORED LINK ROW AND THE TOKEN MUST AGREE ABOUT WHICH FILE
// ---------------------------------------------------------------------------
//
// The trap this closes: `String(row.application_id) !== String(claim)` reads
// "null" === "null" as agreement, so a long-term link and a long-term token
// would "match" on the short-term column neither of them uses — and the check
// meant to catch a swapped token would pass. The owner KIND is compared before
// the ids are.
const rtlRow = { id: LINKID, application_id: APP, lt_loan_id: null };
const ltRow = { id: LINKID, application_id: null, lt_loan_id: LOAN };

eq(link.guestFromLink(rtlRow).applicationId, APP, 'G1 a short-term row reports its application');
eq(link.guestFromLink(ltRow).ltLoanId, LOAN, 'G2 a long-term row reports its loan');
eq(link.guestFromLink({ id: LINKID, application_id: null, lt_loan_id: null }), null,
  'G3 a row owning nothing is not a guest — it gets no doors');
eq(link.guestFromLink({ id: LINKID, application_id: APP, lt_loan_id: LOAN }), null,
  'G4 nor one owning both, which the database CHECK forbids anyway');
eq(link.guestFromLink(null), null, 'G5 and no row at all is not a guest');

ok(link.linkMatchesGuest(rtlRow, rtlGuest), 'G6 a short-term row matches its own token');
ok(link.linkMatchesGuest(ltRow, ltGuest), 'G7 a long-term row matches its own token');
/* HONESTLY: G8 and G9 are the CROSS-PRODUCT cases, and a naive string compare
   happens to refuse them too (one side carries a real id, so the strings
   differ). They are kept because they state the rule, not because they are
   what catches the bug — G10 above is. Recorded rather than left to imply
   more than it does. */
eq(link.linkMatchesGuest(ltRow, rtlGuest), false,
  'G8 a long-term row does not match a short-term token');
eq(link.linkMatchesGuest(rtlRow, ltGuest), false, 'G9 …nor the reverse');
/* THE SHAPE MATTERS, and this assertion was weaker than it looked until a
   mutation exposed it. Written with `{ linkId, ltLoanId: OTHER }` the guest's
   `applicationId` is UNDEFINED, so even a naive `String(a) === String(b)`
   compare answers `"null" === "undefined"` and refuses — for the wrong reason.
   `readGuest` always produces an explicit `applicationId: null`, and THAT is
   the shape where the trap lives: null against null reads as agreement, so one
   borrower's long-term token would match a DIFFERENT long-term link. Build the
   fixture the way the code really builds it. */
eq(link.linkMatchesGuest(ltRow, { linkId: LINKID, applicationId: null, ltLoanId: OTHER }), false,
  'G10 THE ONE THAT MATTERS: a token for a DIFFERENT long-term loan is refused — both '
  + 'rows carry a null application_id, and a plain string compare would call that a match');
/* THE CASE THE OWNER-KIND CHECKS EXIST FOR, found by mutation: removing them
   left every other assertion here green, because resolving each side to its
   single owner (`applicationId || ltLoanId`) already makes a short-term id and
   a long-term id compare unequal. What it does NOT cover is the same id under
   a DIFFERENT kind — a short-term link and a long-term token both naming X.
   Absurd in practice (an application id equal to a loan id), and exactly what a
   uuid collision or a mis-copied claim would look like; the kind check makes it
   structurally impossible rather than improbable. */
eq(link.linkMatchesGuest({ id: LINKID, application_id: APP, lt_loan_id: null },
  { linkId: LINKID, applicationId: null, ltLoanId: APP }), false,
  'G11a the SAME id under a different owner kind is not a match — the kind agrees before the id is read');
eq(link.linkMatchesGuest({ id: LINKID, application_id: null, lt_loan_id: LOAN },
  { linkId: LINKID, applicationId: LOAN, ltLoanId: null }), false,
  'G11b …in the other direction too');

eq(link.linkMatchesGuest(null, ltGuest), false, 'G11 no row matches nothing');
eq(link.linkMatchesGuest(ltRow, null), false, 'G12 and no token matches nothing');

// ---------------------------------------------------------------------------
// H. WITH NOTHING REGISTERED, A LONG-TERM GUEST GETS NOTHING
// ---------------------------------------------------------------------------
//
// The registry is the seam between the two products, so its failure mode has to
// be the safe one: a boot that never loaded the Long-Term side must leave a
// long-term guest with NO doors — never falling through to the short-term list,
// which is the only other thing `rulesFor` could plausibly do.
{
  const fresh = requireFresh('../src/lib/condition-link');
  eq(fresh.rulesFor(ltGuest), null,
    'H1 with no doors registered a long-term guest gets no jail at all');
  eq(fresh.allowedRequest({ method: 'GET', fullPath: `/api/lt/my/loans/${LOAN}/conditions` }, ltGuest), false,
    'H2 …so its own endpoint is refused rather than opened');
  eq(fresh.allowedRequest({ method: 'GET', fullPath: `/api/borrower/applications/${LOAN}` }, ltGuest), false,
    'H3 …and it does NOT fall through to the short-term doors');
  ok(fresh.rulesFor(rtlGuest) !== null,
    'H4 while the short-term jail is built in and needs no registration');

  // And the registry refuses nonsense rather than storing it.
  eq(fresh.registerJail('lt_loan', []), false, 'H5 an empty rule list is not a registration');
  eq(fresh.registerJail('lt_loan', null), false, 'H6 nor a missing one');
  eq(fresh.registerJail('', [{ m: 'GET', re: /x/ }]), false, 'H7 nor one with no owner kind');
}

if (failed) {
  console.log(`\ntest-lt-guest-link-jail-pure: ${failed} of ${n} checks FAILED`);
  process.exit(1);
}
console.log(`test-lt-guest-link-jail-pure: ${n} checks passed`);
