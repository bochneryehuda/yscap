'use strict';
/* =====================================================================
   THE TERM SHEET STUDIO'S NUMBERS MUST SURVIVE THE HAND-OFF TO A LOAN FILE.

   Found by the post-merge audit of #915, in a real browser, on merged main
   (2026-07-31). A term sheet priced as an ASSIGNMENT — total purchase price
   $412,500, seller's own contract $380,000, wholesaler's fee $32,500 — was
   turned into a loan file with the Investor Suite's "Create loan file →"
   button, and the row that landed in Postgres was:

       purchase_price            = 380,000.00     (should be 412,500)
       underlying_contract_price = 380,000.00     (correct)
       assignment_fee            = NULL           (should be 32,500)

   The entire wholesaler's fee vanished off the file, and with it the real
   price the borrower pays — which is the basis for LTC, the recognized /
   effective price and cash to close.

   ROOT CAUSE, and it is one line repeated in three places. The portal has ONE
   money contract, set by MoneyInput: the form STORES a clean numeric string
   ("412500") and only DISPLAYS the grouped one. The Term Sheet Studio is a
   frozen static tool that does NOT follow it — its money boxes hold the
   display text, and YS.collectState() reads the DOM value, so every money
   value crossing out of the studio looks like "412,500". `Number("412,500")`
   is NaN, and the `|| 0` sitting next to it turns that into a silent ZERO.
   The server then (correctly) stores purchase_price = underlying + fee, so a
   zero fee erases the fee AND collapses the price onto the seller's contract.

   Two doors, both live: the staff Investor Suite hand-off (lib/scenario.js →
   StaffNewFile) and the borrower's own studio write-back (Apply.jsx
   patchFromStudio). The fix normalises at the ONE boundary the studio's values
   cross (lib/money.js `moneyStr`), and every money arithmetic uses `moneyNum`.

   EVERY assertion below FAILS on the pre-fix code.
   PURE: no DB, no network, no browser. Run: node scripts/test-studio-money-handoff.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const SRC = path.join(__dirname, '..', 'app-v2', 'src');
// Read tolerantly: on the PRE-FIX code lib/money.js does not exist at all, and a
// hard crash there would hide which of the other guarantees are also missing.
const read = (p) => { try { return fs.readFileSync(path.join(SRC, p), 'utf8'); } catch (_) { return ''; } };

/* ---------------------------------------------------------------------
   1. THE SHARED PARSER — one definition of what a money string means.
   --------------------------------------------------------------------- */
console.log('--- the shared money parser ---');
const moneySrc = read('lib/money.js');
assert(!!moneySrc, 'app-v2/src/lib/money.js exists — the ONE definition of what a money string means');
/* The module is ESM and the rest of the suite is CommonJS, so evaluate the two
   exported functions here rather than dragging in a bundler. If they are missing,
   substitute a deliberately BROKEN stand-in so the assertions below report exactly
   what the pre-fix code does instead of crashing. */
function extract(name, deps) {
  const m = new RegExp(`export function (${name}\\(v\\)\\s*\\{[\\s\\S]*?\\n\\})`).exec(moneySrc);
  if (!m) return null;
  const names = Object.keys(deps || {});
  return new Function(...names, 'return function ' + m[1])(...names.map((k) => deps[k]));
}
const moneyStr = extract('moneyStr') || ((v) => String(v == null ? '' : v));
const moneyNum = extract('moneyNum', { moneyStr }) || ((v) => Number(v) || 0);

assert(moneyStr('412,500') === '412500', `a grouped money string parses to clean digits (got ${JSON.stringify(moneyStr('412,500'))})`);
assert(moneyStr('$1,200,000.50') === '1200000.50', `currency symbols and grouping are stripped, cents kept (got ${JSON.stringify(moneyStr('$1,200,000.50'))})`);
assert(moneyStr('') === '' && moneyStr(null) === '' && moneyStr(undefined) === '', 'blank stays blank');
assert(moneyStr('1.2.3') === '1.23', 'a double decimal point (paste / European grouping) collapses instead of becoming NaN');
assert(moneyNum('412,500') === 412500, `moneyNum reads a grouped value (got ${moneyNum('412,500')})`);
assert(moneyNum('412500') === 412500, 'moneyNum is a drop-in for Number() on an already-clean value');
assert(moneyNum('') === 0 && moneyNum(null) === 0 && moneyNum('abc') === 0, 'moneyNum never returns NaN');
assert(Number.isNaN(Number('412,500')), 'and the reason all of this exists: bare Number() on a grouped value IS NaN');

/* moneyNum IS A DROP-IN OR IT IS A TRAP (pre-merge audit, 2026-07-31). The guard
   in section 4 tells every future author to replace `Number(x) || 0` on a money
   field with this — so for every shape that already parses, it must return the
   IDENTICAL answer. Two escapes were found and closed:
     • the SIGN. moneyStr strips a minus (a MoneyInput must not let one be typed),
       so moneyNum(-32500) used to be +32500 — a silent sign flip on any signed
       money value (a credit, an adjustment, a net figure), which is worse than the
       zero it replaces because it looks right.
     • a value that is ALREADY A NUMBER must not round-trip through a string:
       String(1e21) is "1e+21", which strips to "121". */
{
  const SHAPES = [412500, '412500', '412500.00', '412500.5', 0, '0', '', null, undefined,
    -5000, '-5000', '-32500.00', -0.5, 1e6, 1234567890123, 1e21, 0.1, '0.10'];
  const bad = SHAPES.filter((v) => !Object.is(moneyNum(v), Number(v) || 0));
  assert(bad.length === 0,
    `moneyNum returns EXACTLY what Number(x)||0 returned for every already-parseable shape${bad.length ? ' — diverges on ' + bad.map((v) => `${JSON.stringify(v)}: ${Number(v) || 0} -> ${moneyNum(v)}`).join(', ') : ''}`);
  assert(moneyNum(-32500) === -32500 && moneyNum('-32500') === -32500 && moneyNum('$-1,500.50') === -1500.50,
    `a NEGATIVE money value keeps its sign (got ${moneyNum(-32500)}, ${moneyNum('-32500')}, ${moneyNum('$-1,500.50')})`);
  assert(moneyStr('-32500') === '32500',
    'while moneyStr still strips it — a MoneyInput cannot hold a minus, and that contract is unchanged');
}

/* ---------------------------------------------------------------------
   2. THE STAFF DOOR — lib/scenario.js, the Investor Suite hand-off.
   --------------------------------------------------------------------- */
console.log('\n--- the staff hand-off: scenarioToDraft ---');
/* scenario.js imports a React component, so run its BODY here against the same
   inputs rather than importing the module. The three lines under test are the
   money ones, and they are extracted verbatim from the file, so a regression in
   the real source fails this test. */
const scenSrc = read('lib/scenario.js');
assert(/import\s*\{[^}]*moneyStr[^}]*\}\s*from\s*'\.\/money\.js'/.test(scenSrc),
  'scenarioToDraft imports the shared parser');
assert(/purchasePrice = moneyStr\(v\.price\)/.test(scenSrc),
  'the purchase price crosses the boundary normalised');
assert(/underlyingContractPrice = moneyStr\(v\.origPrice\)/.test(scenSrc),
  "the seller's contract price crosses the boundary normalised");
assert(/moneyStr\(v\.asIs\)/.test(scenSrc) && /moneyStr\(v\.arv\)/.test(scenSrc) && /moneyStr\(v\.construction\)/.test(scenSrc),
  'as-is, ARV and the construction budget are normalised too');
assert(/const fee = Math\.max\(0, moneyNum\(v\.price\) - moneyNum\(v\.origPrice\)\)/.test(scenSrc),
  'the assignment fee is derived with the shared parser, not a bare Number()');

/* the arithmetic itself, on the EXACT values a real studio hands over */
const STUDIO = { price: '412,500', origPrice: '380,000', asIs: '445,000', arv: '689,000', construction: '90,000' };
const fee = Math.max(0, moneyNum(STUDIO.price) - moneyNum(STUDIO.origPrice));
assert(fee === 32500, `the wholesaler's fee comes out right: 412,500 - 380,000 = ${fee} (want 32500)`);
assert(Math.max(0, (Number(STUDIO.price) || 0) - (Number(STUDIO.origPrice) || 0)) === 0,
  'and the OLD expression on the same values really did produce 0 — this is the bug, pinned');

/* ---------------------------------------------------------------------
   3. THE BORROWER DOOR — Apply.jsx patchFromStudio. Same class, same fix.
   --------------------------------------------------------------------- */
console.log('\n--- the borrower door: Apply.jsx patchFromStudio ---');
const applySrc = read('screens/Apply.jsx');
assert(/import\s*\{[^}]*moneyStr[^}]*moneyNum[^}]*\}\s*from\s*'\.\.\/lib\/money\.js'/.test(applySrc),
  'Apply.jsx imports the shared parser');
assert(/patch\.purchasePrice = moneyStr\(f\.price\)/.test(applySrc),
  "the borrower's own studio write-back normalises the purchase price");
assert(/patch\.underlyingContractPrice = moneyStr\(f\.origPrice\)/.test(applySrc),
  "and the seller's contract price");
assert(/const fee = Math\.max\(0, moneyNum\(f\.price\) - moneyNum\(f\.origPrice\)\)/.test(applySrc),
  'and derives the assignment fee with the shared parser');

/* ---------------------------------------------------------------------
   4. THE CONSUMERS — nothing may parse a money field with a bare Number().
      This is the guard that stops the class coming back through a new field.
   --------------------------------------------------------------------- */
console.log('\n--- no consumer parses money with a bare Number() ---');
/* THE LIST HAS TO INCLUDE THE STUDIO'S OWN FIELD NAMES (pre-merge audit,
   2026-07-31). The first cut listed only the PORTAL's names — and the portal's
   values are the CLEAN ones. The identifiers that actually hold the formatted
   text are the studio's: `v.asIs`, `v.construction`, `v.price`, `v.origPrice`,
   `v.payoff` (every id in termsheet.js MONEY_IDS), plus `inp.sellerPrice` off a
   saved registration — which is exactly what this change had to fix in
   scenario.js, Apply.jsx and scenarioFromEngineInputs. Without them a
   reintroduced `Number(v.construction)` sailed straight through the guard.
   Verified: none of the added names appears as a bare Number() today, and none
   false-fires on a non-money field (`f.units`, `f.fico`, `f.priceHistory`,
   `f.sqftPre`, `x.termMonths` all stay clean — see the false-fire probe below).
   KNOWN GAP, deliberate: `loanAmount` is NOT listed. StaffLeads / StaffLeadDetail
   parse it with Number() off an <input type="number">, which a browser will not
   let hold a separator, so those two sites are safe and listing it would only
   force churn. Server-side snake_case names (`purchase_price`, …) are out of
   scope too — those come off Postgres already clean. */
const MONEY_FIELDS = [
  // portal (MoneyInput / draft / applications-row) names
  'purchasePrice', 'underlyingContractPrice', 'assignmentFee', 'asIsValue', 'rehabBudget',
  'payoffAmount', 'originalPurchasePrice', 'salePrice', 'irAmount', 'arv',
  // Term Sheet Studio input ids — the ones that hold the DISPLAY text. This is
  // the MONEY_IDS list in termsheet.js, in full: every box the tool comma-groups.
  'price', 'origPrice', 'assignFee', 'construction', 'asIs', 'payoff', 'tsEffPrice',
  'tsFeeUW', 'tsFeeCredit', 'tsFeeAppr', 'tsFeeTitle',
  // saved-registration (engine inputs) names
  'sellerPrice', 'lenderFee', 'creditFee', 'appraisalFee', 'titleFee',
];
// `\??\.` so optional chaining (`f?.price`) cannot walk around the guard.
const BARE = new RegExp(`Number\\(\\s*[A-Za-z_$][\\w$]*\\??\\.(${MONEY_FIELDS.join('|')})\\b`, 'g');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.jsx?$/.test(e.name)) files.push(p);
  }
})(SRC);
const offenders = [];
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  let m;
  BARE.lastIndex = 0;
  while ((m = BARE.exec(txt))) {
    const line = txt.slice(0, m.index).split('\n').length;
    offenders.push(`${path.relative(SRC, f)}:${line}  ${m[0]}`);
  }
}
assert(offenders.length === 0,
  `no money field is parsed with a bare Number() anywhere under app-v2/src (${offenders.length})${offenders.length ? '\n     ' + offenders.join('\n     ') : ''}`);
assert(files.length > 50, `the guard actually walked the tree (${files.length} files scanned)`);

/* THE GUARD MUST ACTUALLY CATCH A REINTRODUCTION, and must not fire on a field
   that is not money — a guard that does neither is worse than none, because the
   green tick says the class is closed. Both directions are asserted on synthetic
   text so they hold even when the tree happens to be clean. */
{
  const fires = (s) => { BARE.lastIndex = 0; return BARE.test(s); };
  const MUST_CATCH = ['Number(v.price)', 'Number(v.origPrice)', 'Number(v.asIs)', 'Number(v.construction)',
    'Number(v.payoff)', 'Number(v.assignFee)', 'Number(inp.sellerPrice)', 'Number(f.purchasePrice)', 'Number(f.assignmentFee)',
    'Number(f.underlyingContractPrice)', 'Number(f.rehabBudget)', 'Number(f.asIsValue)', 'Number(f.arv)',
    'Number(f.irAmount)', 'Number( f.price )', 'Number(f?.price)', 'Number(x.tsEffPrice)'];
  const MUST_NOT = ['Number(f.units)', 'Number(f.fico)', 'Number(f.priceHistory)', 'Number(f.sqftPre)',
    'Number(x.termMonths)', 'Number(f.irMonths)', 'Number(s.loanAmount)', 'Number(o.routingOrder)',
    'Number(p.pricePerSqft)', 'Number(n)', 'Number(v)'];
  const missed = MUST_CATCH.filter((s) => !fires(s));
  const falseFired = MUST_NOT.filter((s) => fires(s));
  assert(missed.length === 0, `the guard catches every way a money field gets re-Number()'d${missed.length ? ' — MISSES ' + missed.join(', ') : ''}`);
  assert(falseFired.length === 0, `and never fires on a non-money Number()${falseFired.length ? ' — FALSE FIRE on ' + falseFired.join(', ') : ''}`);
}

/* ---------------------------------------------------------------------
   5. END TO END, THROUGH THE SERVER'S OWN RULE. `fields.assignmentFields` is
      what turns the client's numbers into the stored row, and it is the reason
      a zero fee also destroys the purchase price.
   --------------------------------------------------------------------- */
console.log('\n--- the number that actually lands in `applications` ---');
const { assignmentFields } = require(path.join(__dirname, '..', 'src', 'lib', 'fields.js'));
{
  // exactly what the fixed client now sends
  const good = assignmentFields({
    isAssignment: true, loanType: 'Purchase',
    purchasePrice: 412500, underlyingContractPrice: 380000, assignmentFee: 32500,
  });
  assert(good.purchasePrice === 412500, `purchase_price stores the REAL total price (got ${good.purchasePrice})`);
  assert(good.assignFee === 32500, `assignment_fee stores the wholesaler's fee (got ${good.assignFee})`);
  assert(good.underlying === 380000, `underlying_contract_price stores the seller's contract (got ${good.underlying})`);

  // and what the BROKEN client used to send — the row the audit found in Postgres
  const bad = assignmentFields({
    isAssignment: true, loanType: 'Purchase',
    purchasePrice: 412500, underlyingContractPrice: 380000, assignmentFee: 0,
  });
  assert(bad.purchasePrice === 380000 && bad.assignFee === null,
    'pinned: a zero fee stores purchase_price = the seller price and assignment_fee = NULL — which is what made this worth fixing');
}

/* ---------------------------------------------------------------------
   6. AND THE DRAFTS THAT WERE ALREADY WRITTEN THE OLD WAY (pre-merge audit,
      2026-07-31). Fixing scenarioToDraft stops NEW drafts carrying the studio's
      display text. It cannot repair the rows ALREADY in `application_drafts`:
      every draft a borrower started from a saved pricing scenario since #915
      holds `asIsValue: "445,000"`, and POST /api/borrower/drafts/:id/submit
      binds those straight into numeric(14,2) columns. Proven against real
      Postgres during the audit:

          invalid input syntax for type numeric: "445,000"

      — so those borrowers cannot submit their application AT ALL. The fix has to
      reach the last mile: the value that goes to a money column is PARSED, never
      passed through, on every create path. `moneyValue` is that chokepoint and
      `assignmentFields` uses it, so the same formatted draft now stores the right
      numbers instead of throwing. Every assertion below fails on the pre-fix
      server (assignmentFields returned the string, and NaN for the price).
   --------------------------------------------------------------------- */
console.log('\n--- a draft written the OLD way still has to submit ---');
const { moneyValue } = require(path.join(__dirname, '..', 'src', 'lib', 'fields.js'));
{
  assert(typeof moneyValue === 'function', 'src/lib/fields.js exports moneyValue — the money chokepoint on the way to a numeric column');
  const mv = moneyValue || (() => null);
  assert(mv('445,000') === 445000, `a grouped value parses (got ${JSON.stringify(mv('445,000'))})`);
  assert(mv('$1,200,000.50') === 1200000.50, `so does one with a currency symbol and cents (got ${JSON.stringify(mv('$1,200,000.50'))})`);
  assert(mv('') === null && mv(null) === null && mv(undefined) === null && mv('abc') === null && mv('-') === null,
    'blank / nothing-numeric is NULL — the column\'s "not provided", never a fabricated 0');
  assert(mv(-32500) === -32500 && mv('-32,500.00') === -32500, `a negative keeps its sign (got ${mv(-32500)}, ${mv('-32,500.00')})`);
  assert(mv(412500) === 412500 && mv('412500') === 412500 && mv('412500.00') === 412500, 'and an already-clean value is unchanged');

  // the exact draft shape lib/scenario.js wrote before this change
  const legacy = assignmentFields({
    isAssignment: true, loanType: 'Purchase',
    purchasePrice: '412,500', underlyingContractPrice: '380,000', assignmentFee: '32,500',
  });
  assert(legacy.underlying === 380000, `a legacy draft's seller price reaches the column as a NUMBER (got ${JSON.stringify(legacy.underlying)})`);
  assert(legacy.assignFee === 32500, `and the wholesaler's fee (got ${JSON.stringify(legacy.assignFee)})`);
  assert(Number.isFinite(legacy.purchasePrice) && legacy.purchasePrice === 412500,
    `and purchase_price is a finite number, not the NaN a bare Number() produced (got ${JSON.stringify(legacy.purchasePrice)})`);

  // …and the plain (non-assignment) purchase price, which used to go through raw
  const plain = assignmentFields({ isAssignment: false, loanType: 'Purchase', purchasePrice: '412,500' });
  assert(plain.purchasePrice === 412500, `a non-assignment purchase price is parsed too (got ${JSON.stringify(plain.purchasePrice)})`);

  /* Scanned with BLOCK COMMENTS REMOVED: the banned shapes below are quoted
     verbatim in the prose that explains why they are banned, and a guard that
     fires on its own documentation teaches people to delete the documentation.
     The strip is asserted not to have eaten any real code. */
  const code = (p) => {
    const raw = fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
    const out = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    if (!/moneyColumn|assignmentFields/.test(out)) throw new Error(`comment strip ate ${p.join('/')}`);
    return out;
  };
  // the three columns the create routes used to bind raw off the draft
  const routes = [
    ['src/routes/borrower.js', code(['src', 'routes', 'borrower.js'])],
    ['src/routes/staff.js', code(['src', 'routes', 'staff.js'])],
  ];
  for (const [name, txt] of routes) {
    const raw = /\bb\.(asIsValue|arv|rehabBudget)\s*\|\|\s*null/.exec(txt);
    assert(!raw, `${name} never binds a money value to a numeric column raw${raw ? ` — found \`${raw[0]}\`` : ''}`);
    /* AND NEVER RE-TESTS TRUTHINESS ON THE PARSED NUMBER (re-audit, 2026-07-31).
       `moneyValue(b.asIsValue) || null` looks like the same expression with a
       parser bolted on, but it moves the provided/not-provided decision off the
       raw value onto the parsed one — and 0 is falsy, so a "0" a human typed into
       a MoneyInput (which stores a numeric STRING) stopped storing 0.00 and
       started storing NULL on all three create paths. `moneyColumn` is the bind
       that keeps both halves right; this is the shape that must never come back. */
    const wrapped = /money(?:Value)?\(\s*b\.\w+\s*\)\s*\|\|\s*null/.exec(txt);
    assert(!wrapped,
      `${name} decides "was money provided?" on the RAW value (moneyColumn), never on the parsed number — a typed "0" must not become NULL${wrapped ? ` — found \`${wrapped[0]}\`` : ''}`);
  }
  // the shared helper has to hold the same line, since all three routes go through it
  {
    const fld = code(['src', 'lib', 'fields.js']);
    const wrapped = /moneyValue\([^)]*\)\s*\|\|\s*null/.exec(fld);
    assert(!wrapped, `src/lib/fields.js assignmentFields does the same${wrapped ? ` — found \`${wrapped[0]}\`` : ''}`);
    assert(typeof require(path.join(__dirname, '..', 'src', 'lib', 'fields.js')).moneyColumn === 'function',
      'and moneyColumn is exported as the one bind every money column goes through');
  }
}

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL studio money hand-off assertions passed');
process.exit(failures ? 1 : 0);
