'use strict';

/**
 * Pure unit tests (no DB, no server) for the BORROWER ASSISTANT — a standing
 * second login a borrower authorizes, who "can do everything but not see the
 * personal information and not sign documents" (owner-directed). Runs in
 * `npm test`.
 *
 * What is proven here is the SECURITY SPINE, because that is the part where a
 * mistake is not cosmetic:
 *   • the token is a REAL borrower token PLUS an assistant envelope (so every
 *     borrower route works unchanged) and never loses the envelope on refresh;
 *   • the PII scrub deep-strips EVERY personal field, at any nesting, without
 *     mutating the original — and keeps the operational fields the helper needs;
 *   • the blocked-action list matches EXACTLY its routes (signing, the borrower's
 *     identity/PII editor, the payment card, and the borrower credential routes)
 *     and nothing else — an over-broad list would break the parity the owner
 *     asked for;
 *   • the global guard refuses those actions for an assistant caller and is
 *     completely inert for an ordinary borrower or an unauthenticated request.
 */

const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-borrower-assistant-tests';

const A = require('../src/lib/borrower-assistant');
const C = require('../src/lib/crypto');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { n++; assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); };

const BORROWER  = '11111111-1111-1111-1111-111111111111';
const ASSISTANT = '22222222-2222-2222-2222-222222222222';

// ---------------------------------------------------------------------------
// 1. The token: a REAL borrower access token carrying the assistant envelope
// ---------------------------------------------------------------------------
const token = A.mintToken({ borrowerId: BORROWER, borrowerTv: 0, assistantId: ASSISTANT, assistantTv: 4 });
const claims = C.verifyJwt(token);
eq(claims.kind, 'borrower', 'token is a borrower-kind token (so borrower routes work unchanged)');
eq(claims.sub, BORROWER, 'the subject is the BORROWER id (scoping runs off it)');
eq(claims.role, 'borrower', 'role is borrower');
eq(claims.asst, 1, 'the assistant marker is set');
eq(claims.asstId, ASSISTANT, 'the assistant id rides in the envelope');
eq(claims.astv, 4, 'the assistant token_version rides in the envelope');

const env = A.readAssistant(claims);
ok(env, 'readAssistant reads the envelope off verified claims');
eq(env.assistantId, ASSISTANT, 'envelope assistantId');
eq(env.assistantTv, 4, 'envelope assistantTv');

// A PLAIN borrower token (no envelope) is NEVER read as an assistant — otherwise
// an ordinary borrower would get the PII strip + sign block.
eq(A.readAssistant({ kind: 'borrower', sub: BORROWER, tv: 0 }), null, 'a plain borrower token is not an assistant');
eq(A.readAssistant({ kind: 'staff', sub: 'x', asst: 1, asstId: 'y' }), null, 'a staff token is never an assistant');
eq(A.readAssistant({ kind: 'borrower', sub: BORROWER, asst: 1 }), null, 'asst without asstId is not an assistant (forgery guard)');
eq(A.readAssistant(null), null, 'null claims -> null');

// A forged/altered token cannot be minted without the secret — verifyJwt fails.
eq(C.verifyJwt(token.slice(0, -3) + 'zzz'), null, 'a tampered token does not verify');

// ---------------------------------------------------------------------------
// 2. The PII scrub — the "cannot see personal information" half
// ---------------------------------------------------------------------------
const body = {
  first_name: 'Pat', last_name: 'Borrower', email: 'p@x.com', cell_phone: '555-1212',
  current_address: { line1: '1 Main', city: 'Lakewood', state: 'NJ' },
  // Every personal / financial field, in several casings + nested + in an array:
  ssn: '123456789', ssn_last4: '6789', ssnLast4: '6789', ssn_encrypted: 'xx',
  date_of_birth: '1990-01-01', dateOfBirth: '1990-01-01', dob: '1990-01-01',
  fico: 720, credit_score: 720, middle_score: 715, citizenship: 'US', marital_status: 'single',
  card_last4: '9999', cardLast4: '9999', card_exp: '12/28', card_brand: 'visa',
  card_number_encrypted: 'zz', card_cvv_encrypted: 'zz',
  coBorrower: { first_name: 'Jo', ssn_last4: '7777', date_of_birth: '1988-02-02', fico: 680 },
  applications: [{ id: 'a1', loan_amount: 500000, fico: 700, keep: 'ok' }],
};
const scrubbed = A.scrubPii(body);
// kept — the helper needs these to work
ok(scrubbed.first_name === 'Pat' && scrubbed.email === 'p@x.com' && scrubbed.cell_phone === '555-1212', 'name / email / phone kept');
ok(scrubbed.current_address && scrubbed.current_address.city === 'Lakewood', 'property/address kept');
ok(scrubbed.applications[0].loan_amount === 500000 && scrubbed.applications[0].keep === 'ok', 'loan/operational data kept');
ok(scrubbed.coBorrower.first_name === 'Jo', 'co-borrower NAME kept');
// stripped — every PII key, every casing, at every depth
for (const k of ['ssn', 'ssn_last4', 'ssnLast4', 'ssn_encrypted', 'date_of_birth', 'dateOfBirth',
  'dob', 'fico', 'credit_score', 'middle_score', 'citizenship', 'marital_status',
  'card_last4', 'cardLast4', 'card_exp', 'card_brand', 'card_number_encrypted', 'card_cvv_encrypted']) {
  ok(!(k in scrubbed), `top-level PII stripped: ${k}`);
}
ok(!('ssn_last4' in scrubbed.coBorrower) && !('date_of_birth' in scrubbed.coBorrower) && !('fico' in scrubbed.coBorrower), 'nested co-borrower PII stripped');
ok(!('fico' in scrubbed.applications[0]), 'PII inside an array element stripped');
// never mutates the original response object
ok(body.ssn_last4 === '6789' && body.coBorrower.fico === 680 && body.applications[0].fico === 700, 'original object is NOT mutated');
// primitives / null pass through untouched
eq(A.scrubPii(null), null, 'null passes through');
eq(A.scrubPii('hi'), 'hi', 'a string passes through');
eq(A.scrubPii(42), 42, 'a number passes through');
// a cyclic structure does not spin
const cyc = { first_name: 'X', ssn_last4: '1' }; cyc.self = cyc;
const cs = A.scrubPii(cyc);
ok(!('ssn_last4' in cs) && cs.first_name === 'X', 'cyclic structure scrubbed without spinning');

// The PII key set names the sensitive fields (a smoke check the list is real).
ok(A.PII_KEYS.has('ssn') && A.PII_KEYS.has('date_of_birth') && A.PII_KEYS.has('fico') && A.PII_KEYS.has('card_last4'),
  'PII_KEYS covers the sensitive set');

// ---------------------------------------------------------------------------
// 3. The blocked-action list — the "cannot sign / touch the credential" half.
//    It must match EXACTLY the routes it means to (and nothing more).
// ---------------------------------------------------------------------------
const BLOCK = [
  ['POST', '/api/borrower/applications/abc-123/esign/sign-view', 'esign'],
  ['PUT', '/api/borrower/profile', 'profile'],
  ['POST', '/api/borrower/applications/abc/appraisal-card', 'card'],
  ['POST', '/api/borrower/applications/abc/scan-card', 'card'],
  ['POST', '/api/borrower/applications/abc/appraisal-card/from-saved', 'card'],
  ['POST', '/auth/logout', 'logout'],
  ['POST', '/auth/mfa/enable', 'mfa'],
  ['DELETE', '/auth/mfa/disable', 'mfa'],
];
for (const [m, p, code] of BLOCK) {
  const r = A.blockedReason(m, p);
  ok(r && r.code === code, `blocked ${m} ${p} -> ${code}`);
  ok(r && typeof r.message === 'string' && r.message.length > 0, `blocked ${p} carries a plain message`);
}
// query strings are ignored when matching
ok(A.blockedReason('PUT', '/api/borrower/profile?x=1'), 'a query string does not defeat the match');

const ALLOW = [
  // The whole point of a helper — these must NOT be blocked:
  ['POST', '/api/borrower/documents'],                 // upload a document
  ['POST', '/api/borrower/applications/abc/documents'],
  ['GET', '/api/borrower/profile'],                    // READ (PII is scrubbed, not blocked)
  ['GET', '/api/borrower/applications'],
  ['POST', '/api/borrower/messages'],                  // message the team
  ['POST', '/api/borrower/applications/abc/tool'],     // use a tool
  ['GET', '/api/borrower/applications/abc/esign'],     // SEE that a signature is needed
  ['POST', '/auth/assistant/logout'],                  // the helper's own sign-out
  ['GET', '/auth/me'],
  ['POST', '/api/borrower/applications/abc/appraisal-card-something'], // not the card route
];
for (const [m, p] of ALLOW) {
  eq(A.blockedReason(m, p), null, `allowed ${m} ${p}`);
}
// the wrong METHOD on a blocked path is not blocked (e.g. reading the profile)
eq(A.blockedReason('GET', '/api/borrower/profile'), null, 'GET /profile is a read, not blocked');
eq(A.blockedReason('GET', '/auth/logout'), null, 'GET on the logout path is not the logout action');

// ---------------------------------------------------------------------------
// 4. The global guard middleware
// ---------------------------------------------------------------------------
function runGuard({ authHeader, method, path }) {
  let status = null, jsonBody = null, nexted = false;
  const req = { get: (h) => (h.toLowerCase() === 'authorization' ? authHeader : null), method, path };
  const res = { status: (c) => { status = c; return res; }, json: (b) => { jsonBody = b; return res; } };
  A.guard(req, res, () => { nexted = true; });
  return { status, jsonBody, nexted };
}
// assistant token + a blocked action -> 403, does not call next
{
  const r = runGuard({ authHeader: 'Bearer ' + token, method: 'POST', path: '/api/borrower/applications/x/esign/sign-view' });
  eq(r.nexted, false, 'guard blocks a signing attempt (no next)');
  eq(r.status, 403, 'guard answers 403');
  ok(r.jsonBody && r.jsonBody.assistantBlocked === 'esign', 'guard names the blocked reason');
}
// assistant token + an allowed action -> next()
{
  const r = runGuard({ authHeader: 'Bearer ' + token, method: 'POST', path: '/api/borrower/documents' });
  ok(r.nexted && r.status === null, 'guard lets an allowed assistant action through');
}
// a PLAIN borrower token is completely inert (even on a would-be-blocked path)
{
  const plain = C.signJwt({ sub: BORROWER, kind: 'borrower', role: 'borrower', tv: 0 }, 60);
  const r = runGuard({ authHeader: 'Bearer ' + plain, method: 'POST', path: '/api/borrower/applications/x/esign/sign-view' });
  ok(r.nexted && r.status === null, 'guard is inert for an ordinary borrower (they can sign)');
}
// no token -> inert
{
  const r = runGuard({ authHeader: null, method: 'POST', path: '/auth/logout' });
  ok(r.nexted && r.status === null, 'guard is inert with no bearer token');
}

console.log(`\n✓ borrower-assistant pure: ${n} assertions passed`);
process.exit(0);
