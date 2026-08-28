'use strict';
/**
 * THE DEAL FICO — one rule, everywhere (owner-directed 2026-08-28: "The rule
 * is: if it's one borrower, then it's the middle score. If it's more than one,
 * then it's the highest middle score" — reported because the file's score
 * "isn't pulling the accurate middle score").
 *
 * WHAT WAS ACTUALLY WRONG, and what this pins so it stays fixed:
 *   · The PRICING loaders already took the higher-of-two (#99) — but SEVEN
 *     separate queries each carried their own inline copy of the SQL, and the
 *     CONDITION ENGINE's context carried NONE: it read the PRIMARY borrower's
 *     score alone. So on a two-borrower file where the co-borrower's middle
 *     score was higher, pricing said one number while the rules engine, the
 *     underwriting run's investor-guideline review (fico_file) and the AI
 *     grounding said another.
 *   · The TERM-SHEET-OFFER registration loaded `SELECT * FROM applications` —
 *     no borrower join at all — so an offer-accept registration priced with NO
 *     credit score on a file whose borrowers had one.
 *
 * Now `credit.dealFicoSql` / `credit.dealFico` are the ONE definition, every
 * reader calls it, and this test:
 *   1. pins the JS truth table;
 *   2. proves the engine context answers the DEAL fico over real rows (one
 *      borrower → their score; two → the higher; none → null — never 0);
 *   3. proves SQL and JS agree over the real join;
 *   4. SOURCE-GUARDS the one-definition rule: no inline GREATEST(fico) copy
 *      may exist outside credit/index.js, and every known reader calls the
 *      shared builder.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-deal-fico-db (no DATABASE_URL)'); process.exit(0); }

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const credit = require('../src/lib/credit');
const engine = require('../src/lib/conditions/engine');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `dfico-${process.pid}-${Date.now()}`;

(async () => {
  // ── 1. the JS truth table ──────────────────────────────────────────────────
  ok(credit.dealFico(700) === 700, 'one borrower → their middle score');
  ok(credit.dealFico(700, 760) === 760, 'two borrowers → the HIGHEST middle score');
  ok(credit.dealFico(760, 700) === 760, '…whichever side it is on');
  ok(credit.dealFico(700, null) === 700, 'a co-borrower with no score does not drag the deal down');
  ok(credit.dealFico(null, 760) === 760, 'a primary with no score still prices on the co-borrower’s');
  ok(credit.dealFico(null, null) === null, 'no score anywhere → null, never 0');
  ok(credit.dealFico(0, 0) === null, 'a zero is not a score');

  // ── 2 + 3. the engine context over real rows ───────────────────────────────
  const mkBorrower = async (fico) => (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Fi','Co',$1,$2) RETURNING id`,
    [`${uniq}-${Math.random().toString(36).slice(2, 8)}@example.test`, fico])).rows[0].id;
  const mkApp = async (bid, cid) => (await db.query(
    `INSERT INTO applications (borrower_id, co_borrower_id, status, property_address, loan_type)
     VALUES ($1,$2,'underwriting','{"oneLine":"1 Score St"}','Purchase') RETURNING id`, [bid, cid])).rows[0].id;

  const b700 = await mkBorrower(700);
  const c760 = await mkBorrower(760);
  const bNone = await mkBorrower(null);

  const cases = [
    [await mkApp(b700, null), 700, 'one borrower: the context fico is their middle score'],
    [await mkApp(b700, c760), 760, 'two borrowers, co higher: the context fico is the CO’s (the engine used to answer 700 here)'],
    [await mkApp(c760, b700), 760, 'two borrowers, primary higher: still the higher'],
    [await mkApp(bNone, c760), 760, 'primary unscored: the co-borrower’s score carries the file'],
    [await mkApp(bNone, null), null, 'nobody scored: null, never 0'],
  ];
  for (const [appId, want, why] of cases) {
    const loaded = await engine.loadRuleContext(appId);
    const got = loaded && loaded.ctx ? loaded.ctx.fico : (loaded ? loaded.fico : undefined);
    const ctx = got !== undefined ? got : (loaded && loaded.values ? loaded.values.fico : undefined);
    ok(ctx === want || (want === null && ctx == null), `${why} (got ${ctx})`);
    // The SQL and the JS agree on the same rows.
    const row = (await db.query(
      `SELECT ${credit.dealFicoSql('b', 'cb')} AS f, b.fico AS pf, cb.fico AS cf
         FROM applications a JOIN borrowers b ON b.id=a.borrower_id
         LEFT JOIN borrowers cb ON cb.id=a.co_borrower_id WHERE a.id=$1`, [appId])).rows[0];
    ok((row.f == null ? null : Number(row.f)) === credit.dealFico(row.pf, row.cf),
      `SQL and JS agree (${row.pf}/${row.cf} → ${row.f})`);
  }

  // ── 4. THE SOURCE GUARD — one definition, no inline copies ─────────────────
  {
    const root = path.join(__dirname, '..', 'src');
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p2 = path.join(dir, e.name);
        if (e.isDirectory()) walk(p2);
        else if (e.name.endsWith('.js')) files.push(p2);
      }
    })(root);
    const offenders = [];
    let callSites = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      callSites += (src.match(/dealFicoSql\(/g) || []).length;
      if (f.endsWith(path.join('credit', 'index.js'))) continue;
      if (/GREATEST\(COALESCE\([a-z]+\.fico/i.test(src)) offenders.push(path.relative(root, f));
    }
    ok(offenders.length === 0, `no inline copy of the deal-fico SQL survives (${offenders.join(', ') || 'none'})`);
    ok(callSites >= 9, `every reader calls the ONE definition (${callSites} call sites; engine, pricing loaders, tapes, whole-loan, tpo ×2, borrower, intake, term-sheet-offer)`);
    // The two loaders that were WRONG stay on the rule by name.
    const eng = fs.readFileSync(path.join(root, 'lib/conditions/engine.js'), 'utf8');
    ok(/dealFicoSql\('b', 'cbf'\)/.test(eng) && /deal_fico/.test(eng), 'the condition engine reads the deal fico, not the primary’s alone');
    const tso = fs.readFileSync(path.join(root, 'lib/term-sheet-offer.js'), 'utf8');
    ok(/dealFicoSql\('b', 'cb'\)/.test(tso), 'the term-sheet-offer registration prices with the deal fico (it used to join no borrower at all)');
  }

  await db.pool.end().catch(() => {});
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll deal-FICO checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
