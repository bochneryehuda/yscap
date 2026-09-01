'use strict';
/**
 * LONG-TERM TERM SHEETS — THE PILOT DESIGN, AS CONSTANTS.
 *
 * ⛔ THIS IS A CROSSING, AND IT IS AUTHORIZED IN WRITING. Owner-directed
 * 2026-08-30, in their own words: *"Everything should be in our pilot branding
 * the same way our RTL term sheet is. Follow the same kind of design that our
 * RTL term sheet have … Look at the design we have on the RTL. Try to bring in
 * that nice pilot design … Make sure to include our logos and our designs."*
 * Recorded in `docs/LONG-TERM-AUTHORIZED-COPIES.md`.
 *
 * ⛔ IT IS A COPY BY VALUE, NEVER AN IMPORT, and that is not a technicality.
 * `web/v2/tools/termsheet.js` is a FROZEN RTL pricing engine — the file that
 * draws the RTL sheet is the same file that prices an RTL bridge loan — so
 * requiring it would put a frozen engine on Long-Term's render path and would
 * break rule 4 of the two-product law outright. What crosses is the DESIGN: the
 * palette, the band geometry, the lockup, the shape of a disclosures page. What
 * does not cross is a single line of executable RTL logic.
 *
 * Every value below was READ OFF the RTL sheet (`header()`, `band()`, `rowIn`,
 * `para`, `disclosuresPage()`, `footer()`), so the two documents are the same
 * brand rather than two people's memory of it.
 *
 * PURE except for ONE lazy, cached, NEVER-THROWING read of the lockup PNG off
 * disk. A term sheet that fails to render is a term sheet that did not go out
 * and the officer was already told it was issued, so a missing or unreadable
 * asset degrades to the TEXT lockup and the sheet still prints.
 */

const fs = require('fs');
const path = require('path');

// ── the palette ─────────────────────────────────────────────────────────────
// Read off the RTL sheet's own constants, and every one of them is a DARK ink
// on white or a LIGHT ink on the dark band — never a `--ink*` token, which in
// this palette is a light PAPER colour and would render white on white.
const RGB = {
  INK: [0x14, 0x1b, 0x22],        // #141B22 — the header band, and body text
  TEAL: [0x2f, 0x7f, 0x86],       // #2F7F86 — section bands, disclosure headings
  GOLD: [0xae, 0x87, 0x46],       // #AE8746 — the rule under the band, accents
  GRAY: [0x4b, 0x58, 0x5c],       // #4B585C — labels, secondary text
  LINE: [0xdf, 0xd8, 0xcb],       // #DFD8CB — hairlines
  IVORY: [0xf8, 0xf5, 0xee],      // #F8F5EE — the accent row band
  SOFT: [0xf4, 0xf1, 0xea],       // table header ground
  PAPER: [0xf4, 0xf0, 0xe7],      // the identity line inside the dark band
  ONBAND: [0xb0, 0xb8, 0xba],     // muted text ON the dark band
  WHITE: [0xff, 0xff, 0xff],
  FAINT: [0x96, 0x9e, 0xa2],      // the footer's own disclaimer line
  FOOTNOTE: [0x3c, 0x42, 0x48],   // #3C4248 — the officer contact line in the footer
};

// ── the header band ─────────────────────────────────────────────────────────
// RTL: `doc.rect(0, 0, W, 76)` INK, `rect(0, 76, W, 2.2)` GOLD, a LINE hairline
// at 79.4, the lockup 30pt tall at (M, 23). Full-bleed on purpose — the band is
// the one element that runs edge to edge, which is what makes the sheet read as
// ours from across a desk.
/**
 * ⛔ THE BAND'S PROPORTIONS ARE THE APPROVED DESIGN'S, MEASURED OFF IT.
 *
 * It was the RTL sheet's, at 76pt deep with an 18pt title. The sketch's is
 * 74 CSS px — 55.5pt — with a 15pt title, and the extra 20pt it gives back is
 * spent as AIR between the band and the first line of content, which is where
 * the design does its breathing: *"a generous margin is an argument for the
 * importance of what sits inside it"*. Content therefore starts LOWER than
 * before (96, not 92) on a band that is shorter, which is not a contradiction
 * — the gap under the rule roughly trebles.
 *
 * Every baseline below is measured DOWN from the top of the paper, and every
 * one of them is inside `h` with its descender to spare.
 */
/*
 * ⛔ EVERY NUMBER BELOW IS MEASURED OFF THE APPROVED SKETCH, NOT CHOSEN.
 * `docs/longterm/design/` — the owner's own words are *"I expect the sheet to
 * look exactly as the sketch, exactly."* So these are read out of that PDF's own
 * geometry (`get_drawings` for the rules, span bounding boxes for the
 * baselines), and a number here that nobody can point at in the sketch is a
 * number somebody guessed.
 *
 * From the sketch, in points on a 612×792 page:
 *   dark band     0 .. 55.5
 *   gold rule     55.5 .. 57.0     (1.5 thick)
 *   hairline      58.5 .. 59.2     (0.7 thick, 1.5 of air above it)
 *   title top     12.4   serif bold 15.0, right-aligned at 567
 *   sub top       34.6   serif italic 6.45, gold
 *   identity top  46.5   sans 5.4, #B0B8BA
 *   first content 98.5   (the PREPARED FOR eyebrow)
 */
const BAND = {
  h: 55.5,        // the ink band
  rule: 1.5,      // the gold rule directly under it
  hair: 1.5,      // the air between the gold rule and the hairline
  hairW: 0.7,     // the hairline itself
  logoH: 23,      // the lockup's drawn height
  logoTop: 17,    // its top, measured DOWN from the top of the paper
  // BASELINES, measured DOWN from the top of the paper. The sketch gives the
  // TOP of each line, so each is its top plus its own size — which is why they
  // move if `SZ.band*` moves and must be read together with it.
  titleBase: 27.4,   // 12.4 + 15.0
  subBase: 41.1,     // 34.6 + 6.45
  idBase: 51.9,      // 46.5 + 5.4
  contentTop: 98.5,  // where page content starts under the band
};

// ── a section heading ───────────────────────────────────────────────────────
/**
 * ⛔ A SECTION HEADING IS A RULE AND A TICK, NEVER A FILLED BAR.
 *
 * It was a full-width TEAL rounded rectangle carrying white capitals — the RTL
 * sheet's own `band()`. Read beside the approved design it is the single
 * loudest thing on the page: four saturated bars, each shouting a heading, on a
 * document whose entire argument is the figures. Quiet Ledger's fourth rule is
 * *"colour carries one job each, and never two — a single saturated accent
 * reserved exclusively for STRUCTURE"*, and a filled bar the width of the
 * column is decoration wearing structure's clothes.
 *
 * So the design's own shape: a 1.8×6 teal TICK, the label in tracked ink
 * capitals beside it, and a 0.9pt ink rule under the pair. The accent still
 * marks every heading — it is simply spent on a tick rather than on 500 square
 * points of ink. Measured off `.sec` / `.tick` in the sketch (CSS px × 0.75).
 *
 * ⛔ THE IVORY GROUND IS NOT FREED BY THIS. It stays reserved for the one row
 * per group that RESOLVES the arithmetic — a total, a cash-to-close — which is
 * what teaches a reader, without being told, that a warm row is an answer.
 */
/*
 * MEASURED OFF THE SKETCH: the teal tick is (45, 247.5)–(46.5, 253.5), so 1.5
 * wide by 6 tall; the heading sets at x 52.4, so the gap from the tick is 5.9;
 * and the rule under it is 0.7 thick IN INK — not a hairline. That last one is
 * the difference between a heading that reads as a heading and one that reads
 * as another row: the rule under a section is the darkest line on the page.
 * The heading's baseline sits 10.0 above the rule (top 248.0, size 5.7, rule
 * 258.0), so `rulePad` is the gap from the BASELINE down to the rule.
 */
const SECTION = {
  tickW: 1.5, tickH: 6, gap: 5.9, tracking: 1, rule: 0.7, rulePad: 4.3,
};

/*
 * THE HEADLINE STAT BOX, measured off the sketch (612×792, content 45→567):
 *   box            175.5 .. 225.0     → 49.5 tall
 *   gold rule      175.5 .. 176.2     → 0.7 at the TOP
 *   hairline       224.2 .. 225.0     → 0.7 at the bottom
 *   dividers       174.8 / 306.0 / 436.5, 0.7, running the inner height
 *   cell pad-left  9.4
 *   label top      184.2  → 8.7 below the box top
 *   figure top     192.1  → 16.6
 *   caption top    208.8  → 33.3
 * `above` / `below` are the air the sketch leaves around it: the party block
 * ends at 156.9 and the first section tick is at 247.5.
 */
const STATS = {
  h: 49.5, rule: 0.7, padX: 9.4, tracking: 0.65,
  labelTop: 8.7, figureTop: 16.6, captionTop: 33.3,
  above: 18.6, below: 22.5,
};

/** The accent row's ivory band, and the hairline under every row. RTL `rowIn`. */
// The sketch draws every row hairline at 0.7 in #DED8CB — the same weight as
// the rule under a section, which is INK. Weight is not what separates them;
// colour is.
const ROW = { accentPad: 3, hair: 0.7 };

// ── the lockup ──────────────────────────────────────────────────────────────
const LOGO_PATH = path.join(__dirname, 'assets', 'pilot-lockup-light.png');
/** 560 × 273, RGBA — the same lockup the RTL sheet draws, light on transparent,
 *  which is why it belongs on the dark band and nowhere else. */
const LOGO_ASPECT = 560 / 273;

let _logo;   // undefined = not tried, null = tried and unavailable, Buffer = ready
/**
 * The lockup's bytes, or null.
 *
 * ⛔ NEVER THROWS AND NEVER RETRIES A FAILURE. A render must not be able to fail
 * on a decoration, and a per-page retry on a broken deployment would turn one
 * missing file into an I/O storm on every page of every sheet.
 */
function logoBytes() {
  if (_logo !== undefined) return _logo;
  try {
    const buf = fs.readFileSync(LOGO_PATH);
    // Proven to be a PNG before it is handed to the embedder: a truncated or
    // replaced file would otherwise throw INSIDE pdf-lib, past this module's
    // own guard, and take the whole document with it.
    _logo = buf.length > 8 && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a' ? buf : null;
  } catch {
    _logo = null;
  }
  return _logo;
}

// ── the words ───────────────────────────────────────────────────────────────

/**
 * THE DISCLOSURES PAGE — the same SHAPE as the RTL sheet's (a teal heading, a
 * short body, in a fixed order) and deliberately NOT the same TEXT.
 *
 * The RTL page describes a business-purpose BRIDGE loan: minimum earned
 * interest, a deferred origination fee at exit, construction draws. A long-term
 * DSCR rental loan has none of those and has several the bridge sheet has never
 * needed — escrows, flood, the rate lock, the prepayment schedule. Copying the
 * bridge wording onto a 30-year rental loan would put terms on a document that
 * are not the terms of the loan, which is worse than having no page at all.
 *
 * `when` decides whether an item applies to THIS sheet; a missing fact means the
 * item is silent rather than stated as an absence.
 */
const DISCLOSURES = [
  ['Business purpose only',
    'This loan is made solely for business, commercial or investment purposes and is NOT for personal, family '
    + 'or household (consumer) use. It is secured by non-owner-occupied residential investment property, is not '
    + 'subject to consumer-mortgage (TILA / RESPA) disclosures, and requires a personal guaranty and a '
    + 'first-lien position.'],
  ['How this loan qualifies',
    'This is a debt-service-coverage (DSCR) loan. It qualifies on the property\'s own rental income measured '
    + 'against the monthly housing cost — principal, interest, taxes, insurance and any association dues — not '
    + 'on personal income. The rent, taxes and insurance shown are the figures this sheet was worked out on; '
    + 'final figures come from the appraisal, the lease or market rent analysis, and the tax and insurance '
    + 'quotes obtained before closing.'],
  // ⛔ WORDED TO AVOID A "FROM <word>, <word>" SHAPE, DELIBERATELY. The
  // product-separation gate reads Long-Term source for SQL, and its comma-join
  // walker sees `from each guarantor, jointly` as `FROM <table>, <table>` — so
  // the natural phrasing failed the build claiming Long-Term reads an RTL table
  // called "jointly". The gate is not the thing to edit (never edit the gate);
  // "on a joint and several basis" is the same term of art and reads as prose to
  // both a lawyer and a parser. Keep new disclosure text clear of that shape.
  ['Personal guaranty / recourse',
    'Each guarantor gives a personal guaranty, on a joint and several basis, together with a standard '
    + 'non-recourse carve-out guaranty. The borrowing entity remains the obligor on the note.'],
  ['Rate and pricing',
    'The rate and the pricing on this sheet are indicative and are not locked. They move with the market and '
    + 'with the final verified credit score, property type, occupancy, lease status, loan amount and leverage. '
    + 'The rate is set when the loan is locked, in writing.'],
  ['Prepayment',
    'The prepayment terms shown apply if the loan is paid off — by sale or by refinance — during the '
    + 'prepayment period. They are part of the pricing: a shorter prepayment period generally carries a higher '
    + 'rate.', 'prepay'],
  ['Escrows and impounds',
    'Taxes and insurance are escrowed monthly with the payment unless an escrow waiver has been approved in '
    + 'writing. Where a waiver applies it is priced for and is shown on this sheet.'],
  ['Insurance',
    'The borrower shall provide hazard, liability and, where the property sits in a special flood hazard area, '
    + 'flood insurance, each in amounts and with carriers satisfactory to the lender, naming the lender as '
    + 'mortgagee and loss payee.'],
  ['Title',
    'The borrower shall provide a title report and a lender\'s title insurance policy satisfactory to the '
    + 'lender, in first-lien position, with coverage approved by the lender.'],
  ['Appraisal and property condition',
    'The loan is subject to an appraisal acceptable to the lender, and to the property being in rentable '
    + 'condition. A value, a rent or a condition that does not support the terms shown will change them.'],
  ['Due diligence',
    'The borrower will provide all necessary due diligence to the lender, including entity documents, credit '
    + 'authorization, leases, and asset verification.'],
  ['Legal fees and expenses',
    'The borrower shall be required to pay for all legal fees and services related to the loan transaction. '
    + 'The borrower shall additionally pay the lender underwriting and processing fees and all other '
    + 'applicable lender fees.'],
  ['Third-party costs',
    'Title, escrow, recording, appraisal, and any other third-party costs are NOT included in the figures on '
    + 'this sheet and are the borrower\'s responsibility.'],
  ['Disclaimer',
    'This term sheet does not set forth all of the terms of the loan contemplated hereunder. Additional terms '
    + 'and conditions may be set by the lender prior to closing. This term sheet is not a commitment to lend '
    + 'money and is subject to, among other things, the lender\'s sole discretion regarding the borrower\'s '
    + 'status, the property, the loan, title, and due diligence.'],
  ['Acknowledgement & indemnification',
    'By accepting these terms you confirm that you will not hold YS Capital Group and/or the lender liable for '
    + 'any damages related to their decision not to make the loan for any reason. You also confirm that you '
    + 'will indemnify and hold harmless YS Capital Group and the lender from any claims or liabilities related '
    + 'to this transaction.'],
];

module.exports = { STATS, RGB, BAND, SECTION, ROW, LOGO_PATH, LOGO_ASPECT, logoBytes, DISCLOSURES };
