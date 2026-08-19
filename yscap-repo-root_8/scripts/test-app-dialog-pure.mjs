/* PILOT'S OWN MESSAGE BOX — the safety properties (owner-reported 2026-08-06:
   clicking Sign off on a credit condition produced a dialog titled
   "yscap.onrender.com says", so PILOT's own carefully worded refusal was
   presented as if it came from a hosting provider).

   The one thing that MUST hold: a message is never swallowed. Branding is worth
   nothing if the price is a refusal the user never sees, so with no host mounted
   the module falls back to the browser's own dialog. These are the properties a
   render check cannot see.

   Pure — a fake `window`, no browser, no DB. */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) failures++; };

// The module reaches for `window` only on the fallback path.
const alerts = [];
const confirms = [];
let confirmAnswer = true;
globalThis.window = {
  prompt: (m, d) => null,
  alert: (m) => { alerts.push(m); },
  confirm: (m) => { confirms.push(m); return confirmAnswer; },
};

const dlg = await import('../app-v2/src/lib/dialog.js');

// ---------------------------------------------------------------------------
// A. NO HOST MOUNTED → the browser's dialog, immediately. Never queued, never
//    swallowed. This is the property that makes the whole change safe.
// ---------------------------------------------------------------------------
await dlg.showMessage('the file is not ready');
ok(alerts.length === 1 && alerts[0] === 'the file is not ready',
  'no host: the message falls back to the browser rather than vanishing');

await dlg.showMessage('body text', { title: 'PILOT can’t do that yet' });
ok(/PILOT can’t do that yet\n\nbody text/.test(alerts[1]),
  'no host: the title rides along in the fallback (a native dialog has none of its own)');

confirmAnswer = false;
const answered = await dlg.askConfirm('really?');
ok(answered === false && confirms.length === 1,
  'no host: a question falls back to the browser AND returns the real answer');
confirmAnswer = true;
ok((await dlg.askConfirm('really?')) === true, 'no host: a yes is returned as true');

// ---------------------------------------------------------------------------
// B. WITH A HOST → the host renders it, the browser is never touched, and the
//    promise settles only when the person answers.
// ---------------------------------------------------------------------------
const beforeNative = alerts.length + confirms.length;
let shown = null;
const unsubscribe = dlg.subscribeDialog((req) => { shown = req; });

let settled = false;
const p = dlg.showMessage('a branded message');
p.then(() => { settled = true; });
await Promise.resolve();

ok(shown && shown.message === 'a branded message', 'host: the request reaches the host');
ok(shown && shown.kind === 'alert', 'host: it is tagged as a message, not a question');
ok(alerts.length + confirms.length === beforeNative,
  'host: the browser dialog is NOT used when PILOT can draw its own');
ok(settled === false, 'host: the promise is still open while the box is on screen');

dlg.resolveTop(undefined);
await p;
ok(settled === true, 'host: answering settles the promise');
ok(shown === null, 'host: with nothing queued the host is told to render nothing');

// A question returns what the person actually clicked.
const q = dlg.askConfirm('delete it?', { confirmLabel: 'Delete' });
await Promise.resolve();
ok(shown && shown.kind === 'confirm' && shown.confirmLabel === 'Delete',
  'host: a question carries its own button wording');
dlg.resolveTop(true);
ok((await q) === true, 'host: the answer travels back to the caller');

// Two messages in a row: the second waits its turn rather than replacing the
// first — a refusal must never be overwritten before it has been read.
const first = dlg.showMessage('first');
const second = dlg.showMessage('second');
await Promise.resolve();
ok(shown && shown.message === 'first', 'host: the first message is the one on screen');
dlg.resolveTop(undefined);
await first;
ok(shown && shown.message === 'second', 'host: the queued message follows, never lost');
dlg.resolveTop(undefined);
await second;

// Unmounting returns to the fallback rather than stranding messages.
unsubscribe();
const nativeBefore = alerts.length;
await dlg.showMessage('after unmount');
ok(alerts.length === nativeBefore + 1,
  'host removed: messages fall back to the browser again (never stranded)');

// ---------------------------------------------------------------------------
// C. THE MIGRATION IS COMPLETE — no portal screen still raises a browser alert,
//    which is the thing the owner actually saw. A source check, because a single
//    missed call site reproduces the bug on that one screen.
// ---------------------------------------------------------------------------
function jsxFiles(dir, out = []) {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) jsxFiles(p, out);
    else if (e.name.endsWith('.jsx')) out.push(p);
  }
  return out;
}
const offenders = [];
for (const f of jsxFiles('app-v2/src')) {
  const src = read(f);
  // `window.alert(` or a bare `alert(`. NO whitespace before the paren, on
  // purpose: a call never has one, while ordinary English does — the first cut
  // of this check flagged the label "No-draw alert (days)" as a call site.
  if (/\bwindow\.alert\(/.test(src) || /(^|[^\w.$])alert\(/m.test(src)) offenders.push(f);
}
ok(offenders.length === 0,
  `no portal screen raises a browser alert() any more${offenders.length ? ` — still: ${offenders.join(', ')}` : ''}`);

// ---------------------------------------------------------------------------
// C2. THE CONFIRM MIGRATION, AND THE ONE WAY IT CAN GO CATASTROPHICALLY WRONG.
//     `askConfirm` returns a PROMISE. A promise is truthy. So a call site that
//     forgets the `await` reads as "the user said yes" on EVERY click and fires
//     the destructive action nobody agreed to — silently, with a green build.
//     These three guards are what make the migration safe to keep.
// ---------------------------------------------------------------------------
const jsAndJsx = (dir, out = []) => {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) jsAndJsx(p, out);
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
};
const portalFiles = jsAndJsx('app-v2/src').filter((f) => !f.endsWith('app-v2/src/lib/dialog.js'));

// (1) Nothing raises the browser's own confirm any more. dialog.js is excluded
//     because its no-host fallback is deliberate — see the header there.
const nativeConfirm = portalFiles.filter((f) => /\bwindow\.confirm\(/.test(read(f)));
ok(nativeConfirm.length === 0,
  `no portal screen raises a browser confirm() any more${nativeConfirm.length ? ` — still: ${nativeConfirm.join(', ')}` : ''}`);

// (2) EVERY askConfirm call is awaited. This is the guard that matters: an
//     un-awaited call is the "always yes" bug, and nothing else catches it —
//     not the build (a promise is a valid expression), not eslint, not a render.
const unawaited = [];
for (const f of portalFiles) {
  const src = read(f);
  for (const m of src.matchAll(/(.{0,12})\baskConfirm\s*\(/g)) {
    const before = m[1];
    if (/await\s+$/.test(before)) continue;            // the correct form
    if (/[.\w$]$/.test(before.trimEnd())) continue;    // a property/import mention, not a call
    unawaited.push(`${f}: …${m[0].trim()}`);
  }
}
ok(unawaited.length === 0,
  `every askConfirm call is awaited — an un-awaited one reads as "yes" on every click${unawaited.length ? `\n     ${unawaited.join('\n     ')}` : ''}`);

// ---------------------------------------------------------------------------
// C3. THE PROMPT, whose danger is different from the confirm's. `window.prompt`
//     answers TWO ways — a string (possibly '') when they typed and submitted,
//     and null when they CANCELLED — and real call sites here branch on that
//     difference: EncompassSyncPanel returns SILENTLY on null and shows "Add a
//     short reason" on ''. Collapse the two and you scold somebody for backing
//     out. So the contract is asserted, not assumed.
// ---------------------------------------------------------------------------
const nativePrompt = portalFiles.filter((f) => /\bwindow\.prompt\s*\(/.test(read(f)));
ok(nativePrompt.length === 0,
  `no portal screen raises a browser prompt() any more${nativePrompt.length ? ` — still: ${nativePrompt.join(', ')}` : ''}`);

const unawaitedPrompt = [];
for (const f of portalFiles) {
  for (const m of read(f).matchAll(/(.{0,12})\baskPrompt\s*\(/g)) {
    const before = m[1];
    if (/await\s+$/.test(before)) continue;
    if (/[.\w$]$/.test(before.trimEnd())) continue;
    unawaitedPrompt.push(`${f}: …${m[0].trim()}`);
  }
}
ok(unawaitedPrompt.length === 0,
  `every askPrompt call is awaited${unawaitedPrompt.length ? `\n     ${unawaitedPrompt.join('\n     ')}` : ''}`);

const missingPromptImport = portalFiles.filter((f) => {
  const src = read(f);
  if (!/\baskPrompt\s*\(/.test(src)) return false;
  const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\bdialog\.js['"]/);
  return !imp || !/\baskPrompt\b/.test(imp[1]);
});
ok(missingPromptImport.length === 0,
  `every file calling askPrompt imports it${missingPromptImport.length ? ` — missing in: ${missingPromptImport.join(', ')}` : ''}`);

// The two-valued answer, end to end through the host.
let shownP = null;
const unsubP = dlg.subscribeDialog((r) => { shownP = r; });

const p1 = dlg.askPrompt('why?', { defaultValue: 'seed' });
await Promise.resolve();
ok(shownP && shownP.kind === 'prompt' && shownP.defaultValue === 'seed',
  'host: a prompt reaches the host carrying its default value');
dlg.resolveTop('a typed reason');
ok((await p1) === 'a typed reason', 'host: a typed answer comes back verbatim');

const p2 = dlg.askPrompt('why?');
await Promise.resolve();
dlg.resolveTop(null);                       // what Cancel / Escape / backdrop send
ok((await p2) === null, 'host: CANCEL answers null — never an empty string');

const p3 = dlg.askPrompt('why?');
await Promise.resolve();
dlg.resolveTop('');                         // submitted with the box empty
const p3v = await p3;
ok(p3v === '' && p3v !== null,
  'host: an EMPTY SUBMISSION answers "" — a different answer from cancel, and callers rely on it');
unsubP();

// With no host it must be the browser's own prompt, and its null must survive.
const nativeAnswers = [];
const realPrompt = window.prompt;
window.prompt = (m, d) => { nativeAnswers.push([m, d]); return null; };
ok((await dlg.askPrompt('fallback?', { defaultValue: 'x' })) === null,
  'no host: a prompt falls back to the browser AND its cancel stays null');
ok(nativeAnswers.length === 1 && nativeAnswers[0][1] === 'x',
  'no host: the default value is handed to the browser dialog too');
window.prompt = realPrompt;

// (3) Every file that CALLS it also IMPORTS it. esbuild emits an undeclared
//     identifier verbatim, so a missing import builds clean and then throws
//     ReferenceError at click time — which the ErrorBoundary turns into the
//     full-screen "Something went wrong". Seven files hit exactly this while
//     the migration was being written, because they already imported
//     showMessage and the import step skipped them.
const missingImport = portalFiles.filter((f) => {
  const src = read(f);
  if (!/\baskConfirm\s*\(/.test(src)) return false;
  // NOTE the path is matched loosely: a module inside lib/ imports its sibling
  // as './dialog.js', with no 'lib/' in the specifier at all.
  const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\bdialog\.js['"]/);
  return !imp || !/\baskConfirm\b/.test(imp[1]);
});
ok(missingImport.length === 0,
  `every file calling askConfirm imports it${missingImport.length ? ` — missing in: ${missingImport.join(', ')}` : ''}`);

// The host must be mounted, or every message silently takes the fallback and
// nothing is branded at all.
const app = read('app-v2/src/App.jsx');
ok(/<AppDialogHost\s*\/>/.test(app), 'the dialog host is mounted in the app shell');
ok(app.indexOf('<AppDialogHost') < app.indexOf('<ErrorBoundary'),
  'the host sits OUTSIDE the error boundary, so a crashing screen cannot take it down');

// The hard rule: never an --ink* token for text colour (they are LIGHT paper
// colours in this palette and render white-on-white).
const dialogJsx = read('app-v2/src/components/AppDialog.jsx');
ok(!/color:\s*['"]?var\(--ink/.test(dialogJsx), 'no --ink* token is used as a text colour');

// ---------------------------------------------------------------------------
// D. THE TITLE NEVER CLAIMS FAILURE BY DEFAULT (owner-reported 2026-08-19).
// showMessage('Saved.') used to render under "PILOT can't do that yet" because
// the alert title defaulted to the failure headline unless the caller
// remembered tone:'info'. The rule is now: the failure headline appears ONLY on
// an explicit tone:'error'. This reads the source because the component needs a
// DOM to run; the expression is small enough to pin textually, and a rewrite
// that reintroduces "anything not info is an error" fails here.
{
  const src = read('app-v2/src/components/AppDialog.jsx');
  ok(/tone === 'error'/.test(src),
    'the failure headline is opt-in: only an explicit tone:\'error\' produces it');
  ok(!/tone !== 'info'/.test(src),
    'the old backwards default ("anything not info is an error") is gone');
}

console.log(failures ? `\n${failures} failed` : '\nALL app-dialog assertions passed');
process.exit(failures ? 1 : 0);
