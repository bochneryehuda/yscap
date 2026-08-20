/* THE ROLE PILL + SIGN OUT SIT ON A SOLID BAR — never a see-through strip
   (owner-reported 2026-08-20: "on the bottom left side of the screen next to
   where it says Sign out and your persona … that section is transparent, and you
   scroll through that section with all the settings. You can see it in the back
   of it and at the bottom of it. It's not professional").

   THE BUG WAS NOT THE BACKGROUND — it was already an opaque token. It was three
   GAPS around it, and each is its own regression somebody could re-introduce:

     1. `.app-sidebar` had BOTTOM padding. `.sb-foot` is `position:sticky;
        bottom:0`, and a sticky box is constrained to its containing block — the
        rail's CONTENT box — which ends 20px above the visible bottom. So the nav
        links scrolled through a 20px strip UNDER the pinned bar, in plain sight.
     2. The rail's 14px SIDE padding left the bar narrower than the rail, so
        links showed either side of it.
     3. The bar's own 6px transparent `margin-top` sat above its divider.

   Pure — reads the stylesheet and the shell, no browser. A render check would
   catch the symptom; these are the causes. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (cond, what) => { if (cond) { console.log(`  ok  ${what}`); } else { failures++; console.error(`  FAIL ${what}`); } };

const css = read('app-v2/src/styles.css');
const shell = read('app-v2/src/components/StaffLayout.jsx');

/* The declaration block for a selector, at the TOP level of the stylesheet
   (i.e. not inside a media query) unless `from` narrows the search. */
const block = (sel, from = css) => {
  const i = from.indexOf(`\n${sel}{`);
  if (i < 0) return null;
  const j = from.indexOf('}', i);
  return j < 0 ? null : from.slice(i + sel.length + 2, j);
};

console.log('\nA. the rail leaves no strip under the pinned bar');

const rail = block('.app-sidebar');
ok(!!rail, 'the rail is styled');
{
  const pad = /padding:([^;]+);/.exec(rail || '');
  ok(!!pad, '…and declares its padding');
  // Three values = top / sides / bottom, and the bottom must be 0. Four values
  // would also be legal CSS; either way the LAST one is the bottom.
  const parts = (pad ? pad[1] : '').trim().split(/\s+/);
  const bottom = parts.length >= 3 ? parts[parts.length - (parts.length === 4 ? 2 : 1)] : null;
  ok(parts.length === 3 && parts[2] === '0',
    `the rail has NO bottom padding (it is the footer's, so the content box ends where the rail does) — saw "${pad ? pad[1].trim() : '(none)'}"`);
  ok(bottom !== null, 'padding parsed');
}

console.log('\nB. the bar itself is opaque, full-bleed, and owns the space below it');

const foot = block('.sb-foot');
ok(!!foot, 'the footer is styled');
ok(/position:sticky/.test(foot || '') && /bottom:0/.test(foot || ''),
  'it is still pinned to the bottom of the rail, so logout is reachable without scrolling');
ok(/background:var\(--surface\)/.test(foot || ''),
  'its background is the OPAQUE surface token — never an rgba() or an opacity, which is what makes a bar ghost');
ok(!/opacity:/.test(foot || '') && !/rgba\(/.test((foot || '').replace(/box-shadow:[^;]+;?/g, '')),
  '…and nothing translucent anywhere on it except the shadow');
{
  const m = /margin:([^;]+);/.exec(foot || '');
  ok(!!m && /calc\(-1 \* var\(--sb-pad-r,14px\)\)/.test(m[1]) && /calc\(-1 \* var\(--sb-pad-l,14px\)\)/.test(m[1]),
    'negative side margins cancel the rail padding, so the bar spans the FULL width — no links visible either side');
  const p = /padding:([^;]+);/.exec(foot || '');
  ok(!!p && /var\(--sb-pad-b,20px\)/.test(p[1]),
    '…and it carries the rail\'s old bottom space as its OWN padding, so the strip under it is painted');
  ok(!!p && /var\(--sb-pad-r,14px\)/.test(p[1]) && /var\(--sb-pad-l,14px\)/.test(p[1]),
    '…with the side padding put back inside, so the pill and the button keep their inset');
}
ok(/z-index:2/.test(foot || ''), 'it paints above the scrolling links rather than relying on source order');
ok(/border-top:1px solid var\(--border\)/.test(foot || ''),
  'a real divider separates it from the nav');

console.log('\nC. the phone drawer follows the same rule');

const mobile = /@media\(max-width:1080px\)\{[\s\S]*?\n\}/.exec(css);
ok(!!mobile, 'the drawer breakpoint exists');
{
  const m = mobile ? mobile[0] : '';
  ok(/--sb-pad-b:calc\(20px \+ env\(safe-area-inset-bottom, 0px\)\)/.test(m),
    'the phone safe-area inset is handed to the BAR, so the solid bar covers the home-indicator strip');
  ok(/--sb-pad-l:calc\(14px \+ env\(safe-area-inset-left, 0px\)\)/.test(m),
    'the left inset rides the same token, so the bar\'s negative margin still lands on the drawer edge');
  const pad = /\.app-sidebar\{[\s\S]*?padding:([^;]+);/.exec(m);
  ok(!!pad && / 0 /.test(pad[1]),
    'the drawer has no bottom padding either — the same strip would open on a phone otherwise');
}

console.log('\nD. the shell still renders the two things the owner named');

ok(/<div className="sb-foot">/.test(shell), 'the footer is still the one element');
{
  const i = shell.indexOf('<div className="sb-foot">');
  const seg = shell.slice(i, i + 500);
  ok(/className="pill"[^>]*>\{roleLabel\}/.test(seg), '…carrying the role pill ("Super Admin")');
  ok(/Sign out<\/button>/.test(seg), '…and Sign out under it');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  sidebar foot: a solid, full-width bar — nothing scrolls through it or under it');
process.exit(failures ? 1 : 0);
