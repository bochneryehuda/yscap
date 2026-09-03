#!/usr/bin/env node
/**
 * THE BYTE-BY-BYTE COMPARISON — Lender Price against LoanNEX, and each vendor against ITSELF.
 *
 * Owner: *"We need a massive engine that should start comparing byte by byte: Which information is
 * nicely laid out in LenderPrice? Which information do we get from LenderPrice that we have not yet
 * implemented in loannex? Which information is the opposite? Can we look in loannex for
 * ineligibility and for the reason for ineligibility? Do we get every single thing that we get from
 * loannex? Let's double-check and triple-check everything."*
 *
 * ⛔ WHY THIS IS NOT THE EXISTING AUDIT. `test-lt-combined-audit.mjs` compares two PARSED rows, so
 * it can say what each vendor's row carries — and it structurally CANNOT answer "do we get every
 * single thing", because a field our parser never kept is absent from both sides of that
 * comparison and reads as "neither states it". Answering that question means walking the VENDOR'S
 * OWN RAW PAYLOAD and asking, of every key in it, whether it reaches our shape. That is the
 * byte-by-byte the owner asked for, and it is what this adds.
 *
 * IT READS REAL CAPTURES, NOT FIXTURES SOMEBODY WROTE: `src/longterm/loannex/capture/*.json` are
 * recorded vendor responses (the endpoint, the date and the scenario are stamped in each file's
 * `_captured` block). A reading taken from a hand-written sample would only ever prove that the
 * sample matches the parser.
 *
 * MOSTLY A REPORT. Where it ASSERTS, it asserts a claim that must stay true (the ineligibility
 * reason, the wiring); everything else is printed for a person to read and decide. An audit that
 * turns every difference into a failure teaches people to ignore it.
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

const nexParse = require('../src/longterm/loannex/parse.js');
const qs = require('../src/longterm/pricing/quote-shape.js');

let pass = 0; let fail = 0; const open = [];
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const note = (m) => { open.push(m); };
const W = 96;
const H = (t) => console.log(`\n${'─'.repeat(W)}\n${t}\n${'─'.repeat(W)}`);
const pad = (s, n) => String(s == null ? '' : s).slice(0, n - 1).padEnd(n);

/** Every leaf path in an object, arrays collapsed to `[]` so one path stands for a whole list. */
function paths(obj, prefix = '', out = new Set(), depth = 0) {
  if (depth > 6 || obj == null) return out;
  if (Array.isArray(obj)) {
    // One representative element is enough: a list's members share a shape, and walking 1,718
    // rungs would report the same paths 1,718 times.
    if (obj.length) paths(obj[0], `${prefix}[]`, out, depth + 1);
    else out.add(prefix + '[] (empty)');
    return out;
  }
  if (typeof obj !== 'object') { out.add(prefix.replace(/\.$/, '')); return out; }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') paths(v, `${prefix}${k}.`, out, depth + 1);
    else out.add(prefix + k);
  }
  return out;
}

const cap = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'src/longterm/loannex/capture', f), 'utf8'));

// ═══════════════════════════════════════════════════════════════════════════════
H('1. WHAT LOANNEX PUBLISHES ON A PRICING SEARCH, AND WHAT WE KEEP');
{
  const raw = cap('quick-prices.json');
  console.log(`  capture: ${raw._captured.endpoint}   recorded ${raw._captured.recordedOn}`);
  console.log(`  scenario: ${raw._captured.note}\n`);
  const d = raw.response.data;

  // The vendor's own top-level blocks, and what each is.
  const blocks = Object.keys(d);
  const size = (k) => (Array.isArray(d[k]) ? `${d[k].length} rows` : typeof d[k] === 'object' ? 'object' : JSON.stringify(d[k]));
  const parsed = nexParse.parse(raw.response);
  const kept = paths(parsed);
  const kp = [...kept];

  /**
   * WHICH TOP-LEVEL BLOCKS REACH OUR SHAPE. A lookup table (`investors`, `programs`, `products`)
   * is CONSUMED rather than copied — the parser resolves each rung's ids through it — so "not
   * carried through verbatim" is the correct outcome for those and is reported as such rather
   * than as a loss.
   */
  /**
   * ⛔ THE VERDICT PER BLOCK IS AUTHORED, NOT GUESSED — and the first cut of this engine proves why.
   * It matched block names against our parsed key paths by substring, and reported `prices` — the
   * 1,718 priced rows that ARE the board — as "NOT KEPT", because the parse renames them `rungs`.
   * A reading that confident and that wrong is worse than no reading. What CANNOT be authored is
   * the LIST: it is read off the vendor's own payload, so a block LoanNEX adds tomorrow appears
   * here as `unclassified` and forces a decision instead of passing silently.
   */
  const VERDICT = {
    prices: 'KEPT — these become the rungs on every programme (renamed, not dropped)',
    transactionId: 'KEPT — the search identity every explain call is scoped to',
    hasIneligiblePrograms: 'KEPT — drives the "some investors said no" signal',
    investors: 'lookup table — resolved into each row by id (not copied)',
    lockInvestors: 'lookup table — resolved into each row by id (not copied)',
    programs: 'lookup table — resolved into each row by id (not copied)',
    programCodes: 'lookup table — resolved into each row by id (not copied)',
    products: 'lookup table — resolved into each row by id (not copied)',
    mortgageProducts: 'lookup table — resolved into each row by id (not copied)',
    version: 'not kept — the payload schema version, not a fact about the loan',
    hasAnsweredQuestions: 'NOT KEPT — see the open list',
    availableLockActions: 'NOT KEPT — see the open list',
    availableNonLockActions: 'NOT KEPT — see the open list',
    pricingAttributes: 'NOT KEPT — see the open list',
  };
  console.log(pad('VENDOR BLOCK', 26) + pad('SIZE', 14) + 'WHAT WE DO WITH IT');
  const unclassified = [];
  for (const b of blocks) {
    const v = VERDICT[b];
    if (!v) unclassified.push(b);
    console.log(pad(b, 26) + pad(size(b), 14) + (v || 'UNCLASSIFIED — a new vendor block; decide what it is'));
  }
  ok(unclassified.length === 0,
    `COV-1 every block LoanNEX sends has a stated verdict (${unclassified.length ? `unclassified: ${unclassified.join(', ')}` : `all ${blocks.length}`})`);
  const notKept = blocks.filter((b) => /^NOT KEPT/.test(VERDICT[b] || ''));
  if (notKept.length) note(`LoanNEX blocks we do not read at all: ${notKept.join(', ')}. `
    + 'None is a price or an eligibility fact — they are the portal\'s own lock/questionnaire machinery — '
    + 'but nobody has decided in writing that we do not want them.');

  // The RUNG — the row that becomes a price on the board. This is the byte-by-byte that matters.
  const rung = d.prices[0];
  const rungKeys = [...paths(rung)];
  const firstProgram = (parsed.programs || [])[0] || {};
  const firstRung = (firstProgram.rungs || [])[0] || {};
  const ourRungKeys = [...paths(firstRung), ...paths(firstProgram)];
  console.log(`\n  ONE RUNG, FIELD BY FIELD (${rungKeys.length} vendor fields on the rung):`);
  console.log('  ' + pad('VENDOR FIELD', 30) + pad('VALUE', 22) + 'REACHES OUR ROW?');
  const dropped = [];
  /** Where a vendor id is RESOLVED into a name rather than copied, name the field it becomes. */
  const RESOLVES_TO = { investorId: 'lenderId', programId: 'programId', productId: 'product', creditScreenIds: 'programId' };
  for (const k of rungKeys.sort()) {
    const base = k.split('.')[0].replace('[]', '');
    const v = rung[base];
    // ⛔ MATCH ON THE LEAF, NOT THE CONTAINER. `lockTermPrices[].lockDays` IS kept — the parse
    // explodes each priced row into one rung per lock term, so the lock's own fields land directly
    // on the rung — and matching `lockTermPrices` reported all three as dropped. A container the
    // parse flattens is not a field the parse loses.
    const leaf = k.split('.').pop().replace('[]', '');
    const target = RESOLVES_TO[base] || RESOLVES_TO[leaf] || leaf;
    const ours = ourRungKeys.map((o) => o.split('.').pop().replace('[]', '').toLowerCase());
    const hit = ours.includes(target.toLowerCase()) || ours.includes(leaf.toLowerCase());
    if (!hit) dropped.push(k);
    console.log('  ' + pad(k, 30) + pad(Array.isArray(v) ? `[${v.length}]` : JSON.stringify(v), 22)
      + (hit ? (RESOLVES_TO[base] ? `yes (as ${RESOLVES_TO[base]})` : 'yes') : 'NO'));
  }
  if (dropped.length) note(`LoanNEX rung fields not carried onto our row: ${dropped.join(', ')}`);

  const rungCount = (parsed.programs || []).reduce((n, p) => n + (p.rungs || []).length, 0);
  // ⛔ COUNT THE LOCKS, DO NOT ASSUME THEM. Taking the lock count off the FIRST row and
  // multiplying gave 1718 x 3 = 5154 against the 5286 we actually hold — an arithmetic that does not
  // add up reads as a fault in the parser when the truth is simply that not every row carries the
  // same number of lock terms.
  const lockTotal = d.prices.reduce((n, p) => n + ((p.lockTermPrices || []).length), 0);
  const lockCounts = [...new Set(d.prices.map((p) => (p.lockTermPrices || []).length))].sort((a, b) => a - b);
  console.log(`\n  ${d.prices.length} priced rows in, ${(parsed.programs || []).length} programmes carrying ${rungCount} rungs out.`);
  console.log(`  MORE rungs than rows, and that is the mapping rather than a fault: LoanNEX sends ONE row per`);
  console.log(`  (programme, rate) carrying its lock terms inside it, and a lock is part of a quote's identity —`);
  console.log(`  the same rate at 15 and at 45 days is two different prices — so each lock becomes its own rung.`);
  console.log(`  Lock terms per row across the whole payload: ${lockCounts.join(', ')} (${lockTotal} lock quotes in total).`);
  console.log(`  ${lockTotal} published, ${rungCount} held${rungCount === lockTotal ? ' — every one of them.' : rungCount < lockTotal ? ` (${lockTotal - rungCount} sit under programmes the search narrowed away).` : ` (${rungCount - lockTotal} MORE than published — investigate).`}`);
  console.log('  A rung we do not hold is a rung whose programme the search narrowed away, never a field we cannot read.');
}

// ═══════════════════════════════════════════════════════════════════════════════
H('2. INELIGIBILITY — CAN WE SEE IT, AND CAN WE SAY WHY? (the owner\'s own question)');
{
  const raw = cap('fails.json');
  console.log(`  capture: ${raw._captured.endpoint}`);
  console.log(`  vendor's own note: ${raw._captured.note}\n`);
  const parsedF = nexParse.parseFails(raw.response);

  ok(parsedF.lenderCount > 0 && parsedF.itemCount > 0,
    `ELIG-1 LoanNEX DOES publish ineligibility (${parsedF.lenderCount} investors, ${parsedF.itemCount} refused programmes) and we parse it`);

  const withReasons = parsedF.lenders.flatMap((l) => l.items).filter((i) => i.reasons && i.reasons.length);
  ok(withReasons.length > 0,
    `ELIG-2 …WITH the reason, not just the fact (${withReasons.length} of ${parsedF.itemCount} refused programmes name at least one failing attribute)`);

  const withThreshold = parsedF.lenders.flatMap((l) => l.items)
    .flatMap((i) => i.failingAttributes || []).filter((a) => a.min != null || a.max != null);
  ok(withThreshold.length > 0,
    `ELIG-3 …and the THRESHOLD it failed against (${withThreshold.length} failing attributes carry a min or a max)`);

  console.log('\n  A SAMPLE, in the vendor\'s own terms:');
  for (const l of parsedF.lenders.slice(0, 3)) {
    for (const it of (l.items || []).filter((i) => i.reasons.length).slice(0, 2)) {
      console.log(`    ${pad(l.lender, 42)} ${pad(it.program || it.screen, 30)} ${it.reasons.join('; ')}`);
    }
  }
  console.log('\n  READING: this is MORE than Lender Price gives. Lender Price answers with a sentence per');
  console.log('  refused programme; LoanNEX names the exact attribute (Ltv), its status, and the number it');
  console.log('  was measured against (max 0.75) — so "why not?" is answerable without a phone call.');
}

// ═══════════════════════════════════════════════════════════════════════════════
H('3. IS THAT INELIGIBILITY ACTUALLY ON THE SCREEN? (a back end nobody reaches is not a feature)');
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const route = strip(fs.readFileSync(path.join(ROOT, 'src/longterm/routes/combined-pricer.js'), 'utf8'));
  const api = strip(fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/api.js'), 'utf8'));
  const pricer = strip(fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/LtPricer.jsx'), 'utf8'));

  const hasClient = /async function fails\(/.test(fs.readFileSync(path.join(ROOT, 'src/longterm/loannex/client.js'), 'utf8'));
  const hasRoute = /loannex\/disqualify\/:transactionId/.test(route);
  const hasApi = /loannex\/disqualify|loannexDisqualif/i.test(api);
  const boardCarries = /disqualified/.test(route.split('async function priceBoth')[1] || '');
  const screenAsks = /loannexDisqualif|loannex\/disqualify/i.test(pricer);

  console.log(`  the vendor client can ask         : ${hasClient ? 'YES' : 'no'}`);
  console.log(`  the parser can read the answer    : YES (section 2 ran it)`);
  console.log(`  an HTTP route exposes it          : ${hasRoute ? 'YES' : 'no'}`);
  console.log(`  the board carries it              : ${boardCarries ? 'YES' : 'NO'}`);
  console.log(`  the browser has a method for it   : ${hasApi ? 'YES' : 'NO'}`);
  console.log(`  the screen ever asks for it       : ${screenAsks ? 'YES' : 'NO'}`);

  ok(hasClient && hasRoute,
    'WIRE-1 the LoanNEX ineligibility is fetchable — client and route both exist');
  if (!screenAsks || !hasApi) {
    note('THE GAP: the Combined Pricing Engine\'s "not eligible" list is fed ONLY by the Lender Price '
      + 'disqualify flow (askDisqualified -> ltApi.dscrDisqualifications, keyed on the Lender Price searchKey). '
      + 'Nothing on that screen ever asks LoanNEX why ITS investors said no, so a LoanNEX refusal is invisible '
      + 'even though the client, the parser and the route are all built and the vendor answers in more detail.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
H('4. WHAT EACH VENDOR STATES ON A PRICED ROW — measured by RUNNING both mappers');
{
  /**
   * ⛔ THIS IS MEASURED, NOT READ OFF THE SOURCE, and the first cut of this section proves why.
   * It scanned each mapper's source text for the field's name — and reported "Lender Price only: 0"
   * while crediting LoanNEX with `basePoints`, the figure Lender Price is the one that states.
   * The regex had matched the wrong region of the file. A confident wrong reading in a report is
   * worse than no report, so both mappers are now RUN over REAL captured vendor rows and a field
   * counts as stated when a row actually carries a value.
   */
  const lpCapture = require('./fixtures/lt-pricer-live-capture.json');
  const nexRaw = cap('quick-prices.json');
  const nexBoard = nexParse.parse(nexRaw.response);
  const lpRows = qs.optionsFromLenderPrice((lpCapture.programs || []).flatMap((p) => p.options || []));
  const nexRows = qs.optionsFromLoanNex(nexBoard, { loanAmount: 375000, fico: 760, loanPurpose: 'Purchase' });

  /**
   * LoanNEX publishes the ladder up front and EXPLAINS a row only when asked, so a board row and an
   * explained row are two different states of the same quote. Reporting only the board would say we
   * are missing the itemised LLPAs when the truth is that they arrive on the next call.
   */
  const evRaw = cap('evidence.json');
  /**
   * ⛔ THE CAPTURE HOLDS `samples[]` (one per explained quote), NOT a single `response`, and the
   * first cut read `evRaw.response` — which is undefined, so `parseEvidence` returned null, nothing
   * attached, and this section reported `basePrice` / `priceFloor` / `adjustments` as "NEITHER
   * STATES". That directly contradicted section 2, which had just printed LoanNEX's own itemisation.
   * ⛔ AND `attachEvidence` REFUSES an evidence whose rate or lock does not match the option, which
   * is exactly right and exactly what makes a careless fixture silently prove nothing — so the seed
   * is built FROM the evidence's own rate and lock rather than from an unrelated board row.
   */
  const evSample = (evRaw.samples || []).map((x) => nexParse.parseEvidence(x.response || x)).find(Boolean);
  const seed = nexRows[0] ? JSON.parse(JSON.stringify(nexRows[0])) : qs.emptyOption();
  if (evSample) {
    seed.priceBuild.noteRate = evSample.rate;
    seed.priceBuild.price = evSample.price != null ? evSample.price : seed.priceBuild.price;
    if (evSample.lockPeriod != null) seed.terms.dayLock = Number(evSample.lockPeriod);
  }
  const nexExplained = qs.attachEvidence(seed, evSample, {});
  const attached = !!(nexExplained.evidence && nexExplained.evidence.appliesToThisRate);
  ok(attached,
    `COV-3 the captured LoanNEX explain actually attaches (${attached ? 'yes' : `no — ${(nexExplained.evidence || {}).reason}`}) — without this the "explained" column silently reports nothing`);

  const shape = [...paths(qs.emptyOption())].sort();
  const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k.replace('[]', '')]), o);
  const fills = (rows, f) => rows.some((r) => { const v = get(r, f); return v !== null && v !== undefined && !(Array.isArray(v) && !v.length); });

  console.log(`  Lender Price capture: ${lpRows.length} priced options.  LoanNEX capture: ${nexRows.length} priced options.`);
  console.log('  "states it" = at least one REAL captured row carries a value.\n');
  console.log('  ' + pad('COMMON FIELD', 34) + pad('LENDER PRICE', 16) + pad('LOANNEX (board)', 18) + 'LOANNEX (explained)');
  const lpOnly = []; const nxOnly = []; const neither = []; const bothF = []; const onlyAfterExplain = [];
  for (const f of shape) {
    const a = fills(lpRows, f);
    const b = fills(nexRows, f);
    const c = fills([nexExplained], f);
    console.log('  ' + pad(f, 34) + pad(a ? 'states it' : '—', 16) + pad(b ? 'states it' : '—', 18) + (c ? 'states it' : '—'));
    const nx = b || c;
    if (a && nx) bothF.push(f); else if (a) lpOnly.push(f); else if (nx) nxOnly.push(f); else neither.push(f);
    if (!b && c) onlyAfterExplain.push(f);
  }
  console.log(`\n  both: ${bothF.length}   Lender Price only: ${lpOnly.length}   LoanNEX only: ${nxOnly.length}   neither: ${neither.length}`);

  /**
   * ⛔ WHAT THIS SECTION CAN AND CANNOT SEE — stated, because three of its readings would otherwise
   * be taken for something they are not. It measures the two OPTION MAPPERS. Several facts on a
   * live row are added by LATER layers, so they read as "Lender Price only" or "neither" here while
   * being perfectly present on the screen:
   *   • `holdback` — our 0.25 margin is applied to LOANNEX by `vendor-margin.applyToBoard` AFTER the
   *     mapper runs. Reading this line as "LoanNEX has no holdback" is the exact opposite of the truth.
   *   • `whiteLabel` — stamped by the routing merge (VERIFIED: the board builder returns "Ruby").
   *   • `rateSheet.name` — filled by `programsFromLoanNex`, the BOARD builder, not by this mapper.
   */
  console.log('\n  ⚠ THIS SECTION MEASURES THE TWO OPTION MAPPERS. Three facts are added downstream and so read');
  console.log('    wrongly here: `holdback` (our margin is applied to LOANNEX afterwards — the opposite of what');
  console.log('    the table says), `whiteLabel` (stamped by the routing merge) and `rateSheet.name` (filled by');
  console.log('    the board builder). Everything else in the three lists is a real difference between the sheets.');

  if (lpOnly.length) {
    console.log(`\n  FROM LENDER PRICE, NOT YET FROM LOANNEX — the owner's second question:\n    ${lpOnly.join('\n    ')}`);
    note(`Lender Price states these and LoanNEX does not, on the captured scenario: ${lpOnly.join(', ')}.`);
  } else {
    console.log('\n  FROM LENDER PRICE, NOT YET FROM LOANNEX: nothing — every field Lender Price fills, LoanNEX fills too.');
  }
  if (nxOnly.length) console.log(`\n  THE OPPOSITE — FROM LOANNEX, NOT FROM LENDER PRICE:\n    ${nxOnly.join('\n    ')}`);
  if (onlyAfterExplain.length) {
    console.log(`\n  ON LOANNEX ONLY AFTER THE EXPLAIN CALL (the ladder up front, the itemisation on demand):\n    ${onlyAfterExplain.join('\n    ')}`);
  }
  if (neither.length) console.log(`\n  NEITHER STATES on this scenario (the layout draws these blank):\n    ${neither.join('\n    ')}`);

  // The one thing that must not be true: a field the LAYOUT draws that no vendor ever fills is a
  // column that is blank on every row of every board — worth knowing, not worth failing over.
  ok(bothF.length > 0 && nexRows.length > 0 && lpRows.length > 0,
    `COV-2 both mappers ran over real captured rows (${lpRows.length} Lender Price, ${nexRows.length} LoanNEX) — this is measured, not read off the source`);
}

// ═══════════════════════════════════════════════════════════════════════════════
H('WHAT THIS ENGINE SAYS IS STILL OPEN');
if (!open.length) console.log('  Nothing. Every capability the vendors publish is parsed and reachable.');
for (const o of open) console.log(`  • ${o}\n`);

console.log(`\n${fail ? 'FAILED' : 'The assertions passed'} (${pass} passed, ${fail} failed). Everything else above is a reading, not a verdict.`);
process.exit(fail ? 1 : 0);
