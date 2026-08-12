/**
 * THE ONE NOTE BUYER, HOWEVER IT IS SPELLED (owner-directed 2026-08-11) — the PURE
 * half.
 *
 * The owner: "EMCAP Financial and EMCAP are the same note buyer — combine them,
 * everything should understand them as the same, and the one we keep should be
 * linked everywhere; the ClickUp one is canonical. Also: when we change the note
 * buyer in our system and ClickUp didn't accept it, our value stays and it goes to
 * a manual review — never a silent bounce-back."
 *
 * What must hold:
 *   A. canonicalNoteBuyer collapses every spelling of a KNOWN buyer to ONE identity
 *      + its production label; an unknown buyer keeps its own spelling; blank → null.
 *   B. sameNoteBuyer: "EMCAP" ≡ "EMCAP Financial", "Blue Lake" ≡ "Blue Lake Capital",
 *      but two different buyers are never merged.
 *   C. The PICKER collapse: a mixed list of spellings dedups to ONE row per buyer,
 *      offered under the canonical label (the listNoteBuyers dedup, replicated).
 *   D. The bounce-back guard no longer CHURNS on a spelling difference: ClickUp
 *      "EMCAP Financial" vs a file holding "EMCAP" is NOT a change.
 *   E. The free-dropdown note buyer is PROTECTED: a value ClickUp has no option for
 *      is KEPT and flagged (→ manual review), while a mappable / same-buyer / cold-
 *      cache value is left alone.
 *   F. ONE source of truth for the canonical labels (field-registry) — the
 *      Silver→EMCAP auto-link writes the SAME string the picker offers.
 *
 * No DB is touched (db.js loads but is never queried).
 */
'use strict';

const reg = require('../src/lib/conditions/field-registry');
const guard = require('../src/lib/inbound-portal-edit-guard');
const enumGuard = require('../src/lib/inbound-enum-guard');
const nbForProgram = require('../src/lib/note-buyer-for-program');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eqArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- A. canonicalNoteBuyer --------------------------------------------------
const canonCases = [
  ['EMCAP', 'emcap', 'EMCAP Financial'],
  ['emcap', 'emcap', 'EMCAP Financial'],
  ['EMCAP Financial', 'emcap', 'EMCAP Financial'],
  ['EMCAP Financial LLC', 'emcap', 'EMCAP Financial'],
  ['Fidelis', 'fidelis', 'Fidelis Investors LLC'],
  ['Fidelis Investors', 'fidelis', 'Fidelis Investors LLC'],
  ['Fidelis Investors LLC', 'fidelis', 'Fidelis Investors LLC'],
  ['Blue Lake', 'bluelake', 'Blue Lake Capital'],
  ['BlueLake', 'bluelake', 'Blue Lake Capital'],
  ['Blue Lake Capital', 'bluelake', 'Blue Lake Capital'],
  // A TRUNCATED typo of the name combines into Blue Lake (owner-reported 2026-08-12:
  // a stray note buyer "Blue L" showed as its own row).
  ['Blue L', 'bluelake', 'Blue Lake Capital'],
  ['Blue La', 'bluelake', 'Blue Lake Capital'],
  ['Blue Lak', 'bluelake', 'Blue Lake Capital'],
  ['RCN', 'rcn', 'RCN Capital'],
  ['RCN Capital', 'rcn', 'RCN Capital'],
];
for (const [raw, key, label] of canonCases) {
  const c = reg.canonicalNoteBuyer(raw);
  assert(c && c.key === key && c.label === label,
    `A canonicalNoteBuyer(${JSON.stringify(raw)}) → {${key}, "${label}"} (got ${JSON.stringify(c)})`);
}
// An UNKNOWN buyer keeps its own normalized key + trimmed label.
{
  const c = reg.canonicalNoteBuyer('CorrFirst');
  assert(c && c.key === 'corrfirst' && c.label === 'CorrFirst',
    `A CorrFirst is unknown here → keeps its own spelling (got ${JSON.stringify(c)})`);
  const z = reg.canonicalNoteBuyer('  Zephyr Capital  ');
  assert(z && z.key === 'zephyrcapital' && z.label === 'Zephyr Capital',
    'A an unknown buyer is trimmed but not renamed');
  // A DIFFERENT "Blue *" buyer must NOT be swept into Blue Lake — only a genuine
  // truncation of "bluelake" collapses (owner-reported 2026-08-12).
  const bl = reg.canonicalNoteBuyer('Blue Ledger Capital');
  assert(bl && bl.key === 'blueledgercapital' && bl.label === 'Blue Ledger Capital',
    'A "Blue Ledger Capital" is NOT collapsed into Blue Lake');
  const bare = reg.canonicalNoteBuyer('Blue');
  assert(bare && bare.key === 'blue' && bare.label === 'Blue',
    'A a bare "Blue" is too short to be a Blue Lake truncation');
}
for (const blank of [null, undefined, '', '   ', '!!!']) {
  assert(reg.canonicalNoteBuyer(blank) === null, `A a blank/junk value (${JSON.stringify(blank)}) → null`);
}
// Fidelity National (the title insurer) must NEVER read as Fidelis — the prefix
// diverges at the 6th character.
assert(reg.canonicalNoteBuyer('Fidelity National').key === 'fidelitynational',
  'A "Fidelity National" is NOT collapsed into Fidelis');

// ---- B. sameNoteBuyer -------------------------------------------------------
assert(reg.sameNoteBuyer('EMCAP', 'EMCAP Financial'), 'B "EMCAP" ≡ "EMCAP Financial"');
assert(reg.sameNoteBuyer('emcap financial', 'EMCAP'), 'B casing + long/short both collapse');
assert(reg.sameNoteBuyer('Blue Lake', 'Blue Lake Capital'), 'B "Blue Lake" ≡ "Blue Lake Capital"');
assert(reg.sameNoteBuyer('Fidelis', 'Fidelis Investors LLC'), 'B "Fidelis" ≡ "Fidelis Investors LLC"');
assert(!reg.sameNoteBuyer('EMCAP', 'Fidelis'), 'B two different buyers are never merged');
assert(!reg.sameNoteBuyer('EMCAP Financial', 'Blue Lake Capital'), 'B EMCAP ≠ Blue Lake');
assert(reg.sameNoteBuyer(null, 'EMCAP'), 'B a null side is "same" (nothing to compare)');
assert(reg.sameNoteBuyer('EMCAP', null), 'B a null side is "same" either way');
assert(reg.sameNoteBuyer(null, null), 'B two blanks are "same"');

// ---- C. the picker collapse (listNoteBuyers dedup, replicated) --------------
// A realistic mixed feed: ClickUp gives the long labels, the registry the short
// ones, the DB whatever stuck. They MUST collapse to one row per buyer.
{
  const feed = ['EMCAP Financial', 'EMCAP', 'Fidelis', 'Fidelis Investors LLC',
    'Blue Lake', 'Blue Lake Capital', 'RCN Capital', 'CorrFirst', 'corrfirst', 'Zephyr Capital'];
  const byKey = new Map();
  for (const label of feed) {
    const c = reg.canonicalNoteBuyer(label);
    if (!c) continue;
    if (!byKey.has(c.key)) byKey.set(c.key, { value: c.key, label: c.label });
  }
  const rows = [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  const labels = rows.map((r) => r.label);
  assert(eqArr(labels, ['Blue Lake Capital', 'CorrFirst', 'EMCAP Financial', 'Fidelis Investors LLC', 'RCN Capital', 'Zephyr Capital']),
    `C ten spellings collapse to six canonical rows (got ${JSON.stringify(labels)})`);
  // No buyer appears twice.
  assert(new Set(rows.map((r) => r.value)).size === rows.length, 'C every row is a distinct buyer key');
}

// ---- D. the bounce-back guard no longer churns on a spelling ----------------
// Before: "EMCAP" (file) vs "EMCAP Financial" (ClickUp) read as a change, so the
// guard kept "EMCAP" and re-pushed forever (a re-push of the same buyer no-ops, so
// the two never converged). Now it is recognized as the same buyer → nothing held.
{
  const keys = (a) => a.map((x) => x.field).sort();
  let r = guard.classifyConflicts(
    { lender: 'EMCAP Financial' }, { lender: 'EMCAP' }, { lender: 'EMCAP Financial' });
  assert(keys(r.kept).length === 0 && keys(r.conflicts).length === 0,
    'D "EMCAP" ≡ "EMCAP Financial" — no churn, nothing held, no false conflict');
  // A GENUINE buyer change the file made (ClickUp stale) is still KEPT.
  r = guard.classifyConflicts(
    { lender: 'EMCAP Financial' }, { lender: 'Fidelis Investors LLC' }, { lender: 'EMCAP Financial' });
  assert(eqArr(keys(r.kept), ['lender']) && keys(r.conflicts).length === 0,
    'D a real note-buyer edit (EMCAP → Fidelis) with ClickUp stale is KEPT, never bounced');
  // Both sides moved to different buyers → a real two-sided conflict → review.
  r = guard.classifyConflicts(
    { lender: 'Blue Lake Capital' }, { lender: 'Fidelis Investors LLC' }, { lender: 'EMCAP Financial' });
  assert(eqArr(keys(r.conflicts), ['lender']) && keys(r.kept).length === 0,
    'D both sides changed the note buyer to different buyers → a two-sided conflict (review)');
}

// ---- E. the free-dropdown note buyer is protected (→ manual review) ---------
{
  const free = enumGuard.protectedFreeColumns();
  const lender = free.find((c) => c.col === 'lender');
  assert(!!lender && !!lender.cu, 'E the note buyer is a protected FREE two-way dropdown');
  const cu = lender.cu;
  const options = { [cu]: [{ id: 'o1', name: 'EMCAP Financial' }, { id: 'o2', name: 'Fidelis Investors LLC' }] };

  // (1) PILOT holds a buyer ClickUp has NO option for → KEEP ours + flag (review).
  let held = enumGuard.unmappableOverwrites(
    { lender: 'EMCAP Financial' }, { lender: 'Zephyr Capital' }, options);
  assert(held.length === 1 && held[0].field === 'lender'
    && held[0].kept === 'Zephyr Capital' && held[0].incoming === 'EMCAP Financial',
    'E a note buyer ClickUp cannot hold is KEPT and flagged for manual review');
  assert(enumGuard.summarize(held).includes('Zephyr Capital'), 'E the review summary names the kept buyer');

  // (2) PILOT holds a buyer ClickUp CAN hold → normal sync (portal-edit-guard owns it).
  held = enumGuard.unmappableOverwrites(
    { lender: 'Fidelis Investors LLC' }, { lender: 'EMCAP Financial' }, options);
  assert(held.length === 0, 'E a note buyer with a matching ClickUp option is NOT held here (syncs normally)');

  // (3) same buyer, different spelling → not a change (no review, no churn).
  held = enumGuard.unmappableOverwrites(
    { lender: 'EMCAP Financial' }, { lender: 'EMCAP' }, options);
  assert(held.length === 0, 'E "EMCAP" vs "EMCAP Financial" is the same buyer → never flagged');

  // (4) a cold option cache → cannot prove unmappable → skip (never a false review).
  held = enumGuard.unmappableOverwrites(
    { lender: 'EMCAP Financial' }, { lender: 'Zephyr Capital' }, {});
  assert(held.length === 0, 'E with no ClickUp options (cold cache) the note buyer is never flagged');

  // (5) filling a blank is never a revert.
  held = enumGuard.unmappableOverwrites(
    { lender: 'EMCAP Financial' }, { lender: null }, options);
  assert(held.length === 0, 'E filling a blank note buyer is never held');

  // The pure enum-guard behavior for the crosswalked columns is unchanged: the
  // note buyer is the ONLY free two-way dropdown today.
  assert(free.filter((c) => c.col !== 'lender').length === 0,
    'E lender is the only free two-way dropdown protected (a future one is picked up automatically)');
}

// ---- F. ONE source of truth for the canonical labels ------------------------
assert(nbForProgram.LABEL_FOR_PROVIDER.emcap === reg.NOTE_BUYER_CANONICAL_LABEL.emcap
  && nbForProgram.LABEL_FOR_PROVIDER.fidelis === reg.NOTE_BUYER_CANONICAL_LABEL.fidelis
  && nbForProgram.LABEL_FOR_PROVIDER.bluelake === reg.NOTE_BUYER_CANONICAL_LABEL.bluelake,
  'F the Silver→EMCAP auto-link writes the SAME canonical label the picker offers');
assert(nbForProgram.noteBuyerForProgram('silver') === reg.canonicalNoteBuyer('EMCAP').label,
  'F a Silver file derives exactly the label a hand-picked EMCAP stores');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
