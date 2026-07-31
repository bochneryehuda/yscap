/* =====================================================================
   THE STUDIO OPENS SHOWING THE FILE'S PAYOFF — ON A REAL FILE.

   Found by the re-audit (2026-07-31), and it is a two-part failure that a
   source-reading test could never have caught.

   `ProductStudioPanel` builds the studio's opening state in three branches. Two
   of them go through `scenarioFromEngineInputs`, which knows only the frozen
   ENGINE inputs — it has no key for the payoff, the payoff lender, their loan
   number or the cash-out. The third branch, the only one that passed those four
   through, runs solely when the file has NEITHER a registration NOR a server
   quote… and `pricing.quoteAll` always returns `inputs`, so `GET /pricing`
   always yields a quote. That branch is unreachable on a real file.

   So on essentially every file:
     · the payoff boxes opened BLANK, which is why the payoff rows added to the
       printed term sheet never rendered; and
     · `termOptionsFromSnapshot` still SENT the blank cash-out, and the register
       route reads a blank as "clear it" — so re-registering a file WIPED the
       cash-out figure saved on it.

   This test bundles and runs the REAL components (esbuild, JSX loader) rather
   than reading their source, because the defect was entirely about which branch
   executes. It skips cleanly if esbuild is unavailable.

   Run: node scripts/test-payoff-studio-prefill.mjs
   ===================================================================== */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ESBUILD = join(ROOT, 'app-v2', 'node_modules', '.bin', 'esbuild');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(String(a) === String(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

if (!existsSync(ESBUILD)) {
  console.log('(skipping — app-v2 esbuild not installed)');
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'payoff-prefill-'));
try {
  /* The entry imports the REAL modules. `studioStateFor` is not exported, so the
     opening state is reproduced by calling the two exported builders exactly the
     way the panel's own branches call them — and the test ALSO asserts that the
     panel really does spread `filePayoff()` into each branch, so this stand-in
     cannot drift away from the component. */
  const entry = join(tmp, 'entry.mjs');
  writeFileSync(entry, `
import { buildStudioState, scenarioFromEngineInputs } from ${JSON.stringify(join(ROOT, 'app-v2/src/components/TermSheetStudio.jsx'))};
import { termOptionsFromSnapshot } from ${JSON.stringify(join(ROOT, 'app-v2/src/components/ProductStudioPanel.jsx'))};
globalThis.__out = { buildStudioState, scenarioFromEngineInputs, termOptionsFromSnapshot };
`);
  const bundle = join(tmp, 'bundle.cjs');
  execFileSync(ESBUILD, [entry, '--bundle', '--platform=node', '--format=cjs',
    '--loader:.js=jsx', '--jsx=automatic', `--outfile=${bundle}`],
  { cwd: join(ROOT, 'app-v2'), stdio: ['ignore', 'ignore', 'pipe'] });

  const require_ = createRequire(import.meta.url);
  require_(bundle);
  const { buildStudioState, scenarioFromEngineInputs, termOptionsFromSnapshot } = globalThis.__out;

  // A real refinance file that has been registered: the four payoff facts live
  // on the FILE, and the registration's engine inputs carry none of them.
  const app = {
    loan_type: 'Refinance — Cash-Out', property_address: { state: 'NJ' },
    payoff_amount: 300000, payoff_lender: 'Chase Home Finance', payoff_loan_number: 'CHF-88213',
    estimated_cash_out: 62000, est_closing_date: '2026-09-01',
  };
  const filePayoff = () => ({
    payoffAmount: app.payoff_amount, payoffLender: app.payoff_lender,
    payoffLoanNumber: app.payoff_loan_number, estimatedCashOut: app.estimated_cash_out,
  });
  const engineInputs = { loanType: 'Refinance', cashOut: true, strategy: 'FF', state: 'NJ',
    asIsValue: 600000, arv: 900000, rehabBudget: 200000, fico: 720, term: 12 };

  console.log('--- the registered-file branch opens with the file’s payoff ---');
  {
    const st = buildStudioState(scenarioFromEngineInputs(engineInputs, {
      estClosingDate: app.est_closing_date, ...filePayoff(),
    }));
    eq(st.v.payoff, '300000', 'the payoff amount is prefilled');
    eq(st.v.payoffLender, 'Chase Home Finance', 'the lender is prefilled');
    eq(st.v.payoffLoanNo, 'CHF-88213', 'their loan number is prefilled');
    eq(st.v.cashOutAmt, '62000', 'and the typed cash-out is prefilled');
    // The bug: WITHOUT the spread, every one of these is blank — which is what
    // shipped, and what silently cleared the file's cash-out on re-register.
    const blank = buildStudioState(scenarioFromEngineInputs(engineInputs, { estClosingDate: app.est_closing_date }));
    eq(blank.v.cashOutAmt, '', 'the engine inputs alone carry NO cash-out (this is why the spread is required)');
    eq(blank.v.payoffLender, '', 'nor the lender');
  }

  console.log('\n--- and what the register then SENDS cannot wipe the file ---');
  {
    const st = buildStudioState(scenarioFromEngineInputs(engineInputs, { ...filePayoff() }));
    const sent = termOptionsFromSnapshot({ program: 'standard', fields: st.v });
    eq(sent.estimatedCashOut, '62000',
      'a re-register carries the file’s own figure back, so the server writes it unchanged');
    // The failure mode, stated as its own assertion: a BLANK here is what the
    // server reads as "clear it".
    const wiped = termOptionsFromSnapshot({ program: 'standard', fields: buildStudioState(scenarioFromEngineInputs(engineInputs, {})).v });
    eq(wiped.estimatedCashOut, '', 'a studio that never saw the file sends a blank — which CLEARS the column');
    assert(sent.estimatedCashOut !== wiped.estimatedCashOut,
      'so the prefill is the only thing standing between a re-register and a wiped cash-out');
  }

  console.log('\n--- the panel really does spread it into EVERY branch ---');
  {
    // The stand-in above only proves the builders behave. This proves the
    // component actually calls them that way — in all three branches, including
    // the resumed-autosave path, so no branch can quietly go back to blank.
    const src = require_('node:fs').readFileSync(join(ROOT, 'app-v2/src/components/ProductStudioPanel.jsx'), 'utf8');
    assert(/const filePayoff = \(\) => \(\{/.test(src), 'there is ONE definition of the file-owned payoff values');
    /* Each branch is pinned by its OWN marker, not by a count — a count passes
       while one branch quietly loses the spread, which is exactly the shape of
       the defect this test exists for. */
    const BRANCHES = [
      ['the registered-scenario branch', /\.\.\.econFallback\(inp\), \.\.\.fileEcon\(\), \.\.\.filePayoff\(\)/],
      ['the server-quote branch', /\.\.\.econFallback\(inp\), \.\.\.filePayoff\(\),/],
      // Anchored on a marker only THIS branch has — its literal file-column
      // prefill list. A looser anchor matched the branch above it, so removing
      // the spread here went unnoticed (caught by mutating each branch in turn).
      ['the no-registration branch', /irAmount: app\.requested_ir_amount,[\s\S]{0,320}\.\.\.filePayoff\(\),/],
      ['the resumed-autosave branch', /const ae = \{ \.\.\.fileEcon\(\), \.\.\.filePayoff\(\) \}/],
    ];
    for (const [name, re] of BRANCHES) assert(re.test(src), `${name} spreads the file's payoff`);
    assert(/payoffAmount: 'payoff'[\s\S]{0,160}estimatedCashOut: 'cashOutAmt'/.test(src),
      'and a resumed autosave maps all four onto their studio boxes');
  }
} catch (e) {
  console.error('ERROR', e && e.message ? e.message : e);
  failures++;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL payoff studio-prefill assertions passed');
process.exit(failures ? 1 : 0);
