'use strict';
/**
 * THE SPREADSHEET EDITOR IS REACHABLE FROM EVERY SURFACE THAT SHOWS THE RECORD — one component,
 * three mounts, one URL.
 *
 * Owner-directed 2026-08-24: *"On the track record section we should have a button to open up the
 * old static version of the track record where there is an import button. You can import the excel
 * sheet and that has the same old logic … so we need to add maybe a button to open up the old
 * static version, then you can import, it imports everything and then you can save it … Add that
 * button and bring back how it was … Leave all the enhancements but just bring in that feature."*
 *
 * NOTHING WAS BROUGHT BACK, BECAUSE NOTHING WAS TAKEN AWAY — the gap was WHERE it could be reached
 * from. The tool has been one click away on the LOAN FILE the whole time; what changed on
 * 2026-08-19 is that "Open full screen" stopped opening it and started opening the live workspace
 * (correctly — that screen is the record you read), which left the WORKSPACE and the borrower
 * PROFILE as the two places a person could stand with the whole record in front of them and no way
 * to import a spreadsheet into it. That is what these assertions pin.
 *
 * PURE — no database, no browser. What it guards is structural: that the three surfaces mount the
 * SAME component and that the tool's URL is built in exactly one place. Three hand-typed query
 * strings is three chances for one surface to open the tool in the wrong MODE, and the mode is
 * what decides whether it saves to this borrower's record or to nobody's.
 */

const fs = require('fs');
const path = require('path');

let n = 0, failed = 0;
const ok = (cond, label) => { n++; if (cond) return; failed++; console.error('  ✘ ' + label); };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/* Comments are stripped before every "must not appear" assertion: the component's own header
   necessarily QUOTES the tool's URL while explaining it, and a guard that read comments would fail
   on its own explanation and then get "fixed" by deleting it. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const CONTROL = 'app-v2/src/components/track-record/SpreadsheetEditor.jsx';
/* The three staff surfaces that show a borrower's whole record. `ExportRecord` is mounted on
   exactly these three and is the shape this follows — a person standing on any of them is looking
   at the same record and must have the same two things they can do with it. */
const SURFACES = [
  ['app-v2/src/screens/StaffApplication.jsx', "the loan file's Track record section"],
  ['app-v2/src/screens/StaffBorrowerDetail.jsx', "the borrower profile's Track record tab"],
  ['app-v2/src/screens/StaffTrackRecordWorkspace.jsx', 'the full-screen workspace'],
];

// ── A. the tool itself still carries the Excel import ────────────────────────────────────────
{
  /* The whole feature rests on this button existing in the static tool. If it is ever removed
     there, three mounts of a control that opens it prove nothing at all. */
  const tool = src('web/v2/tools/track-record.html');
  ok(/TR\.importXlsx\(/.test(tool), 'A1 the static tool still has its Excel import handler');
  ok(/accept="\.xlsx"/.test(tool), 'A2 …wired to a file input that takes an .xlsx');
  ok(/Import/.test(tool), 'A3 …behind a visible Import button');

  /* And the bridge is what carries an import back INTO the workflow rather than into a local
     scratchpad — the owner's "it imports everything and then you can save it, whatever it saves
     automatically and it goes into the workflow". */
  const bridge = src('web/v2/tools/track-record-portal.js');
  ok(/internal["']?\s*\)\s*===\s*["']1["']/.test(bridge) || /q\.get\("internal"\)/.test(bridge),
    'A4 the bridge recognises the staff mode this control opens');
  ok(/api\(\s*["']POST["']/.test(bridge) && /api\(\s*["']PUT["']/.test(bridge),
    'A5 …and writes rows back through the ordinary API, so an import lands in the record');
  ok(/clientRowId/.test(bridge),
    'A6 …create-once with the row id adopted back, so a re-import never duplicates a line');
}

// ── B. one definition of the URL ─────────────────────────────────────────────────────────────
{
  /* READ THE CODE, NOT THE PROSE. The component's header necessarily NAMES both modes while
     explaining why one of them is wrong, so a check over the whole file would pass on a builder
     that had been switched to the borrower mode as long as the comment still said "internal" —
     found by mutation, and it is the one mutation that got through the first cut of this file. */
  const control = stripComments(src(CONTROL));
  ok(/export function legacyToolUrl\(/.test(control), 'B1 the URL is built by one exported function');
  ok(/internal=1/.test(control), 'B2 …in the STAFF bridge mode');
  ok(/encodeURIComponent\(borrowerId\)/.test(control),
    'B3 …with the borrower encoded, so an id can never break out of the query string');
  ok(!/portal=1/.test(control),
    'B4 …and never the BORROWER mode, which resolves the person from the session and would open '
    + 'the wrong record on a staff screen');

  for (const [f, what] of SURFACES) {
    const body = stripComments(src(f));
    ok(!/tools\/track-record\.html/.test(body),
      `B5[${what}] builds no track-record tool URL of its own`);
  }
}

// ── C. all three surfaces mount it ───────────────────────────────────────────────────────────
{
  for (const [f, what] of SURFACES) {
    const body = src(f);
    ok(/import SpreadsheetEditor from/.test(body), `C1[${what}] imports the shared control`);
    ok(/<SpreadsheetEditor\b/.test(body), `C2[${what}] mounts it`);
    /* It has to be handed a borrower or it opens on nobody. */
    ok(/<SpreadsheetEditor[^>]*borrowerId=\{/.test(body), `C3[${what}] passes a borrower`);
    /* An import changes the record, so the surface behind the sheet must re-read it — otherwise
       somebody imports twelve projects and the page still shows the old count. */
    ok(/<SpreadsheetEditor[^>]*onClosed=\{/.test(body), `C4[${what}] reloads itself when the sheet closes`);
  }
  /* The same three surfaces the export control is on — they are the surfaces that show the whole
     record, and offering one without the other is what this fixes. */
  for (const [f, what] of SURFACES) {
    ok(/<ExportRecord\b/.test(src(f)), `C5[${what}] also carries the export control (the shape this follows)`);
  }
}

// ── D. the loan file's borrower switch still closes the sheet ────────────────────────────────
{
  /* The loan file used to close the sheet by hand when somebody switched between the borrower and
     the co-borrower, so it could not be left open on one person's record while the page had moved
     to the other's. The state that did that is gone; the KEY is what does it now, and dropping the
     key would silently reintroduce exactly that. */
  const file = src('app-v2/src/screens/StaffApplication.jsx');
  ok(/<SpreadsheetEditor\s+key=\{borrowerId\}/.test(file),
    'D1 the loan file keys the control on the borrower, so switching people remounts it closed');
  ok(!/setFull\b/.test(file), 'D2 …and the hand-rolled open state it replaced is gone entirely');
}

// ── E. the control is safe to render ─────────────────────────────────────────────────────────
{
  const control = src(CONTROL);
  ok(/if \(!borrowerId\) return null/.test(control),
    'E1 no borrower, no button — it never opens the tool on nobody');
  /* An --ink* token is a LIGHT paper colour in this palette and renders white-on-white. */
  ok(!/color:\s*['"`]?var\(--ink/.test(control), 'E2 no --ink* token is used as a text colour');
  ok(/title=/.test(control), 'E3 the button says what it does on hover');
}

console.log(`${failed ? '✗' : '✓'} test-track-record-spreadsheet-pure: ${n - failed}/${n} checks passed`);
process.exit(failed ? 1 : 0);
