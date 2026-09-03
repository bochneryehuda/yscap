'use strict';
/**
 * LONG-TERM — WHY A RATE SHEET CANNOT BE USED IS SAID ON THE SCREEN WHERE
 * SOMEBODY IS CHOOSING IT.
 *
 * Two ways that question goes unanswered, both from one owner sentence:
 * *"the settings you can't really change from LenderPric, the loannex, maybe
 * only not on mobile."* Section H is the sheet with no login; section I is the
 * greyed-out button whose only explanation was a hover tooltip.
 *
 * ── THE REPORT THIS PINS ───────────────────────────────────────────────────
 * Owner, 2026-09-03: *"It still does not. I searched again. It still does not
 * come up in any of the new five. It's not pulling on the ink from loannex
 * yet."*
 *
 * WHAT WAS ACTUALLY WRONG was not the routing and not the deploy. MEASURED: the
 * live bundle already carried the settings section, and `applyRouting` does
 * exactly what it was told — an investor whose sheet does not answer is HIDDEN
 * rather than quietly served from the other sheet. The gap was that the LoanNEX
 * client's own `configured()` had ZERO CALLERS, while every other integration
 * here (Encompass, ClickUp, Lender Price, DocuSign, OCR) consults its own before
 * doing work. With no login set the sign-in throws, five investors vanish from
 * the board — silently, by the owner's own direction for the pricing page — and
 * nothing anywhere said the login had never been set.
 *
 * PURE: no network, no database.
 */

const conn = require('../src/longterm/pricing/sheet-connection');
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
/* TOTAL: a mutation can turn any of these null, and `.includes` on null CRASHES the
   battery where it stands rather than failing the assertion — which reports a pass
   rate that means nothing. Every read of a mutable value goes through here. */
const msg = (x) => String((x && x.message) || '');
/* Comments necessarily NAME what they explain, so a "must not appear" check that
   reads them fails on its own explanation — strip them first. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n── A. TWO CLIENTS, TWO SHAPES, ONE ANSWER ──');
ok(conn.readConfigured(true) === 'connected', 'A1 Lender Price answers a BOOLEAN true');
ok(conn.readConfigured(false) === 'not_connected', 'A2 …and a boolean false');
ok(conn.readConfigured({ ok: true }) === 'connected', 'A3 LoanNEX answers an OBJECT with ok:true');
ok(conn.readConfigured({ ok: false }) === 'not_connected', 'A4 …and ok:false');

console.log('\n── B. IT MAY NEVER SAY "CONNECTED" ON A GUESS ──');
for (const [v, what] of [[null, 'null'], [undefined, 'nothing at all'], [{}, 'an object with no ok'],
  ['yes', 'a string'], [1, 'a number'], [{ ok: 'yes' }, 'ok as a string']]) {
  ok(conn.readConfigured(v) === 'unknown', `B  ${what} reads as UNKNOWN, never as connected`);
}

console.log('\n── C. IT ONLY SPEAKS WHEN SOMEBODY IS ACTUALLY ROUTED THERE ──');
ok(conn.standingFor('loannex', { ok: false }, 0).speak === false,
  'C1 a sheet nobody uses being unconfigured is NOT a problem — silent');
ok(conn.standingFor('loannex', { ok: true }, 5).speak === false,
  'C2 a connected sheet is silent, however many are routed to it');
ok(conn.standingFor('loannex', { ok: false }, 5).speak === true,
  'C3 …and it speaks the moment a real investor is pointed at a sheet that cannot answer');
ok(conn.standingFor('loannex', null, 5).speak === true,
  'C4 an UNCHECKABLE sheet with investors on it speaks too — silence would read as "fine"');
ok(msg(conn.standingFor('loannex', null, 5)).includes('could not check'),
  'C5 …and says it could not check, rather than claiming it is down');

console.log('\n── D. THE MESSAGE IS ACTIONABLE AND TELLS THE WHOLE TRUTH ──');
{
  const m = msg(conn.standingFor('loannex', { ok: false }, 5));
  ok(/NEX_USERNAME/.test(m) && /NEX_PASSWORD/.test(m), 'D1 it names the credential to set');
  ok(/NEX_TOKEN_KEY/.test(m), 'D2 …including the other way in');
  ok(/5 investors/.test(m), 'D3 it says how many investors this is costing');
  ok(/will not appear on the board/.test(m), 'D4 it says what actually happens to them');
  ok(/not taken from the other sheet/.test(m),
    'D5 …and that the other sheet is NOT used in their place — the thing somebody would otherwise assume');
  ok(msg(conn.standingFor('loannex', { ok: false }, 1)).includes('1 investor is'),
    'D6 one investor reads as "investor is", not "investors are"');
}

console.log('\n── E. WHICH SHEET IS ASKED FOR WHOM ──');
{
  const rows = [
    { enabled: true, source: 'loannex' }, { enabled: true, source: 'loannex' },
    { enabled: true, source: 'lenderprice' },
    { enabled: true, source: 'both' },
    { enabled: false, source: 'loannex' },
    null, {},
  ];
  const c = conn.routedCounts(rows);
  ok(c.loannex === 3, `E1 LoanNEX is asked for 3 (two of its own plus the "both") — got ${c.loannex}`);
  ok(c.lenderprice === 2, `E2 Lender Price for 2 (its own plus the "both") — got ${c.lenderprice}`);
  ok(conn.routedCounts(null).loannex === 0, 'E3 no rows is zero, never a throw');
  ok(conn.routedCounts([{ enabled: false, source: 'loannex' }]).loannex === 0,
    'E4 a switched-OFF investor is not waiting on anything');
}

console.log('\n── F. IT CAN NEVER BREAK THE SCREEN IT DECORATES ──');
{
  const both = conn.connectionsFor({ lenderprice: true, loannex: { ok: false } }, { lenderprice: 21, loannex: 5 });
  ok(both.lenderprice && both.loannex, 'F1 both sheets always come back');
  ok(both.lenderprice.speak === false && both.loannex.speak === true, 'F2 …each judged on its own');
  const thrower = { get ok() { throw new Error('boom'); } };
  let threw = false;
  let out = null;
  try { out = conn.connectionsFor({ loannex: thrower }, { loannex: 5 }); } catch (_) { threw = true; }
  ok(!threw, 'F3 a source that blows up does not take the settings screen with it');
  ok(out && out.loannex.state === 'unknown', 'F4 …and reads as unknown, which is the honest answer about it');
  ok(conn.connectionsFor(null, null).loannex.state === 'unknown', 'F5 nothing at all likewise');
}

console.log('\n── G. THE REAL CLIENT, AND THE REAL FIVE ──');
{
  const before = { u: process.env.NEX_USERNAME, p: process.env.NEX_PASSWORD, t: process.env.NEX_TOKEN_KEY };
  delete process.env.NEX_USERNAME; delete process.env.NEX_PASSWORD; delete process.env.NEX_TOKEN_KEY;
  const nex = require('../src/longterm/loannex/client');
  ok(conn.readConfigured(nex.configured()) === 'not_connected',
    'G1 with no login in the environment the REAL LoanNEX client reports not connected');
  process.env.NEX_USERNAME = 'someone'; process.env.NEX_PASSWORD = 'secret';
  ok(conn.readConfigured(nex.configured()) === 'connected',
    'G2 …and connected once a username and password are set');
  if (before.u === undefined) delete process.env.NEX_USERNAME; else process.env.NEX_USERNAME = before.u;
  if (before.p === undefined) delete process.env.NEX_PASSWORD; else process.env.NEX_PASSWORD = before.p;
  if (before.t === undefined) delete process.env.NEX_TOKEN_KEY; else process.env.NEX_TOKEN_KEY = before.t;

  // The population the owner is actually asking about.
  const settings = require('../src/longterm/pricing/investor-settings');
  const c = conn.routedCounts(settings.roster({}));
  ok(c.loannex === 5, `G3 the five owner-switched investors are the ones waiting on LoanNEX (got ${c.loannex})`);
  const st = conn.standingFor('loannex', { ok: false }, c.loannex);
  ok(st.speak && /5 investors/.test(msg(st)),
    'G4 …so an unconfigured LoanNEX on this deployment says exactly that, on the settings screen');
}

console.log('\n── H. A BACK END NOBODY RENDERS IS THE SAME SILENCE ──');
{
  const route = stripComments(read('../src/longterm/routes/investor-settings-routes.js'));
  ok(/sheetConnection\.connectionsFor\(/.test(route), 'H1 the settings door computes it');
  ok(/\bconnections,/.test(route), 'H2 …and actually answers with it');
  ok(/routedCounts\(shown\)/.test(route),
    'H3 counted over the rows SHOWN, so the sentence and the list can never contradict each other');

  const screen = stripComments(read('../app-v2/src/longterm/LtInvestorSources.jsx'));
  ok(/data\.connections/.test(screen), 'H4 the screen reads it');
  /* ⛔ PIN THE WHOLE RENDER EXPRESSION, not the call. `{false && sheetTrouble.map(`
     leaves the call in the file and draws nothing — MEASURED: that mutation left
     this suite fully green until this assertion was tightened. The empty array is
     the only thing allowed to silence it. */
  ok(/\{\s*sheetTrouble\.map\(/.test(screen), 'H5 …and renders it, behind no other condition');
  ok(/\.filter\(\s*\([a-z]\)\s*=>\s*[a-z]\s*&&\s*[a-z]\.speak\s*&&\s*[a-z]\.message\s*\)/.test(screen),
    'H6 …keyed on the SERVER\'s decision to speak, not a second rule here');
  ok(/\{c\.message\}/.test(screen), 'H7 …with the server\'s own wording, not a second copy of it');
  ok(!/NEX_USERNAME/.test(screen),
    'H8 the screen never restates the credential names — one definition, on the server');
}

console.log('\n── J. WHEN DID THIS SHEET LAST ACTUALLY ANSWER ──');
{
  const NOW = Date.parse('2026-09-03T14:00:00.000Z');
  const r = conn.lastAnsweredAll({ lenderprice: '2026-09-03T13:02:00.000Z' }, NOW);
  ok(r.lenderprice.everAnswered === true, 'J1 a sheet that has answered says so');
  ok(r.lenderprice.at === '2026-09-03T13:02:00.000Z', 'J2 …and carries the stamp the board wrote');
  ok(Math.abs(r.lenderprice.ageHours - (58 / 60)) < 0.01, 'J3 …with how long ago, measured');
  ok(r.loannex.everAnswered === false, 'J4 a sheet that never has says THAT');
  ok(/never answered a search/.test(String(r.loannex.neverNote)),
    'J5 …in words, so it can never be mistaken for one that answered a minute ago');

  /* NEVER GUESSES A TIME. Each of these is a way a register can be unreadable. */
  for (const [b, what] of [[null, 'no register at all'], [{}, 'an empty register'],
    [{ loannex: '' }, 'a blank stamp'], [{ loannex: 'yesterday' }, 'an unparseable stamp'],
    [{ loannex: 12345 }, 'a number instead of a stamp'], ['nope', 'a register that is not an object']]) {
    ok(conn.lastAnsweredAll(b, NOW).loannex.everAnswered === false,
      `J  ${what} reads as never answered, never as a time`);
  }
  ok(conn.lastAnsweredAll({ loannex: '2099-01-01T00:00:00.000Z' }, NOW).loannex.ageHours === null,
    'J6 a stamp in the FUTURE is a clock disagreement — reported with no age, never a negative one');
  let threw = false;
  try { conn.lastAnsweredAll({ get loannex() { throw new Error('boom'); } }, NOW); } catch (_) { threw = true; }
  ok(!threw, 'J7 …and an unreadable register never takes the screen down');

  /* ⛔ THE SENTENCE WITH A DATE IN IT IS NOT WRITTEN ON THE SERVER — only the
     reader's browser knows the reader's timezone. */
  ok(r.lenderprice.neverNote === null, 'J8 an answered sheet carries no server-written sentence');
  const mod = stripComments(read('../src/longterm/pricing/sheet-connection.js'));
  ok(!/last answered a search on \$\{/.test(mod),
    'J9 …the server never composes a dated line, which would be right in one timezone only');

  const route = stripComments(read('../src/longterm/routes/investor-settings-routes.js'));
  ok(/lastAnsweredAll\(sight/.test(route), 'J10 the door reads it from the register the board already writes');
  ok(/\blastAnswered,/.test(route), 'J11 …and answers with it');

  const screen = stripComments(read('../app-v2/src/longterm/LtInvestorSources.jsx'));
  ok(/data\.lastAnswered/.test(screen), 'J12 the screen reads it');
  /* ⛔ PIN THE GUARD CLAUSE, NOT THE CALL. Wrapping the render in `{false && (`
     leaves `sheetActivity.map(` sitting in the file, so an assertion on the call
     alone stays green while nothing is drawn — this exact mutation walked past
     the first version of this check. */
  ok(/\{sheetActivity\.length > 0 && \(/.test(screen) && /sheetActivity\.map\(/.test(screen),
    'J13 …and renders it whenever there is anything to say, always, not only on trouble');
  ok(/toLocaleString\(\)/.test(screen), 'J14 …formatting the date in the READER\'s own timezone');
  ok(/x\.neverNote/.test(screen), 'J15 …and printing the server\'s wording for the never case');
}

console.log('\n── I. A GREYED-OUT BUTTON EXPLAINS ITSELF WITHOUT A HOVER ──');
{
  const screen = stripComments(read('../app-v2/src/longterm/LtInvestorSources.jsx'));
  const css = stripComments(read('../app-v2/src/styles.css'));

  ok(/const lockReason = \(/.test(screen),
    'I1 the reason a source cannot be picked has ONE definition');
  /* The point is that the SENTENCE exists once. Two readers call it; a second
     literal copy is how the tooltip and the visible line drift apart. */
  ok((screen.match(/has never carried this investor/g) || []).length === 1,
    'I2 …written out exactly once, so the tooltip and the visible line can never disagree');
  ok((screen.match(/lockReason\(/g) || []).length === 2,
    'I2b …and read by BOTH of them');
  ok(/title=\{isLocked \? lockReason\(/.test(screen),
    'I3 the tooltip no longer carries its own copy of the sentence');
  ok(/className="lt-inv-lock"/.test(screen), 'I4 …and the visible line is rendered');
  ok(/\(r\.lockedOut \|\| \[\]\)\.filter\(\(id\) => id !== 'off'\)/.test(screen),
    'I5 OFF is never described as locked — the owner\'s rule is that an investor can always be turned off');

  /* The desktop table has a working tooltip, so repeating the sentence on every
     row there would be a wall of noise. It appears ONLY in the stacked form. */
  ok(/\.lt-inv-lock\{display:none\}/.test(css), 'I6 hidden by default, so the desktop table is unchanged');
  const container = (css.match(/@container \(max-width: 820px\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/\.lt-inv-lock\{display:block/.test(container),
    'I7 …and shown only in the stacked form, which is the one with no hover');
  ok(/\.lt-inv-lock\{[^}]*color:#4B585C/.test(container),
    'I8 dark on white — never an --ink* token, which is a LIGHT paper colour in this palette');
  ok(!/\.lt-inv-lock\{[^}]*var\(--ink/.test(css), 'I9 …asserted, not merely intended');
}

console.log(`\ntest-lt-sheet-connection-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
