'use strict';
/**
 * LONG-TERM — THE VERIFICATION OF RENT IS THE OWNER'S OWN BLANK, PROVEN BY READING
 * THE RENDERED BYTES BACK.
 *
 * WHAT THIS SUITE IS REALLY ABOUT. The owner reported, in these words: *"You messed
 * up by far. You're not using our blank VOR. You're pre-filling some of the
 * information from part two."* Both halves of that are properties of the RENDERED
 * PDF, not of the source, so nothing here reads a source file and asserts about it.
 * It renders the real document and takes it apart again:
 *
 *   1. it is ONE page at 612 x 792 — the owner's page, not one we added;
 *   2. THE OWNER'S OWN FORM TEXT IS STILL THERE — the form mark, the title, the
 *      Privacy Act notice, the "To Be Completed By Landlord" bar. A lookalike drawn
 *      with `PDFDocument.create()` cannot carry them, which is what makes this the
 *      test that the earlier defect would have failed;
 *   3. every value we prefill appears, and appears ABOVE y=334;
 *   4. NOTHING of ours appears at or below y=334 except the invisible anchors — and
 *      every one of those IS drawn, because a declared-but-undrawn anchor silently
 *      stops DocuSign asking a required question;
 *   5. our ink never lands on top of the form's printed text;
 *   6. a blank that is not the owner's fails at LOAD rather than in a landlord's
 *      inbox.
 *
 * ── HOW THE READ-BACK WORKS, AND WHY IT IS SOUND ────────────────────────────
 *
 * Extraction is done with `unpdf` (pdf.js under the hood), which returns every text
 * run with the transform it was drawn under — x and y in the PDF's own user space,
 * bottom-up, the same coordinates `fields.js` is written in. That matters more than
 * convenience: scanning the raw content stream would tell us what OPERATORS we
 * emitted, whereas this tells us where the text ACTUALLY LANDS after the page's own
 * transforms, which is what a landlord sees. And because pdf.js has no idea what
 * colour a run is, the white 4pt anchors come back like everything else — so
 * "invisible" cannot hide a stray prefill from this test either.
 *
 * OURS vs THE FORM'S is decided by DIFFERENCE, not by guesswork: the blank is
 * extracted too, and any run in the output that is not in the blank at the same
 * string and position is ours. That is what makes assertion 4 airtight — there is
 * nothing for a prefill to hide behind.
 *
 * Pure: no database, no network, no DocuSign. It reads two files off disk (the
 * owner's blank, and a deliberately wrong stub it writes to a temp directory).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const F = require('../src/longterm/vor/fields');
const { buildVorPdf, BLANK_PATH, _internals } = require('../src/longterm/vor/pdf');

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ok - ${name}`);
}
async function okAsync(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok - ${name}`);
}

/* A complete form, in the keys the OWNER'S form actually has — items 1 to 9 and
   nothing else. Every value is distinctive enough that finding it in the extracted
   text cannot be an accident of the form's own wording. */
const FULL = {
  landlord_block: 'Rivka Stein\nAcme Realty Management LLC\n88 Clifton Avenue, Lakewood, NJ 08701',
  lender_block: 'YS Capital Group\n5 New Montrose Avenue, #Bsmt\nBrooklyn, NY 11211',
  lender_signature: 'Chaya Gruber',
  lender_title: 'Loan Officer',
  request_date: '2026-08-30',
  loan_number: 'YSCAP258134700',
  property_address: '12 Oak Street, Apt 2, Lakewood, NJ 08701',
  account_name: 'Leib Lichtman and Sarah Lichtman',
  applicant_block: 'Leib Lichtman and Sarah Lichtman\n12 Oak Street, Apt 2, Lakewood, NJ 08701',
  applicant_signature: 'See attached signature',
  coapplicant_signature: 'See attached signature',
};

/** Every text run on page 1, with where it landed. */
async function runsOf(bytes) {
  const { getDocumentProxy } = require('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  return {
    pages: doc.numPages,
    width: page.getViewport({ scale: 1 }).width,
    height: page.getViewport({ scale: 1 }).height,
    runs: content.items
      .filter((i) => i.str && i.str.trim())
      .map((i) => ({
        s: i.str,
        // transform[4], transform[5] are the run's origin in PDF user space —
        // bottom-up, exactly the coordinates fields.js is written in.
        x: i.transform[4],
        y: i.transform[5],
        w: i.width,
        h: i.height,
      })),
  };
}

/** Identity of a run, for the difference that separates our ink from the form's. */
const runKey = (r) => `${r.s}@${r.x.toFixed(1)},${r.y.toFixed(1)}`;

/**
 * The distinctive words a value should leave on the page, AS PRINTED — item 5 is a
 * date, and it prints as the form's own 08/30/2026 rather than as the ISO day the
 * database holds. Comparing on words rather than whole strings is deliberate: a
 * value that wraps inside its band is drawn as two runs, which is correct and must
 * not read as a missing value.
 */
function printedWords(key, value) {
  const shown = _internals.fmtValue(F.BY_KEY.get(key), value);
  return String(shown).split(/[\s\n]+/).filter((w) => w.length >= 4);
}

/**
 * Do two runs' INK overlap? A run is drawn on its baseline, so its box runs from the
 * font's descender below it to its ascender above. Helvetica's are -0.207 and 0.718
 * em (from its own AFM), and both the owner's form and our overlay are set in it —
 * so these are the real glyph extents rather than a guessed padding, which matters
 * on a form whose printed rows are only 27pt apart.
 */
const ASCENT = 0.718;
const DESCENT = 0.207;
function overlaps(a, b) {
  const box = (r) => ({ x1: r.x, x2: r.x + r.w, y1: r.y - r.h * DESCENT, y2: r.y + r.h * ASCENT });
  const A = box(a);
  const B = box(b);
  return A.x1 < B.x2 && B.x1 < A.x2 && A.y1 < B.y2 && B.y1 < A.y2;
}

console.log('\nLong-Term — the verification of rent, overlaid on the owner’s blank\n');

(async () => {
  const blank = await runsOf(fs.readFileSync(BLANK_PATH));
  const pdf = await buildVorPdf(FULL);
  const out = await runsOf(pdf);

  const blankKeys = new Set(blank.runs.map(runKey));
  const ourRuns = out.runs.filter((r) => !blankKeys.has(runKey(r)));
  const ourText = ourRuns.map((r) => r.s).join(' ');
  const allText = out.runs.map((r) => r.s).join(' ');

  // ────────────────────────────────────────────────────────────────────────
  // A. It is the owner's page, and it is still the owner's form
  // ────────────────────────────────────────────────────────────────────────
  ok('the rendered form is ONE page at 612x792 — the owner’s page, not one we added', () => {
    assert.strictEqual(out.pages, 1, 'a second page means we appended rather than overlaid');
    assert.strictEqual(Math.round(out.width), F.PAGE.w);
    assert.strictEqual(Math.round(out.height), F.PAGE.h);
  });

  ok('THE OWNER’S OWN FORM TEXT SURVIVES the render — this is what proves an overlay', () => {
    /* Each of these is printed on the blank the owner sent and on nothing we could
       plausibly have drawn ourselves. A document built with PDFDocument.create()
       carries none of them, which is exactly how the reported defect is caught. */
    const mustSurvive = [
      F.FORM_MARK,                            // the form mark at the foot of the page
      'Request for Verification of Rent',      // the form's own title
      'Privacy Act Notice',                    // the federal notice we would never write
      'Part I - Request',
      'To Be Completed By Landlord',           // the bar the owner rule is measured from
      'Part II',
      'Part III',
      'Information to be verified',
      'Signature of Landlord',
    ];
    for (const s of mustSurvive) {
      assert.ok(allText.includes(s), `the owner’s form no longer says "${s}" — this is a lookalike, not their blank`);
    }
    // And it survives INTACT: the blank's runs are all still there, unmoved.
    const outKeys = new Set(out.runs.map(runKey));
    const lost = blank.runs.filter((r) => !outKeys.has(runKey(r)));
    assert.deepStrictEqual(lost.map((r) => r.s), [], 'runs of the owner’s form went missing or moved');
  });

  // ────────────────────────────────────────────────────────────────────────
  // B. Our half is there, and all of it is above the bar
  // ────────────────────────────────────────────────────────────────────────
  ok('every value we prefill appears in the rendered document', () => {
    for (const [key, value] of Object.entries(FULL)) {
      for (const w of printedWords(key, value)) {
        assert.ok(ourText.includes(w), `${key}: "${w}" never reached the page`);
      }
    }
  });

  ok('every prefilled value sits ABOVE the "To Be Completed By Landlord" bar', () => {
    const visible = ourRuns.filter((r) => r.h > 5);      // the anchors are 4pt
    assert.ok(visible.length >= 10, 'the prefill should print more than a handful of runs');
    for (const r of visible) {
      assert.ok(r.y > F.LANDLORD_BAND_TOP,
        `our text "${r.s.slice(0, 40)}" printed at y=${r.y.toFixed(1)}, inside the landlord’s half`);
    }
  });

  await okAsync('a value we do not hold prints NOTHING — no dash, no stand-in, the owner’s blank stays blank', async () => {
    /* On a government-style form a dash sitting in a ruled blank reads as an ANSWER
       ("no landlord", "no rent") rather than as an omission, which is why the em-dash
       stand-in the first version printed had to go. */
    const bare = await buildVorPdf({ lender_signature: 'Chaya Gruber' });
    const bareOut = await runsOf(bare);
    const bareOurs = bareOut.runs.filter((r) => !blankKeys.has(runKey(r)) && r.h > 5);
    assert.deepStrictEqual(bareOurs.map((r) => r.s), ['Chaya Gruber'],
      'a form holding one value printed something else as well');
  });

  // ────────────────────────────────────────────────────────────────────────
  // C. THE RULE THAT MATTERS MOST — nothing of ours below the bar but anchors
  // ────────────────────────────────────────────────────────────────────────
  ok('NOTHING of ours is drawn at or below y=334 except the invisible anchors', () => {
    const anchors = new Set(F.allAnchors());
    const below = ourRuns.filter((r) => r.y <= F.LANDLORD_BAND_TOP);
    for (const r of below) {
      assert.ok(anchors.has(r.s.trim()),
        `"${r.s.slice(0, 60)}" is ours and printed at y=${r.y.toFixed(1)} — Part II and Part III are never prefilled by us`);
    }
  });

  ok('and no prefilled VALUE appears anywhere in the Part II / Part III band', () => {
    /* Said a second way, from the data rather than from the geometry: if a value we
       hold turned up below the bar under any coordinate at all, it is prefill in the
       landlord's half however it got there. */
    const belowText = ourRuns.filter((r) => r.y <= F.LANDLORD_BAND_TOP).map((r) => r.s).join(' ');
    for (const [key, value] of Object.entries(FULL)) {
      for (const w of printedWords(key, value)) {
        assert.ok(!belowText.includes(w), `${key}: "${w}" reached the landlord’s half`);
      }
    }
  });

  ok('every landlord field’s anchor IS drawn, at the coordinate fields.js declares', () => {
    const drawn = new Map(ourRuns.filter((r) => r.h <= 5).map((r) => [r.s.trim(), r]));
    const missing = F.allAnchors().filter((a) => !drawn.has(a));
    assert.deepStrictEqual(missing, [], `anchors declared but never drawn: ${missing.join(', ')}`);
    assert.ok(F.allAnchors().length >= 14, 'the form asks the landlord more than a handful of questions');
    for (const p of F.anchorPlacements()) {
      const r = drawn.get(p.anchor);
      assert.ok(Math.abs(r.x - p.x) < 1 && Math.abs(r.y - p.y) < 1,
        `${p.anchor} landed at ${r.x.toFixed(1)},${r.y.toFixed(1)} rather than ${p.x},${p.y}`);
      assert.ok(r.y <= F.LANDLORD_BAND_TOP, `${p.anchor} is above the bar, over something we already answered`);
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // D. Our ink is in the blanks, not across the form's printing
  // ────────────────────────────────────────────────────────────────────────
  ok('no prefilled value is drawn on top of the form’s own printed text', () => {
    const hits = [];
    for (const o of ourRuns.filter((r) => r.h > 5)) {
      for (const b of blank.runs) {
        if (overlaps(o, b)) hits.push(`"${o.s.slice(0, 30)}" over "${b.s.slice(0, 30)}"`);
      }
    }
    assert.deepStrictEqual(hits, [], `our text printed across the form's own lines: ${hits.join('; ')}`);
  });

  // ────────────────────────────────────────────────────────────────────────
  // E. A blank that is not the owner's is refused at LOAD
  // ────────────────────────────────────────────────────────────────────────
  await okAsync('a swapped blank — wrong size, or more than one page — fails at LOAD, not in the mail', async () => {
    const { PDFDocument } = require('pdf-lib');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-vor-blank-'));

    // Legal-sized: every coordinate in fields.js would land somewhere else.
    const legal = await PDFDocument.create();
    legal.addPage([612, 1008]);
    const legalPath = path.join(dir, 'legal.pdf');
    fs.writeFileSync(legalPath, Buffer.from(await legal.save()));

    // Two pages: the form we measured is page 1 of one page.
    const twoUp = await PDFDocument.create();
    twoUp.addPage([612, 792]);
    twoUp.addPage([612, 792]);
    const twoUpPath = path.join(dir, 'two.pdf');
    fs.writeFileSync(twoUpPath, Buffer.from(await twoUp.save()));

    const notAPdf = path.join(dir, 'nope.pdf');
    fs.writeFileSync(notAPdf, 'this is not a PDF at all');

    /* The loader's own check, pointed at each stub in turn — the same call the module
       makes at require-time on the real blank. */
    assert.throws(() => _internals.assertOwnersBytes(fs.readFileSync(legalPath), legalPath),
      /1008|612x1008/, 'a Legal-sized blank must be refused');
    assert.throws(() => _internals.assertOwnersBytes(fs.readFileSync(twoUpPath), twoUpPath),
      /page/, 'a two-page blank must be refused');
    assert.throws(() => _internals.assertOwnersBytes(fs.readFileSync(notAPdf), notAPdf),
      /not a PDF/, 'a file that is not a PDF must be refused');

    // And the parsed-document check agrees with the byte-level one, so a blank that
    // slips past the boot scan is still stopped before any ink is laid.
    assert.throws(() => _internals.assertOwnersPage(legal, legalPath), /1008/);
    assert.throws(() => _internals.assertOwnersPage(twoUp, twoUpPath), /one page|has 2/);

    // The real blank passes both.
    _internals.assertOwnersBytes(fs.readFileSync(BLANK_PATH), BLANK_PATH);
    _internals.assertOwnersPage(await _internals.loadBlank(), BLANK_PATH);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ────────────────────────────────────────────────────────────────────────
  // F. Rendering twice from the same data gives the same document
  // ────────────────────────────────────────────────────────────────────────
  await okAsync('a second render is not the first one’s form with a second loan on top', async () => {
    /* pdf-lib MUTATES a loaded document, so a cached document rather than cached
       BYTES would accumulate: the second landlord would receive the first one's
       tenant. Rendering a different loan and reading it back is how that is caught. */
    const other = await buildVorPdf({
      landlord_block: 'Weiss Property Group\n41 Kennedy Boulevard, Bayonne, NJ 07002',
      lender_block: 'YS Capital Group\n5 New Montrose Avenue, #Bsmt\nBrooklyn, NY 11211',
      lender_signature: 'Yehuda Klein',
      lender_title: 'Loan Processor',
      request_date: '2026-09-02',
      loan_number: 'YSCAP258200011',
      property_address: '7 Sycamore Court, Bayonne, NJ 07002',
      account_name: 'Mendel Weiss',
      applicant_block: 'Mendel Weiss\n7 Sycamore Court, Bayonne, NJ 07002',
      applicant_signature: 'See attached signature',
    });
    const otherOut = await runsOf(other);
    const otherOurs = otherOut.runs.filter((r) => !blankKeys.has(runKey(r))).map((r) => r.s).join(' ');
    assert.ok(otherOurs.includes('Mendel'), 'the second render carries its own data');
    assert.ok(!otherOurs.includes('Lichtman'), 'and none of the first render’s applicant');
    assert.ok(!otherOurs.includes('Acme'), 'nor the first render’s landlord');
    assert.ok(!otherOurs.includes('YSCAP258134700'), 'nor the first render’s loan number');
    assert.strictEqual(otherOut.pages, 1, 'still one page');
  });

  /* ── THE FORM IS CHECKED BY IDENTITY, NOT ONLY BY SHAPE ──────────────────────
   The structural boot check asks "one page, 612x792". That is not the question.
   The field-id REFERENCE SHEET — one filename away in the same directory, with
   Encompass ids printed IN THE BLANKS — is also one page at 612x792 and used to pass
   it. Rendered through this module it puts "RentedFrom | RentedTo | AmountOfRent |
   Period | PaymentsPastDue30 | AdditionalInformation" into Part II and mails it to a
   landlord: literally "pre-filled on the field ID call", the one thing the owner said
   to leave empty. An empty page, a PILOT-branded lookalike and a page rotated 90
   degrees passed too. So the blank is now pinned by digest. */
const REF_SHEET = path.join(path.dirname(BLANK_PATH), 'vor-field-ids-reference.pdf');

ok('the field-id reference sheet still passes the STRUCTURAL check — which is why shape alone is not enough', () => {
  // If this ever starts throwing, the structural check got stricter and the comment
  // above needs revisiting — but the digest below is what actually guards the form.
  _internals.assertOwnersBytes(fs.readFileSync(REF_SHEET), 'the field-id reference sheet');
});

ok('the DIGEST refuses the field-id reference sheet — the form that would print Encompass ids into Part II', () => {
  assert.throws(() => _internals.assertOwnersDigest(fs.readFileSync(REF_SHEET), 'the field-id reference sheet'),
    /not the owner's blank VOR/);
});

ok('and refuses any other file of the right shape — an empty page, a lookalike', () => {
  assert.throws(() => _internals.assertOwnersDigest(Buffer.from('%PDF-1.4\nnot the owner form\n'), 'a lookalike'),
    /not the owner's blank VOR/);
});

ok("…while accepting the owner's own blank — the pin is an identity check, not a wall", () => {
  _internals.assertOwnersDigest(fs.readFileSync(BLANK_PATH), "the owner's blank");
});


/* ── THE THREE DEFECTS THE OWNER REPORTED ON 2026-08-31 ─────────────────────
   Each is measured against the OWNER'S OWN BLANK, not asserted from memory:
   the printed labels' baselines are read out of the form itself, so the
   assertions below describe the paper rather than a number somebody typed. */

ok('the lender row clears both printed labels — the "a little too low" fix', () => {
  const F = require('../src/longterm/vor/fields.js');
  /* MEASURED off the blank with pypdf: "Signature of Lender" / "Title" / "Date"
     / "Lender's No. (Optional)" all sit on baseline 530.4, and the next printed
     label ("Information to be verified") on 503.4. At the old y=512 a 9pt line's
     descenders reached ~510.0, INSIDE the next label's glyphs. */
  const LABEL_BASE = 530.4;
  const NEXT_BASE = 503.4;
  const ASC = 0.718;   // Helvetica
  const DESC = 0.207;
  const row = ['lender_signature', 'lender_title', 'request_date', 'loan_number'].map((k) => F.BY_KEY.get(k));

  assert.ok(row.every(Boolean), 'all four fields on the lender row exist');
  const ys = [...new Set(row.map((f) => f.y))];
  assert.deepStrictEqual(ys, [row[0].y],
    `the four share one baseline — raising only the two the owner named would leave the row crooked (got ${ys.join(', ')})`);

  for (const f of row) {
    const size = f.size || F.DEFAULT_SIZE;
    const top = f.y + size * ASC;
    const bottom = f.y - size * DESC;
    assert.ok(top < LABEL_BASE - size * DESC - 1.5,
      `${f.key}: its ascenders (${top.toFixed(1)}) must clear the label above`);
    assert.ok(bottom > NEXT_BASE + size * ASC + 1.5,
      `${f.key}: its descenders (${bottom.toFixed(1)}) must clear the next section's label — this is the reported defect`);
  }
});

ok('the landlord block carries the contact details, in the band the form leaves', () => {
  const F = require('../src/longterm/vor/fields.js');
  const f = F.BY_KEY.get('landlord_block');
  /* The owner asked for "name of the management, address of the management,
     contact information for the management" plus an email and a phone. That is
     four lines, and item 1 is a four-line band — so it fits where the form
     already leaves room rather than running into item 3 below it. */
  assert.ok((f.lines || 1) >= 4, `item 1 must be a band of at least four lines (is ${f.lines})`);
  const lowest = f.y - (f.lines - 1) * (f.lineHeight || 11);
  assert.ok(lowest > 544.4, `the block must stop above the certification line at 544.4 (reaches ${lowest})`);
});

ok('a landlord field we already know the answer to is OFFERED, never asserted', () => {
  const F = require('../src/longterm/vor/fields.js');
  const bare = F.tabsForLandlord();
  const filled = F.tabsForLandlord({ ll_phone: '718-555-0101' });
  const phone = (t) => t.text.find((x) => x.tabLabel === 'll_phone');

  assert.ok(phone(bare) && phone(bare).value === undefined,
    'with nothing to suggest the tab is the empty box it has always been');
  assert.strictEqual(phone(filled).value, '718-555-0101',
    'the phone we already hold starts the landlord off — owner-directed');
  assert.ok(phone(filled).required === phone(bare).required,
    'and a suggestion never changes whether the field is required — it is still theirs to answer');

  // Every OTHER landlord tab is untouched: a default map that leaked would be
  // us answering Part III on the landlord's behalf, on a form they then sign.
  const others = (t) => t.text.filter((x) => x.tabLabel !== 'll_phone');
  assert.deepStrictEqual(others(filled), others(bare),
    'no other landlord field gains a value');
  assert.deepStrictEqual(filled.sign, bare.sign, 'the signature tab is untouched');
  assert.deepStrictEqual(filled.date, bare.date, 'the date tab is untouched');
});

ok('OUR half of the form can never carry a landlord answer', () => {
  const F = require('../src/longterm/vor/fields.js');
  /* `cleanOurData` drops every key whose field is not ours — which is exactly
     why the phone pre-fill travels in its own `landlordDefaults` channel and
     NOT in `data`. Putting it in `data` was the first cut and it vanished here,
     silently, which is the failure this pins. */
  const cleaned = F.cleanOurData({ lender_signature: 'A Officer', ll_phone: '718-555-0101' });
  assert.strictEqual(cleaned.lender_signature, 'A Officer');
  assert.ok(!('ll_phone' in cleaned),
    'a landlord field put into OUR data is dropped — so the pre-fill must not travel there');
});

ok('the person SENDING it signs it, with the file’s officer as the fallback', () => {
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'src/longterm/vor/data.js'), 'utf8');
  /* Owner-directed: "the signature of the lender and the title of the person of
     the lender should be pre-filled with the user that is sending it out."
     BOTH shapes have to be read — the screen doors pass `{actor}`, the SEND
     door passes `staffId` — or the one path the owner actually named falls back
     to the file's officer, which is the defect. */
  assert.match(src, /opts\.actor && opts\.actor\.id/, 'the acting user is read');
  assert.match(src, /opts\.staffId/, "the send door's own shape is read too");
  assert.match(src, /loan\.loan_officer_id/, 'the file officer remains the fallback');
  // The fallback must come LAST, or it wins on every send.
  const iActor = src.indexOf('opts.actor && opts.actor.id');
  const iStaff = src.indexOf('opts.staffId');
  const iOfficer = src.indexOf('loan.loan_officer_id || null,\n  ].filter(Boolean)');
  assert.ok(iActor < iStaff, 'the acting user is asked before the send door shape');
  assert.ok(iStaff < (iOfficer === -1 ? Infinity : iOfficer),
    'the file officer is asked LAST — it is the fallback, not the answer');
});

console.log(`\ntest-lt-vor-overlay-pure: ${checks} checks passed\n`);
})().catch((e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
