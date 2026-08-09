'use strict';

/**
 * Source guards for the PUBLIC (pre-auth) screens. Pure — no DB, no server, no
 * browser. Runs in `npm test`.
 *
 * Two classes are pinned here, both of which shipped and were reported by the
 * owner (2026-08-09: "helpers' sign-in is totally messed up … it has a separate
 * sign-in URL … the CSS is terribly messed up").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. A FORM CONTROL WITHOUT `className="input"` RENDERS UNSTYLED.
 * ─────────────────────────────────────────────────────────────────────────────
 * The styling rule in app-v2/src/styles.css is `.input,select,textarea{…}` — it
 * matches the CLASS, not the `input` TAG. So `<select>` and `<textarea>` are
 * styled bare while a bare `<input>` falls back to the browser default: a
 * narrow box with the wrong font, wrong border and wrong colours, sitting on a
 * white PILOT card. That is exactly how the retired helper sign-in screen
 * looked — its password box (which comes from PasswordInput, and so carries the
 * class) was styled while its email box, one line above, was not.
 *
 * It is invisible in review because the JSX looks perfectly reasonable, and no
 * build, lint or unit test can see it. Hence a source guard.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. THERE IS ONE CLIENT SIGN-IN SCREEN.
 * ─────────────────────────────────────────────────────────────────────────────
 * A borrower's HELPER signs in on the same screen the borrower does; the SERVER
 * works out which credential store the email and password belong to
 * (src/auth/index.js `tryAssistantCredentials`). No separate screen, no separate
 * URL, no separate link in the login footer.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCREENS = path.join(ROOT, 'app-v2', 'src', 'screens');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); };
const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * The source with its COMMENTS removed. Every "this must not appear" assertion
 * below runs on this, never on the raw file: the code that removed the separate
 * helper sign-in explains itself in a comment that necessarily NAMES the thing
 * it removed ("no Helper sign in link here, deliberately"), and a guard that
 * reads comments would fail on the very fix it exists to protect — then get
 * "fixed" by deleting the explanation, which is the worst outcome.
 *
 * Block comments cover both `/* … *\/` and the JSX `{/* … *\/}` form. Line
 * comments are only stripped when the `//` OPENS the line, so a `https://` URL
 * inside a string is never mistaken for one.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// The public / pre-auth screens: everything a person can reach with no session.
// Keep this list in step with the public <Route>s in app-v2/src/App.jsx.
// ---------------------------------------------------------------------------
const PUBLIC_SCREENS = [
  'Login.jsx', 'StaffLogin.jsx', 'Verify.jsx', 'Forgot.jsx', 'Reset.jsx',
  'Accept.jsx', 'AssistantAccept.jsx', 'AcceptTerms.jsx', 'GuestChat.jsx',
  'DrawAccept.jsx', 'EsignDone.jsx',
];

/**
 * Every `<input …>` tag in a source string, as whole tags.
 *
 * A regex alone is not enough: these tags span lines and carry JSX expressions
 * whose braces contain `>` (`onChange={(e) => …}`), so the first `>` after
 * `<input` is regularly INSIDE an attribute rather than the end of the tag. So
 * scan, tracking quote and brace depth, and stop at a `>` that is genuinely at
 * depth zero.
 */
function inputTags(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf('<input', i)) !== -1) {
    // `<inputSomething` would be a different (capitalised) component; a real tag
    // is followed by whitespace, `/` or `>`.
    if (!/[\s/>]/.test(src[i + 6] || '')) { i += 6; continue; }
    let j = i + 6, depth = 0, quote = '';
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '{') { depth++; continue; }
      if (c === '}') { depth--; continue; }
      if (c === '>' && depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

// Controls the `.input` rule does not govern, so they need no class:
//   checkbox/radio — sized by their own global `input[type=checkbox]` rules;
//   file/hidden    — never rendered as a text box (file inputs here are hidden
//                    and driven by a styled button).
const EXEMPT_TYPE = /type\s*=\s*(["'])(checkbox|radio|file|hidden)\1/;

// What counts as "dressed". An inline `style` prop is accepted alongside the
// class because a few controls here legitimately draw their own box (the draw
// dispute amount/reason fields set their own border, padding and a 16px font —
// 16px on purpose: iOS Safari zooms the whole page on focus of anything
// smaller). What is being caught is a control with NEITHER, which can only ever
// render as a raw browser default.
const DRESSED = /(className|style)\s*=/;

// Proof the scanner actually works — a scanner that silently found nothing
// would make every assertion below pass while checking nothing at all.
const SAMPLE = `
  <input className="input" value={a} onChange={(e) => setA(e.target.value)} />
  <input value={b} onChange={(e) => (e.x > 1 ? f() : g())} placeholder="a > b" />
  <inputish className="nope" />
`;
const sample = inputTags(SAMPLE);
ok(sample.length === 2, `the tag scanner finds both <input> tags (found ${sample.length})`);
ok(sample[0].includes('className'), 'the scanner keeps a tag whole through a JSX arrow expression');
ok(!sample[1].includes('className'),
  'the scanner does not run a tag past its own end (the `>` inside an attribute is not the tag end)');

// ---------------------------------------------------------------------------
// 1. Every text control on a public screen is styled
// ---------------------------------------------------------------------------
for (const file of PUBLIC_SCREENS) {
  const full = path.join(SCREENS, file);
  ok(fs.existsSync(full), `public screen ${file} exists (keep PUBLIC_SCREENS in step with App.jsx)`);
  const src = read(full);
  for (const tag of inputTags(src)) {
    if (EXEMPT_TYPE.test(tag)) continue;
    const flat = tag.replace(/\s+/g, ' ').slice(0, 90);
    ok(DRESSED.test(tag),
      `${file}: this <input> has neither className nor style, so it renders as an unstyled browser default — add className="input" → ${flat}`);
  }
}

// ---------------------------------------------------------------------------
// 2. ONE client sign-in screen
// ---------------------------------------------------------------------------
ok(!fs.existsSync(path.join(SCREENS, 'AssistantLogin.jsx')),
  'the separate helper sign-in screen is gone — a helper signs in on the client login screen');

const login = stripComments(read(path.join(SCREENS, 'Login.jsx')));
ok(!/assistant\/login/.test(login),
  'the client login screen carries no link to a separate helper sign-in');
ok(!/Helper sign in/i.test(login),
  'the client login footer has no "Helper sign in" link');

// Nothing anywhere may NAVIGATE to the retired screen. The App.jsx redirect is
// the one permitted mention (it keeps an old bookmark working), so it is read
// separately below rather than swept here.
for (const file of fs.readdirSync(SCREENS)) {
  if (!file.endsWith('.jsx')) continue;
  const src = stripComments(read(path.join(SCREENS, file)));
  ok(!/nav\(\s*['"]\/assistant\/login/.test(src),
    `${file}: navigates to the retired /assistant/login screen — send them to /login`);
}

const app = stripComments(read(path.join(ROOT, 'app-v2', 'src', 'App.jsx')));
ok(!/import\s+AssistantLogin/.test(app), 'App.jsx no longer imports the retired screen');
ok(/path="\/assistant\/login"[^>]*element=\{<Navigate to="\/login"/.test(app.replace(/\s+/g, ' ')),
  'an old /assistant/login link still lands on the client login (redirect kept)');

const api = stripComments(read(path.join(ROOT, 'app-v2', 'src', 'lib', 'api.js')));
ok(!/assistantLogin\s*:/.test(api),
  'the client API surface has no separate helper-login call (the client login handles it)');

// ---------------------------------------------------------------------------
// 3. The server half: the client login really does consult the helper store
// ---------------------------------------------------------------------------
// The behaviour is proven end-to-end over real HTTP in
// scripts/test-borrower-assistant-db.js; this is the cheap structural guard
// that the wiring is still in place when no database is available.
const auth = read(path.join(ROOT, 'src', 'auth', 'index.js'));

/* The body of a top-level function/route, from its header to the closing brace
   in column 0. Slicing it MATTERS: a lazy `[\s\S]*?` search from a function
   header runs happily past the end of that function, so "does the fallback
   consult the helper store?" would be answered `true` by the call inside the
   LEGACY endpoint further down the file — the guard would pass with the wiring
   torn out. */
function bodyAfter(src, header) {
  const start = src.indexOf(header);
  assert.ok(start !== -1, `expected to find ${header} in src/auth/index.js`);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end === -1 ? undefined : end);
}

ok(/async function tryAssistantCredentials\(/.test(auth),
  'the helper credential check exists as ONE definition');
ok(/tryAssistantCredentials\(/.test(bodyAfter(auth, 'async function answerCrossSurfaceLogin(')),
  'the cross-surface fallback consults the helper store');
const borrowerLoginBody = bodyAfter(auth, "router.post('/borrower/login'");
ok((borrowerLoginBody.match(/answerCrossSurfaceLogin\(/g) || []).length === 2,
  'the client login tries the other stores on BOTH failure paths (no account, and wrong borrower password)');
// The legacy endpoint must DELEGATE, never re-implement — two copies of a
// credential check drift in lockout counting and in what the token carries.
const legacyBody = bodyAfter(auth, "router.post('/assistant/login'");
ok(/tryAssistantCredentials\(/.test(legacyBody),
  'the legacy /auth/assistant/login endpoint delegates to the shared check');
ok(!/FROM borrower_assistants/.test(legacyBody),
  'the legacy endpoint does not carry its own copy of the credential query');

console.log(`auth-screens guards: ${n} assertions passed`);
