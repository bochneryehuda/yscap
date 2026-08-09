/**
 * THE BULK PROPERTY WORKBENCH — the promises that must hold in the SOURCE.
 *
 * These are structural guarantees, not rendering details, so they are asserted
 * against the file itself. The one that carries this suite:
 *
 *   THERE IS NO BULK IMPORT PATH, AND THERE MUST NEVER BE ONE.
 *
 * The owner asked for a per-property accuracy review in those words, and the
 * asymmetry is the reason: bulk DECLINE can only ever withhold credit, while
 * bulk IMPORT would put unread deals on somebody's record and price a loan on
 * them. A loop calling `import_new` would be an easy, plausible "improvement"
 * that quietly removes the review this whole screen exists to enforce, so it is
 * guarded rather than left to reviewer memory.
 *
 * MUTATION-TESTING NOTE, because this one cost a session. Inject the mutation
 * with an EDITOR, never through a shell `node -e`/`perl -0pi` one-liner: the
 * shell eats the single quotes around 'import_name', the file ends up carrying a
 * BARE identifier, and then the guard below "fails to fire" — reading as a hole
 * in the guard when the mutation is what was broken. The quote requirement has
 * since been dropped (see the loop guard), so that particular misreading cannot
 * recur, but the escaping trap applies to every guard in this file.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(R, 'app-v2/src/screens/StaffPropertyWorkbench.jsx');
const src = fs.readFileSync(FILE, 'utf8');
/* Strip comments before matching. A source guard must read CODE, not prose —
   this file's own header discusses bulk import at length, and a naive grep
   would trip on the explanation of why it is forbidden. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

console.log('\n1. There is no bulk import, and the tick imports nothing');
{
  /* Every `import_new` must be a SINGLE decide on the property being reviewed —
     never inside a loop over the ticked set. The action is matched WITHOUT
     requiring its quotes: a bulk import assembled through a constant or a
     variable is the same bulk import, and demanding `'import_new'` verbatim
     would let the exact rewrite this guard exists to catch walk straight past
     it. Verified not to fire on the clean file, so the looser match costs
     nothing. */
  const loopy = /(for\s*\(|\.map\(|\.forEach\()[^]{0,400}?import_new/.test(code);
  ok(!loopy, 'no loop anywhere calls import_new — a bulk import cannot be expressed in this file');

  const bulkFn = /async function\s+importTicked|function\s+importAll|importTicked\s*=/.test(code);
  ok(!bulkFn, 'and there is no function named for importing the ticked set');

  /* The tick must only ever build the run. */
  ok(/function startRun\(\)/.test(code) && /setRun\(ids\)/.test(code),
    'ticking builds a REVIEW RUN (startRun sets the list) rather than deciding anything');
  const startRunBody = code.slice(code.indexOf('function startRun()'), code.indexOf('async function declineTicked'));
  ok(!/staffDecideCandidate/.test(startRunBody),
    '…and startRun calls no decide at all — the tick genuinely imports nothing');
}

console.log('\n2. Bulk DECLINE is allowed, and still needs a reason');
{
  const d = code.slice(code.indexOf('async function declineTicked'), code.indexOf('const current ='));
  ok(/for \(const id of ids\)/.test(d) && /'decline'/.test(d),
    'declining IS done in bulk — it can only ever withhold credit, never add it');
  ok(/askPrompt/.test(d) && /Add a short reason/.test(d),
    '…but never without a reason: the next search reads it to avoid re-raising the property');
  ok(/failed\.length/.test(d) && /did not save/.test(d),
    '…and a partial failure is REPORTED, never silent — the rest stay in the list');
}

console.log('\n3. Searching spends money, so it is always a deliberate click');
{
  const s = code.slice(code.indexOf('async function search()'), code.indexOf('function toggle('));
  ok(/askConfirm/.test(s) && /allowance/.test(src),
    'the search asks first and says it uses the office\'s shared hourly allowance');
  ok(!/useEffect\([^)]*\)\s*=>\s*\{[^}]*search\(\)/.test(code),
    'and nothing calls it on mount — a page load must never spend the allowance');
  ok(/out\.summary/.test(code) && !/found nothing/.test(code),
    'the "what happened" sentence comes from the SERVER, so two screens cannot word it two ways');
}

console.log('\n4. A band is a REASON, never a score');
{
  /* Matching a bare `\d+%` here reads CSS, not meaning — `width: '100%'` is a
     table style, and the first cut of this guard failed on exactly that. What
     must be absent is a NUMERIC CONFIDENCE: an identifier for one, or the band
     itself rendered raw where a number could later be substituted. */
  ok(!/\b(score|percent|confidencePct|matchScore|confidenceScore)\b/i.test(code),
    'no numeric-confidence identifier exists — a score would describe county coverage and read as a judgement about the borrower');
  const rendersBandRaw = /\{\s*r\.matchConfidence\s*\}/.test(code);
  ok(!rendersBandRaw,
    'the raw band value is never printed — it is always mapped to words through BAND, so there is no slot a number could fill');
  ok(/exact:/.test(code) && /near:/.test(code) && /none:/.test(code),
    'all three bands are rendered, including "not sure" — the state a reviewer is actually needed for');
  ok(/Not sure/.test(src), '…and the near band is called what it is, in plain words');
}

console.log('\n5. Dark text on white, and the browser dialogs are never used');
{
  ok(!/var\(--ink/.test(src),
    'no --ink* token is used for a colour — in this palette those are LIGHT and render white-on-white');
  ok(/#141B22/.test(src) && /#4B585C/.test(src), 'the explicit dark inks are used instead');
  for (const bad of ['window.alert(', 'window.confirm(', 'window.prompt(']) {
    ok(!src.includes(bad), `no ${bad} — the portal has its own dialogs`);
  }
  ok(/askConfirm|askPrompt|showMessage/.test(code), '…and it uses them');
  /* Every askConfirm/askPrompt must be awaited: a promise is TRUTHY, so a
     missing await reads as "the user said yes" on every click. */
  const calls = [...code.matchAll(/(await\s+)?ask(Confirm|Prompt)\(/g)];
  ok(calls.length > 0 && calls.every((m) => !!m[1]),
    'every askConfirm/askPrompt is awaited — an un-awaited one returns a truthy promise and reads as consent');
}

console.log('\n6. The refusals the server can send are all handled');
{
  ok(/would_reopen_verification/.test(code),
    'a merge that would reopen a verification is caught and asked about, not shown as a raw error');
  ok(/deal_type_needed/.test(code),
    'and a missing deal type is explained — a line without one counts toward nothing');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  the tick imports nothing, bulk decline is safe, and no bulk import can be expressed');
process.exit(fail ? 1 : 0);
