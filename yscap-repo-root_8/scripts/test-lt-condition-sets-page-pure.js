'use strict';
/**
 * THE PUBLISHED CONDITION LIST CANNOT GO STALE — the guard on the generator.
 *
 * Owner-directed 2026-08-31: *"Look for missing conditions from the original
 * list."* Nothing was missing from the FILE; what had drifted was the LIST. It
 * showed three condo documents where the owner's own condo letter asks for four
 * — the bylaws had been added to the library and never to the page — and it had
 * never heard of the payoff contact added since. Both are exactly the failure
 * this repo's "generate, don't hand-maintain" rule exists to stop, so the page
 * is derived now and this is what keeps it honest.
 *
 * It checks BOTH WAYS, like the parity ledger: a condition or a document slot
 * the page does not name fails the build (that is the whole point), and an
 * entry in the generator's two hand-written tables that names a condition no
 * longer in the library fails too — so a row cannot sit there describing
 * something that is gone.
 *
 * PURE: it builds the page in memory. No database, no network.
 */
const gen = require('../src/longterm/conditions-center/page/build');
const lib = require('../src/longterm/conditions-center/library');
const registry = require('../src/longterm/conditions-center/field-registry');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const html = gen.build();
const text = html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const all = [...lib.PRIOR_TO_SUBMISSION, ...lib.PRIOR_TO_CTC];

/* ═══ A. EVERY CONDITION IS ON THE PAGE ════════════════════════════════════ */

const missing = all.filter((c) => !text.includes(c.label));
assert(missing.length === 0,
  `A1 every condition in the library is named on the page${missing.length ? ` — MISSING: ${missing.map((c) => c.code).join(', ')}` : ` (${all.length})`}`);
assert(all.length >= 28,
  `A2 …and there are at least the 28 the owner's own list named (${all.length})`);

/* ═══ B. EVERY DOCUMENT SLOT IS ON THE PAGE ════════════════════════════════
   This is the one that would have caught the condo bylaws: the condition was
   named, its wording was right, and one of the four documents it asks for was
   simply not on the page — which reads as "we ask for three". */

const slotMisses = [];
for (const c of all) {
  for (const s of c.slots || []) if (!text.includes(s.label)) slotMisses.push(`${c.code}:${s.label}`);
}
assert(slotMisses.length === 0,
  `B1 every document slot is named on the page${slotMisses.length ? ` — MISSING: ${slotMisses.join(', ')}` : ''}`);

/* ═══ C. THE COUNTS ARE THE LIBRARY'S OWN ═════════════════════════════════ */

const t = gen.tally(all);
assert(text.includes(`${t.total} conditions across both gates`),
  `C1 the headline count is the real one (${t.total})`);
assert(text.includes(`${t.borrower} the borrower sees`) && text.includes(`${t.internal} internal only`),
  `C2 …and so are the two beside it (${t.borrower} / ${t.internal})`);
for (const [name, list] of [['prior to submission', lib.PRIOR_TO_SUBMISSION], ['prior to clear to close', lib.PRIOR_TO_CTC]]) {
  const g = gen.tally(list);
  assert(text.includes(`${g.total} conditions`), `C3 the ${name} gate counts its own (${g.total})`);
}

/* ═══ D. THE TWO HAND-WRITTEN TABLES CANNOT ROT ═══════════════════════════ */

const codes = new Set(all.map((c) => c.code));
const staleWays = Object.keys(gen.WAYS).filter((k) => !codes.has(k));
assert(staleWays.length === 0,
  `D1 no "answered another way" blurb names a condition that no longer exists${staleWays.length ? ` — STALE: ${staleWays.join(', ')}` : ''}`);
const kinds = [...new Set(all.map((c) => c.kind))];
const unhelped = kinds.filter((k) => !gen.CHIP_HELP[k]);
assert(unhelped.length === 0,
  `D2 every kind of condition has its tag wording, so a new one cannot render blank${unhelped.length ? ` — MISSING: ${unhelped.join(', ')}` : ` (${kinds.join(', ')})`}`);

/* ═══ E. "WHICH FILES GET IT" IS WRITTEN FOR A PERSON ═════════════════════
   The published page said "Applies to in_flood_zone is yes" on four conditions
   and "It is a refinance is yes" on the rest — one sentence written two ways,
   because half of it was typed by hand. A raw field key must never reach the
   page again. */

const usedFields = new Set();
for (const c of all) for (const r of (c.rule && c.rule.rules) || []) usedFields.add(r.field);
const unlabelled = [...usedFields].filter((k) => {
  const f = (registry.FIELDS || []).find((x) => x.key === k);
  return !(f && f.label);
});
assert(unlabelled.length === 0,
  `E1 every rule field the library uses has a human label${unlabelled.length ? ` — RAW: ${unlabelled.join(', ')}` : ` (${usedFields.size} fields)`}`);
const leakedKeys = [...usedFields].filter((k) => new RegExp(`Applies to</span> [^<]*\\b${k}\\b`).test(html));
assert(leakedKeys.length === 0,
  `E2 …and no raw key reaches an "Applies to" line${leakedKeys.length ? ` — LEAKED: ${leakedKeys.join(', ')}` : ''}`);

/* ═══ F. AN INTERNAL CONDITION SHOWS NO BORROWER WORDING ══════════════════ */

const cards = html.split('<article class="cond">').slice(1);
assert(cards.length === all.length, `F1 one card per condition (${cards.length})`);
/* ASKED OF THE RULE, NOT OF TODAY'S DATA. Every internal condition in the
   library happens to carry no borrower wording, so checking the real cards
   proves nothing — a renderer that printed borrower wording on an internal card
   would sail through it, which a mutation confirmed. So the renderer is handed
   an internal condition that DOES carry borrower wording: the one shape that
   can actually leak. */
const synthetic = gen.card({
  code: 'lt_synthetic_internal', label: 'A synthetic internal condition',
  hint: 'Internal only, but carrying borrower wording somebody left on it.',
  borrowerLabel: 'WORDING THAT MUST NOT APPEAR', audience: 'internal', kind: 'document', slots: [],
});
assert(!/They see it as|WORDING THAT MUST NOT APPEAR/.test(synthetic),
  'F2 an internal-only condition prints no borrower wording, even when the row carries some');
assert(/Internal only/.test(synthetic), 'F3 …and it is tagged internal only');
const shown = gen.card({
  code: 'lt_synthetic_shared', label: 'A synthetic shared condition', hint: 'Both see it.',
  borrowerLabel: 'WHAT THEY SEE', audience: 'both', kind: 'document', slots: [],
});
assert(/They see it as/.test(shown) && /WHAT THEY SEE/.test(shown),
  'F4 …while a condition the borrower DOES see prints their own wording (the control)');

console.log(failures ? `\nFAILED ${failures} assertion(s)` : '\nOK test-lt-condition-sets-page-pure (all assertions passed)');
process.exit(failures ? 1 : 0);
