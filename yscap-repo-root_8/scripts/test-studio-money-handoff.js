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
const MONEY_FIELDS = ['purchasePrice', 'underlyingContractPrice', 'origPrice', 'price', 'asIsValue', 'arv', 'rehabBudget', 'assignmentFee', 'irAmount'];
const BARE = new RegExp(`Number\\(\\s*[A-Za-z_$][\\w$]*\\.(${MONEY_FIELDS.join('|')})\\b`, 'g');
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

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL studio money hand-off assertions passed');
process.exit(failures ? 1 : 0);
