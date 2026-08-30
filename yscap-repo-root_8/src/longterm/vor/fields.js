'use strict';
/**
 * LONG-TERM — THE VERIFICATION OF RENT: WHAT THE OWNER'S OWN FORM ASKS, AND WHO
 * ANSWERS IT.
 *
 * THE FORM IS THE OWNER'S BLANK, NOT ONE OF OURS. `src/longterm/assets/blank-vor.pdf`
 * is the standard Request for Verification of Rent (form mark `GVOR_S 11/15`) — one
 * page, 612 x 792 pt, flat, no AcroForm fields. Every coordinate below was read off
 * THAT file and is written down in `docs/longterm/VOR-FORM-MAP.md`; this module is
 * the machine-readable half of that map. Nothing here describes a document we draw.
 *
 * ── THE RULE, IN THE OWNER'S WORDS (corrected 2026-08-30) ────────────────────
 *
 * An earlier reading of this had us "prefill part one and part two". THAT WAS WRONG
 * and the owner said so: *"You messed up by far. You're not using our blank VOR.
 * You're pre-filling some of the information from part two."* and *"the VOR needs to
 * be on the exact blank form that I sent you."*
 *
 * The corrected rule, which this file exists to enforce:
 *
 *   WE FILL IN ITEMS 1 THROUGH 9 — everything above the "To Be Completed By
 *   Landlord" bar. PART II AND PART III ARE NEVER PREFILLED BY US. Not partially,
 *   not helpfully, and not because `assets/vor-field-ids-reference.pdf` (the same
 *   form with Encompass field ids printed in the blanks) shows an id in one of those
 *   boxes. That sheet says where data COMES FROM; it is not a list of what gets
 *   printed. The owner: *"You leave empty even if it's pre-filled on the field ID
 *   call."*
 *
 * The bar is at y = 334 on the page, so the rule is a NUMBER rather than a habit:
 * every field we answer sits above it, every field the landlord answers sits at or
 * below it, and `assertBandsMatchWhoAnswers` below refuses to load a build where
 * that is not true. The overlay test then proves the same thing about the rendered
 * bytes.
 *
 * ── THE ANCHOR IS THE CONTRACT, AND IT IS DECLARED ONCE ─────────────────────
 *
 * A DocuSign anchor tab lands on a string PRINTED IN THE DOCUMENT. So the PDF and
 * the tab list are two halves of one mechanism, and the moment they are written in
 * two places they drift — the tab lands on the wrong line, or on nothing, and the
 * landlord is asked to sign a blank corner. Both read `anchor` from here, and the
 * test asserts every landlord field's anchor is actually drawn.
 *
 * ── WHY THERE IS ONE SIGNER, NOT TWO ────────────────────────────────────────
 *
 * A rent verification is a request WE make of a landlord, and the borrower's
 * permission to make it was given when they signed the application — which is what
 * the form's own "To Landlord:" paragraph cites, and why item 9 carries the words
 * "See attached signature" rather than a second signing ceremony. So the envelope
 * has ONE recipient: the landlord. Routing it through the borrower first would
 * double the turnaround on a submission-gating condition to collect a signature we
 * already hold.
 *
 * ── "REQUIRED" MEANS DOCUSIGN REFUSES TO FINISH WITHOUT IT ──────────────────
 *
 * A required tab is enforced by DocuSign in the signing session — the landlord
 * cannot press Finish while one is empty. That is the whole reason the blanks are
 * tabs rather than lines on a page: a form emailed as an attachment comes back with
 * whatever somebody felt like filling in, and chasing the rest is the work this is
 * meant to remove.
 *
 * SEPARATION: pure. Nothing here reads a table, a config value or another module.
 */

/** The owner's page. A blank of any other size moves every coordinate in this file,
    which is why `vor/pdf.js` refuses to load one. */
const PAGE = { w: 612, h: 792 };

/** The form's own mark, printed at the foot of the page. The overlay test looks for
    it in the RENDERED bytes: if it is gone we drew a lookalike instead of writing on
    the owner's blank, which is the exact defect the owner reported. */
const FORM_MARK = 'GVOR_S';

/**
 * The "To Be Completed By Landlord" bar, in PDF coordinates (bottom-up).
 *
 * This single number is the whole owner rule made mechanical: anything of ours that
 * prints at or below it is prefill in the landlord's half, and that is the one thing
 * this form may never contain. The only thing we put below the bar is an invisible
 * 4pt anchor, which is not an answer — it is where DocuSign hangs the empty box.
 */
const LANDLORD_BAND_TOP = 334;

/** The three parts, exactly as the form prints them. */
const PARTS = [
  {
    key: 'request',
    number: 'I',
    title: 'Request',
    who: 'us',
    blurb: 'Lender — complete items 1 through 8. Have applicant(s) complete item 9. '
      + 'Forward directly to the landlord named in item 1.',
  },
  {
    key: 'rent',
    number: 'II',
    title: 'Verification of Rent',
    who: 'landlord',
    blurb: 'The landlord’s own answers. We never fill in any of it, even where the '
      + 'field-id reference sheet shows an Encompass id in the blank.',
  },
  {
    key: 'signature',
    number: 'III',
    title: 'Authorized Signature',
    who: 'landlord',
    blurb: 'The landlord signs here. Left blank by us and required on DocuSign.',
  },
];

/**
 * The fields, in the form's own order and under the form's own item numbers.
 *
 * `who: 'us'`       — we print it, at (x, y), above the bar.
 * `who: 'landlord'` — nothing of ours is printed; an invisible anchor goes at (x, y)
 *                     and DocuSign hangs the tab on it.
 *
 * `tab` is the DocuSign tab type for the landlord's half:
 *   text | date | radio | sign | dateSigned
 *
 * `lines` > 1 marks a BAND rather than a rule — a box the form leaves several lines
 * of room in (the two address blocks, item 7, item 8). `pdf.js` wraps into it and
 * stops at `lines`; running past the band would print over the form's next printed
 * label, which on a government-style form reads as vandalism rather than an answer.
 */
const FIELDS = [
  // ── PART I — items 1 to 9. OURS, all of it, all above the bar ─────────────
  { key: 'landlord_block', part: 'request', who: 'us', item: '1',
    label: 'To (Name and address of landlord)',
    x: 60, y: 598, width: 240, lines: 4, lineHeight: 11, size: 9 },

  { key: 'lender_block', part: 'request', who: 'us', item: '2',
    label: 'From (Name and address of lender)',
    x: 320, y: 598, width: 240, lines: 4, lineHeight: 11, size: 9 },

  { key: 'lender_signature', part: 'request', who: 'us', item: '3',
    label: 'Signature of Lender',
    x: 60, y: 512, width: 115, size: 9 },

  { key: 'lender_title', part: 'request', who: 'us', item: '4',
    label: 'Title',
    x: 190, y: 512, width: 150, size: 9 },

  { key: 'request_date', part: 'request', who: 'us', item: '5', type: 'date',
    label: 'Date',
    x: 353, y: 512, width: 95, size: 9 },

  /* Item 6 prints "(Optional)" on the form itself, so it is optional HERE too — a
     missing loan number must not be what stops a landlord being asked about a
     tenancy. We do hold one on every long-term file, so in practice it prints. */
  { key: 'loan_number', part: 'request', who: 'us', item: '6', optional: true,
    label: 'Lender’s No. (Optional)',
    x: 467, y: 512, width: 90, size: 9 },

  /* ITEM 7 IS THE ADDRESS THE BORROWER RENTS — NOT THE SUBJECT PROPERTY. On a
     long-term file the subject is an investment property somebody else lives in, so
     printing it here would ask this landlord about a house they have never seen,
     and the answer would be "we have no such tenant". */
  { key: 'property_address', part: 'request', who: 'us', item: '7',
    label: 'Property Address',
    x: 49, y: 477, width: 250, lines: 3, lineHeight: 11, size: 9 },

  { key: 'account_name', part: 'request', who: 'us', item: '7',
    label: 'Account in the name of',
    x: 310, y: 477, width: 248, lines: 3, lineHeight: 11, size: 9 },

  { key: 'applicant_block', part: 'request', who: 'us', item: '8',
    label: 'Name and Address of Applicant(s)',
    x: 49, y: 393, width: 280, lines: 4, lineHeight: 10, size: 8.5 },

  /* ITEM 9 IS NOT A SIGNING CEREMONY. The applicant already signed the application
     that authorises this request, so the owner directed the words "See attached
     signature" onto the form's X-lines rather than a second DocuSign recipient. The
     two X-lines are the applicant and the co-applicant; the second prints only when
     there IS one, because an empty X-line is the form's own way of saying so. */
  { key: 'applicant_signature', part: 'request', who: 'us', item: '9',
    label: 'Signature of Applicant(s)',
    x: 356, y: 383, width: 200, size: 8.5 },

  { key: 'coapplicant_signature', part: 'request', who: 'us', item: '9', optional: true,
    label: 'Signature of Co-Applicant',
    x: 356, y: 356, width: 200, size: 8.5 },

  // ── PART II — the landlord's rental information. ALL BLANK, ALL BELOW 334 ──
  /* Every x below is "just past the form's own printed label", measured in the
     8pt Helvetica the blank is set in: e.g. "Tenant rented from" starts at x=49 and
     ends at 116.1, so the blank begins at 120. The one place the map quotes the
     LABEL position rather than the blank is the satisfactory Yes/No pair (444/493);
     those labels end at 456.7 and 503.2, so the buttons go at 460 and 506 by the
     same rule every other blank on this line follows. */
  { key: 'll_rented_from', part: 'rent', who: 'landlord', item: '10', tab: 'date',
    label: 'Tenant rented from', anchor: 'vor_ll_from',
    x: 124, y: 292, width: 84, height: 14 },

  { key: 'll_rented_to', part: 'rent', who: 'landlord', item: '10', tab: 'date',
    label: 'Tenant rented to', anchor: 'vor_ll_to',
    x: 224, y: 292, width: 84, height: 14 },

  /* AN EITHER/OR, NOT TWO BOXES. A pair of independent checkboxes lets a landlord
     tick both or neither and return a form that answers nothing; a radio group makes
     DocuSign enforce exactly one. The group name is the field key, which is what the
     answer comes back keyed by. */
  { key: 'll_satisfactory', part: 'rent', who: 'landlord', item: '10', tab: 'radio',
    label: 'Is account satisfactory?',
    options: [
      { value: 'Yes', anchor: 'vor_ll_sat_yes', x: 460, y: 292 },
      { value: 'No', anchor: 'vor_ll_sat_no', x: 506, y: 292 },
    ] },

  { key: 'll_rent_amount', part: 'rent', who: 'landlord', item: '10', tab: 'text',
    label: 'Amount of rent', anchor: 'vor_ll_rent',
    x: 127, y: 281, width: 120, height: 14 },

  { key: 'll_arrears', part: 'rent', who: 'landlord', item: '10', tab: 'radio',
    label: 'Is rent in arrears?',
    options: [
      { value: 'Yes', anchor: 'vor_ll_arr_yes', x: 155, y: 269 },
      { value: 'No', anchor: 'vor_ll_arr_no', x: 200, y: 269 },
    ] },

  /* The arrears AMOUNT and PERIOD are optional because they only exist when the
     answer above is Yes — demanding them would stop a landlord with nothing to
     report from ever pressing Finish. */
  { key: 'll_arrears_amount', part: 'rent', who: 'landlord', item: '10', tab: 'text',
    optional: true, label: 'Arrears amount', anchor: 'vor_ll_arr_amt',
    x: 127, y: 258, width: 100, height: 14 },

  { key: 'll_arrears_period', part: 'rent', who: 'landlord', item: '10', tab: 'text',
    optional: true, label: 'Arrears period', anchor: 'vor_ll_arr_period',
    x: 242, y: 258, width: 120, height: 14 },

  { key: 'll_late_12', part: 'rent', who: 'landlord', item: '10', tab: 'text',
    optional: true, label: 'No. of late payments past due 30 in the last 12 months',
    anchor: 'vor_ll_late12',
    x: 160, y: 235, width: 90, height: 14 },

  { key: 'll_additional', part: 'rent', who: 'landlord', item: '11', tab: 'text',
    optional: true,
    label: 'Additional information which may be of assistance in determination of credit worthiness',
    anchor: 'vor_ll_addl',
    x: 52, y: 206, width: 500, height: 30 },

  // ── PART III — the landlord's signature block. ALSO ALL BLANK ─────────────
  { key: 'll_signature', part: 'signature', who: 'landlord', item: '12', tab: 'sign',
    label: 'Signature of Landlord', anchor: 'vor_ll_sig',
    x: 52, y: 122 },

  { key: 'll_title', part: 'signature', who: 'landlord', item: '13', tab: 'text',
    label: 'Title (Please print or type)', anchor: 'vor_ll_title',
    x: 280, y: 122, width: 180, height: 14 },

  /* ITEM 14 IS STAMPED, NOT TYPED. A dateSigned tab is filled in by DocuSign from
     the signature itself (owner-directed), so a landlord cannot mistype the date
     they signed on, or back-date it. */
  { key: 'll_signed_on', part: 'signature', who: 'landlord', item: '14', tab: 'dateSigned',
    label: 'Date', anchor: 'vor_ll_dt',
    x: 485, y: 122 },

  { key: 'll_printed_name', part: 'signature', who: 'landlord', item: '15', tab: 'text',
    label: 'Please print or type name signed in item 12', anchor: 'vor_ll_printed',
    x: 52, y: 95, width: 200, height: 14 },

  { key: 'll_phone', part: 'signature', who: 'landlord', item: '16', tab: 'text',
    label: 'Phone No.', anchor: 'vor_ll_phone',
    x: 280, y: 95, width: 160, height: 14 },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** The fields WE fill in — the ones the preview lets a person edit. */
function ourFields() { return FIELDS.filter((f) => f.who === 'us'); }
/** The fields the LANDLORD answers — one DocuSign tab each, and no ink of ours. */
function landlordFields() { return FIELDS.filter((f) => f.who === 'landlord'); }

/**
 * PDF y is measured UP from the bottom of the page; a DocuSign tab's y is measured
 * DOWN from the top. Every coordinate in this file is the PDF one (it has to be —
 * it is where the ink goes), so the flip lives HERE, once, rather than as a `792 -`
 * somebody remembers to write at each call site and eventually forgets at one.
 */
function docusignY(yPdf) { return PAGE.h - Number(yPdf); }

/**
 * The anchor string as DocuSign searches for it, and as the PDF draws it — slashes
 * included. Returned from ONE place so the two can never be spelled differently.
 */
function anchorString(field) {
  if (!field || !field.anchor) return null;
  return `/${field.anchor}/`;
}

/** The same, for one option of a radio group. */
function optionAnchorString(option) {
  if (!option || !option.anchor) return null;
  return `/${option.anchor}/`;
}

/**
 * Everything the PDF must draw invisibly, and everything DocuSign will search for:
 * one string per landlord field, plus one per radio OPTION (a group with a missing
 * option anchor is a question with one answer, which is not a question).
 */
function allAnchors() {
  const out = [];
  for (const f of landlordFields()) {
    if (f.tab === 'radio') {
      for (const o of f.options || []) {
        const a = optionAnchorString(o);
        if (a) out.push(a);
      }
      continue;
    }
    const a = anchorString(f);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Where each anchor is DRAWN, so `pdf.js` never re-derives a coordinate and the
 * overlay test can check the ink landed where the map says it would.
 */
function anchorPlacements() {
  const out = [];
  for (const f of landlordFields()) {
    if (f.tab === 'radio') {
      for (const o of f.options || []) {
        out.push({ key: f.key, value: o.value, anchor: optionAnchorString(o), x: o.x, y: o.y });
      }
      continue;
    }
    out.push({ key: f.key, anchor: anchorString(f), x: f.x, y: f.y });
  }
  return out.filter((p) => p.anchor);
}

/**
 * The DocuSign tab list for the landlord, in the shared client's own shape.
 *
 * `sign` and `date` are bare anchor strings (a signHere and a dateSigned tab);
 * `text` and `radio` carry the rest of what the box needs. Every tab is REQUIRED
 * unless the field says otherwise, because an optional tab is a blank we then have
 * to chase — which is the work this form exists to remove.
 *
 * `yTop` rides along on every tab purely so the ONE bottom-up/top-down conversion is
 * visible in what we hand the provider, rather than implied.
 */
function tabsForLandlord() {
  const out = { sign: [], date: [], text: [], radio: [] };
  for (const f of landlordFields()) {
    if (f.tab === 'radio') {
      const radios = (f.options || [])
        .filter((o) => o.anchor)
        .map((o) => ({ anchor: optionAnchorString(o), value: o.value, yTop: docusignY(o.y) }));
      if (radios.length) out.radio.push({ group: f.key, required: !f.optional, radios });
      continue;
    }
    const anchor = anchorString(f);
    if (!anchor) continue;
    if (f.tab === 'sign') { out.sign.push(anchor); continue; }
    if (f.tab === 'dateSigned') { out.date.push(anchor); continue; }
    out.text.push({
      anchor,
      tabLabel: f.key,                 // what the answer comes BACK keyed by
      required: !f.optional,
      width: f.width || 180,
      height: f.height || 14,
      yTop: docusignY(f.y),
    });
  }
  return out;
}

/* A duplicate anchor puts two tabs on one line and leaves the other blank — a
   defect nobody sees until a landlord returns a half-filled form. It is a
   programming error, so it is caught at LOAD, not by a test somebody might not
   run. */
(function assertAnchorsUnique() {
  const seen = new Set();
  for (const a of allAnchors()) {
    if (seen.has(a)) throw new Error(`vor/fields: two fields share the anchor ${a}`);
    seen.add(a);
  }
})();

/* THE OWNER'S RULE, ENFORCED BY ARITHMETIC RATHER THAN BY CARE. A field of OURS
   whose y slipped at or below the "To Be Completed By Landlord" bar would print our
   text into the landlord's half — the exact defect the owner reported — and a
   landlord field that drifted above it would hang an empty DocuSign box over
   something we already answered. Neither is visible in a diff, so neither is left to
   a reviewer to notice. */
(function assertBandsMatchWhoAnswers() {
  for (const f of FIELDS) {
    const ys = f.tab === 'radio' ? (f.options || []).map((o) => o.y) : [f.y];
    for (const y of ys) {
      if (typeof y !== 'number' || !Number.isFinite(y)) {
        throw new Error(`vor/fields: ${f.key} has no y on the owner's page`);
      }
      if (f.who === 'us' && y <= LANDLORD_BAND_TOP) {
        throw new Error(`vor/fields: ${f.key} is ours but sits at y=${y}, inside the landlord's half (<= ${LANDLORD_BAND_TOP})`);
      }
      if (f.who === 'landlord' && y > LANDLORD_BAND_TOP) {
        throw new Error(`vor/fields: ${f.key} is the landlord's but sits at y=${y}, above the bar (> ${LANDLORD_BAND_TOP})`);
      }
    }
    if (f.who === 'landlord' && f.tab !== 'radio' && !f.anchor) {
      throw new Error(`vor/fields: ${f.key} is the landlord's and has no anchor, so DocuSign would never ask it`);
    }
  }
})();

/**
 * What is still missing before this can be sent.
 *
 * Only OUR fields are judged — the landlord's are blank BY DESIGN, which is the
 * whole point of the form. An `optional` field of ours is never demanded (a file
 * with one borrower has no co-applicant, and asking for one would be nonsense).
 *
 * Returns the field KEYS, so the screen can point at the box rather than printing a
 * sentence somebody has to translate back into a field.
 */
function missing(data) {
  const d = data || {};
  const out = [];
  for (const f of ourFields()) {
    if (f.optional) continue;
    const v = d[f.key];
    if (v == null || String(v).trim() === '') out.push(f.key);
  }
  return out;
}

/**
 * Keep only the fields this form actually has, and only OUR half.
 *
 * The editor posts an object; a key nothing recognises is DROPPED rather than
 * stored, and a LANDLORD key sent from our side is dropped too — filling in the
 * landlord's answer for them is the one thing a verification of rent may never do,
 * and the door is where that has to be refused rather than a rule somebody
 * remembers.
 */
function cleanOurData(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const f = BY_KEY.get(k);
    if (!f || f.who !== 'us') continue;
    if (v == null) { out[k] = null; continue; }
    out[k] = String(v).slice(0, (f.lines || 1) > 1 ? 400 : 200).trim();
  }
  return out;
}

module.exports = {
  PAGE, FORM_MARK, LANDLORD_BAND_TOP, PARTS, FIELDS, BY_KEY,
  ourFields, landlordFields, docusignY, anchorString, optionAnchorString,
  tabsForLandlord, allAnchors, anchorPlacements,
  missing, cleanOurData,
};
