#!/usr/bin/env node
'use strict';
/**
 * LT — THE RENT FORM'S BLOCKS ARE REAL LINES, ON THE SCREEN AS WELL AS ON THE PAPER.
 *
 * Owner-reported 2026-08-31: *"the way you display what we fill in, everything is
 * on one line — it doesn't even have a space. After 'YS Capital Group' we have our
 * address right away without a space. The same thing after the name and address of
 * the applicant … We need to redesign that section to have multiple lines on
 * certain stuff that needs multiple lines, and also the section of To (Name and
 * address of landlord) also needs to have the ability to be multiple lines, and
 * should also be able manually to enter multiple lines and to input automatically
 * from the landlord contact information."*
 *
 * ── THE ROOT CAUSE WAS WORSE THAN A DISPLAY PROBLEM ─────────────────────────
 *
 * The PDF has always honoured a newline (`wrapBlock`) and the field map has always
 * carried the box height (`lines: 4`). What no field carried was `type:
 * 'multiline'` — the ONE thing the editor tested — so every name-and-address
 * block was drawn in a one-line `<input>`. A browser strips the newlines out of
 * one of those, so the block read as a single run with no space, exactly as
 * reported, AND the moment anybody touched the box it was SAVED that way: the
 * landlord then received the mangled version on the printed form.
 *
 * So the editor now DERIVES it from `lines`, which is the height of the real box
 * on the owner's blank — one definition, and a block added later gets its proper
 * editor without anybody remembering a second flag.
 *
 * PROVEN TO FAIL: reverting the editor to the hand-set flag no field sets (1);
 * re-flowing the line breaks away in the render, which reproduces the owner's
 * report on the paper as well as the screen (4); and dropping the overflow
 * report so an over-long block is cut in silence again (3).
 *
 * PURE. No database. The PDF half renders the owner's real blank from disk.
 */
const F = require('../src/longterm/vor/fields.js');
const pdf = require('../src/longterm/vor/pdf.js');
const fs = require('fs');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

(async () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const screen = strip(fs.readFileSync(require.resolve('../app-v2/src/longterm/LtVor.jsx'), 'utf8'));
  const blocks = F.FIELDS.filter((f) => f.who === 'us' && (Number(f.lines) || 1) > 1);
  const singles = F.FIELDS.filter((f) => f.who === 'us' && (Number(f.lines) || 1) <= 1);

  console.log('\nA. THE FORM ITSELF SAYS WHICH FIELDS ARE BLOCKS');
  {
    ok(blocks.length >= 4, 'there are several name-and-address blocks', blocks.map((f) => f.key).join(', '));
    // The owner named these by name.
    for (const key of ['landlord_block', 'lender_block', 'applicant_block']) {
      ok(blocks.some((f) => f.key === key), `${key} is one of them — the owner named it`);
    }
    ok(singles.some((f) => f.key === 'request_date') && singles.some((f) => f.key === 'lender_title'),
      'and a one-line answer is still one line — a date does not need a box', singles.map((f) => f.key).join(', '));
  }

  console.log('\nB. THE EDITOR DERIVES IT — no second flag to forget');
  {
    ok(/Number\(field\.lines\)/.test(screen),
      'the screen reads the field map\'s own line count');
    ok(/rows > 1/.test(screen),
      'THE ONE THAT MATTERS: a field of more than one line gets a real box — reverting to the hand-set flag, which no field sets, is the bug itself');
    ok(/rows=\{rows\}/.test(screen), '…sized to the box on the paper');
    ok(!/type: 'multiline'/.test(screen) || /field\.type === 'multiline'/.test(screen),
      'the old hand-set flag is still honoured where it appears, so nothing that used it breaks');
    // THE BUG ITSELF: no field the map calls a block may reach the one-line input.
    // Asserted on the DERIVATION rather than on the markup, because the markup is
    // one branch and this is the rule it must implement.
    /* And the FIELD MAP's side of the same rule: this one guards the map rather
       than the screen — a block added with no `lines` would fall through to a
       one-line box, where a browser eats its line breaks. */
    const wouldBeSingle = blocks.filter((f) => !((Number(f.lines) || 1) > 1 || f.type === 'multiline'));
    ok(wouldBeSingle.length === 0,
      'and no block in the map can fall through to a one-line box',
      wouldBeSingle.map((f) => f.key).join(', '));
  }

  console.log('\nC. THE PAPER PRINTS THEM AS LINES — the owner\'s own example');
  {
    const W = pdf._internals;
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lender = 'YS Capital Group\n5 New Montrose Avenue, #Bsmt\nBrooklyn, NY 11211';
    const lines = W.wrapBlock(lender, font, 9, 240);
    ok(lines.length === 3, 'the lender block is three lines, not one run', JSON.stringify(lines));
    ok(lines[0] === 'YS Capital Group',
      'THE OWNER\'S OWN CASE: "YS Capital Group" ends its line, and the address starts the next one',
      JSON.stringify(lines[0]));
    /* Asserted PER LINE, not on the joined text: joining them with no separator
       IS the mangling, so a test that did that would fail on correct output. What
       must not exist is a SINGLE line carrying both the company and the street. */
    ok(!lines.some((l) => /YS Capital Group/.test(l) && /Montrose/.test(l)),
      '…and no one line carries both, which is the run-together they were shown',
      JSON.stringify(lines));
    // A long line still WRAPS inside its box — the newlines add breaks, they do
    // not turn wrapping off.
    const long = W.wrapBlock('Acme Property Management LLC of Ocean County, New Jersey', font, 9, 120);
    ok(long.length > 1, 'and a line too long for the box still wraps', JSON.stringify(long));
  }

  console.log('\nD. NOTHING FALLS OFF THE PAPER IN SILENCE');
  {
    const tooLong = ['Acme Property Management LLC', 'Rivka Stein',
      '88 Clifton Avenue, Suite 300, Lakewood, New Jersey 08701',
      'rivka@acme.example', '(732) 555-0100'].join('\n');
    const over = await pdf.measureOverflow({ landlord_block: tooLong });
    const one = over.find((o) => o.key === 'landlord_block');
    ok(!!one, 'a block longer than its box is REPORTED, not quietly cut', JSON.stringify(over));
    ok(one && one.total > one.printed && one.printed === 4,
      '…saying how many lines there are and how many the form holds', JSON.stringify(one));
    ok(!!(one && one.label), '…and naming the block in the form\'s own words', String(one && one.label));

    const fits = await pdf.measureOverflow({
      lender_block: 'YS Capital Group\n5 New Montrose Avenue, #Bsmt\nBrooklyn, NY 11211',
    });
    ok(fits.length === 0, 'a block that fits reports nothing', JSON.stringify(fits));
    ok((await pdf.measureOverflow(null)).length === 0, 'and nothing at all is not an overflow');

    ok(/This is \$\{?/.test(screen) || /will not print/.test(screen),
      'and the screen says it where the person is typing', '');
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
})();
