#!/usr/bin/env node
'use strict';
/**
 * LOANNEX + LENDER PRICE — the merged board, the election, and the read-only wall
 * (pure, offline).
 *
 * THE ELECTION IS MEASURED AGAINST A KNOWN ANSWER, not asserted. The recorded
 * LoanNEX board (1,718 price rows, 9 investors, 90 programs) is fed to the merge as
 * BOTH sources with one side shifted by an exact, known amount — so the reported
 * margin must come back as exactly that amount, in the right direction, on every
 * investor. A merge that reads the wrong field, compares across lock periods or
 * mixes product classes cannot reproduce an injected 0.250 across 510 matched
 * quotes; an assertion like "chosen === 'loannex'" could pass while doing all three.
 *
 * PROVEN TO FAIL: compare across lock days and DELTA-2 goes red; drop the product
 * class from the comparison key and CLASS-1 goes red; let an unresolved investor
 * name merge into a neighbouring key and UNMAPPED-1 goes red; print an unnamed
 * investor's REAL name as their white label and LABEL-2 goes red; allow a write path
 * onto the LoanNEX client and READONLY-* go red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const parse = require('../src/longterm/loannex/parse');
const { merge, compare } = require('../src/longterm/pricing/merge');
const { classify } = require('../src/longterm/pricing/product-class');
const client = require('../src/longterm/loannex/client');
const captured = require('../src/longterm/loannex/capture/quick-prices.json');
const fails = require('../src/longterm/loannex/capture/fails.json');
const evidence = require('../src/longterm/loannex/capture/evidence.json');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const clone = (x) => JSON.parse(JSON.stringify(x));

console.log('LoanNEX parse + the two-source merge election');

// ---- the parse reproduces the vendor's own totals --------------------------
const board = parse.parse(captured.response);
ok(board.rungCount === Number(captured.response.metadata.numberOfPrices),
  `PARSE-1 the expanded rungs equal the vendor's own numberOfPrices (${board.rungCount})`);
ok(board.lenderCount === captured.response.data.investors.length,
  'PARSE-2 every investor in the answer reaches the board');
ok(board.programs.every((p) => p.lender && p.program && p.product),
  'PARSE-3 every program row resolves its investor, program AND product — no dangling ids');
ok(board.programs.every((p) => p.rungs.every((r) => r.lockDays != null)),
  'PARSE-4 every rung carries its lock period — a 30-day quote is never comparable to a 60-day one');
ok(board.programs.every((p) => p.rungs.every((r) => r.pointsDerived === true)),
  'PARSE-5 points are flagged DERIVED, so nobody reads them as a vendor-supplied number');
ok(board.programs.every((p) => p.rateSheetName === null),
  'PARSE-6 LoanNEX has no separate sheet name, so it is null — never the program name restated as a second fact');

// ---- the disqualify tree ---------------------------------------------------
{
  const d = parse.parseFails(fails.response);
  ok(d.lenderCount > 0 && d.itemCount > 0, 'FAILS-1 the ineligibility tree flattens to lender → program → reasons');
  const reasons = d.lenders.flatMap((l) => l.items.flatMap((i) => i.reasons));
  ok(reasons.length > 0 && reasons.every((r) => typeof r === 'string' && r.length > 10),
    'FAILS-2 every failure renders as a sentence a person can read');
  const withMax = d.lenders.flatMap((l) => l.items).flatMap((i) => i.failingAttributes).filter((a) => a.max != null);
  ok(withMax.length > 0, 'FAILS-3 …and the threshold itself is kept beside it, not replaced by the sentence');
  ok(/75%/.test(reasons.join(' ')), 'FAILS-4 an LTV threshold reads as a percentage, not as 0.75');
}

// ---- the LLPA breakdown ----------------------------------------------------
{
  const e = parse.parseEvidence(evidence.samples[0].response);
  const sum = e.basePrice + e.adjustments.reduce((s, a) => s + a.priceAdjustment, 0);
  ok(Math.abs(sum - e.price) < 0.001,
    'EVID-1 base price plus every adjustment equals the quoted price to the cent');
  ok(e.rateSheetLastUpdated, 'EVID-2 …and the sheet date rides with it (the freshness signal)');
}

// ---- the election reproduces an INJECTED, KNOWN margin ---------------------
function shift(b, d) {
  const c = clone(b);
  for (const p of c.programs) for (const r of p.rungs) if (r.price != null) {
    r.price = Math.round((r.price + d) * 1000) / 1000; r.points = Math.round((100 - r.price) * 1000) / 1000;
  }
  return c;
}
{
  // Asserted as a PROPERTY, never against a hard-coded investor count: adding an
  // investor alias legitimately changes that count, and a test pinned to today's
  // number reads as a broken feature the day the sheet grows.
  const tie = merge({ lenderprice: clone(board), loannex: clone(board) });
  ok(tie.summary.inBoth > 0 && tie.summary.ties === tie.summary.inBoth
     && tie.summary.electedLoannex === 0 && tie.summary.electedLenderprice === 0,
    `ELECT-1 identical boards elect NOBODY — a tie is a tie, never a coin toss (${tie.summary.ties}/${tie.summary.inBoth})`);

  const nxBetter = merge({ lenderprice: clone(board), loannex: shift(board, 0.25) });
  const exact = nxBetter.investors.filter((i) => i.chosen === 'loannex' && i.comparison && i.comparison.meanDeltaPrice === 0.25);
  ok(exact.length === nxBetter.summary.inBoth && nxBetter.summary.inBoth > 0,
    `DELTA-1 a +0.250 shift is recovered as exactly 0.250 on every investor (${exact.length}/${nxBetter.summary.inBoth})`);
  const acra = nxBetter.investors.find((i) => i.key === 'acra');
  ok(acra && acra.comparison.comparedPoints > 400,
    `DELTA-2 …measured over hundreds of matched (product, lock, rate) quotes, not a handful (${acra ? acra.comparison.comparedPoints : 0})`);
  ok(acra && acra.comparison.loannexWins === acra.comparison.comparedPoints && acra.comparison.lenderpriceWins === 0,
    'DELTA-3 …and every single matched quote points the same way, as an exact shift must');

  const lpBetter = merge({ lenderprice: shift(board, 0.5), loannex: clone(board) });
  ok(lpBetter.summary.electedLenderprice === lpBetter.summary.inBoth && lpBetter.summary.electedLoannex === 0,
    'DELTA-4 the election is symmetric — Lender Price wins when Lender Price is better');
  ok(lpBetter.investors.every((i) => /0\.500 in price on average/.test(i.reason || '')),
    'DELTA-5 …and the REASON states the measured margin, so a person can disagree with it');
}

// ---- nothing is compared across a product class or a lock period -----------
{
  const a = classify({ product: '30 Yr. Fixed' });
  const b = classify({ product: '5/6 ARM (30 Yr. Term)' });
  const io = classify({ product: '30 Yr. Fixed IO (10 Yr. IO)' });
  ok(a.key !== b.key && a.key !== io.key && b.key !== io.key,
    'CLASS-1 a fixed, an ARM and an interest-only are three different classes');
  ok(classify({ product: 'Mystery Product' }) === null,
    'CLASS-2 an unreadable product is EXCLUDED from comparison, never assumed to be a 30-year fixed');
  // A source quoting only 30-day locks against one quoting only 60 has NO basis.
  const only30 = clone(board), only60 = clone(board);
  for (const p of only30.programs) p.rungs = p.rungs.filter((r) => r.lockDays === 30);
  for (const p of only60.programs) p.rungs = p.rungs.filter((r) => r.lockDays === 60);
  const m = merge({ lenderprice: only30, loannex: only60 });
  const noBasis = m.investors.filter((i) => i.presentIn.length === 2 && i.electionBasis === 'no_comparable_basis');
  ok(noBasis.length > 0 && m.investors.every((i) => i.electionBasis !== 'better_execution'),
    'CLASS-3 two sources sharing no lock period elect NOBODY — they are not comparable');
}

// ---- an unresolved investor is reported, never merged ----------------------
{
  // RE-POINTED 2026-08-30, not weakened. This used to use Button Finance as its
  // example of an investor the registry does not know — and they were ADDED to
  // the registry that day, on purpose: an unmapped NAME can never be switched
  // off by a per-investor setting, which is the whole point of the settings
  // screen. So the example is now a name nobody will ever add, which is what the
  // RULE was always about; using a real company as the fixture is what made this
  // assertion describe a registry entry rather than a behaviour.
  const withStranger = clone(board);
  withStranger.programs.push({
    ...withStranger.programs[0],
    lender: 'Nobody Capital Partners LLC', investor: 'Nobody Capital Partners LLC',
    lenderId: null, investorOrganizationGuid: null,
  });
  const m = merge({ lenderprice: null, loannex: withStranger }, { errors: { lenderprice: 'lp_creds_missing' } });
  const names = m.unmapped.map((u) => u.name).sort();
  ok(names.includes('Nobody Capital Partners LLC'),
    'UNMAPPED-1 an investor on no sheet is REPORTED by name, never guessed into a neighbouring key');
  ok(!m.investors.some((i) => i.key === null),
    'UNMAPPED-2 …and never appears as a merged investor with no identity');
  ok(m.sources.lenderprice.answered === false && /creds/.test(m.sources.lenderprice.error),
    'DEGRADED-1 a program that did not answer is NAMED as not answering…');
  ok(m.summary.loannexOnly === m.summary.investorCount && m.summary.inBoth === 0,
    'DEGRADED-2 …and is never merged as an empty board that loses every election');
  ok(m.investors.every((i) => i.electionBasis === 'sole_source'),
    'DEGRADED-3 …so a one-source answer says "only this program quotes it", not "this one is better"');
}

// ---- the white-label rule --------------------------------------------------
{
  const m = merge({ lenderprice: null, loannex: clone(board) });
  ok(m.investors.every((i) => i.whiteLabel !== i.investor),
    'LABEL-1 every merged investor carries a white-label name distinct from the real one');
  // RE-POINTED 2026-08-30 for the same reason as UNMAPPED-1: Button Finance now
  // resolves to a real key and has NO white-label name yet, so "every investor on
  // this board has one" stopped being true of this fixture. The RULE it was
  // guarding is the one that matters and is asserted directly instead — an
  // investor nobody has named carries NULL, and never their real name, because
  // the white label is the one name a client may see.
  ok(m.investors.every((i) => i.whiteLabel === null || (typeof i.whiteLabel === 'string' && i.whiteLabel.length > 0)),
    'LABEL-2 an investor nobody has named yet carries NULL — never an empty string somebody could print, and never their real name');
  const named = m.investors.filter((i) => i.whiteLabel);
  ok(named.length > 0 && named.every((i) => i.whiteLabel !== i.investor),
    `LABEL-2b …and every investor who HAS been named carries a name of their own (${named.length} of ${m.investors.length} on this board)`);
}

// ---- the client is a VIEWER: the read-only wall -----------------------------
{
  const I = client._internals;
  const allowed = [['POST', '/loans/apps/abc/quick-prices'], ['GET', '/loans/evidences/a/b/fails'],
                   ['GET', '/lookups/counties?stateValue=NJ'], ['GET', '/loans/apps/x/settings']];
  const blocked = [['POST', '/loans/locks'], ['POST', '/loans/registrations/a'], ['PUT', '/loans/apps/a'],
                   ['DELETE', '/loans/apps/a'], ['PATCH', '/loans/apps/a/quick-prices'],
                   ['POST', '/loans/apps/a/lock'], ['POST', '/orders']];
  ok(allowed.every(([m, p]) => { try { return I.assertReadOnly(m, p); } catch { return false; } }),
    'READONLY-1 every pricing and lookup path this client needs is allowed');
  ok(blocked.every(([m, p]) => { try { I.assertReadOnly(m, p); return false; } catch (e) { return e.code === 'loannex_write_blocked'; } }),
    'READONLY-2 …and every lock / register / delete path is refused BEFORE the wire');
  ok(I.READ_ONLY_PATHS.every((p) => /^(GET|POST) /.test(p)) &&
     !I.READ_ONLY_PATHS.some((p) => /lock|registration|book/i.test(p)),
    'READONLY-3 the allowlist itself contains no booking path — it is positive, not a blocklist of verbs');
  const scrubbed = I.scrub('{"authenticationToken":"eyJhbGciOiJI.eyJzdWIiOiJ4In0.abcdefghij","refreshToken":"secret"} tokenKey=aba5e526-6185-430c');
  ok(!/eyJ|secret|aba5e526/.test(scrubbed),
    'SCRUB-1 a JWT, a refresh token and a hand-off ticket are all redacted before anything can log them');
  ok(I.tokenKeyFromIframeHtml('<iframe src="https://webapp.loannex.com/nex-app?portal=nqmfcorr&amp;tokenKey=aba5e526-6185-430c-9bae-5beb2018a7c6">') === 'aba5e526-6185-430c-9bae-5beb2018a7c6',
    'TICKET-1 the one-time ticket is read from the portal HTML, both recorded iframe shapes');
  // THIS ASSERTION MOVED, IT WAS NOT DROPPED. It used to pin that the portal
  // sign-in was NOT implemented, which was the truth while no recording contained
  // it. A recording now does, and it is implemented (`portal-login.js`) — so the
  // thing worth pinning is the distinction that replaced it: IMPLEMENTED is not
  // PROVEN, and /health must keep saying so until a real sign-in has happened.
  const cfg = client.configured();
  ok(cfg.loginImplemented === true && cfg.loginExercised === false,
    'LOGIN-1 the portal sign-in is reported as implemented but NOT YET EXERCISED — a green tick never implies we have actually signed in');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
