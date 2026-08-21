/* A FILE DROPPED IN THE WRONG PLACE MUST NOT DESTROY THE PAGE
   (owner-reported 2026-08-21, item 6: dropping a document outside an upload zone
   "will close your file, explode it").

   That is the BROWSER'S DEFAULT, not one screen's bug: with nothing calling
   preventDefault on a `drop`, the tab NAVIGATES TO THE FILE and the whole app goes
   with it — a half-typed note, an open tool sheet, a condition mid-review — while the
   file is not uploaded either. app-v2 had no guard at all, so the app was safe on the
   few square inches that happen to be an upload zone and hostile everywhere else.

   The two properties that matter, and they pull against each other:
     1. a drop NOBODY wanted is stopped, and said out loud;
     2. a drop a real zone HANDLED is never touched — the guard must not eat an upload.

   Pure — a fake window, no browser, no DB. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let fail = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) fail++; };

// A minimal window that records what was registered and can dispatch to it.
const handlers = {};
globalThis.window = {
  addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
  removeEventListener: (t, fn) => { handlers[t] = (handlers[t] || []).filter((f) => f !== fn); },
};

const G = await import('../app-v2/src/lib/stray-drop-guard.js');

let told = 0;
const uninstall = G.installStrayDropGuard(() => { told += 1; });

ok(typeof handlers.dragover?.[0] === 'function', 'a dragover listener is registered');
ok(typeof handlers.drop?.[0] === 'function', 'a drop listener is registered');

/* dragover MUST be prevented too, and that is not decoration: a browser only fires
   `drop` on a target whose dragover was prevented, so without it the drop never
   reaches the guard and the tab navigates anyway. */
const evt = (over, opts = {}) => ({
  dataTransfer: opts.noDataTransfer ? null
    : { types: 'types' in opts ? opts.types : ['Files'] },
  defaultPrevented: !!opts.defaultPrevented,
  preventDefault() { this.defaultPrevented = true; },
  _kind: over,
});

let e = evt('dragover');
handlers.dragover[0](e);
ok(e.defaultPrevented, 'a file dragged over the page is prevented — without this no drop event ever fires');

// ---- 1. THE STRAY DROP ------------------------------------------------------
told = 0;
e = evt('drop');
handlers.drop[0](e);
ok(e.defaultPrevented, 'A STRAY DROP IS STOPPED — the browser never navigates to the file');
ok(told === 1, '…and the person is told, because a drop that silently does nothing reads as broken');

// ---- 2. A REAL UPLOAD IS NEVER TOUCHED --------------------------------------
// A zone that handled the drop has already called preventDefault (the shared hook
// does, on the same native event), so the guard must stand completely down.
told = 0;
e = evt('drop', { defaultPrevented: true });
handlers.drop[0](e);
ok(told === 0, 'A DROP A REAL ZONE HANDLED IS LEFT ALONE — the guard never eats an upload, and never nags about one');

// ---- 3. IT ONLY REACTS TO FILES ---------------------------------------------
// Dragging text or a link inside the page is ordinary interaction, not a lost upload.
for (const c of [{ types: ['text/plain'] }, { types: [] }, { types: undefined }, { noDataTransfer: true }]) {
  told = 0;
  e = evt('drop', c);
  handlers.drop[0](e);
  ok(!e.defaultPrevented && told === 0,
    `dragging ${c.noDataTransfer ? 'an event with no dataTransfer at all' : JSON.stringify(c.types)} is ignored — only FILES are a lost upload`);
}
e = evt('dragover', { types: ['text/plain'] });
handlers.dragover[0](e);
ok(!e.defaultPrevented, '…and a non-file drag is not prevented either, so text drag-and-drop still works');

// ---- 4. IT CANNOT BREAK THE APP ---------------------------------------------
told = 0;
const hostile = { get dataTransfer() { throw new Error('hostile'); }, preventDefault() {} };
let threw = null;
try { handlers.drop[0](hostile); } catch (err) { threw = err; }
ok(threw === null, 'an unreadable event never throws out of the listener');
{
  // A notifier that throws must not take the page down with it either.
  uninstall();
  const un2 = G.installStrayDropGuard(() => { throw new Error('bad notifier'); });
  let t2 = null;
  const ev2 = evt('drop');
  try { handlers.drop[0](ev2); } catch (err) { t2 = err; }
  ok(t2 === null, 'a notifier that throws is contained…');
  ok(ev2.defaultPrevented, '…and the page is STILL protected, which is the half that matters');
  un2();
}

// ---- 5. INSTALLED ONCE ------------------------------------------------------
{
  const before = (handlers.drop || []).length;
  const a = G.installStrayDropGuard(() => {});
  const b = G.installStrayDropGuard(() => {});
  ok((handlers.drop || []).length === before + 1,
    'installing twice registers ONE listener — a second would double the message');
  a(); b();
}

// ---- 6. IT IS ACTUALLY WIRED IN ---------------------------------------------
// A guard nobody installs is worth nothing, and this is the kind of wiring a
// refactor drops silently.
{
  const main = read('app-v2/src/main.jsx');
  ok(/installStrayDropGuard\(/.test(main), 'the app installs it at start-up');
  ok(/from '\.\/lib\/stray-drop-guard\.js'/.test(main), '…from the shared module, not a copy');
  ok(/showMessage\(/.test(main), '…and tells the user in PILOT\'s own words, never a browser dialog');
}

// ---- 7. THE SWEEP: dragged files reach the same upload the button uses -------
// Owner item 6: "a lot of the uploads are missing the drag and drop option. You can
// only click and upload… Please dig in." These are the zones converted so far; the
// guard above is what makes the ones NOT yet converted merely useless rather than
// destructive.
console.log('\n7. the converted upload zones');
{
  const zones = [
    ['components/ChatThread.jsx', 'the message attachment (staff, borrower and broker all share it)'],
    ['components/CreditReport.jsx', 'the credit report import'],
    ['components/AppraisalPanel.jsx', 'the appraisal XML import'],
    ['screens/StaffLeadDetail.jsx', 'lead files'],
    // ---- the 2026-08-21 sweep: everything the task list still listed as click-only ----
    ['components/EmailCenter.jsx', 'the email compose box — every reply surface shares it (item 5)'],
    ['components/DrawsPanel.jsx', 'the draw desk: the manual wire form + the supporting documents'],
    ['components/BorrowerDraws.jsx', 'the borrower’s own draw uploads (three of them)'],
    ['screens/TpoFile.jsx', 'the broker portal’s uploads — per condition and unattached'],
    ['screens/StaffPurchasing.jsx', 'the purchase advice'],
    ['screens/StaffNewFile.jsx', 'the new-file MISMO import'],
    ['screens/StaffLabelingConsole.jsx', 'the labeling console'],
    ['components/arena/ArenaChallenges.jsx', 'the Arena proof photo'],
  ];
  for (const [f, what] of zones) {
    const body = read(`app-v2/src/${f}`);
    ok(/<DropZone/.test(body) && /DropZone\.jsx'/.test(body), `${what} accepts a dragged file`);
  }
  const dz = read('app-v2/src/components/DropZone.jsx');
  ok(/useFileDrop/.test(dz), 'DropZone wraps the ONE shared hook rather than re-implementing it');
}

// A credit report is TWO files; dropping both at once must fill both slots. Asserted
// from SOURCE: the component imports React, which is absent where app-v2's deps are
// not installed (CI runs there).
console.log('\n8. a credit report arrives as two files');
{
  const src = read('app-v2/src/components/CreditReport.jsx');
  ok(/export function sortCreditDrop/.test(src), 'one shared rule decides which slot a dropped file belongs in');
  ok(/endsWith\('\.xml'\)/.test(src) && /endsWith\('\.pdf'\)/.test(src),
    '…by the file KIND, so both halves land correctly whichever order they were dropped');
  // CALL sites only — the `export function sortCreditDrop(files, put)` declaration
  // matches the same text, which is why this excludes it rather than counting blind.
  const calls = (src.match(/(?<!function )sortCreditDrop\(files/g) || []).length;
  ok(calls === 2, `…used by BOTH the one-borrower and the per-borrower shapes (found ${calls})`);
}

console.log(`\n${fail === 0 ? 'ALL' : 'SOME'} stray-drop assertions: ${fail} failed`);
process.exit(fail ? 1 : 0);
