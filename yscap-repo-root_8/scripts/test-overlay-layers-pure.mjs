/* THE FILE OVERVIEW STAYS REACHABLE WHILE A DOCUMENT IS OPEN
   (owner-reported 2026-08-20: "when you're previewing a document, a PDF, or
   anything else … the entire screen in the back gets black. You can't click on
   the overview to preview the PDF, and the overview is also not available. We
   need to have the overview available while we're previewing the PDF … you
   should be able to see both together so you can compare maybe the PDF to the
   file overview to see the details").

   Two halves, and the test proves them two different ways:

   (A) THE STORE, EXECUTED. Which layers are open is a COUNT, not a flag —
       so a second preview opening and closing must not free the first one's
       hold, and a double release must not free somebody else's. That is real
       logic, so it is RUN here, not grepped.

   (B) THE LAYER ORDER + THE WIRING, READ FROM SOURCE. A z-index and a class
       name only exist in CSS and JSX; what a test can prove is that the four
       layers are still ordered the way the fix requires, that the confirm
       dialog still outranks all of them, and that both components are still
       plugged into the store. Each is a real regression somebody could ship.

   Pure — no React, no DOM, no browser, no DB. */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (cond, what) => { if (cond) { console.log(`  ok  ${what}`); } else { failures++; console.error(`  FAIL ${what}`); } };

const store = await import('../app-v2/src/lib/overlay-layers-store.js');

console.log('\nA. the store — counted, not flagged');

// A fresh store is empty, and the empty snapshot is the SAME object every time
// (useSyncExternalStore compares by identity and loops forever otherwise).
ok(store.getSnapshot().preview === false && store.getSnapshot().overview === false,
  'nothing is open to begin with');
ok(store.getSnapshot() === store.getSnapshot(), 'a read that changed nothing returns the SAME snapshot object');
ok(store.getServerSnapshot() === store.EMPTY, 'the server snapshot is the frozen empty one, so SSR and the first client render agree');

let notified = 0;
const stop = store.subscribe(() => { notified += 1; });

const preview1 = store.acquire('preview');
ok(store.getSnapshot().preview === true, 'opening a preview is visible to a reader');
ok(store.getSnapshot().overview === false, '…and says nothing about the overview');
ok(notified === 1, 'subscribers were told once');

const before = store.getSnapshot();
const preview2 = store.acquire('preview');
ok(store.getSnapshot() === before, 'a SECOND preview changes no boolean, so the snapshot object is untouched');
ok(notified === 1, '…and nobody is re-notified for a no-op');

preview1();
ok(store.getSnapshot().preview === true,
  'closing the FIRST preview while a second is open leaves a preview open — the count is what makes this right');

// A double release must not free the other holder's count. This is the bug a
// plain decrement would ship: StrictMode runs effects twice in development.
preview1();
preview1();
ok(store.getSnapshot().preview === true, 'releasing the same hold twice frees nothing extra');

preview2();
ok(store.getSnapshot().preview === false, 'the last preview closing clears the layer');
ok(!store.getSnapshot().preview && !store.getSnapshot().overview, '…back to nothing open');

// Both kinds at once — the state the whole feature exists for.
const rel = { p: store.acquire('preview'), o: store.acquire('overview') };
ok(store.getSnapshot().preview && store.getSnapshot().overview,
  'a preview and the overview can be open AT THE SAME TIME — the point of the change');
rel.o(); rel.p();
ok(!store.getSnapshot().preview && !store.getSnapshot().overview, 'and both release cleanly');

// An unknown kind is a no-op rather than a new counter nobody reads.
const quiet = store.getSnapshot();
const bogus = store.acquire('not-a-layer');
ok(typeof bogus === 'function' && store.getSnapshot() === quiet,
  'an unknown layer kind changes nothing and still returns a safe release');
bogus();

// A listener that throws must not stop the rest hearing about it.
let heard = 0;
const stopBad = store.subscribe(() => { throw new Error('bad listener'); });
const stopGood = store.subscribe(() => { heard += 1; });
const t = store.acquire('overview');
ok(heard === 1, 'a throwing subscriber never stops the others being notified');
t(); stopBad(); stopGood(); stop();
ok(store._internals.counts.preview === 0 && store._internals.counts.overview === 0,
  'the counts end where they started — no hold leaked through this whole run');

console.log('\nB. the layer order — a confirm dialog still wins, the preview no longer blacks out the tab');

const css = read('app-v2/src/styles.css');
const z = (sel) => {
  const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*z-index:\\s*(\\d+)`);
  const m = re.exec(css);
  return m ? Number(m[1]) : null;
};
const zDialog = z('.cv-modal-back');
const zPreview = z('.cv-modal-back.dp-back');
const zTabOver = z('.fov-tab.fov-over-preview');
const zPanelOver = z('.fov-panel.fov-over-preview');
const zTab = z('.fov-tab');
const zPanel = z('.fov-panel');

ok(zDialog === 200, 'app confirm dialogs are still z 200');
ok(Number.isFinite(zPreview) && zPreview < zDialog,
  'the document preview has its OWN layer BELOW the confirm dialogs — a dialog opened over a preview still wins');
ok(Number.isFinite(zTabOver) && zTabOver > zPreview,
  'while a preview is open the overview TAB paints above it — this is the black-sheet bug, fixed');
ok(Number.isFinite(zPanelOver) && zPanelOver > zTabOver,
  '…and the panel above the tab');
ok(zPanelOver < zDialog, '…and BOTH still below a confirm dialog');
ok(Number.isFinite(zTab) && zTab < zPreview && Number.isFinite(zPanel) && zPanel < zPreview,
  'with no preview open the tab and panel keep their ORIGINAL, lower layer — nothing else moved');

ok(/\.cv-modal-back\.dp-back\.dp-beside-overview\{padding-right:calc\(var\(--fov-w\)/.test(css),
  'with the overview out the preview SHRINKS by the panel width, so the two sit side by side');
ok(/--fov-w:\s*420px/.test(css) && /\.fov-panel\{[^}]*width:min\(var\(--fov-w/.test(css),
  '…and that width is ONE definition the panel itself uses, so the shift can never disagree with the panel');
{
  // Below ~1024px there is no room for both; the shift must be cancelled or the
  // document would be squeezed to nothing.
  const narrow = /@media\(max-width:1024px\)\{[\s\S]{0,600}?\}/.exec(css);
  ok(!!narrow && /\.cv-modal-back\.dp-back\.dp-beside-overview\{padding-right:20px\}/.test(narrow[0]),
    'on a narrow screen the panel overlays instead of squeezing the document');
}

console.log('\nC. the wiring — both components are actually plugged in');

const preview = read('app-v2/src/components/DocPreview.jsx');
const overview = read('app-v2/src/components/FileOverviewSlideOver.jsx');

ok(/useDocPreviewLayer\(/.test(preview), 'the preview registers itself as an open layer');
ok(/useFileOverviewLayer\(open\)/.test(overview), 'the overview registers itself only while it is OPEN');
ok(/className=\{`cv-modal-back dp-back\$\{layers\.overview \? ' dp-beside-overview' : ''\}`\}/.test(preview),
  'the preview wears its own backdrop class, and steps aside when the overview is out');
ok(/fov-over-preview/.test(overview), 'the overview raises itself above an open preview');
ok(/\{open && !over && <div className="fov-back"/.test(overview),
  'the overview drops its OWN dim while ANYTHING full-screen is open — a second dim would darken what is being compared');

// ---------------------------------------------------------------------------
// D. A FULL-SCREEN TOOL SHEET (owner-reported 2026-08-21: "the nice overview button
//    on the right side … is not available in the full screens that are populated,
//    including: the terms you generated / products and pricing / track record full
//    screen / scope of work for full screen. This should always be available").
//
//    The SAME defect as the preview, at a very different NUMBER: a tool sheet is
//    `.toolsheet` at z 1000, not `.cv-modal-back` at 200, so the preview's 160/165
//    escalation is nowhere near enough. That is why it is its own class.
// ---------------------------------------------------------------------------
console.log('\nD. a full-screen tool sheet');
{
  const sheet = z('.toolsheet');
  const tab = z('.fov-tab.fov-over-tool');
  const panel = z('.fov-panel.fov-over-tool');
  const flash = z('.flash-dock');
  ok(sheet === 1000, `the tool sheet really is at z 1000 (got ${sheet}) — the number this exists for`);
  ok(tab !== null && tab > sheet, `the tab climbs ABOVE the tool sheet (${tab} > ${sheet})`);
  ok(panel !== null && panel > tab, `…and the panel above the tab (${panel} > ${tab})`);
  ok(flash !== null && flash > panel, `…and a toast still lands on top of both (${flash} > ${panel})`);
  ok(z('.fov-tab.fov-over-preview') < sheet,
    'the PREVIEW escalation is NOT enough on its own — which is why the tool layer is a separate class');

  // Both sheets must register, or the tab stays buried on that one.
  const toolModal = read('app-v2/src/components/ToolModal.jsx');
  const studio = read('app-v2/src/components/ProductStudioPanel.jsx');
  ok(/useToolSheetLayer\(true\)/.test(toolModal),
    'the Scope of Work / track record sheet registers the layer');
  ok(/useToolSheetLayer\(openStudio\)/.test(studio),
    'the Products & Pricing studio registers it only while the sheet is OPEN (released on close and on unmount)');
  ok(/fov-over-tool/.test(overview), 'the overview raises itself above an open tool sheet');
  // Every component that paints a `.toolsheet` must register, or it re-opens the bug.
  const painters = [];
  for (const f of readdirSync(join(ROOT, 'app-v2/src/components')).filter((x) => x.endsWith('.jsx'))) {
    const body = read(`app-v2/src/components/${f}`);
    if (/className="toolsheet"/.test(body)) painters.push(f);
  }
  ok(painters.length > 0, `found the components that paint a full-screen sheet (${painters.join(', ')})`);
  const unregistered = painters.filter((f) => !/useToolSheetLayer\(/.test(read(`app-v2/src/components/${f}`)));
  ok(unregistered.length === 0,
    `every component that paints a full-screen sheet registers the layer${unregistered.length ? ` — missing: ${unregistered.join(', ')}` : ''}`);
}

// Esc must close ONE thing per press. Both listen on window, so the lower layer
// has to stand down; the overview is the higher one whenever it is open.
ok(/if \(layers\.overview\) return undefined;/.test(preview),
  'Esc closes the TOP layer: the preview stands down while the overview is out, so one press closes one thing');

// Portaled to <body>: a preview opened from inside another modal would otherwise
// inherit that modal's stacking context and NO z-index here could lift the panel
// above it.
ok(/createPortal\(body, document\.body\)/.test(preview), 'the preview is portaled to <body>, so the layer order is decidable');
ok(/createPortal\(layer, document\.body\)/.test(overview), 'the overview is portaled to <body> too');
ok(/typeof document !== 'undefined' && document\.body/.test(preview) && /typeof document !== 'undefined' && document\.body/.test(overview),
  '…both guarded, so a non-browser render never throws');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  overlay-layers: the overview stays reachable — and clickable — while a document is open');
process.exit(failures ? 1 : 0);
