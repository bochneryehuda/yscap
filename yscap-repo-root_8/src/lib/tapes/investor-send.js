'use strict';
/**
 * "SEND TO INVESTOR" — the data tape leaves by EMAIL, on a human's click, never
 * on autopilot (owner-directed 2026-08-18, verbatim: "a button to send this tape
 * to the investor … it should not work on autopilot yet. It should be manual").
 *
 * WHAT THE EMAIL IS, exactly:
 *   - subject  "New file for review - {loan number} - {property address}"
 *   - body     the deal in figures — purchase price (as-is value on a refinance),
 *              loan amount, construction holdback, interest reserve, rate,
 *              out-of-pocket rehab, and the three leverage ratios (initial LTV,
 *              ARV LTV, effective LTV) — each labelled with its own formula so an
 *              investor never guesses what a ratio is against. NO ORIGINATION FEE,
 *              ever (the owner named it as excluded; our fee income is not the
 *              investor's underwriting picture).
 *   - attaches ONLY the Excel tape. One attachment, structurally — the send takes
 *              a single {buf, filename, contentType} and builds the list itself.
 *   - To       the investor's people — at least ONE email or the send refuses.
 *              Addresses used here are SAVED per investor (the same
 *              investor_delivery_contacts book the draw delivery reads, keyed by
 *              investorKeyFor) so the next file offers them pre-listed.
 *   - Cc       the file's loan officer(s) + processor(s), visibly — a reply-all
 *              reaches the whole team.
 *   - Reply-To the file's own unique inbox (file+<id>@…), so the investor's reply
 *              threads into the file and fans out to the team through the
 *              existing file-inbox machinery. The address is also stated in the
 *              email body in words.
 *
 * THE GATES ARE THE EXPORT ROUTE'S OWN — the route runs the identical sequence
 * (permission, issuance backstop, Encompass tape gate, buyer/program match) via
 * the shared tapeExportGates helper before this module ever sees a buffer, so an
 * emailed tape can never leave a file the download button would refuse.
 */

const cfg = require('../../config');
const email = require('../email');
const template = require('../email/template');
const { fileReplyTo } = require('../file-address');
const investorSend = require('../../sitewire/investor-delivery-send');   // contactsForNoteBuyer / investorKeyFor

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

const usd = (n) => {
  // NULL/blank is UNKNOWN and is omitted, never "$0" — Number(null) is 0, which
  // is finite, so without this guard a missing column prints as a confident
  // zero-dollar figure in an email to an investor (audit 2026-08-18 finding 4;
  // the same money(null) rule lib/file-overview already applies). A genuine 0
  // still prints "$0".
  if (n == null || n === '') return null;
  const x = Number(n);
  return Number.isFinite(x) ? `$${Math.round(x).toLocaleString('en-US')}` : null;
};
const pct = (frac) => {
  // Every ratio here is a FRACTION (0.7 = 70%): the registered quote's
  // acqLtvPct/arvPct are engine fractions (pricing.normalize), and the effective
  // LTV is computed in this module. NO percent-form tolerance knee — the audit
  // (98b8fac #1) reproduced a $400k loan on a $100k lot printing "4%" instead of
  // 400% because a 1.5 knee read every ratio past 150% as already-in-percent.
  // A ground-up's loan routinely exceeds the lot's as-is value, so ratios far
  // past 1.5 are ordinary, and understating leverage to a capital partner is the
  // worst direction to be wrong in.
  const x = Number(frac);
  if (!Number.isFinite(x) || x <= 0) return null;
  return `${(Math.round(x * 100 * 100) / 100).toString()}%`;
};

/** "New file for review - {loan number} - {property address}" — the owner's exact shape.
 *  A missing loan number drops its segment rather than printing a blank dash. */
function subjectFor(app) {
  const loanNo = String(app.ys_loan_number || app.investor_loan_number || '').trim();
  const pa = app.property_address || {};
  const addr = String(pa.oneLine || pa.raw
    || [pa.line1, pa.city, [pa.state, pa.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    || '').trim();
  return ['New file for review', loanNo || null, addr || null].filter(Boolean).join(' - ');
}

/**
 * The deal in figures — PURE over the application row + the registered quote.
 * A figure that is unknown is OMITTED, never guessed or printed as $0; the
 * origination fee is deliberately absent (asserted by the test).
 */
function dealFigures(app, quote) {
  const s = (quote && quote.sizing) || {};
  // ONE definition of "sizes on the as-is value" — never a re-inlined /refi/ test
  // (the deal-basis house rule; behaviorally identical, structurally shared).
  const isRefi = require('../deal-basis').sizesOnAsIsValue(app.loan_type);
  const rows = [];
  const add = (label, value) => { if (value != null) rows.push({ label, value }); };

  if (isRefi) add('As-is value', usd(app.as_is_value));
  else add('Purchase price', usd(app.purchase_price));
  add('Loan amount', usd(s.totalLoan));
  add('Initial advance', usd(s.initialAdvance));
  add('Construction holdback', usd(s.rehabHoldback));
  add('Interest reserve (financed)', usd(s.financedReserve));
  // quote.noteRate is a FRACTION (0.10625) — rendered through the ONE rate
  // formatter (rate-format.fmtRatePct → "10.625"), never printed raw (the
  // audit 9a05513 class: a raw fraction reads "0.104%").
  add('Interest rate', quote && quote.noteRate != null && Number.isFinite(Number(quote.noteRate))
    ? `${require('../rate-format').fmtRatePct(quote.noteRate)}%` : null);
  // Out-of-pocket rehab: the applied exception amount when one exists, else the
  // plain arithmetic gap between the construction budget and what is financed.
  let oop = Number(s.oopRehab);
  if (!Number.isFinite(oop) || oop <= 0) {
    const budget = Number(app.rehab_budget), financed = Number(s.rehabHoldback);
    oop = (Number.isFinite(budget) && Number.isFinite(financed) && budget - financed > 0.5) ? budget - financed : 0;
  }
  add('Out-of-pocket rehab (borrower-funded)', oop > 0 ? usd(oop) : (rows.some((r) => /holdback/i.test(r.label)) ? '$0' : null));
  // The engine's acquisition denominator is min(price, as-is) on a purchase, so
  // the label says "acquisition value" — not "as-is value", which is wrong
  // whenever the price is the lower figure (audit 98b8fac note 7).
  add('Initial LTV (initial advance ÷ acquisition value)', pct(s.acqLtvPct));
  add('ARV LTV (total loan ÷ after-repair value)', pct(s.arvPct));
  // TOTAL LTC — the whole loan against the whole COST, which is the third leverage
  // figure this deal actually has (owner-directed 2026-08-21).
  //
  // It REPLACES a computed "Effective LTV (total loan ÷ as-is value)". That figure
  // divided the WHOLE loan — which finances the rehab — by a value that does NOT
  // include the rehab, so on any real construction deal it printed something like
  // 108% or 140% and described nothing: the owner's words were "It's a stupid
  // matrix … we need to add over there the total LTC and remove this other
  // effective LTV, which calculates the total loan amount according to the initial
  // and gets to 140 LTV."
  //
  // It is READ from the engine, never recomputed here. `sizing.ltcPct` is the
  // engine's own `totalLoan / costBasis`, and `costBasis` is the frozen
  // owner-authorized definition (2026-08-05): the LOWER of the purchase price and
  // the as-is value, plus the construction budget. That is the same number the
  // rate grid classifies the deal on, so the tape and the pricing can never state
  // two different LTCs — the "one definition, never a second copy" rule.
  add('Total LTC (total loan ÷ total cost)', pct(s.ltcPct));
  add('Total cost (acquisition + construction budget)', usd(s.costBasis));
  return rows;
}

const dedupe = (list) => {
  const seen = new Set();
  const out = [];
  for (const x of list) { const a = String(x || '').trim().toLowerCase(); if (a && !seen.has(a)) { seen.add(a); out.push(a); } }
  return out;
};

/**
 * An OPTIONAL address list (the extra Cc). Same address rules as the recipients,
 * and the same refusal wording for a bad one — but an EMPTY list is a valid
 * answer, which is the one thing that makes it different from `cleanRecipients`.
 */
function extraAddresses(list) {
  if (!Array.isArray(list) || !list.length) return { emails: [], problem: '' };
  const emails = [];
  for (const raw of list) {
    const m = String(raw == null ? '' : raw).trim().match(/<([^>]+)>\s*$/);
    const addr = (m ? m[1] : String(raw == null ? '' : raw)).trim().toLowerCase();
    if (!addr) continue;
    if (!EMAIL_RE.test(addr)) return { emails: [], problem: `"${addr}" is not a valid email address.` };
    emails.push(addr);
  }
  return { emails: dedupe(emails), problem: '' };
}

/** Validate + normalize a recipient list. Returns { emails, problem }. */
function cleanRecipients(list) {
  const seen = new Set();
  const emails = [];
  for (const raw of Array.isArray(list) ? list : []) {
    // Unwrap a pasted "Name <addr>" form.
    const m = String(raw == null ? '' : raw).trim().match(/<([^>]+)>\s*$/);
    const addr = (m ? m[1] : String(raw == null ? '' : raw)).trim().toLowerCase();
    if (!addr) continue;
    if (!EMAIL_RE.test(addr)) return { emails: [], problem: `"${addr}" is not a valid email address.` };
    if (!seen.has(addr)) { seen.add(addr); emails.push(addr); }
  }
  if (!emails.length) return { emails: [], problem: 'Add at least one investor email address before sending.' };
  return { emails, problem: '' };
}

/** The file's loan officer(s) + processor(s) — internal, active, with an address. */
async function teamCc(appId, db) {
  try {
    const r = await db.query(
      `SELECT DISTINCT lower(btrim(su.email)) AS email
         FROM application_assignees aa JOIN staff_users su ON su.id = aa.staff_id
        WHERE aa.application_id = $1 AND aa.removed_at IS NULL AND aa.role IN ('loan_officer','processor')
          AND su.is_active = true AND su.is_external = false AND NULLIF(btrim(su.email),'') IS NOT NULL
       UNION
       SELECT DISTINCT lower(btrim(su.email)) AS email
         FROM applications a JOIN staff_users su ON su.id IN (a.loan_officer_id, a.processor_id)
        WHERE a.id = $1 AND su.is_active = true AND su.is_external = false AND NULLIF(btrim(su.email),'') IS NOT NULL`,
      [appId]);
    return r.rows.map((x) => x.email).filter((e) => EMAIL_RE.test(e));
  } catch (_) { return []; }
}

/** Load what the compose screen needs. Returns { app, figures, subject, contacts, cc, replyTo }. */
async function previewTapeSend(appId, db) {
  const a = (await db.query(
    `SELECT a.id, a.ys_loan_number, a.investor_loan_number, a.property_address, a.loan_type,
            a.purchase_price, a.as_is_value, a.arv, a.rehab_budget, a.lender,
            pr.quote
       FROM applications a
       LEFT JOIN product_registrations pr ON pr.application_id = a.id AND pr.is_current
      WHERE a.id = $1 AND a.deleted_at IS NULL LIMIT 1`, [appId])).rows[0];
  if (!a) return null;
  // The TAPE desk's people, not the draw team's — two different conversations
  // with the same investor (db/602; owner-reported 2026-08-21).
  const contacts = await investorSend.contactsForNoteBuyer(a.lender, { purpose: 'tape' });
  return {
    app: a,
    subject: subjectFor(a),
    figures: dealFigures(a, a.quote || null),
    investor: { label: a.lender || null, key: investorSend.investorKeyFor(a.lender) },
    contacts: contacts.map((c) => ({ id: c.id, email: c.email, name: c.name || null, role: c.role || null })),
    cc: await teamCc(appId, db),
    replyTo: fileReplyTo(appId),
  };
}

/**
 * Save the addresses this send used under the file's investor, so the next file
 * for the same buyer offers them. Best-effort — a failed save never fails a send.
 */
async function saveRecipients(db, lenderLabel, emails, actorId) {
  const key = investorSend.investorKeyFor(lenderLabel);
  if (!key) return;
  for (const addr of emails) {
    try {
      // Saved against the TAPE list. A person already on the DRAW list keeps that
      // membership and GAINS this one (the array is added to, never replaced) —
      // one contact can genuinely handle both.
      await db.query(
        `INSERT INTO investor_delivery_contacts (label_norm, label, email, active, created_by, purposes)
         VALUES ($1,$2,$3,true,$4, ARRAY['tape']::text[])
         ON CONFLICT (label_norm, lower(email)) DO UPDATE
            SET active = true, updated_at = now(),
                purposes = CASE
                  WHEN 'tape' = ANY(investor_delivery_contacts.purposes) THEN investor_delivery_contacts.purposes
                  ELSE investor_delivery_contacts.purposes || 'tape'::text
                END`,
        [key, String(lenderLabel).trim(), addr, actorId || null]);
    } catch (_) { /* best-effort */ }
  }
}

/**
 * The send itself. `tape` = { buf, filename, contentType } from buildTape — the
 * ONE attachment. Throws {status, message} on a refusal; returns
 * { ok, to, cc, replyTo, subject } on success.
 */
async function sendTapeToInvestor(appId, db, { tape, to, cc: extraCc, note, actorId, actorName }) {
  const pre = await previewTapeSend(appId, db);
  if (!pre) { const e = new Error('file not found'); e.status = 404; throw e; }
  const { emails, problem } = cleanRecipients(to);
  if (problem) { const e = new Error(problem); e.status = 400; throw e; }
  // Extra people to copy, typed on the compose screen (owner-directed 2026-08-21:
  // "you need to give the option to CC more people"). OPTIONAL — an empty list is
  // fine here, unlike `to`, so it is validated with the same address rules but
  // never refused for being empty.
  const extra = extraAddresses(extraCc);
  if (extra.problem) { const e = new Error(extra.problem); e.status = 400; throw e; }
  if (!tape || !tape.buf || !tape.buf.length) { const e = new Error('The tape could not be built — nothing was sent.'); e.status = 500; throw e; }

  // The team rides as a VISIBLE Cc (never Bcc — a reply-all must reach everyone),
  // and the typed extras ride beside them. Deduped, and minus anyone already in
  // To — one person must never receive the same email twice.
  const cc = dedupe([...pre.cc, ...extra.emails]).filter((c) => !emails.includes(c));
  const replyTo = pre.replyTo || cfg.replyToDefault || null;

  const noteText = String(note || '').trim().slice(0, 2000);
  const figureLines = pre.figures.map((f) => `${f.label}: ${f.value}`);
  const bodyLines = [
    'Please find attached a new file for your review.',
    ...(noteText ? ['', noteText] : []),
    '',
    ...figureLines,
    '',
    // The "threads into the loan file" claim is only true of the PER-FILE inbox
    // (pre.replyTo, which exists only when CHAT_REPLY_DOMAIN is configured) —
    // never of the general Reply-To fallback, which lands in a shared mailbox
    // (audit 2026-08-18 minor: the body over-claimed threading; same gate the
    // compose modal already applies).
    pre.replyTo ? `Reply to this email and your response threads straight into the loan file (${pre.replyTo}).` : null,
  ].filter((x) => x != null);

  const rendered = template.render({
    title: 'New file for review',
    intro: 'Please find attached a new file for your review.' + (noteText ? ` ${noteText}` : ''),
    meta: pre.figures.map((f) => ({ label: f.label, value: f.value })),
    note: pre.replyTo ? `Reply to this email and your response goes straight to the loan file's team inbox (${pre.replyTo}).` : '',
    replyable: !!replyTo,
  });

  await email.sendMail({
    to: emails,
    cc: cc.length ? cc : undefined,
    replyTo,
    subject: pre.subject,
    text: bodyLines.join('\n'),
    html: rendered && rendered.html ? rendered.html : undefined,
    attachments: [{ filename: tape.filename, content: tape.buf.toString('base64'), contentType: tape.contentType }],
    _ctx: {
      applicationId: appId, type: 'tape_sent_to_investor', audience: 'staff',
      attachSummary: [{ what: 'data tape', filename: tape.filename, bytes: tape.buf.length }],
    },
  });

  await saveRecipients(db, pre.app.lender, emails, actorId);
  return { ok: true, to: emails, cc, replyTo, subject: pre.subject, sentBy: actorName || null };
}

module.exports = { subjectFor, dealFigures, cleanRecipients, extraAddresses, previewTapeSend, sendTapeToInvestor, saveRecipients, teamCc };
