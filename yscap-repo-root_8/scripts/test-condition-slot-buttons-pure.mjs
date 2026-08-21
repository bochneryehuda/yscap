/* THE AUDIENCE IS THE BUTTON — a staff member opening a document slot for a document
   THEY have must not have to answer questions about the borrower first.

   Owner-reported 2026-08-21, verbatim: "In the conditions right now, you can request
   another doc, and it opens up another slot … but that is putting only a request,
   which is requesting it from the [borrower]. If you have a document that you want to
   put in a separate slot, I don't use that request button. Next to the request button,
   maybe add the feature: I just open a new document slot in this condition, and it
   should go together with that condition in the same folder and stuff like that."

   The SERVER has always been able to do this (`lib/conditions/extra-slots.js` has
   carried an `internal` audience since it shipped, and only an EXTERNAL ask sets
   status='requested' or notifies anybody — proven live in
   test-condition-extra-slots-db.js sections B1/B2 and B5-B8). What was missing was a
   way to reach it: one button, with the internal option behind two sequential confirm
   dialogs that only appeared on a borrower-facing condition.

   So this suite guards the REACHABILITY, which is the half that was broken, and it is
   a source read because that is what a source defect is:

     · both doors exist, and each names its audience as a LITERAL at the call site —
       an audience computed from a dialog answer is the shape that was replaced;
     · the internal door is UNCONDITIONAL — it must be there on a staff-only condition,
       which is exactly the condition the owner was standing on;
     · the external door is gated on the condition being borrower-facing — there is
       nobody to request from otherwise, and a button that quietly did something else
       would be the same confusion in a new place;
     · both places that render a condition row still mount it, or the feature exists
       and is invisible on one of the two screens.

   Pure — no React, no DOM, no browser, no DB. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (cond, what) => { if (cond) { console.log(`  ok  ${what}`); } else { failures++; console.error(`  FAIL ${what}`); } };

const screen = read('app-v2/src/screens/StaffApplication.jsx');

// The component's own body, so a match somewhere else on this 7,000-line screen can
// never stand in for one inside it.
const start = screen.indexOf('function RequestSlotButton(');
const end = screen.indexOf('\nfunction Item(', start);
ok(start > 0 && end > start, 'the slot-button component is where the two condition rows import it from');
const body = screen.slice(start, end);

console.log('\nA. two doors, and the audience is a literal at each one');

ok(/openSlot\('external'\)/.test(body), "the request door asks for the EXTERNAL audience by name");
ok(/openSlot\('internal'\)/.test(body), "the add-a-slot door asks for the INTERNAL audience by name");
ok(/const openSlot = async \(audience\)/.test(body),
  'both go through ONE ask, so the two doors can never drift in what they validate, refuse or say');

// The replaced shape: `let audience = 'internal'` re-bound from a confirm's answer.
// Anything that ASSIGNS to `audience` after the parameter is that shape coming back.
ok(!/\baudience\s*=\s*(?!=)/.test(body.replace(/openSlot = async \(audience\)/, '')),
  'the audience is never re-decided inside the component — pressing a button IS the whole choice');
ok(/api\.conditionSlotAdd\(appId, it\.id, \{ label: name, audience \}\)/.test(body),
  '…and the audience the button named is what reaches the server, unmodified');

console.log('\nB. who sees which door');

// The internal button must sit OUTSIDE the borrowerFacing guard. Read it structurally:
// the guarded region is the `{borrowerFacing && ( … )}` block.
const guarded = /\{borrowerFacing && \(([\s\S]*?)\n      \)\}/.exec(body);
ok(!!guarded, 'the external door is rendered inside a borrower-facing guard');
ok(guarded && /Request another document/.test(guarded[1]),
  '…and it is the REQUEST door that is guarded — there is nobody to request from on a staff-only condition');
ok(guarded && !/Add a document slot/.test(guarded[1]),
  'the ADD-A-SLOT door is NOT inside that guard — it is the one the owner needs on an internal condition');
ok(/Add a document slot/.test(body), '…and it is rendered');

// A staff-only condition would otherwise carry a button labelled as a borrower request
// that quietly did something else — the confusion this replaced.
ok(/const borrowerFacing = it\.audience === 'borrower' \|\| it\.audience === 'both';/.test(body),
  "borrower-facing means the condition's own audience, the same test the server applies");

console.log('\nC. the wording tells the truth about what each one does');

ok(/notified/.test(body) && /not notified/.test(body),
  'each door says whether the borrower hears about it — the difference between them');
ok(/same folder in the TPR export/.test(body),
  "both say the document stays part of this condition — the owner's \"it should go together with that condition in the same folder\"");

console.log('\nD. it is mounted on BOTH condition rows');

const mounts = screen.match(/<RequestSlotButton /g) || [];
ok(mounts.length === 2, `rendered on the internal row AND the borrower-facing row (found ${mounts.length})`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  condition slots: a staff member can open a slot without asking the borrower for anything');
process.exit(failures ? 1 : 0);
