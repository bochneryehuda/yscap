/**
 * THE CLOCK IS ON ALL FOUR SENDS, AND IT IS ONE CONTROL (owner-directed 2026-08-20).
 *
 * "For the order emails … title orders, insurance orders, or even investor
 * delivery, anything that you're sending out an email for, also closing prep …
 * just add an additional option with the small icon, like a time to schedule the
 * email instead of ordering it immediately."
 *
 * A pure source test, because the thing worth guarding here is STRUCTURAL: that
 * every send surface mounts the SAME control rather than growing its own, and
 * that the queued/failed banner is on every one of them. A rendering test would
 * prove one screen looks right; this proves the four cannot drift apart.
 *
 * It also carries the two traps this repo has been bitten by before and which a
 * green `npm run build` does NOT catch: a `--ink*` token used as a text colour
 * (every one of them is a LIGHT paper colour, so the control would render
 * white-on-white), and a browser dialog used instead of PILOT's own.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const control = read('app-v2/src/components/ScheduleSend.jsx');
const surfaces = {
  'the title & insurance orders': 'app-v2/src/components/OrdersPanel.jsx',
  'the closing-prep request': 'app-v2/src/components/ClosingPrepCard.jsx',
  'the investor delivery': 'app-v2/src/components/DrawsPanel.jsx',
};

console.log('\nA. one control, mounted on every send the owner named');
for (const [what, path] of Object.entries(surfaces)) {
  const src = read(path);
  ok(/from '\.\/ScheduleSend\.jsx'/.test(src), `${what} imports the shared control`);
  ok(/<ScheduleButton\b/.test(src), `…and offers the clock beside its send button — ${what}`);
  ok(/<ScheduledSends\b/.test(src), `…and shows what is queued, and what FAILED, on ${what}`);
  // A surface that built its own date box would drift on the timezone, which is
  // the one thing about this feature nobody can see is wrong until an order goes
  // out at 4am.
  ok(!/type="datetime-local"/.test(src), `${what} does not roll its own date picker`);
}

console.log('\nB. the icon, and the time being unmistakable');
ok(/🕐/.test(control), 'the control carries the small clock icon the owner asked for');
const etCount = (control.match(/ET/g) || []).length;
ok(etCount >= 3, 'and every time it shows is labelled ET — a bare "8:00" leaves the reader guessing which 8 o\'clock');
ok(/America\/New_York/.test(control), 'the presets are built on the New York calendar, not the browser\'s');
ok(/Tomorrow 8:00 AM/.test(control), 'and the owner\'s own case — worked at night, out in the morning — is one press');

console.log('\nC. the two traps a green build does not catch');
ok(!/color:\s*['"]?var\(--ink/.test(control),
  'no --ink* token is used as a text colour — every one of them is a LIGHT paper colour and would render this white-on-white');
ok(/#141B22/.test(control), '…the text colour is an explicit dark');
ok(!/window\.(confirm|alert|prompt)\(/.test(control), 'no browser dialog — PILOT\'s own message box is used');
ok(/await askConfirm\(/.test(control), 'and the confirm is awaited (a promise is TRUTHY, so a missing await reads as "yes")');
// Every control on a public/white card needs the class, or a bare <input> falls
// back to the browser default and looks broken beside its styled siblings.
const inputs = control.match(/<input[^>]*>/g) || [];
ok(inputs.length > 0 && inputs.every((t) => /className="input"/.test(t)),
  'every field carries className="input" — a bare <input> is styled by the browser, not by PILOT');

console.log('\nD. the scheduling door mirrors the send door, one for one');
const api = read('app-v2/src/lib/api.js');
for (const [name, path] of [
  ['staffScheduleOrder', '/orders/${kind}/schedule'],
  ['staffScheduleClosingPrep', '/closing-prep/schedule'],
  ['staffScheduledSends', '/scheduled-sends'],
  ['staffCancelScheduledSend', '/scheduled-sends/${id}/cancel'],
  ['drawScheduleInvestorDelivery', '/investor-delivery/schedule'],
]) {
  ok(api.includes(name) && api.includes(path), `the portal can reach ${name}`);
}

console.log('\nE. what the scheduler is NOT');
const lib = read('src/lib/scheduled-sends.js');
ok(!/sendMail|nodemailer|buildOrderEmail|recipientsFor|attachments/.test(lib),
  'the scheduler holds no email code at all — it re-enters the send route rather than owning a second copy');
ok(/requireAuth|Bearer/.test(lib),
  'and it goes in through the ordinary front door, so every session check still applies');
// A backtick inside a SQL template literal silently ends the string; it cost a
// confusing syntax error once already in this file.
ok(!/--[^\n]*`/.test(lib), 'no SQL comment contains a backtick — inside a template literal it ends the string');

if (fail) { console.error(`\n${fail} FAILURE(S)`); process.exit(1); }
console.log('\nOK  the schedule control is one definition, on every send the owner named');
