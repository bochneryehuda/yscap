#!/usr/bin/env node
'use strict';
/**
 * LT - THE GENERATED LEDGERS' AUTHORED PROSE MUST STAY TRUE (§2.80).
 *
 * OFFLINE: pure. Reads source files. No database, no vendor call.
 *
 * THE CLASS. Four ledgers in `docs/longterm/` are GENERATED — an unwired module, an unrun suite, an
 * unreachable route, an uncalled export — precisely because a hand-kept list goes stale silently. Each
 * of them then invites a human REASON beside a row, and carries authored prose above the lists, and the
 * generator PRESERVES both without ever checking them. So a hand-written reason inside a generated list
 * is a hand-kept list, one level down, wearing the generated file's credibility.
 *
 * MEASURED 2026-08-18. `LT-UNREACHED.md` asserted, in its most important section — the one about the
 * HARD RULE that a capital provider's name never reaches a borrower or a TPO:
 *
 *   "the second defence is only half present … `maySeeField` / `stripInternalOnly` are still uncalled
 *    anywhere — so the NEXT client surface must not assume they are in the path"
 *
 * Both are called by `src/longterm/client-view.js`, which `routes/my-loans.js` requires and the server
 * mounts at `/api/lt/my`. So BOTH defences the rule names are in the path today, and the stronger of
 * the two — build the client's payload from an allowlist rather than filter a staff one — is exactly
 * what that route does. The sentence was already false when it was written. Nothing could tell.
 *
 * WHAT THIS GUARD DOES, and the shape is §2.76's: each claim is BICONDITIONAL. The prose must be
 * PRESENT (a reword that quietly drops a claim fails section A) and the code fact must HOLD (section
 * B) — a "must not appear" test alone catches only one direction. Section C is the rewording net: a
 * retracted claim must not come back.
 *
 * ⛔ A RETRACTED CLAIM IS QUOTED IN ITALICS, AND THE GUARD READS ASSERTED PROSE ONLY. The correction
 * that removed the stale sentence necessarily QUOTES it, and a net that read quotations would fail on
 * the very fix it protects — and would then be "fixed" by deleting the explanation, which is worse than
 * the original defect. So `asserted()` strips *"…"* quotations before every must-not-appear check. That
 * is a convention this repo already follows when it retracts something in writing; keep to it.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs', 'longterm');
const SRC = path.join(ROOT, 'src');

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }

const read = (p) => fs.readFileSync(p, 'utf8');

/** Prose the file ASSERTS, with italic quotations (a retracted claim, a quoted report) removed. */
function asserted(md) {
  return String(md).replace(/\*"[\s\S]*?"\*/g, ' ');
}

/** Every .js under src/, so "does anything call this?" is asked of the whole product. */
function srcFiles(dir = SRC, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { srcFiles(p, out); continue; }
    if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
const SRC_FILES = srcFiles();

/**
 * Files under src/ that reference `name`, excluding the module that defines it.
 * A COMMENT counts as a reference here on purpose: this answers "is this name spoken about anywhere
 * outside its own file", which is the question the ledgers' own generator asks. Where a claim needs a
 * REAL call rather than a mention, the claim says so with its own predicate.
 */
function referencesOutside(name, ownerFile) {
  const re = new RegExp(`\\b${name}\\b`);
  return SRC_FILES.filter((p) => !p.endsWith(ownerFile) && re.test(read(p)));
}

/**
 * A real call — `x.name(` or `name(` — in one file, comments stripped.
 *
 * IT CANNOT TELL A CALL FROM A DEFINITION, and that is fine here BECAUSE every claim asks about a name
 * defined in a DIFFERENT module (`maySeeField` lives in `audience.js`, not in `client-view.js`). Ask it
 * about a name a file defines and it will answer yes; D10 pins that limitation so nobody later reads a
 * true answer as proof of a call it cannot see.
 */
function callsInto(file, name) {
  const src = read(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  return new RegExp(`(?:\\.|\\b)${name}\\s*\\(`).test(src);
}

const CLIENT_VIEW = path.join(SRC, 'longterm', 'client-view.js');
const MY_LOANS = path.join(SRC, 'longterm', 'routes', 'my-loans.js');

// ---------------------------------------------------------------------------
// THE CLAIMS TABLE. Each entry: the ledger, the prose that must be there, the fact that must hold, and
// the retracted phrasings that must not come back. Adding a claimed FACT to a ledger means adding a row
// here in the same commit — that is the whole point of the guard.
// ---------------------------------------------------------------------------
const CLAIMS = [
  {
    id: 'both-defences-wired',
    ledger: 'LT-UNREACHED.md',
    prose: /BOTH DEFENCES ARE WIRED/,
    why: 'the investor-name HARD RULE — the ledger says both defences are in the path',
    holds: () => callsInto(CLIENT_VIEW, 'maySeeField')
      && callsInto(CLIENT_VIEW, 'stripInternalOnly')
      && callsInto(CLIENT_VIEW, 'internalOnlyColumns')
      && callsInto(CLIENT_VIEW, 'scrubInvestorNames'),
    forbidden: [
      [/`maySeeField` \/ `stripInternalOnly`\s*(?:\n\s*)?are still uncalled anywhere/,
        'the retracted "still uncalled anywhere" sentence is back as an assertion'],
      [/second defence is only half\s*(?:\n\s*)?present/,
        'the retracted "only half present" sentence is back as an assertion'],
    ],
  },
  {
    id: 'audience-wired',
    ledger: 'LT-UNREACHED.md',
    prose: /`audience\.js` IS WIRED NOW/,
    why: 'the free-text scrub reaches the one client surface that exists',
    holds: () => referencesOutside('scrubInvestorNames', 'longterm/audience.js').length > 0
      && callsInto(MY_LOANS, 'audienceOfActor'),
    forbidden: [],
  },
  {
    id: 'client-view-refuses-the-sql',
    ledger: 'LT-UNREACHED.md',
    prose: /assertNoInternalColumns/,
    why: 'the ledger claims the client SELECT is refused at LOAD time, not merely filtered afterwards',
    holds: () => callsInto(MY_LOANS, 'assertNoInternalColumns'),
    forbidden: [],
  },
  {
    id: 'canary-cron-has-a-launcher',
    ledger: 'LT-UNREACHED.md',
    prose: /scripts\/lt-ppe-canary-cron\.js/,
    why: 'the row says this module is deliberately unwired from src/ BECAUSE a launcher runs it',
    holds: () => {
      const l = path.join(ROOT, 'scripts', 'lt-ppe-canary-cron.js');
      return fs.existsSync(l) && /canary-cron-command/.test(read(l));
    },
    forbidden: [],
  },
  {
    id: 'program-audit-has-a-launcher',
    ledger: 'LT-UNREACHED.md',
    prose: /scripts\/lt-ppe-program-audit\.js/,
    why: 'same shape — unwired from src/ only because an operator command starts it',
    holds: () => {
      const l = path.join(ROOT, 'scripts', 'lt-ppe-program-audit.js');
      return fs.existsSync(l) && /program-audit-command/.test(read(l));
    },
    forbidden: [],
  },
  {
    id: 'program-audit-feeds-the-preflight',
    ledger: 'LT-UNREACHED.md',
    prose: /`ppe\/program-audit\.js` is wired, and by exactly the route its own row predicted/,
    why: 'the row was struck on the ground that the FREE pre-flight now reads it — if that stops being true it is unwired again and nothing else would say so',
    holds: () => {
      const pf = path.join(SRC, 'longterm', 'ppe', 'agreement-preflight.js');
      return fs.existsSync(pf) && /require\(['"]\.\/program-audit['"]\)/.test(read(pf))
        && callsInto(pf, 'auditProgram');
    },
    forbidden: [],
  },
  {
    id: 'canary-clock-reached-by-the-driver',
    ledger: 'LT-UNREACHED.md',
    prose: /`ppe\/canary-clock\.js` is wired too\*\*, through `ppe\/canary-driver\.js`/,
    why: 'the other struck row — the driver is what reaches the clock, and a lazy require is easy to remove without noticing',
    holds: () => {
      const d = path.join(SRC, 'longterm', 'ppe', 'canary-driver.js');
      return fs.existsSync(d) && /require\(['"]\.\/canary-clock['"]\)/.test(read(d));
    },
    forbidden: [],
  },
  {
    id: 'ticket-judgement-lives-here',
    ledger: 'LT-UNREACHED.md',
    prose: /sets \*\*`ticketWorthy`\*\*/,
    why: "the row withdraws an earlier 'duplicate, retire it' framing on the ground that this file holds the only implementation of the owner's ticket judgement",
    holds: () => {
      const m = path.join(SRC, 'longterm', 'ppe', 'disqualify-reconcile.js');
      const src = read(m);
      return /ticketWorthy/.test(src) && /reconcileScenario/.test(src)
        && referencesOutside('reconcileScenario', 'ppe/disqualify-reconcile.js').length === 0;
    },
    forbidden: [],
  },
];

// ---------------------------------------------------------------------------
// A - THE GUARD CAN SEE THE PROSE. A claim quietly reworded away must fail here, or every check below
//     passes vacuously on a file that no longer says anything.
// ---------------------------------------------------------------------------
const LEDGERS = {};
for (const c of CLAIMS) {
  if (!LEDGERS[c.ledger]) {
    const p = path.join(DOCS, c.ledger);
    ok(fs.existsSync(p), `A0 ${c.ledger} exists`);
    LEDGERS[c.ledger] = fs.existsSync(p) ? read(p) : '';
  }
  ok(c.prose.test(LEDGERS[c.ledger]),
    `A[${c.id}] ${c.ledger} still makes the claim this guard is about — ${c.why}`);
}

// ---------------------------------------------------------------------------
// B - AND THE CLAIM IS TRUE. This is the half that was missing entirely.
// ---------------------------------------------------------------------------
for (const c of CLAIMS) {
  let held = false;
  let threw = null;
  try { held = !!c.holds(); } catch (e) { threw = e; }
  ok(!threw, `B[${c.id}] the check itself ran — ${threw && threw.message}`);
  ok(held, `B[${c.id}] the ledger's claim is TRUE in the code — ${c.why}`);
}

// ---------------------------------------------------------------------------
// C - A RETRACTED CLAIM DOES NOT COME BACK. Read on ASSERTED prose only, so the correction may quote
//     the sentence it withdrew (which it must, or the record of why is lost).
// ---------------------------------------------------------------------------
for (const c of CLAIMS) {
  const body = asserted(LEDGERS[c.ledger] || '');
  for (const [re, what] of c.forbidden) {
    ok(!re.test(body), `C[${c.id}] ${what}`);
  }
}

// ---------------------------------------------------------------------------
// D - CAN THE GUARD SEE ANYTHING AT ALL? Every assertion above is a regex over a file, so a wrong path,
//     an empty read or an over-eager stripper would make the whole suite pass on nothing.
// ---------------------------------------------------------------------------
{
  ok(SRC_FILES.length > 100, `D1 the src sweep found the tree (${SRC_FILES.length} files)`);
  ok(Object.values(LEDGERS).every((t) => t.length > 500), 'D2 every ledger read carries real content');

  // The stripper must remove a quotation and nothing else.
  const sample = 'kept text *"retracted claim"* kept tail';
  ok(!/retracted claim/.test(asserted(sample)), 'D3 an italic quotation is stripped before a must-not-appear check');
  ok(/kept text/.test(asserted(sample)) && /kept tail/.test(asserted(sample)),
    'D4 …and only the quotation is stripped');

  // THE CORRECTION IS QUOTED, and the C net must be reading past it. Without this, C passes because the
  // stripper is broken rather than because the claim is gone.
  ok(/still uncalled\s+anywhere/.test(LEDGERS['LT-UNREACHED.md']),
    'D5 the ledger DOES still quote the sentence it withdrew — the record of why is intact');
  ok(!/still uncalled\s+anywhere/.test(asserted(LEDGERS['LT-UNREACHED.md'])),
    'D6 …and it survives only as a quotation, which is why section C can be strict');

  // The predicates discriminate: a name nothing calls must read as uncalled.
  ok(!callsInto(CLIENT_VIEW, 'thisFunctionDoesNotExistAnywhere'),
    'D7 callsInto says no to a name that is not there — the checks in B are not passing on a loose match');
  ok(callsInto(CLIENT_VIEW, 'maySeeField'), 'D8 …and yes to one that is');

  // A COMMENT IS NOT A CALL. `my-loans.js` names maySeeField/stripInternalOnly in its header while
  // client-view is what calls them; if the comment stripper were broken, B would pass off the prose.
  ok(!callsInto(MY_LOANS, 'maySeeField'),
    'D9 a name mentioned only in a comment does not count as a call — the exact way this claim could pass on nothing');

  // The stated limitation, pinned rather than left as a comment somebody may stop believing.
  ok(callsInto(CLIENT_VIEW, 'assertNoInternalColumns'),
    'D10 callsInto answers yes for a name a file DEFINES — so every claim above deliberately asks about a name defined elsewhere');
}

console.log(failures.length
  ? `FAIL - lt ledger claims (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
  : `ok - lt ledger claims (${pass} assertions)`);
process.exit(failures.length ? 1 : 0);
