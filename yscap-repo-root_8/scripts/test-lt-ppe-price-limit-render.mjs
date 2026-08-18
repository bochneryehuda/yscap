#!/usr/bin/env node
/**
 * LT PPE — the two screens this change added: the rate-sheet CHOOSER and the PRICE-LIMIT card.
 *
 * WHAT THESE TWO SURFACES ARE FOR.
 *
 *   · The CHOOSER replaced a free-text UUID box. A person used to price a loan by pasting a version
 *     id, so the sheet everybody had agreed to publish carried no special standing at all. Now they
 *     pick a PROGRAM and the version in EFFECT for it is what prices — with the exact-version box
 *     kept under "advanced", because naming a specific version is a real need and this had to ADD a
 *     way rather than take one away.
 *   · The PRICE-LIMIT card is the button that never existed. `PUT /rate-sheets/:id/price-limit` and
 *     `ltApi.ppeSetPriceLimit` both shipped, and the reachability gate reported that client entry as
 *     the ONE no screen calls — the five values bounding every quote could only be set with curl.
 *
 * ASSERTED ON RENDERED TEXT, NOT ON SOURCE. A guard that proves an identifier is MENTIONED proves
 * nothing about what a person sees: the sibling suite records a mutation that replaced every cap's
 * condition with `false`, left the unreachable render line in place, and passed every source-shaped
 * assertion. So the presentational halves are exported and handed a state directly — `renderToString`
 * never runs an effect, and every state worth guarding here (nothing published, two published, limits
 * in force, the recorded history, the published refusal) is a LOADED one.
 *
 * React's server renderer splits `{a} literal {b}` into text nodes divided by `<!-- -->` markers, so
 * the assertions match the STRIPPED text — which is what makes them about what a person READS rather
 * than about React's node boundaries.
 *
 *   node scripts/test-lt-ppe-price-limit-render.mjs
 *
 * LT-only. No database, no network.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const appv2 = path.join(repo, 'app-v2');
const require2 = createRequire(path.join(appv2, 'package.json'));

let n = 0; let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); n += 1; if (!cond) failures += 1; };

const esbuild = require2('esbuild');

// Both screens call `ltApi` at module load; a never-settling stub keeps this about RENDERING.
const STUB_API = `
export const ltApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
export default ltApi;
`;

const LIMIT_SRC = path.join(appv2, 'src/longterm/PriceLimitCard.jsx');
const BREAKDOWN_SRC = path.join(appv2, 'src/longterm/LtPricingBreakdown.jsx');

const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import PriceLimitCard, { PriceLimitCardView, describeLimit, limitLine, changeLine, ROUNDING_MODES, ON_EXCEED } from ${JSON.stringify(LIMIT_SRC)};
import LtPricingBreakdown, { RateSheetChooserView } from ${JSON.stringify(BREAKDOWN_SRC)};
globalThis.__React = React;
globalThis.__renderToString = renderToString;
globalThis.__LimitCard = PriceLimitCard;
globalThis.__LimitView = PriceLimitCardView;
globalThis.__Chooser = RateSheetChooserView;
globalThis.__Breakdown = LtPricingBreakdown;
globalThis.__pure = { describeLimit, limitLine, changeLine, ROUNDING_MODES, ON_EXCEED };
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-price-limit-'));
const outfile = path.join(tmp, 'bundle.cjs');
const stubPlugin = {
  name: 'stub-api',
  setup(build) {
    build.onResolve({ filter: /(^|\/)api\.js$/ }, (args) => {
      if (args.importer.includes(path.join('src', 'longterm'))) return { path: 'lt-api-stub', namespace: 'stub' };
      return null;
    });
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB_API, loader: 'js' }));
  },
};

try {
  await esbuild.build({
    stdin: { contents: entry, resolveDir: appv2, loader: 'jsx' },
    bundle: true, outfile, platform: 'node', format: 'cjs', jsx: 'automatic',
    logLevel: 'silent', plugins: [stubPlugin], absWorkingDir: appv2,
  });
} catch (e) {
  ok(false, `both screens bundle at all: ${String(e && e.message).slice(0, 400)}`);
  console.log(`\n${failures} FAILED of ${n}`);
  process.exit(1);
}
ok(true, 'A0 both screens and everything they import BUNDLE — a green Vite build proves neither');

require2(outfile);
const React = globalThis.__React;
const renderToString = globalThis.__renderToString;
const LimitCard = globalThis.__LimitCard;
const LimitView = globalThis.__LimitView;
const Chooser = globalThis.__Chooser;
const Breakdown = globalThis.__Breakdown;
const { describeLimit, limitLine, changeLine, ROUNDING_MODES, ON_EXCEED } = globalThis.__pure;

const text = (html) => String(html)
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ')
  .replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();

const el = React.createElement;

// ---- 1. the first paint -------------------------------------------------------------------------
{
  let err = null; let html = '';
  try { html = renderToString(el(Breakdown, {})); } catch (e) { err = e; }
  ok(!err, `A1 the pricing screen's first paint renders without throwing${err ? `: ${err.message}` : ''}`);
  ok(text(html).includes('Which rate sheet prices this'),
    'A2 …and the chooser is ON it — a control nothing renders is the same defect one layer up');
  // THE FREE-TEXT BOX IS GONE FROM THE MAIN FORM. It is still reachable under "advanced", which is
  // the next assertion; what must not survive is it being the ONLY way in.
  ok(!/Rate-sheet version the priced sheet to break down/.test(text(html)),
    'A3 …and the old top-level "version id" field is no longer the way a person picks a sheet');
  ok(text(html).includes('Name an exact version instead'),
    'A4 …while the exact-version box IS still there, under advanced — this ADDED a way, it removed none');
}

{
  let err = null; let html = '';
  const version = { id: 'v-1', versionNo: 3, status: 'draft' };
  try {
    html = renderToString(el(LimitCard, { version, priceLimit: null, history: [], editable: true, status: 'draft' }));
  } catch (e) { err = e; }
  ok(!err, `A5 the price-limit card renders without throwing${err ? `: ${err.message}` : ''}`);
  ok(text(html).includes('Price limits'), 'A6 …and names itself');
}

// ---- 2. the chooser's three states, RENDERED ----------------------------------------------------
const PROGRAMS = { programs: [
  { id: 'p-1', code: 'DSCR30', name: 'DSCR 30yr fixed', investorName: 'Deephaven Mortgage' },
  { id: 'p-2', code: 'DSCR40', name: 'DSCR 40yr IO', investorName: 'Deephaven Mortgage' },
] };

{
  const html = renderToString(el(Chooser, {
    programs: PROGRAMS, programsError: '', programId: 'p-1', versionId: '',
    effective: {
      published: { id: 'v-9', versionNo: 4, channel: 'correspondent', effectiveFrom: '2026-08-01T00:00:00.000Z' },
      reason: null, message: 'Version 4 is published and in effect for this program on the correspondent channel.',
      candidates: [],
    },
    effectiveError: '', busy: false, onProgram: () => {}, onVersion: () => {},
  }));
  const t = text(html);
  ok(/In effect/.test(t) && /Version 4/.test(t),
    'B1 a program with a published sheet SHOWS which version is in effect');
  ok(/correspondent/.test(t) && /2026-08-01/.test(t),
    'B2 …with the channel and the date it took effect, so "which sheet" is answerable at a glance');
  ok(/Deephaven Mortgage/.test(t) && /DSCR 30yr fixed/.test(t),
    'B3 …and the programs are named by investor and product, never by a bare id');
}

{
  const html = renderToString(el(Chooser, {
    programs: PROGRAMS, programsError: '', programId: 'p-2', versionId: '',
    effective: {
      published: null, reason: 'no_published_rate_sheet',
      message: 'Nothing is published for this program, so there is no rate sheet to price from. Publish one, or name an exact version.',
      candidates: [],
    },
    effectiveError: '', busy: false, onProgram: () => {}, onVersion: () => {},
  }));
  const t = text(html);
  // THE ONE THAT MATTERS. A screen that quietly showed the newest draft here is how a loan gets
  // priced off a sheet nobody published — the failure this whole change exists to prevent.
  ok(/Nothing published/.test(t),
    'B4 THE ONE THAT MATTERS: nothing published is a NAMED state on the screen, never a blank');
  ok(/Nothing is published for this program/.test(t),
    'B5 …in the SERVER\'s own words, so the screen cannot describe a state differently from a quote');
  ok(/Publish one, or name an exact version/.test(t),
    'B6 …and it names the two ways forward — never a dead end');
  ok(!/Version \d/.test(t),
    'B7 …and it offers NO version at all, so nothing can be mistaken for one that is in effect');
}

{
  const html = renderToString(el(Chooser, {
    programs: PROGRAMS, programsError: '', programId: 'p-1', versionId: '',
    effective: {
      published: null, reason: 'ambiguous_published_rate_sheet',
      message: '2 rate sheets are published and in effect for this program, so which one prices is not decided. Name the exact version you mean.',
      candidates: [
        { id: 'v-a', versionNo: 2, channel: 'correspondent', effectiveFrom: null },
        { id: 'v-b', versionNo: 5, channel: 'wholesale', effectiveFrom: null },
      ],
    },
    effectiveError: '', busy: false, onProgram: () => {}, onVersion: () => {},
  }));
  const t = text(html);
  ok(/Not decided/.test(t) && /which one prices is not decided/.test(t),
    'B8 two published versions reads as UNDECIDED — never a silently chosen winner');
  ok(/v-a/.test(t) && /v-b/.test(t),
    'B9 …and BOTH candidates are on the screen, so a person can name the one they mean');
}

{
  const html = renderToString(el(Chooser, {
    programs: null, programsError: 'The programs could not be read.', programId: '', versionId: '',
    effective: null, effectiveError: '', busy: false, onProgram: () => {}, onVersion: () => {},
  }));
  ok(/The programs could not be read/.test(text(html)),
    'B10 a FAILED read is said — rendering an empty list would read as "no programs yet", which is a different fact');

  const empty = renderToString(el(Chooser, {
    programs: { programs: [] }, programsError: '', programId: '', versionId: '',
    effective: null, effectiveError: '', busy: false, onProgram: () => {}, onVersion: () => {},
  }));
  ok(/No programs exist yet/.test(text(empty)),
    'B11 …and a read that SUCCEEDED and found nothing says THAT instead, sending a person to the console');
}

{
  const html = renderToString(el(Chooser, {
    programs: PROGRAMS, programsError: '', programId: 'p-1', versionId: '0f8b-typed-by-hand',
    effective: { published: { id: 'v-9', versionNo: 4, channel: 'correspondent', effectiveFrom: null }, reason: null, message: '', candidates: [] },
    effectiveError: '', busy: false, onProgram: () => {}, onVersion: () => {},
  }));
  ok(/the program above is ignored while it is filled in/.test(text(html)),
    'B12 a named version SAYS it wins over the program — precedence a person can only otherwise learn from behaviour');
}

// ---- 3. the price-limit card: what is in force, and who moved it ---------------------------------
{
  const html = renderToString(el(LimitView, {
    priceLimit: { min_price_milli: 98000, rounding_mode: 'none', rounding_increment_milli: 0, cap_tiers: [], on_exceed: 'cap_and_keep_eligible' },
    history: [{
      id: 1, before: { minPriceMilli: 101000 }, after: { minPriceMilli: 98000 },
      changedFields: ['minPriceMilli'], reason: 'renegotiated with the investor on the call',
      changedBy: 'a.person@ys', changedAt: 1786000000000,
    }],
    editable: true, status: 'draft', busy: false, error: '', note: '',
    form: { minPrice: '98', roundingMode: 'none', increment: '0', onExceed: 'cap_and_keep_eligible', reason: '' },
    onField: () => {}, pending: null, onReview: () => {}, onConfirm: () => {}, onCancel: () => {},
  }));
  const t = text(html);
  ok(/In force now/.test(t) && /minimum price 98/.test(t),
    'C1 WHAT IS IN FORCE NOW is on the screen before any input — a person must read the floor they are moving');
  ok(/Last changed by/.test(t) && /a\.person@ys/.test(t),
    'C2 …and WHO moved it last');
  ok(/renegotiated with the investor on the call/.test(t),
    'C3 …and WHY, in their own words — the only thing that can answer "why is this 98 and not 101?"');
  ok(/changed minPriceMilli/.test(t),
    'C4 …and WHICH of the five moved, so nobody diffs two JSON blobs to find out');
  ok(/A reason of at least 8 characters is required/.test(t),
    'C5 the reason is required, and the screen SAYS so before a person fills the form');
}

{
  const html = renderToString(el(LimitView, {
    priceLimit: null, history: [], editable: true, status: 'draft', busy: false, error: '', note: '',
    form: { minPrice: '', roundingMode: 'nearest_eighth', increment: '0.125', onExceed: 'cap_and_keep_eligible', reason: '' },
    onField: () => {}, pending: null, onReview: () => {}, onConfirm: () => {}, onCancel: () => {},
  }));
  const t = text(html);
  // A blank box would read as "no limits, nothing to see". "It prices with the engine's coded
  // defaults" is a real and quite different state.
  ok(/No price limits are set on this version/.test(t) && /coded defaults/.test(t),
    'C6 a sheet with NO limit row says so — never an empty box, which reads as nothing to know');
  ok(/No recorded change to these limits yet/.test(t),
    'C7 …and "nobody has changed these" is said rather than left blank');
}

{
  const html = renderToString(el(LimitView, {
    priceLimit: { min_price_milli: 98000, rounding_mode: 'none', rounding_increment_milli: 0, cap_tiers: [], on_exceed: 'cap_and_keep_eligible' },
    history: [], editable: false, status: 'published', busy: false, error: '', note: '',
    form: { minPrice: '98', roundingMode: 'none', increment: '0', onExceed: 'cap_and_keep_eligible', reason: '' },
    onField: () => {}, pending: null, onReview: () => {}, onConfirm: () => {}, onCancel: () => {},
  }));
  const t = text(html);
  ok(/can no longer be changed/.test(t) && /Open a NEW draft/.test(t),
    'C8 a PUBLISHED sheet shows the refusal WITH the way forward — a hidden control is indistinguishable from a broken one');
  ok(!/Review this change/.test(t),
    'C9 …and the button is genuinely absent rather than present-and-doomed');
  ok(/minimum price 98/.test(t),
    'C10 …while what is IN FORCE is still shown, because that is what a published sheet is pricing from');
}

{
  const html = renderToString(el(LimitView, {
    priceLimit: null,
    history: [
      { id: 3, before: { minPriceMilli: 98000 }, after: { minPriceMilli: 95000 }, changedFields: ['minPriceMilli'], reason: 'r3', changedBy: 'c@ys', changedAt: 1786000002000 },
      { id: 2, before: { minPriceMilli: 101000 }, after: { minPriceMilli: 98000 }, changedFields: ['minPriceMilli'], reason: 'r2', changedBy: 'b@ys', changedAt: 1786000001000 },
      { id: 1, before: null, after: { minPriceMilli: 101000 }, changedFields: ['minPriceMilli'], reason: 'r1', changedBy: 'a@ys', changedAt: 1786000000000 },
    ],
    editable: true, status: 'draft', busy: false, error: '', note: '',
    form: { minPrice: '', roundingMode: 'none', increment: '', onExceed: 'cap_and_keep_eligible', reason: '' },
    onField: () => {}, pending: null, onReview: () => {}, onConfirm: () => {}, onCancel: () => {},
  }));
  const t = text(html);
  ok(/2 earlier changes to these limits/.test(t),
    'C11 the EARLIER changes are counted and offered — a history nobody is told about reads as the whole story');
  ok(/b@ys/.test(t) && /a@ys/.test(t),
    'C12 …and every one of them is really rendered, not merely counted');
}

{
  const html = renderToString(el(LimitView, {
    priceLimit: null, history: [], editable: true, status: 'draft', busy: false,
    error: 'That change was refused.', note: '',
    form: { minPrice: '', roundingMode: 'none', increment: '', onExceed: 'cap_and_keep_eligible', reason: 'a good reason' },
    onField: () => {}, pending: null, onReview: () => {}, onConfirm: () => {}, onCancel: () => {},
  }));
  ok(/That change was refused/.test(text(html)),
    'C13 the SERVER\'s own refusal is shown — a generic failure leaves a person unable to tell one rule from another');
}

// ---- 3b. the INLINE confirmation, and what it quotes ---------------------------------------------
//
// The browser's confirm() is banned, and Long-Term may not import RTL's shared dialog helper (the
// separation gate refuses it — `LtPpe.jsx` records the same decision). So the confirmation is an
// inline step, and what makes it worth a click is that it quotes BOTH SIDES.
{
  const armed = renderToString(el(LimitView, {
    priceLimit: { min_price_milli: 98000, rounding_mode: 'none', rounding_increment_milli: 0, cap_tiers: [], on_exceed: 'cap_and_keep_eligible' },
    history: [], editable: true, status: 'draft', busy: false, error: '', note: '',
    form: { minPrice: '95', roundingMode: 'none', increment: '0', onExceed: 'cap_and_keep_eligible', reason: 'renegotiated on the call' },
    onField: () => {},
    pending: {
      body: {}, before: 'minimum price 98, rounding none', after: 'minimum price 95, rounding none',
      reason: 'renegotiated on the call',
    },
    onReview: () => {}, onConfirm: () => {}, onCancel: () => {},
  }));
  const t = text(armed);
  ok(/Confirm this change/.test(t) && /money rules every quote on this sheet is bounded by/.test(t),
    'C14 the armed change says what it is about to move');
  ok(/Now: minimum price 98/.test(t) && /After: minimum price 95/.test(t),
    'C15 THE ONE THAT MATTERS: the confirmation quotes BOTH sides — a bare "are you sure?" costs a click and tells nobody anything');
  ok(/Reason: renegotiated on the call/.test(t),
    'C16 …and the reason that will be recorded, so it is checked before it is filed, not after');
  ok(/Change them, and record why/.test(t) && /Go back/.test(t),
    'C17 …and both ways out are offered');
  ok(!/Review this change/.test(t),
    'C18 …while the first-press button is gone, so one press cannot be mistaken for the other');
}

// ---- 4. the pure helpers, every branch ----------------------------------------------------------
{
  ok(describeLimit(null) === null, 'D1 no limit row describes as nothing, never as a zero floor');
  const d = describeLimit({ min_price_milli: null, rounding_mode: 'nearest_eighth', rounding_increment_milli: 125, cap_tiers: [], on_exceed: 'ineligible' });
  ok(d.floorText === 'no minimum price',
    'D2 a NULL floor reads as "no minimum price" — a real answer, and not the same as a floor of zero');
  ok(limitLine(null) === 'no price limits at all',
    'D3 …and the whole absence has its own sentence');
  const line = limitLine(describeLimit({ min_price_milli: 98000, rounding_mode: 'none', rounding_increment_milli: 0, cap_tiers: [{ uptoLoanAmount: 1000000, capMilli: 103000 }], on_exceed: 'cap_and_keep_eligible' }));
  ok(/minimum price 98/.test(line) && /1 loan-size cap tier/.test(line),
    'D4 the one-line summary carries the floor AND the cap tiers, which is what a confirmation quotes');
  ok(changeLine({ changedBy: null, changedAt: 0, changedFields: [] }).includes('an unrecorded time'),
    'D5 a missing timestamp says so rather than printing the epoch');
  ok(changeLine({ changedBy: null, changedAt: 1, changedFields: [] }).includes('nothing (the values were re-saved unchanged)'),
    'D6 …and a change that moved nothing says THAT, rather than rendering an empty list');
  ok(changeLine({ changedBy: null, changedAt: 1, changedFields: [] }).includes('somebody whose name was not recorded'),
    'D7 …and an unattributed change is named as unattributed, never left blank');
}

// ---- 5. the two rules this codebase enforces on every LT screen -----------------------------------
{
  for (const [name, src] of [['PriceLimitCard', LIMIT_SRC], ['LtPricingBreakdown', BREAKDOWN_SRC], ['RateSheetConsole', path.join(appv2, 'src/longterm/RateSheetConsole.jsx')]]) {
    const s = fs.readFileSync(src, 'utf8');
    ok(!/color:\s*['"]?var\(--ink/.test(s),
      `E1 ${name} uses no \`--ink*\` token as a text colour — every one of them is a LIGHT paper colour here`);
    const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(!/window\.(alert|confirm|prompt)\s*\(/.test(code) && !/(^|[^.\w])(alert|confirm|prompt)\s*\(/.test(code),
      `E2 ${name} raises no BROWSER dialog — PILOT's own message box, always`);
  }
  const limitSrc = fs.readFileSync(LIMIT_SRC, 'utf8');
  // LONG-TERM MAY NOT IMPORT RTL CODE. The shared dialog helper lives in `app-v2/src/lib/`, and the
  // product-separation gate refuses the crossing — which is the gate doing its job, and the same
  // decision `LtPpe.jsx` already records. The confirmation is inline instead.
  ok(!/from\s+'\.\.\/lib\//.test(limitSrc),
    'E3 the card imports nothing out of RTL\'s folders — the separation gate refuses that crossing');
  ok(/ltApi\.ppeSetPriceLimit\([^)]*pending\.body\)/.test(limitSrc),
    'E4 …and it sends the body that was REVIEWED, never one re-read off the form after the fact');
  ok(/ltApi\.ppeSetPriceLimit\(/.test(limitSrc),
    'E5 …making this card the caller `ppeSetPriceLimit` never had');
}

// ---- 6. it is MOUNTED, AND THE MOUNT IS LIVE ------------------------------------------------------
//
// A card nothing renders is the same defect one layer up — and "the identifier appears in the file"
// does NOT prove it renders. PROVEN: a mutation that wrapped the mount as `{false && <PriceLimitCard`
// left the tag in the source, passed a `/<PriceLimitCard\s/` guard, and ALSO left the reachability
// gate green (that scan reads `ltApi.ppeSetPriceLimit(` out of the file, not the render tree). So the
// guard below refuses a mount disabled by a falsy literal, and requires it to sit inside the block
// that renders when a sheet is open.
//
// LIMITATION, STATED RATHER THAN IMPLIED: this is a SOURCE check. `renderToString` never runs the
// effect that loads the sheet, so the console's loaded state cannot be rendered without splitting it
// the way this change split the two new surfaces. A mount disabled by a RUNTIME-false expression
// (rather than a literal) would still pass — the honest bound of what is proven here.
{
  const consoleSrc = fs.readFileSync(path.join(appv2, 'src/longterm/RateSheetConsole.jsx'), 'utf8');
  ok(/import PriceLimitCard from '\.\/PriceLimitCard\.jsx'/.test(consoleSrc),
    'F1 the rate-sheet console imports the price-limit card');

  const sheetBlock = consoleSrc.slice(consoleSrc.indexOf('{sheet && ('));
  ok(sheetBlock.length > 0 && /<PriceLimitCard\s/.test(sheetBlock),
    'F2 …and MOUNTS it inside the block that renders once a sheet is open');
  ok(!/\{\s*(false|null|0)\s*&&\s*<PriceLimitCard/.test(consoleSrc),
    'F2b …and the mount is not disabled by a falsy literal — a tag in the source is not a rendered control');
  ok(/<PriceLimitCard[\s\S]{0,400}onSaved=/.test(consoleSrc),
    'F3 …with a reload, so the card can never sit on limits the save just replaced');

  const bd = fs.readFileSync(BREAKDOWN_SRC, 'utf8');
  ok(/<RateSheetChooserView\s/.test(bd) && !/\{\s*(false|null|0)\s*&&\s*<RateSheetChooserView/.test(bd),
    'F4 the pricing screen mounts the chooser, undisabled');
  ok(/ltApi\.ppeCurrentRateSheet\(/.test(bd),
    'F5 …and calls the "which version is in effect" read, which is what makes publishing mean something here');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
process.exit(failures ? 1 : 0);
