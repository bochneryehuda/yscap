/**
 * LT TERM SHEETS — WHAT IS ACTUALLY ON THE PAPER.
 *
 * `test-lt-termsheet-pure.js` proves the RULES; this renders real PDF bytes and
 * reads them back, because two things about a document are facts about the
 * RENDER and nothing about the source can prove either:
 *
 *   ⛔ NOTHING DRAWS PAST ITS OWN MARGIN. The RTL side learned this the
 *     expensive way — a page that grew silently drew its rows through the
 *     footnote and off the sheet, on a document that had already gone out for
 *     signature. Every drawn string's box is read back and checked against all
 *     four margins, WITH ZERO TOLERANCE, and against the footer band.
 *
 *   ⛔ NO INVESTOR NAME REACHES THE PAGE (CLAUDE.md rule 10, the hard one). The
 *     snapshot's whitelist is defence (a); the renderer's scrub is defence (b),
 *     for a name a HUMAN typed into a label, an address or a programme name. So
 *     EVERY recorded spelling is pushed through the five free-text fields of a
 *     real term sheet and the extracted text is swept for it. A rule proven on
 *     the chokepoint is proven about a function; this is proven about the paper.
 *
 * The text is extracted with `unpdf`, which is already a production dependency.
 * NOTE its geometry is the AUTHORITY here and pdf-lib's is not: unpdf reports
 * the un-kerned advance a viewer uses, which is exactly the figure `pdf.js` was
 * corrected to measure by.
 */

import { createRequire } from 'node:module';
import { getDocumentProxy } from 'unpdf';

const require = createRequire(import.meta.url);
const snapshot = require('../src/longterm/termsheet/snapshot.js');
const layout = require('../src/longterm/termsheet/layout.js');
const pdf = require('../src/longterm/termsheet/pdf.js');
const investors = require('../src/longterm/encompass/investors.js');
const audience = require('../src/longterm/audience.js');
const brand = require('../src/longterm/termsheet/brand.js');
const fs = require('fs');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const SCENARIO = {
  purpose: 'Purchase', propertyType: 'Single family', value: 500000, loan: 375000,
  ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: 'NJ', city: 'Lakewood', zip: '08701',
  rentMonthly: 3900, taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0,
  prepayMonths: 60, prepayStructure: '5 Year',
};
const quote = (label, ratePct, rawPrice, extra) => Object.assign({
  label, consumerLabel: 'Platinum', product: '30-Year Fixed DSCR', mode: 'borrowerPaid',
  ratePct, rawPrice, scenario: SCENARIO, pricedAt: '2026-08-30T13:30:00.000Z',
}, extra || {});

async function render(selections, prepared, opts) {
  const built = snapshot.buildSnapshot({ selections, plan: PLAN, anchorIndex: 0, prepared: prepared || {} });
  if (!built.ok) throw new Error(`snapshot refused: ${built.error}`);
  const lay = layout.buildLayout(built.snapshot, { code: 'TS-4KH92B', expiryHours: 24, ...(opts || {}) });
  return pdf.renderTermSheet(lay);
}

/** Every drawn string with its box, page by page. */
async function readBack(bytes) {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const pages = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      items.push({
        s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height,
      });
    }
    pages.push(items);
  }
  return { pageCount: doc.numPages, pages, text: pages.map((p) => p.map((i) => i.s).join('')).join('\n') };
}

/** Every way a box can be in the wrong place. */
/**
 * ⛔ THE PAPER HAS THREE ZONES, AND A STRING MUST SIT WHOLLY INSIDE ONE OF THEM.
 *
 * The brand band and the footer are PAGE FURNITURE — drawn over every page after
 * the flow, deliberately outside the content box — so a single "inside the
 * margins" box would flag the document's own branding as a defect. What actually
 * must never happen is a string landing in NO zone: between the content floor and
 * the footer (content that grew through its own footer — the RTL failure this
 * whole renderer is built against), between the content ceiling and the band, or
 * off the paper entirely.
 *
 * The zones come from `pdf.ZONES`, not from numbers retyped here: a test carrying
 * its own copy of the layout passes the day the layout moves.
 */
function violations(pages) {
  const LEFT = pdf.M.left;
  const RIGHT = pdf.PAGE.w - pdf.M.right;
  const Z = pdf.ZONES;
  const zoneOf = (it) => {
    const bottom = it.y;
    const top = it.y + it.h;
    for (const [name, z] of Object.entries(Z)) {
      if (bottom >= z.bottom - 0.5 && top <= z.top + 2) return name;
    }
    return null;
  };
  const bad = [];
  pages.forEach((items, pi) => {
    for (const it of items) {
      const label = JSON.stringify(it.s.slice(0, 34));
      // The side margins hold in EVERY zone. Only filled rectangles bleed to the
      // paper edge, and a rectangle is not a string.
      if (it.x < LEFT - 0.01) bad.push(`p${pi + 1} past the LEFT margin at x=${it.x.toFixed(2)} — ${label}`);
      if (it.x + it.w > RIGHT + 0.01) bad.push(`p${pi + 1} past the RIGHT margin, ends ${(it.x + it.w).toFixed(2)} of ${RIGHT} — ${label}`);
      const zone = zoneOf(it);
      if (!zone) bad.push(`p${pi + 1} in NO zone — y=${it.y.toFixed(2)}..${(it.y + it.h).toFixed(2)} — ${label}`);
    }
    // Two strings on one line whose boxes overlap are two things printed on top
    // of each other. A 0.6pt tolerance ignores boxes that merely touch.
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        if (Math.abs(a.y - b.y) > 1.5) continue;
        if (a.x < b.x + b.w - 0.6 && b.x < a.x + a.w - 0.6) {
          bad.push(`p${pi + 1} OVERPRINT ${JSON.stringify(a.s.slice(0, 20))} over ${JSON.stringify(b.s.slice(0, 20))}`);
        }
      }
    }
  });
  return bad;
}

console.log('\nnothing draws past its own margin — on the paper, at zero tolerance');
{
  const LONG = 'Supercalifragilisticexpialidociousandthensomemorewithnospacesatall'.repeat(4);
  const cases = {
    'the documented three-option comparison': {
      sel: [quote('No points', 7.375, 102), quote('Buy the rate down', 6.875, 99.75), quote('Take the credit', 7.875, 103.75)],
      prep: {
        borrowerName: 'Jonathan Reyes', propertyAddress: '218 Forest Avenue, Lakewood, NJ 08701',
        officerName: 'Sara Klein', officerEmail: 'sara@yscapgroup.com', officerPhone: '(732) 555-0148',
        officerNmls: '1123456', companyName: 'YS Capital Group', companyNmls: '2609746',
        preparedAt: 'August 30, 2026', expiresAt: 'September 1, 2026',
      },
    },
    'a single offer': { sel: [quote('The offer', 7.375, 102)], prep: { borrowerName: 'Jonathan Reyes', officerName: 'Sara Klein' } },
    'the full eight options': {
      sel: [7.0, 7.125, 7.25, 7.375, 7.5, 7.625, 7.75, 7.875].map((r, i) => quote(`Option ${i + 1} with a deliberately long label`, r, 102 - (i - 3) * 0.5)),
      prep: {},
    },
    'workflow B — 70 against 80 LTV': {
      sel: [
        quote('70% LTV', 7.375, 102, { scenario: { ...SCENARIO, loan: 350000, ltv: 70 } }),
        quote('80% LTV', 7.625, 101.5, { scenario: { ...SCENARIO, loan: 400000, ltv: 80 } }),
      ],
      prep: {},
    },
    'hostile input — a name and an address nothing can encode or fit': {
      sel: [quote(LONG.slice(0, 120), 7.375, 102)],
      prep: {
        borrowerName: '李明 Émile Ünal 🏠',
        propertyAddress: LONG,
        officerName: 'Sara ≥ Klein → NMLS',
        companyName: 'YS Capital Group ✓',
      },
    },
    // A COMPARISON of hostile labels, which is the ONLY shape that puts an
    // officer's own 60 characters into a SECTION HEADING — a single-offer sheet
    // titles its detail page with the programme name, which is always short. The
    // heading is one line by design and is the one place the draw chokepoint's
    // own box is the only thing standing between a typed label and the margin.
    'hostile labels on a comparison — the section heading has nothing else to save it': {
      sel: [
        quote(LONG.slice(0, 60), 7.375, 102),
        quote(LONG.slice(10, 70), 6.875, 99.75),
      ],
      prep: { borrowerName: 'Jonathan Reyes', propertyAddress: LONG.slice(0, 90) },
    },
    'no code, no company, nothing prepared': { sel: [quote('x', 7.375, 102)], prep: {}, opts: {} },
    // A RIGHT-ALIGNED string is placed at `right − its own width`, so one that is
    // too wide is pushed off the LEFT edge rather than the right — the opposite
    // end from where anyone looks for it. The code is passed in by the caller, so
    // an absurd one is a real input and this is the path's own test rather than a
    // contrived one.
    'an absurd term sheet ID, which is right-aligned and would run off the LEFT': {
      sel: [quote('x', 7.375, 102)],
      prep: { companyName: 'YS Capital Group', companyNmls: 'N'.repeat(90) },
      opts: { code: `TS-${'W'.repeat(80)}` },
    },
  };
  let total = 0;
  for (const [name, c] of Object.entries(cases)) {
    // eslint-disable-next-line no-await-in-loop
    const back = await readBack(await render(c.sel, c.prep, c.opts));
    const bad = violations(back.pages);
    total += back.pages.reduce((n, p) => n + p.length, 0);
    check(bad.length === 0, `${name}: ${back.pageCount} page(s), every box inside its margins${bad.length ? `\n       ${bad.slice(0, 3).join('\n       ')}` : ''}`);
  }
  check(total > 500, `${total} drawn strings measured in total — enough for the check to mean something`);
}

console.log('\na long value is BROKEN onto more lines, never swallowed');
{
  // The two protections cover each other — a wrap that fails to break a
  // too-long token is caught by the draw chokepoint's clip, and vice versa — so
  // GEOMETRY ALONE cannot tell which of them is doing the work. This asks the
  // other question: is the value still THERE? A clip that swallowed it would
  // leave the page inside its margins and the address missing, which is the
  // failure a reader would actually notice.
  const RUN = 'Supercalifragilisticexpialidociousandthensomemorewithnospacesatall'.repeat(3);
  const back = await readBack(await render([quote('x', 7.375, 102)], { propertyAddress: RUN }));
  const flat = back.text.replace(/\s+/g, '');
  const longest = 'Supercalifragilisticexpialidocious';
  const occurrences = flat.split(longest).length - 1;
  check(occurrences === 3,
    `an unbreakable ${RUN.length}-character run is carried in FULL across the lines it needs (${occurrences} of 3 repeats survived) — never clipped away to fit`);
  check(!flat.includes('\u2026'), '…and nothing had to be replaced by an ellipsis to get there');
}

console.log('\nthe page says what the document says');
{
  const back = await readBack(await render(
    [quote('No points', 7.375, 102), quote('Buy the rate down', 6.875, 99.75), quote('Take the credit', 7.875, 103.75)],
    { borrowerName: 'Jonathan Reyes', officerName: 'Sara Klein', companyName: 'YS Capital Group', companyNmls: '2609746' },
  ));
  // ⛔ ASSERTED AS THE PROPERTY, NOT AS A PAGE COUNT. "One detail page each" is
  // the owner's "it's just adding pages to it"; a hard-coded 4 would fail the day
  // a disclosure paragraph gets one line longer, and would then be "fixed" by
  // bumping the number — which is how a real regression gets waved through.
  // Squashed AND case-folded: a section band is set in tracked capitals, which
  // pdf-lib emits one character per draw call, so the extracted run carries no
  // spaces and no lower case.
  const squash = (s) => s.replace(/\s+/g, '').toLowerCase();
  const pagesWith = (needle) => back.pages
    .map((items, i) => (squash(items.map((it) => it.s).join('')).includes(squash(needle)) ? i : -1))
    .filter((i) => i >= 0);
  const LABELS = ['No points', 'Buy the rate down', 'Take the credit'];
  const where = LABELS.map(pagesWith);
  // Every label appears on the COMPARISON page, in its table column — so the
  // detail page is the OTHER one it appears on. Asserting "the first page that
  // mentions it" would have been satisfied by the table alone and proved nothing
  // about the detail pages existing at all.
  check(where.every((p) => p.includes(0)), 'every option is named in the comparison table on page one');
  const details = where.map((p) => p.filter((i) => i > 0));
  check(details.every((p) => p.length >= 1), 'and every option has a page of its own beyond that table');
  const firsts = details.map((p) => p[0]);
  check(new Set(firsts).size === 3,
    `each option's detail page is its OWN — the owner's "it's just adding pages to it", literally (pages ${firsts.join(', ')} of ${back.pageCount})`);
  check(back.pageCount >= 4, `and the document runs to at least one page per option plus the comparison (${back.pageCount})`);
  const carries = (want) => back.text.includes(want.replace(/ /g, '')) || back.text.includes(want);
  for (const want of ['You pay $8,438 (2.250 pts)', 'You receive $6,563 (1.750 pts)',
    '67 months (5 years 7 months)', '51 months (4 years 3 months)', 'TS-4KH92B',
    `Page 1 of ${back.pageCount}`, `Page ${back.pageCount} of ${back.pageCount}`]) {
    check(carries(want), `the paper carries "${want}"`);
  }
  // ⛔ THE OWNER'S OWN BUG, ASSERTED ON THE PAPER. The sheet used to print
  //     At closing                       No points either way
  //     Origination fee (2.000 points)   $7,500
  // — two true lines and a document that contradicted itself, because the value
  // answered what the RATE costs while its label promised the whole closing
  // position. Only a rendered page can prove the pair is gone; a block-list test
  // cannot see what ended up printed next to what.
  check(carries('Cost to get this rate'),
    'the rate\'s own cost is labelled for what it is about — the rate');
  check(carries('Lender charges, net'),
    '…and the whole closing position is a separate figure with its own honest label');
  check(!/Atclosing.{0,40}Nopointseitherway/.test(back.text.replace(/\s+/g, '')),
    '…and the pair the owner read — a par phrase under a closing label — cannot occur');
  check(!/\b10[0-4]\.\d{2,3}\b/.test(back.text.replace(/,/g, '')),
    'and NO PRICE — 101.750 is a wholesale number with no meaning to a borrower, and teaching them one is the babysitting the owner ruled out');
  check(/not a commitment to lend/i.test(back.text), 'every page states that it is an estimate, not a commitment');
}


console.log('\nthe PILOT design is on every page — the band, the lockup, the footer');
{
  // ⛔ ONLY A RENDER CAN PROVE THIS. The band and the footer are page FURNITURE:
  // they are drawn over the whole page list after the flow, precisely so a page
  // the renderer adds mid-table cannot come out bare. A block-list test cannot
  // see a page the flow invented, which is the exact page at risk.
  const bytes = await render(
    [7.0, 7.125, 7.25, 7.375, 7.5].map((r, i) => quote(`Option ${i + 1}`, r, 102 - (i - 2) * 0.5)),
    {
      borrowerName: 'Jonathan Reyes', propertyAddress: '218 Forest Avenue, Lakewood, NJ 08701',
      officerName: 'Sara Klein', officerEmail: 'sara@yscapgroup.com', officerPhone: '(732) 555-0148',
      companyName: 'YS Capital Group', companyNmls: '2609746', preparedAt: 'August 30, 2026 9:14 AM',
    },
  );
  const back = await readBack(bytes);
  const Z = pdf.ZONES;
  const squash = (s) => s.replace(/\s+/g, '').toLowerCase();

  let bandless = [];
  let footerless = [];
  back.pages.forEach((items, i) => {
    const inBand = items.filter((it) => it.y >= Z.band.bottom);
    const inFoot = items.filter((it) => it.y + it.h <= Z.footer.top);
    if (!squash(inBand.map((it) => it.s).join('')).includes('comparisonsheet')) bandless.push(i + 1);
    if (!squash(inFoot.map((it) => it.s).join('')).includes('notacommitmenttolend')) footerless.push(i + 1);
  });
  check(back.pageCount >= 6, `a five-option comparison runs to ${back.pageCount} pages — enough for the check to mean something`);
  check(bandless.length === 0, `the brand band names the document on EVERY page (missing on ${bandless.join(', ') || 'none'})`);
  check(footerless.length === 0, `and the footer disclaims on EVERY page (missing on ${footerless.join(', ') || 'none'})`);

  // Every page numbers itself, and the count is the real one.
  let misnumbered = [];
  back.pages.forEach((items, i) => {
    if (!squash(items.map((it) => it.s).join('')).includes(squash(`Page ${i + 1} of ${back.pageCount}`))) misnumbered.push(i + 1);
  });
  check(misnumbered.length === 0, `every page numbers itself correctly (wrong on ${misnumbered.join(', ') || 'none'})`);

  // ⛔ THE LOCKUP IS ON THE PAPER, not merely referenced. The owner asked for it
  // by name — "Make sure to include our logos and our designs" — and an image
  // that failed to embed leaves a branded band with a hole in it, which reads as
  // a broken document rather than as a missing decoration.
  const raw = Buffer.from(bytes).toString('latin1');
  const images = (raw.match(/\/Subtype\s*\/Image/g) || []).length;
  check(images >= 1, `the lockup is embedded in the document (${images} image object(s))`);
  check(brand.logoBytes() && brand.logoBytes().length > 1000,
    'and the asset it comes from is a real PNG on disk, not a placeholder');

  // ⛔ AND IT DEGRADES RATHER THAN FAILING. A term sheet that will not render is
  // a term sheet that did not go out, and the officer was already told it was
  // issued — so an unreadable asset must cost the logo and nothing else.
  const realPath = brand.LOGO_PATH;
  const saved = fs.readFileSync(realPath);
  try {
    fs.writeFileSync(realPath, Buffer.from('not a png at all'));
    delete require.cache[require.resolve('../src/longterm/termsheet/brand.js')];
    delete require.cache[require.resolve('../src/longterm/termsheet/pdf.js')];
    const brand2 = require('../src/longterm/termsheet/brand.js');
    const pdf2 = require('../src/longterm/termsheet/pdf.js');
    check(brand2.logoBytes() === null, 'a corrupt lockup file is refused before it reaches the embedder');
    const lay = layout.buildLayout(snapshot.buildSnapshot({
      selections: [quote('The offer', 7.375, 102)], plan: PLAN, prepared: { borrowerName: 'Jonathan Reyes' },
    }).snapshot, { code: 'TS-4KH92B', expiryHours: 24 });
    const degraded = await pdf2.renderTermSheet(lay);
    const back2 = await readBack(degraded);
    check(back2.pageCount >= 1, 'the sheet still renders without it');
    check(squash(back2.text).includes('yscapital'),
      '…and the wordmark is SET IN TYPE instead, so the band is never a hole');
  } finally {
    fs.writeFileSync(realPath, saved);
    delete require.cache[require.resolve('../src/longterm/termsheet/brand.js')];
    delete require.cache[require.resolve('../src/longterm/termsheet/pdf.js')];
  }
}

console.log('\nthe owner\'s four items, on the paper');
{
  const squash = (s) => s.replace(/\s+/g, '').toLowerCase();
  const FULL = {
    borrowerName: 'Riverbend Holdings LLC', propertyAddress: '218 Forest Avenue, Lakewood, NJ 08701',
    officerName: 'Sara Klein', companyName: 'YS Capital Group', companyNmls: '2609746',
    preparedAt: 'August 30, 2026 9:14 AM', expiresAt: 'August 31, 2026 9:14 AM',
  };
  const ts = await readBack(await render([quote('The offer', 7.375, 102)], FULL, { expiryHours: 24 }));
  const flat = squash(ts.text);

  // (1) THE FULL PROPERTY ADDRESS AND THE PERSON'S NAME — the owner asked to be
  // able to put both on the sheet, and a term sheet is refused without them.
  check(flat.includes(squash('Riverbend Holdings LLC')), 'the borrower\'s name is on the paper');
  check(flat.includes(squash('218 Forest Avenue, Lakewood, NJ 08701')), 'and the full property address');

  // (2) PITI — "we also need to add something for principal, interest, taxes,
  // and insurance, only if the taxes and insurance were entered".
  check(flat.includes(squash('Total monthly payment (principal, interest, taxes & insurance)')),
    'the total monthly payment names all four things it is the total of');
  const bare = { ...SCENARIO, taxMonthly: null, insuranceMonthly: null };
  const noPiti = await readBack(await render(
    [quote('A', 7.375, 102, { scenario: bare }), quote('B', 6.875, 99.75, { scenario: bare })], FULL,
  ));
  check(!squash(noPiti.text).includes(squash('Total monthly payment')),
    '…and a sheet with no taxes and no insurance carries NO total — not a partial one wearing the right label');

  // (3) THE ORIGINATION FEE, BROKEN DOWN.
  check(flat.includes(squash('2.000 points of the $375,000 loan amount')),
    'the origination fee shows the multiplication that produced it');

  // (4) THE LENDER FEES, LISTED — so the waived column can be compared against
  // the charged one.
  const waived = await readBack(await render([
    quote('Pays the fees', 7.375, 102),
    quote('Fees waived', 7.875, 103.75, { mode: 'lenderPaid', waiveLenderFees: true }),
  ], FULL));
  const wflat = squash(waived.text);
  check(wflat.includes(squash('Application fee')) && wflat.includes(squash('Commitment fee')),
    'both lender fees are named on the paper');
  check(wflat.includes(squash('covered by the lender, not paid by you')),
    '…and the waived one says so, with what it would have been');
  check(wflat.includes(squash('Lender fees you are not paying')), '…and the saving is totalled');

  // (5) THE EXPIRY, in the owner's own unit.
  check(flat.includes(squash('This term sheet expires in 24 hours')),
    'the term sheet says it expires in 24 HOURS — the unit is the message');

  // (6) SIGNABLE, AND ONLY THE TERM SHEET.
  check(flat.includes(squash('Borrower / guarantor')), 'a term sheet has somewhere to sign');
  check(!wflat.includes(squash('Borrower / guarantor')),
    'and a comparison has none — a signature under two columns records agreement to nothing in particular');

  // (7) THE DISCLOSURES, on both.
  check(flat.includes(squash('Business purpose only')) && wflat.includes(squash('Business purpose only')),
    'both carry the disclosures page');
}

console.log('\nrule 10 — the investor name never reaches the paper');
{
  const spellings = [];
  for (const inv of investors.INVESTORS) {
    for (const raw of [inv.label].concat(inv.aliases || [])) if (raw) spellings.push(String(raw));
  }
  check(spellings.length > 100, `${spellings.length} recorded spellings to sweep — a hand-typed name is spelled many ways, and a "!== 'Deephaven'" check passes "Deepahven approval.pdf" straight through`);

  // ⛔ A DIFFERENTIAL SWEEP, NOT A SUBSTRING SEARCH — and the difference matters
  // more the more prose the document carries. A short alias is a substring of
  // ordinary English: "Roc" lives inside "p-roc-essing", which the disclosures
  // page says in "the lender underwriting and processing fees". A naive search
  // for the squashed needle therefore reports a leak on a page where the name was
  // scrubbed perfectly and the word "processing" simply exists — a FALSE POSITIVE
  // that would be "fixed" by shortening the guard, which is exactly how a real
  // leak gets waved through.
  //
  // So the same document is rendered TWICE: once with the investor's name in
  // every free-text field, once with a neutral placeholder of the same shape.
  // The boilerplate contributes identically to both, so any INCREASE in how often
  // the needle occurs is the injected name surviving — and nothing else can be.
  const sweepText = async (name) => {
    const back = await readBack(await render(
      [quote(`Sold to ${name} today`, 7.375, 102, { product: `${name} 30-Year Fixed` })],
      {
        borrowerName: `${name} Holdings LLC`,
        // ⛔ THE VESTING ENTITY IS SWEPT TOO, and it is the field most likely to
        // carry an investor's name by accident: an officer typing who the loan
        // is going into is one keystroke from typing who is buying it. It rides
        // `preparedFor` onto the "prepared for" line AND onto its own signature
        // line, so a leak here would reach the page twice.
        entityName: `${name} Capital Partners LLC`,
        propertyAddress: `1 ${name} Road, Lakewood, NJ`,
        officerName: 'Sara Klein',
        companyName: `YS Capital (${name})`,
      },
    ));
    // The extracted run has no spaces between items, so the name is sought in
    // the SQUASHED text — a name broken across two draw calls would otherwise
    // slip a naive search.
    return back.text.replace(/\s+/g, '').toLowerCase();
  };
  const occurrences = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);
  const CONTROL = 'Wexlaton';   // a word no investor is called and no prose contains
  const controlText = await sweepText(CONTROL);

  let leaked = 0;
  let first = null;
  for (const name of spellings) {
    const needle = name.replace(/\s+/g, '').toLowerCase();
    if (needle.length < 3) continue;
    // eslint-disable-next-line no-await-in-loop
    const flat = await sweepText(name);
    if (occurrences(flat, needle) > occurrences(controlText, needle)) {
      leaked += 1;
      if (!first) first = name;
    }
  }
  // ⛔ AND THE SWEEP IS PROVEN TO BITE. A differential that could never report a
  // leak would pass forever; the control name is not an investor, so it MUST
  // survive onto the page and be counted.
  check(occurrences(controlText, CONTROL.toLowerCase()) > 0,
    `the sweep can see an injected name at all — the control "${CONTROL}" reaches the page ${occurrences(controlText, CONTROL.toLowerCase())} times`);
  check(leaked === 0, `all ${spellings.length} spellings swept through five free-text fields of a real term sheet — none survived onto the page${first ? ` (first leak: ${first})` : ''}`);

  // And the sweep is only worth anything if it CAN see a leak.
  const control = await readBack(await render(
    [quote('Sold to CONTROLSENTINEL today', 7.375, 102)], { borrowerName: 'CONTROLSENTINEL Holdings' },
  ));
  check(control.text.replace(/\s+/g, '').toLowerCase().includes('controlsentinel'),
    '…and a sentinel word that is NOT an investor does reach the page, so the sweep is looking at real text and not at nothing');
  // ⛔ AND THE SAME PROOF FOR THE ENTITY, ON ITS OWN. Sweeping a field the page
  // never draws proves NOTHING — it would report "no leak" for ever while the
  // field went unscrubbed somewhere else. So the vesting entity is shown to
  // reach the paper under its own sentinel, separately from the borrower's name.
  //
  // ⛔ AND IT IS ASSERTED ON PAGE ONE SPECIFICALLY, not on "somewhere in the document". The entity
  // reaches the paper TWICE — the "prepared for" block on page 1 and its signature line on the
  // last — so a check for the word anywhere passes while the recipient block silently drops it.
  // MEASURED: unmutated it is on pages 1 and 3; with the PDF reverted to printing `borrowerName`
  // alone, page 1 loses it and the loose check still passed. Page one is the claim.
  const entityControl = await readBack(await render(
    [quote('The offer', 7.375, 102)], { entityName: 'ENTITYSENTINEL Capital LLC' },
  ));
  const entityOnPage1 = (entityControl.pages[0] || []).map((i) => i.s).join('')
    .replace(/\s+/g, '').toLowerCase().includes('entitysentinel');
  check(entityOnPage1,
    '…and the VESTING ENTITY is printed in the "prepared for" block on page one, so sweeping it sweeps a field the reader actually sees');
  check(audience.mentionsInvestor('Sold to Deephaven today'),
    'the ONE definition still recognises an investor — this suite never re-implements the check, it uses it');
}

console.log('\nthe compensation never reaches the paper — the OTHER hard invisibility rule');
{
  // ⛔ WHY THIS EXISTS. Owner-directed 2026-08-23: *"adding a charge on the fee breakdown
  // for two points origination only and keeping the YSP invisible. The lender-paid
  // compensation should always also be kept invisible on both of the sides."* That is as
  // hard a rule as rule 10 above, on the same document — and until 2026-08-30 it was
  // enforced by nothing. The behaviour was correct; a comment said so; no test held it.
  //
  // ⛔ THE ONE THING THAT IS *NOT* SECRET, and confusing the two is how this guard would be
  // written wrong: in BORROWER-PAID the comp IS the origination fee, so it MUST be printed.
  // What must never appear is the YSP, and the lender-paid comp in either position.
  //
  // The figures are deliberately odd (2.875 / 1.375 / 3.625) so a hit is unmistakable — a
  // plan of 2 / 0 / 2 would collide with ordinary prices, rates and term counts all over
  // the page and could not tell a leak from a coincidence.
  const SECRET_PLAN = { borrowerPaid: 2.875, ysp: 1.375, lenderPaid: 3.625, applicationFee: 1595, commitmentFee: 500 };
  const words = ['compensation', 'lender-paid', 'borrower-paid', 'yield spread', 'ysp', 'comp plan'];

  for (const [mode, price, waive] of [['borrowerPaid', 101.5, false], ['lenderPaid', 104, true]]) {
    const built = snapshot.buildSnapshot({
      selections: [quote('Lender A', 7.25, price, { mode, waiveLenderFees: waive })],
      plan: SECRET_PLAN, anchorIndex: 0, prepared: {},
    });
    if (!built.ok) { check(false, `a ${mode} sheet could be built (${built.error})`); continue; }
    const lay = layout.buildLayout(built.snapshot, { code: 'TS-COMP', expiryHours: 24 });
    const bytes = await pdf.renderTermSheet(lay);
    const { text } = await readBack(bytes);
    const low = text.toLowerCase();

    // The sweep is worth nothing if the page is empty or the fixture never priced.
    check(text.length > 2000 && text.includes('7.25'),
      `the ${mode} sheet really rendered (${text.length} characters, and it carries its own rate)`);
    check(!low.includes('1.375'),
      `the YSP never reaches a ${mode} page — the owner's "keeping the YSP invisible"`);
    check(!low.includes('3.625'),
      `and neither does the lender-paid compensation — "invisible on both of the sides"`);
    for (const w of words) {
      check(!low.includes(w), `and the page never says "${w}" on a ${mode} sheet`);
    }
    // THE OTHER DIRECTION, so this can never pass by rendering nothing: in borrower-paid
    // the comp IS the origination and MUST be on the page.
    if (mode === 'borrowerPaid') {
      check(low.includes('2.875') && /origination/i.test(text),
        'while the borrower-paid comp IS printed, as the origination fee it actually is — the sweep is reading a real fee list, not an empty page');
    } else {
      check(!low.includes('2.875'),
        'and on a lender-paid sheet there is no origination at all, so that figure is absent too');
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
