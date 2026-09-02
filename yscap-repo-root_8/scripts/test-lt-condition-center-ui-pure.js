#!/usr/bin/env node
/**
 * The Long-Term Condition Center's own UI guards.
 *
 * These are SOURCE guards on `app-v2/src/longterm/**`. They exist because the
 * defects they pin are invisible to a build: an over-clipped popup, a control
 * offered on a file it does not belong to, and a form field wired to the wrong
 * writer all compile perfectly and are only wrong on screen.
 *
 * Every "must not appear" assertion runs against the COMMENT-STRIPPED source —
 * the code that removes a trap necessarily NAMES it in a comment, and a guard
 * that read comments would fail on its own explanation and then get "fixed" by
 * deleting the explanation (the lesson `test-staff-view-pure.js` records).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Strip /* *\/ and // comments so a guard never reads its own explanation. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(detail ? `${name} — ${detail}` : name);
}

// ── A. The "More ▾" menu may never be clipped ───────────────────────────────
// Owner-reported 2026-08-31: "When you click on the More button and the
// conditions, it pops up all the things below, and it gets cut off."
// ROOT CAUSE: the condition card wrapped the row AND its expanded body in
// `overflow:hidden`, and `.cond-more-menu` is a `position:absolute` popup drawn
// INSIDE that body — so the card's own edge cut the options off. Measured in a
// real browser against the built stylesheet: the menu ran 333px past the card
// and `elementFromPoint` on the last option hit the page, not the option.
{
  const src = stripComments(read('app-v2/src/longterm/LtFileConditions.jsx'));

  ok('LtFileConditions renders the shared More menu',
    /ConditionActions/.test(src));

  // No inline overflow clip anywhere in the file. A clip on ANY ancestor of the
  // popup reproduces the bug, and every container in this file is one.
  const clips = src.match(/overflow[^,;}\n]*['"]hidden['"]/g) || [];
  ok('no inline overflow:hidden survives in the condition card',
    clips.length === 0,
    `found ${clips.length}: ${clips.join(' | ')}`);

  // And the class-based escape hatch must not be used here either.
  ok('the condition card does not opt into the flush (clipping) card class',
    !/lt-card-flush/.test(src));
}

// ── B. The stylesheet's own popup contract ──────────────────────────────────
// The menu is positioned relative to its `<details>`, so it can only ever be
// clipped by an ancestor — which is why the guard above is on the ancestor and
// not on the menu.
{
  const css = read('app-v2/src/styles.css');
  ok('.cond-more is the positioning context', /\.cond-more\{[^}]*position:relative/.test(css));
  ok('.cond-more-menu is an absolutely-positioned popup',
    /\.cond-more-menu\{[^}]*position:absolute/.test(css));
}

// ── C. A CONDITION RENDERS AS WHAT IT IS ────────────────────────────────────
// Owner-reported 2026-08-31: *"The file contacts condition has an upload slot.
// This is not the intent"* and *"Title ordered and insurance ordered now have a
// file upload. This is a different kind of condition."*
// ROOT CAUSE: the library has carried `kind` on every condition since it was
// written — `form` on the contacts, `order` on the six orders — and the renderer
// read NONE of it, so all three drew the same drop zone.
{
  const src = stripComments(read('app-v2/src/longterm/LtFileConditions.jsx'));

  ok('the renderer reads the condition KIND', /kind === 'form'/.test(src) && /kind === 'order'/.test(src));

  // The drop zone must be GATED, not merely present somewhere in the file.
  // Pinning the mere presence of `isForm` would pass on a version that computed
  // it and never used it — which is the same bug wearing a variable name.
  ok('the drop zone is gated on the kind',
    /\{!isForm && !isOrder \? \(\s*<DropZone/.test(src),
    'the DropZone is not guarded by the kind flags');

  ok('a form and an order mount their own body',
    /<LtConditionContacts/.test(src) && /<LtConditionOrder/.test(src));

  // A document that IS on a form or an order is still shown — hiding evidence is
  // worse than an upload box that should not be there.
  ok('a document already on a form or an order is still shown',
    /\(!isForm && !isOrder\) \|\| docs\.length > 0/.test(src));
}

// ── D. THE ORDER CONDITION MOUNTS THE ORDERS DESK'S OWN CARD ────────────────
// *"it follows the exact thing that happens in the order section: it actually
// pops up the draft and stuff like that."* Two cards would be two previews of
// one letter, and the one that drifts is the one somebody sends.
{
  const src = stripComments(read('app-v2/src/longterm/LtConditionOrder.jsx'));
  ok('it imports the desk\'s OrderCard rather than drawing one',
    // `openLoanSection` rides on the same import: the rent order's card sends
    // people to the Verification of rent section (audit 2026-09-02, B1).
    /import \{ OrderCard(?:, \w+)* \} from '\.\/LtOrders\.jsx'/.test(src));
  ok('it does not define a card of its own',
    !/function OrderCard/.test(src));
  ok('it self-hides on a condition that is not an order',
    /if \(!kind\) return null;/.test(src));
  ok('an order the desk does not carry is SAID, not hidden',
    /does not\s*\n?\s*carry that order|does not carry/.test(src));

  const orders = stripComments(read('app-v2/src/longterm/LtOrders.jsx'));
  ok('OrderCard is exported for exactly that reason', /export function OrderCard/.test(orders));
}

// ── E. THE CONTACTS DESK IS THE SHORT-TERM ONE ──────────────────────────────
// *"Bring over the entire file contact … it should not copy. It should be the
// same, should be the exact same vendor setup and use the same information."*
{
  const src = stripComments(read('app-v2/src/longterm/LtFileContacts.jsx'));
  ok('the long-term contacts desk mounts the SHARED component',
    /import FileContacts from '\.\.\/components\/FileContacts\.jsx'/.test(src));
  ok('it passes its own adapter rather than branching inside the component',
    /adapter=\{adapter\}/.test(src) && /list:/.test(src) && /suggest:/.test(src));
  ok('it carries the long-term vocabulary', /ny_settlement_agent/.test(src) && /landlord/.test(src));

  // No second contacts screen anywhere under app-v2/src/longterm.
  const fs2 = require('fs');
  const dir = path.join(ROOT, 'app-v2/src/longterm');
  const rogue = fs2.readdirSync(dir)
    .filter((f) => f.endsWith('.jsx') && f !== 'LtFileContacts.jsx' && f !== 'LtConditionContacts.jsx')
    .filter((f) => /contact/i.test(stripComments(fs2.readFileSync(path.join(dir, f), 'utf8'))
      .match(/function\s+\w*Contact\w*/g) ? 'yes' : ''));
  ok('no second contacts screen was grown on the long-term side', rogue.length === 0, rogue.join(', '));
}

// ── F. THE CONTACT FORM WRITES THE LOAN'S REAL CONTACT ──────────────────────
// *"I know all the orders are automatically a problem because the FileContacts
// is one dummy, and the orders are not linked to the correct FileContacts, so
// you can't even send it out."* The form is only worth anything if it writes the
// row the ORDER reads — nothing stored on the condition would satisfy anything.
{
  const src = stripComments(read('app-v2/src/longterm/LtConditionContacts.jsx'));
  for (const verb of ['orderVendorLink', 'orderVendorCreate', 'orderVendorSearch', 'orderVendorUnlink']) {
    ok(`the contact form uses ${verb} — the loan's own contact record`, src.includes(verb));
  }
  ok('the flood agent can be taken from the hazard agent in one click',
    /SAME_AS[\s\S]{0,200}flood_insurance[\s\S]{0,120}hazard_insurance/.test(src));
  ok('…by LINKING the same directory card, never copying its details',
    /link\(source\.serviceContactId\)/.test(src));
  ok('a contact that does not belong to this file is greyed, not dropped',
    /applies === false/.test(src) && /opacity/.test(src));
  ok('and "we cannot tell" is drawn differently from "no"',
    /applies === null/.test(src));
  ok('no --ink token is used as a text colour (it is a LIGHT paper colour)',
    !/color:\s*['"`]?var\(--ink/.test(src));
}

if (fails.length) {
  console.error(`\n${fails.length} FAILED:`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${pass} checks passed`);
