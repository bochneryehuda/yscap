'use strict';
/**
 * LT — WHY DOES ENCOMPASS SAY NO? A read-only diagnostic.
 *
 * Run this where the Encompass credentials live:
 *
 *     node scripts/test-lt-encompass-access-probe.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS FOR
 *
 * 68 endpoints answer 403 on this tenant while the API user holds the Super
 * Administrator persona. "The admin has full access" and "the API answers 403" are
 * both true, and the reason is that several independent things gate this API. A 403 on
 * its own does not say which one closed, so these are candidates in the order worth
 * testing — cheapest and most likely first:
 *
 *   1. WHAT WE ASK FOR AT LOGIN. Our client names `scope=lp`. Two mature Encompass
 *      clients name NO scope at all on this grant, and OAuth (RFC 6749 §3.3) says a
 *      server given no scope applies its own default — normally everything the caller
 *      is entitled to. We may have been narrowing our own token. The earlier
 *      introspection could not have caught this: it reported `lp` because `lp` is what
 *      we asked for. STEP 0 below tests it, and it is free.
 *
 *   2. WHETHER THE API USER REALLY HOLDS THE PERSONA WE BELIEVE. Assumed, never
 *      checked. The roster and persona endpoints both answer today, so it is cheap.
 *      NOTE: a Super Administrator ALREADY holds the settings areas we want — ICE's
 *      matrix lists them under "Default Persona Access", footnoted "minimum persona
 *      access level required to interact with the functionality out-of-the-box". So
 *      ticking boxes on Personas > Settings tab EXTENDS an area to OTHER personas and
 *      will not open anything for an account that is already a super admin. An earlier
 *      draft of this file advised exactly that; it was wrong.
 *
 *   3. THE USER'S USER GROUP. Template-backed settings are gated separately: "In
 *      order for [a] user to access Public and Company-wide Loan Programs, BOTH of
 *      these folders must be selected in the user's user group." No persona grants
 *      this. Narrow — it applies to loan programs.
 *
 *   4. THE PRODUCT / CLIENT ENTITLEMENT. Some families are separately licensed
 *      add-ons (product & pricing / EPPS, secondary and the lock desk, tasks). No
 *      persona opens a product the tenant does not have.
 *
 * WHAT THIS SCRIPT ADDS that the earlier probe did not: it keeps the RESPONSE BODY
 * of every refusal. ICE puts a summary in it, and the wording differs by gate — that
 * is the evidence that says which candidate to go and work, instead of guessing.
 * The earlier sweep recorded only the status code, which is why the question is
 * still open.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOT PART OF `npm test`, deliberately, though it is named like the suites so the
 * separation gate recognises it as long-term code. It makes LIVE API calls when the
 * credentials are present, and a check that talks to a vendor on every push is a
 * check that eventually gets switched off. Run it by hand when you need the answer.
 *
 * READ-ONLY. Every call is a GET through the guarded client, plus the one pipeline
 * SEARCH used to find a loan id to test loan sub-resources against. It writes
 * nothing, to Encompass or to our database, and it adds no endpoint to the client's
 * allowlist. `scripts/check-encompass-readonly.js` covers this file.
 */

const client = require('../src/longterm/encompass/client');

const OK = (s) => `  ✓ ${s}`;
const NO = (s) => `  ✗ ${s}`;

/**
 * The refusals worth diagnosing, tagged with what we SUSPECT — never with a
 * conclusion. `unknown` is used honestly and often: for most of these a super admin
 * should already have access, so we genuinely do not know, and the response body is
 * the point of running this.
 *
 * `{loan}` is replaced with a real loan id found from the pipeline.
 */
const PROBES = [
  // Cause unknown — a super admin should already hold these, which is exactly why
  // the refusal wording is what we need.
  { path: '/encompass/v3/settings/businessRules/milestoneCompletion', gate: 'unknown',
    tick: null,
    worth: 'The 91 Milestone Completion rules. We know 22, from screen recordings — the single biggest gap in what PILOT knows about how this lender works.' },
  { path: '/encompass/v3/settings/loan/folders', gate: 'unknown',
    tick: null,
    worth: 'The folder list — which folders mean a live deal and which mean it is over. Without it the long-term pipeline cannot tell a withdrawn file from a live one.' },
  { path: '/encompass/v1/settings/milestoneTemplates', gate: 'unknown',
    tick: null,
    worth: 'The milestone templates behind the stage ladder.' },
  { path: '/encompass/v3/settings/loan/conditionTemplates', gate: 'unknown',
    tick: null,
    worth: 'The condition vocabulary, instead of inferring it from whatever values happen to appear.' },
  { path: '/encompass/v3/settings/customFields', gate: 'unknown',
    tick: null,
    worth: 'What every CX. field on this tenant actually means.' },

  // Candidate 3 — user-group gated template folders.
  { path: '/encompass/v3/settings/loan/programs', gate: 'usergroup',
    tick: "the user's USER GROUP must include the Public and Company-wide template folders",
    worth: 'The real program definitions behind field 1401. Today our program taxonomy is reverse-engineered from loan data.' },

  // Candidate 4 — separately licensed add-ons.
  { path: '/encompass/v1/settings/lockPolicy', gate: 'product',
    tick: 'Secondary / lock desk is a licensed add-on',
    worth: 'The lock desk rules. We already read each loan’s lock posture, so this is an improvement rather than a blocker.' },
  { path: '/encompass/v3/settings/pricing/investors', gate: 'product',
    tick: 'Product & Pricing (EPPS) is a licensed add-on',
    worth: 'The investor list. INTERNAL ONLY — the investor name never reaches a client.' },

  // Loan sub-resources — cause unknown, which is exactly why the body matters.
  { path: '/encompass/v3/loans/{loan}/milestoneLogs', gate: 'unknown',
    tick: null,
    worth: 'Who moved a file to each milestone and when. PILOT currently records only what it watched change itself, and says so on every screen.' },
  { path: '/encompass/v3/loans/{loan}/associates', gate: 'unknown',
    tick: null,
    worth: 'The loan team in v3 shape. The v1 form already answers, so this is a nicety.' },
  { path: '/encompass/v3/loans/{loan}/customFields', gate: 'unknown', tick: null,
    worth: 'Per-loan custom field values.' },
];

/** One line of evidence per endpoint: the status and, crucially, what ICE SAID. */
async function probe(path) {
  try {
    const body = await client.apiGet(path);
    const n = Array.isArray(body) ? body.length : (body && typeof body === 'object' ? Object.keys(body).length : 0);
    return { ok: true, status: 200, note: Array.isArray(body) ? `array[${n}]` : `object(${n} keys)` };
  } catch (e) {
    // The client throws `LT Encompass <status>: <first 200 chars of the body>`.
    const msg = String((e && e.message) || e);
    const m = /LT Encompass (\d{3}): ?([\s\S]*)$/.exec(msg);
    if (m) return { ok: false, status: Number(m[1]), note: m[2].trim() || '(empty body)' };
    return { ok: false, status: null, note: msg };
  }
}

/** A loan id to hang the sub-resource probes on. Read-only, one row. */
async function anyLoanId() {
  try {
    const rows = await client.pipelineSearch({
      filter: { canonicalName: 'Loan.LoanAmount', matchType: 'greaterThan', value: 0 },
      fields: ['Loan.LoanNumber'],
      sortOrder: [{ canonicalName: 'Loan.LastModified', order: 'Descending' }],
    }, { limit: 1, start: 0 });
    const list = Array.isArray(rows) ? rows : (rows && rows.loans) || [];
    return list.length ? (list[0].loanId || list[0].id || null) : null;
  } catch (e) {
    console.log(NO(`could not read one loan to test against: ${(e && e.message) || e}`));
    return null;
  }
}

(async () => {
  console.log('\nENCOMPASS ACCESS — what is actually refusing us, and why\n');

  if (!client.configured()) {
    console.log(NO('Encompass is not configured in this environment.'));
    console.log('    Set LT_ENCOMPASS_CLIENT_ID / _SECRET / _INSTANCE_ID (or the shared ENCOMPASS_* vars),');
    console.log('    plus LT_ENCOMPASS_USERNAME and _PASSWORD, then run this again.');
    console.log('    Nothing is written anywhere — this only reads.\n');
    process.exit(0);
  }

  // ── STEP 0: ARE WE ASKING FOR TOO LITTLE? ──────────────────────────────────
  // Our client names `scope=lp` on the password grant. Two independent, mature
  // Encompass clients — EncompassRest (.NET) and EncompassConnect (TypeScript) —
  // send NO scope at all on that grant. OAuth says a server given no scope applies
  // its own default, which is normally everything the caller is entitled to. So we
  // may have been narrowing our own token by naming `lp`, and the earlier
  // introspection could never have revealed it: it reported `lp` because `lp` is
  // what we asked for. This asks for nothing and reports what we are handed.
  console.log('STEP 0 — what are we actually granted?\n');
  const scopeTries = [null, 'lp'];
  const grants = [];
  for (const s of scopeTries) {
    try {
      const r = await client.tokenProbe(s);
      grants.push(r);
      console.log(`${r.ok ? OK('') : NO('')}asked for ${String(r.requested).padEnd(11)} → ${r.ok ? `granted: ${r.granted}` : `${r.status} ${String(r.error).slice(0, 120)}`}`);
    } catch (e) {
      console.log(NO(`asked for ${s == null ? '(omitted)' : s} → ${(e && e.message) || e}`));
    }
  }
  const omitted = grants.find((g) => g.requested === '(omitted)' && g.ok);
  const named = grants.find((g) => g.requested === 'lp' && g.ok);
  if (omitted && named && omitted.granted !== named.granted && omitted.granted !== '(not stated)') {
    console.log(`\n  >>> WORTH ACTING ON: omitting the scope grants "${omitted.granted}" while naming lp grants "${named.granted}".`);
    console.log('      We have been asking for less than we are entitled to. Drop `params.scope`');
    console.log('      from the password grant in src/longterm/encompass/client.js and re-run this.\n');
  } else if (omitted) {
    console.log('\n  (Omitting the scope grants the same thing, so `lp` is not what is holding us back.)\n');
  }

  const loanId = await anyLoanId();
  console.log(loanId ? OK(`reading against loan ${loanId}`) : NO('no loan id — the loan sub-resource checks will be skipped'));

  const results = [];
  for (const p of PROBES) {
    if (p.path.includes('{loan}') && !loanId) continue;
    const path = p.path.replace('{loan}', loanId || '');
    const r = await probe(path);
    results.push({ ...p, path, ...r });
    console.log(`${r.ok ? OK('') : NO('')}${String(r.status || '---').padEnd(4)} ${p.path}`);
    if (!r.ok) console.log(`        ICE said: ${r.note.slice(0, 220)}`);
  }

  // GROUP BY WHAT ICE SAID. Endpoints closed by the same gate answer with the same
  // wording, so the distinct bodies ARE the list of separate problems to fix — which
  // is the whole reason this script keeps them.
  const bySignature = new Map();
  for (const r of results.filter((x) => !x.ok)) {
    const sig = `${r.status} ${r.note.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, '<id>').slice(0, 120)}`;
    if (!bySignature.has(sig)) bySignature.set(sig, []);
    bySignature.get(sig).push(r);
  }

  console.log('\n\nDISTINCT REFUSALS — each one is a separate thing to fix\n');
  let n = 0;
  for (const [sig, rs] of bySignature) {
    n += 1;
    console.log(`${n}. ${sig}`);
    for (const r of rs) console.log(`     ${r.path}   [suspected: ${r.gate}]`);
    const ticks = [...new Set(rs.map((r) => r.tick).filter(Boolean))];
    if (ticks.length) console.log(`     to try first: ${ticks.join('  |  ')}`);
    console.log('');
  }

  const opened = results.filter((r) => r.ok);
  if (opened.length) {
    console.log('ALREADY OPEN (no action needed):');
    for (const r of opened) console.log(`  ${r.path} — ${r.note}`);
    console.log('');
  }

  console.log('WHAT TO DO WITH THIS');
  console.log('  1. For anything suspected "persona": Encompass > Settings > Company/User Setup >');
  console.log('     Personas > (the persona on the API user) > Settings tab > tick the area named');
  console.log('     above > Save. Then run this again. This is free and takes a minute.');
  console.log('  2. For "usergroup": Settings > Company/User Setup > User Groups > the API user’s');
  console.log('     group > include the Public and Company-wide template folders.');
  console.log('  3. For "product": that family is a licensed add-on. Paste the exact refusal above');
  console.log('     into a case with ICE and ask whether the instance is entitled to it.');
  console.log('  NOTE: ticking boxes on Personas > Settings tab will NOT help an account that is');
  console.log('     already a Super Administrator — ICE lists these areas as super-admin');
  console.log('     out-of-the-box. That tab extends areas to OTHER personas.');
  console.log('  4. Anything still refusing after 1 and 2 is a real ICE question. Send them the');
  console.log('     endpoint, the exact wording above, the instance id and the client id, and ask');
  console.log('     which entitlement opens it. Quote their words back at them, not ours.\n');

  process.exit(0);
})().catch((e) => {
  console.error('probe failed:', (e && e.message) || e);
  process.exit(1);
});
