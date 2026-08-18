'use strict';
/**
 * PROGRAM AVAILABILITY — the pure rule module + the wiring guards
 * (owner-directed 2026-08-18: "turn on and turn off certain programs … right now
 * we're discontinuing the gold program … the super admin … turning on the gold
 * program for stuff that's already in process … that entire box of the gold
 * program should disappear … Pre-fill the saying that the gold program is
 * discontinued").
 *
 * What must hold:
 *   A. The one definition (src/lib/program-availability.js): defaults, cleaning,
 *      offered/refusal truth table, per-file exception, availabilityFor shape.
 *   B. The refusal can NEVER fire on junk, on 'manual', or with no settings —
 *      the fail direction is "offered", because the expensive failure is
 *      refusing every registration in the company over a settings hiccup.
 *   C. pricing-settings carries the value with a NULL system default (so an
 *      unconfigured company behaves byte-identically to before the feature).
 *   D. SOURCE WIRING GUARDS — all SIX register doors ask the shared module
 *      (staff register, staff accept-counter, borrower register, TPO register,
 *      term-sheet-offer auto-register, intake auto-register), and the studio
 *      tool actually reads the switches (progOffered) in its card renderer.
 *      Deleting the gate at any door fails this suite.
 *
 * No database needed.
 */
const fs = require('fs');
const path = require('path');
const pa = require('../src/lib/program-availability');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const OFF = { programAvailability: { gold: { active: false, note: 'The Gold Standard program has been discontinued.' } } };
const EXC_APP = { program_exceptions: { gold: { by: 'u-1', byName: 'Owner', at: '2026-08-18T00:00:00Z', reason: 'already in process' } } };

// ── A. the truth table ────────────────────────────────────────────────────────
assert(pa.PROGRAM_KEYS.join(',') === 'standard,gold,silver', 'A1 the three marketed programs, and only them, are togglable');
assert(pa.programActive('gold', {}) === true && pa.programActive('gold', null) === true,
  'A2 no settings / empty settings → every program active');
assert(pa.programActive('gold', OFF) === false && pa.programActive('standard', OFF) === true && pa.programActive('silver', OFF) === true,
  'A3 switching gold off touches ONLY gold');
assert(pa.programOffered('gold', OFF, {}) === false, 'A4 a discontinued program is not offered on a plain file');
assert(pa.programOffered('gold', OFF, EXC_APP) === true, 'A5 the per-file super-admin exception brings it back for THAT file');
assert(pa.programOffered('gold', OFF, { program_exceptions: { silver: { by: 'x' } } }) === false,
  'A6 an exception for a DIFFERENT program does not bring gold back');
assert(pa.registrationRefusal('standard', {}, OFF) === null, 'A7 an active program never refuses');
{
  const msg = pa.registrationRefusal('gold', {}, OFF);
  assert(typeof msg === 'string' && /discontinued/i.test(msg) && /super admin/i.test(msg) && /Gold Standard/.test(msg),
    'A8 the refusal states the discontinuation AND the super-admin way through, naming the program');
}
assert(pa.registrationRefusal('gold', EXC_APP, OFF) === null, 'A9 the exception file registers');
assert(pa.registrationRefusal('gold', {}, {}) === null, 'A10 with no switches set, nothing refuses (pre-feature behavior)');
assert(pa.discontinuedInfo('gold', OFF).note === 'The Gold Standard program has been discontinued.',
  'A11 the stored note is the discontinued wording');
assert(/Gold Standard program has been discontinued/.test(pa.defaultDiscontinuedNote('gold'))
  && /Silver program has been discontinued/.test(pa.defaultDiscontinuedNote('silver')),
  'A12 the pre-filled default note names the program (owner: "Pre-fill the saying")');
assert(pa.discontinuedInfo('gold', { programAvailability: { gold: { active: false } } }).note === pa.defaultDiscontinuedNote('gold'),
  'A13 an OFF program with no typed note falls back to the pre-filled default');
assert(pa.anyDiscontinued(OFF) === true && pa.anyDiscontinued({}) === false,
  'A14 anyDiscontinued drives whether the per-file exception card renders');

// availabilityFor — the shape every screen consumes
{
  const m = pa.availabilityFor(OFF);
  assert(m.standard.offered === true && m.gold.offered === false && m.gold.active === false && !!m.gold.note && m.silver.offered === true,
    'A15 availabilityFor (no app): company map, offered mirrors active');
  const mf = pa.availabilityFor(OFF, EXC_APP);
  assert(mf.gold.offered === true && mf.gold.active === false && mf.gold.exception && mf.gold.exception.byName === 'Owner',
    'A16 availabilityFor (with app): the exception flips offered while active stays false — the banner state');
  const clean = pa.availabilityFor({}, {});
  assert(clean.gold.offered === true && clean.gold.note === undefined && clean.gold.exception === undefined,
    'A17 an all-on company carries no note and no exception fields');
}

// program spellings resolve through the shared programKey (one definition)
assert(pa.registrationRefusal('Gold Standard', {}, OFF) !== null && pa.registrationRefusal('GOLD', {}, OFF) !== null,
  'A18 "Gold Standard"/"GOLD" spellings hit the same gold switch (shared programKey)');

// ── B. the fail direction ─────────────────────────────────────────────────────
assert(pa.registrationRefusal('manual', {}, OFF) === null, 'B1 the MANUAL product is never refused — it is the exception path itself');
assert(pa.registrationRefusal('', {}, OFF) === null && pa.registrationRefusal(null, {}, OFF) === null
  && pa.registrationRefusal('dscr', {}, OFF) === null,
  'B2 a blank/unknown program is never refused (never refuse on a value we cannot read)');
assert(pa.programOffered('gold', { programAvailability: 'garbage{{{' }, {}) === true,
  'B3 unreadable switches read as OFFERED (the register gate must not brick the company on junk)');
assert(pa.cleanProgramAvailability({ gold: { active: true }, silver: 'junk', nonsense: { active: false } }) === null,
  'B4 cleaning drops active programs, junk shapes and unknown programs — only explicit OFF rows are stored');
{
  const c = pa.cleanProgramAvailability({ gold: { active: false, note: 'x'.repeat(500) }, standard: { active: false } });
  assert(c.gold.note.length === 300 && c.standard.note === undefined && c.gold.active === false,
    'B5 the note is capped at 300 and only kept when typed');
}
assert(pa.cleanProgramExceptions('{"gold":{"by":"u","reason":"r"}}').gold.reason === 'r'
  && Object.keys(pa.cleanProgramExceptions({ dscr: { by: 'u' } })).length === 0
  && Object.keys(pa.cleanProgramExceptions(null)).length === 0,
  'B6 exception cleaning: JSON strings parse, unknown programs and junk read as "no exception"');
assert(pa.fileException({ program_exceptions: { gold: 'junk' } }, 'gold') === null
  && pa.fileException({ program_exceptions: { gold: {} } }, 'gold') === null
  && pa.fileException({ program_exceptions: { gold: [] } }, 'gold') === null
  && pa.fileException({ program_exceptions: { gold: { reason: 'no who or when' } } }, 'gold') === null,
  'B7 a malformed exception blob (junk / {} / [] / no by-or-at) is NOT an exception — it must be provably a recorded decision');
assert(pa.fileException({ program_exceptions: { gold: { at: '2026-08-18T00:00:00Z' } } }, 'gold') !== null,
  'B8 …while an entry carrying the recorded when (or who) still counts');

// ── C. pricing-settings carries it, NULL by default ──────────────────────────
{
  const ps = require('../src/lib/pricing-settings');
  assert(ps.SYSTEM_DEFAULTS.programAvailability === null,
    'C1 the system default is NULL — an unconfigured company offers every program, byte-identical to before');
  assert(pa.programOffered('gold', ps.SYSTEM_DEFAULTS, {}) === true, 'C2 …and the gate reads that default as "offered"');
}

// ── D. source wiring guards — the six doors + the studio ─────────────────────
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
function doorWired(file, marker, what) {
  const src = read(file);
  const wired = src.includes("require('../lib/program-availability')") || src.includes("require('./program-availability')");
  const uses = /registrationRefusal|programOffered/.test(src);
  assert(wired && uses && src.includes(marker), `D ${what} (${file}) asks the shared program-availability module`);
}
doorWired('src/routes/staff.js', 'program_discontinued', 'the STAFF register door (and accept-counter)');
assert((read('src/routes/staff.js').match(/program-availability'\)\s*\n?\s*\.registrationRefusal|program-availability'\)\s*\.registrationRefusal/g) || []).length >= 2,
  'D2 staff.js gates BOTH doors — register AND accept-counter');
doorWired('src/routes/borrower.js', 'program_discontinued', 'the BORROWER register door');
doorWired('src/routes/tpo.js', 'program_discontinued', 'the TPO (broker) register door');
doorWired('src/lib/term-sheet-offer.js', 'program_discontinued', 'the term-sheet-offer auto-register');
doorWired('src/lib/intake-auto-register.js', 'program_discontinued', 'the public-intake auto-register');
// The super-admin per-file exception endpoint exists and is super-admin-gated.
{
  const src = read('src/routes/staff.js');
  const i = src.indexOf("'/applications/:id/program-exception'");
  assert(i > -1 && src.slice(i, i + 120).includes("requireRole('super_admin')"),
    'D3 the per-file exception endpoint exists and is SUPER-ADMIN-only');
}
// The studio tool hides the card, guards selection, and drops the Excel section.
{
  const ts = read('web/v2/tools/termsheet.js');
  assert(/function progOffered\(/.test(ts) && /pcard-gone/.test(ts),
    'D4 the studio has the ONE progOffered() rule and a display:none card state — the box disappears');
  assert(/selectProgram\(p\)\s*\{[^]*?progOffered\(p\)/.test(ts),
    'D5 a hidden program cannot be selected (keyboard/programmatic path refused too)');
  assert(/progOffered\("gold"\)\s*\?\s*\{\s*title:\s*"Gold Standard Program"/.test(ts),
    'D6 the Excel export drops a discontinued program\'s section — the export never resurfaces the hidden box');
  assert(/progDiscInfo/.test(ts) && /Turned back on for this file only by an approved exception/.test(ts),
    'D7 the exception file shows the pre-filled discontinued banner on the returned card');
  assert(!/super-admin exception/.test(ts),
    'D7b the banner names no internal role — it renders on borrower/broker studios too');
  const html = read('web/v2/tools/term-sheet.html');
  assert(html.includes('id="tsProgAvail"') && html.includes('data-noshare'),
    'D8 the per-file map rides a data-noshare hidden input — never a shared link');
  assert(html.includes('id="goldDisc"') && html.includes('id="stdDisc"') && html.includes('id="silverDisc"'),
    'D9 each program card carries its discontinued-banner slot');
}
// The panel feeds the studio and offers the super-admin per-file control.
{
  const panel = read('app-v2/src/components/ProductStudioPanel.jsx');
  assert((panel.match(/tsProgAvail/g) || []).length >= 2,
    'D10 ProductStudioPanel snaps the FILE\'s effective map into the studio on BOTH prefill paths (draft + fresh)');
  assert(panel.includes('staffProgramException') && panel.includes("staffRole === 'super_admin'"),
    'D11 the per-file toggle renders for a super admin and calls the audited endpoint');
}
// The Pricing Admin Center edits the switches and the settings PUT stores them.
{
  const scr = read('app-v2/src/screens/StaffCompanyPricing.jsx');
  assert(scr.includes('programAvailability: availToBody(avail)') && /Programs offered/.test(scr),
    'D12 the Pricing Admin Center saves the per-program switches');
  const rt = read('src/routes/admin-pricing.js');
  assert(rt.includes('cleanProgramAvailability') && rt.includes('program_availability'),
    'D13 the settings PUT cleans through the ONE module and stores the column');
  // The Admin Center's pre-fill and the studio's fallback are browser MIRRORS of
  // defaultDiscontinuedNote (they cannot require the server module) — this drift
  // guard fails the moment either stops matching it word for word.
  const noteTail = 'program has been discontinued and is not being offered on new deals right now.';
  assert(pa.defaultDiscontinuedNote('gold').endsWith(noteTail), 'D14 the server default note is the canonical wording');
  assert(scr.includes(noteTail), 'D14b the Admin Center pre-fill mirrors it word for word');
  assert(read('web/v2/tools/termsheet.js').includes(noteTail), 'D14c the studio banner fallback mirrors it word for word');
}
// The PUBLIC feed scrubs the admin-typed note before it leaves (audit #1) —
// borrower-safe on the most exposed surface, without mutating the settings cache.
{
  const sv = read('src/server.js');
  const i = sv.indexOf("'/api/pricing-defaults'");
  assert(i > -1 && /scrubText/.test(sv.slice(i, i + 1400)),
    'D15 /api/pricing-defaults scrubs the discontinued note for anonymous callers');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
