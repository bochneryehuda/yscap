'use strict';
/**
 * LONG-TERM — SEND A BORROWER THE LOGIN-FREE LINK TO THEIR CONDITIONS.
 *
 * The owner asked for this surface on 2026-08-28 and named it while doing so:
 * *"another way for borrowers to manage their conditions if they're not so
 * technical. A more simple condition center for them, with an email directly
 * with links to upload and enter the information over there … without him being
 * able to set up an account or portal."* The 2026-08-30 share-the-code directive
 * then made the Condition Center ONE implementation for both products, so this
 * file is deliberately thin: the link, the jail, the expiry, the revocation and
 * the EMAIL ITSELF are all the shared module's, and what lives here is the two
 * things that are genuinely Long-Term's own — which loan, and which conditions.
 *
 * ── WHY THE EMAIL IS NOT REWRITTEN HERE ─────────────────────────────────────
 *
 * `buildOutstandingEmail` reads as short-term at a glance, and it is not: every
 * product-specific line in it is already keyed on the ITEM rather than on the
 * product. The Scope-of-Work line appears only for `toolKey === 'rehab_budget'`,
 * which no long-term condition carries, so it simply does not appear. Copying
 * the builder to change nothing but the sender would be the second copy the
 * owner rejected — and the copy is the one that stops getting the fix when the
 * shared one is improved.
 *
 * The WORDING that IS Long-Term's own — every condition's label and hint — is
 * already Long-Term's own, because it comes out of `read.forLoan` from the
 * long-term condition library. The email is a frame around the borrower's own
 * items; the items are what carry the voice.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * · It never sends to an address the caller supplies for a borrower it did not
 *   check — the recipient is resolved from the loan's own confirmed borrower.
 * · It never mints a link for a loan with nothing outstanding. A link is an
 *   instruction to do something; sending one that opens an empty list trains
 *   people to ignore the next one.
 * · It never throws for a reason a person can act on — every refusal comes back
 *   as `{ ok: false, reason }` in plain words.
 */

const db = require('../db');
const conditionLink = require('../../lib/condition-link');
const read = require('../conditions-center/read');

/** Register the long-term doors the moment anything here is used. */
require('./jail').register();

/** The bucket keys a client never sees are already filtered by `read.forLoan`
    (audience 'external'); what is left is "not finished yet". */
function outstandingFrom(list) {
  return (list || [])
    .filter((c) => !read.DONE.has(String(c.status || '')))
    .map((c) => ({
      // The shared email builder's own item shape. `kind: 'checklist'` is what
      // earns a condition its OWN direct link in the email — the owner's
      // *"every condition should have an upload button that takes them
      // directly to upload to that condition directly."*
      kind: 'checklist',
      id: c.id,
      label: c.label,
      detail: c.hint || null,
      /* NO `toolKey`, DELIBERATELY. The shared builder uses it for exactly one
         line — the Scope-of-Work / Investor Suite pointer, keyed on
         `rehab_budget`, which is a short-term construction concept no long-term
         condition carries. The long-term reader does not expose a tool key at
         all (it is selected and never mapped), so passing one would be a field
         that is always null pretending to mean something. Omitted, and said so
         here rather than left to look like an oversight. */
    }));
}

/**
 * What is still outstanding on this loan, in the BORROWER's own wording.
 * Never throws; an unreadable loan answers an empty list and says so.
 */
async function outstandingFor(loanId, client = db) {
  let view = null;
  try {
    view = await read.forLoan(loanId, { db: client, audience: 'client' });
  } catch (_) {
    return { ok: false, items: [], reason: 'PILOT could not read this loan’s conditions just now.' };
  }
  /* THE CONDITIONS LIVE INSIDE THE BUCKETS. `forLoan` returns
     `{ buckets, summary, degraded, audience }` and each bucket carries its own
     `conditions` — there is no top-level list. The first cut of this file read
     `view.conditions`, which is `undefined`, so every loan would have answered
     "nothing outstanding" and the email would have gone out empty while
     reporting success. Nothing would have errored. Flattened here, once. */
  const all = [];
  for (const b of (view && view.buckets) || []) {
    for (const c of (b && b.conditions) || []) all.push(c);
  }

  /* A DEGRADED READ IS NOT AN EMPTY ONE. `read.forLoan` answers `degraded` when
     it could not read everything, and treating that as "nothing outstanding"
     would send a borrower a link to an empty list — or, worse, tell the team
     the file is clear. Say we could not tell. */
  if (view && view.degraded) {
    return { ok: false, items: outstandingFrom(all), degraded: true,
      reason: 'PILOT could only partly read this loan’s conditions, so it will not send a list that may be short.' };
  }
  return { ok: true, items: outstandingFrom(all) };
}

// ---------------------------------------------------------------------------
// WHO IT GOES TO, AND WHAT THE DESK SEES BEFORE IT SENDS
// ---------------------------------------------------------------------------

/**
 * The loan, its borrower, its officer and its property — everything the shared
 * email builder asks for, read once.
 *
 * THE BORROWER'S ADDRESS IS PREFERRED FROM THE PROFILE, NOT THE MIRROR. A
 * long-term loan carries `borrower_email` copied from Encompass, and it goes
 * stale the moment somebody corrects the address on the person's record — which
 * is the record every other PILOT email already uses. The identity zone is
 * READ-ONLY to Long-Term (`sql-read borrowers`, authorized) and that is all this
 * does: read it. The mirror is the fallback for a loan nobody has linked yet.
 */
async function loadLoan(loanId, client = db) {
  const { rows } = await client.query(
    `SELECT l.id, l.loan_number, l.borrower_id, l.loan_officer_id,
            l.borrower_first_name, l.borrower_last_name, l.borrower_email,
            l.encompass_archived, l.archived_duplicate,
            p.street, p.city, p.state, p.zip,
            b.first_name AS profile_first, b.last_name AS profile_last, b.email AS profile_email,
            lo.full_name AS lo_name, lo.title AS lo_title, lo.email AS lo_email,
            lo.phone AS lo_phone, lo.cell AS lo_cell, lo.nmls AS lo_nmls
       FROM lt_loans l
       LEFT JOIN lt_properties p ON p.loan_id = l.id
       LEFT JOIN borrowers b ON b.id = l.borrower_id
       LEFT JOIN staff_users lo ON lo.id = l.loan_officer_id AND lo.is_active
      WHERE l.id = $1::uuid`,
    [String(loanId)],
  );
  return rows[0] || null;
}

/** The one-line property address, the same shape the orders desk renders. */
function propertyLine(l) {
  if (!l) return '';
  const tail = [l.city, [l.state, l.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [l.street, tail].filter(Boolean).join(', ');
}

/** The email address for this loan's borrower — profile first, mirror second. */
function borrowerEmail(l) {
  const fromProfile = String((l && l.profile_email) || '').trim().toLowerCase();
  if (fromProfile) return fromProfile;
  return String((l && l.borrower_email) || '').trim().toLowerCase();
}

/** Their first name, from whichever record actually holds one. */
function borrowerFirst(l) {
  return String((l && l.profile_first) || (l && l.borrower_first_name) || '').trim() || null;
}

/** The header block every built email shares. */
function emailData(l) {
  return {
    loanNumber: l.loan_number ? String(l.loan_number).toUpperCase() : '',
    propertyLine: propertyLine(l),
    firstName: borrowerFirst(l),
    officer: l.lo_name
      ? {
        name: l.lo_name,
        title: l.lo_title || 'Loan Officer',
        email: l.lo_email,
        phone: l.lo_cell || l.lo_phone || null,
        nmls: l.lo_nmls || null,
      }
      : null,
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * EVERY REASON THIS LOAN CANNOT BE SENT A LINK, in the words a person can act
 * on. Read at PREVIEW time so the desk sees them before pressing anything, and
 * again at SEND time so a file that went archived in between cannot slip
 * through — the screen's answer is never trusted for the write.
 *
 * A LOAN WITH NO CONFIRMED BORROWER IS THE ONE THAT SURPRISES PEOPLE. The guest
 * session is a real borrower-kind token whose subject IS the borrower's profile
 * id, so without one there is nothing to be signed in AS. That is the same
 * refusal `entity-profile.js` makes for the same reason, worded the same way.
 */
function blockers(l) {
  const out = [];
  if (!l) return ['That loan was not found.'];
  if (l.encompass_archived === true || l.archived_duplicate === true) {
    out.push('This loan is archived, so PILOT does not email its borrower from it.');
  }
  if (!l.borrower_id) {
    out.push('This loan is not linked to a borrower profile yet, so there is nobody to sign the link in as. Link the borrower first.');
  }
  if (!borrowerEmail(l)) {
    out.push('PILOT holds no email address for this borrower, so there is nowhere to send it.');
  }
  return out;
}

/**
 * THE PREVIEW — what would go out, to whom it could go, and every link already
 * sent on this loan. Never throws; an unreadable loan says so.
 */
async function outreachPreview(loanId, client = db) {
  let loan = null;
  try {
    loan = await loadLoan(loanId, client);
  } catch (_) {
    return { ok: false, status: 503, error: 'PILOT could not read this loan just now. Try again in a moment.' };
  }
  if (!loan) return { ok: false, status: 404, error: 'That loan was not found.' };

  const outstanding = await outstandingFor(loanId, client);
  const data = emailData(loan);

  // WHO IT CAN GO TO. The loan's own borrower, and nobody else by default — a
  // long-term loan has no co-borrower column and no helper roster of its own, so
  // inventing recipients here would be a business rule nobody stated. The desk
  // may still type an extra address, which is sent as the borrower's own view
  // and says so on the screen.
  const recipients = [];
  const be = borrowerEmail(loan);
  if (be) {
    recipients.push({
      email: be,
      name: [borrowerFirst(loan), loan.profile_last || loan.borrower_last_name].filter(Boolean).join(' ') || be,
      kind: 'borrower',
      borrowerId: loan.borrower_id || null,
      source: loan.profile_email ? 'profile' : 'encompass',
    });
  }

  let prior = [];
  try {
    prior = (await client.query(
      `SELECT id, sent_to_email, created_at, expires_at, revoked_at, last_used_at, use_count
         FROM condition_links WHERE lt_loan_id = $1::uuid ORDER BY created_at DESC LIMIT 12`,
      [String(loanId)],
    )).rows;
  } catch (_) { prior = []; }

  // The body exactly as the send builds it, with a placeholder where each
  // recipient's own secure button will go.
  let preview = null;
  try {
    const built = conditionLink.buildOutstandingEmail({
      items: outstanding.items, token: 'preview', data, note: '',
    });
    preview = { subject: built.subject, text: built.text };
  } catch (_) { preview = null; }

  return {
    ok: true,
    loanNumber: data.loanNumber || null,
    propertyLine: data.propertyLine || null,
    items: outstanding.items,
    itemsReadable: outstanding.ok === true,
    itemsReason: outstanding.ok ? null : outstanding.reason,
    recipients,
    prior,
    blockers: blockers(loan),
    linkDays: conditionLink.LINK_TTL_DAYS,
    preview,
  };
}

/**
 * THE SEND — one email per chosen address, each carrying its OWN link.
 *
 * ONE LINK PER RECIPIENT, NEVER ONE SHARED LINK. The token is a bearer
 * capability: sharing one across addresses means revoking it cuts everybody off
 * and `last_used_at` can never say who opened it. The short-term desk made the
 * same choice for the same reason.
 */
async function sendOutreach({ loanId, emails, note, actorId }, client = db) {
  const wanted = Array.from(new Set((Array.isArray(emails) ? emails : [])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter(Boolean)));
  if (!wanted.length) return { ok: false, status: 400, error: 'Pick at least one recipient.' };
  if (wanted.length > 8) return { ok: false, status: 400, error: 'Pick up to 8 recipients.' };
  for (const e of wanted) {
    if (!EMAIL_RE.test(e)) return { ok: false, status: 400, error: `"${e}" is not a valid email address.` };
  }

  let loan = null;
  try {
    loan = await loadLoan(loanId, client);
  } catch (_) {
    return { ok: false, status: 503, error: 'PILOT could not read this loan just now. Try again in a moment.' };
  }
  if (!loan) return { ok: false, status: 404, error: 'That loan was not found.' };

  // RE-CHECKED HERE, not trusted from the preview the screen fetched earlier.
  const blocked = blockers(loan);
  if (blocked.length) return { ok: false, status: 409, error: blocked[0], blockers: blocked };

  /* NOTHING OUTSTANDING SENDS NOTHING, and a read PILOT could only partly do
     sends nothing either. A link that opens an empty list teaches people to
     ignore the next one; a link built from a short list is worse, because it
     tells the borrower they are nearly finished when nobody knows that. */
  const outstanding = await outstandingFor(loanId, client);
  if (!outstanding.ok) {
    return { ok: false, status: 503, error: outstanding.reason || 'PILOT could not read this loan’s conditions just now.' };
  }
  if (!outstanding.items.length) {
    return { ok: false, status: 409, error: 'Nothing is outstanding for the borrower on this loan — there is nothing to send.' };
  }

  const data = emailData(loan);
  const cleanNote = typeof note === 'string' ? note.slice(0, 2000) : '';
  const email = require('../../lib/email');
  /* REPLY-TO IS THE OFFICER'S OWN ADDRESS. Long-Term has no per-file inbound
     thread address (the only long-term family is `ltorder+…`, which files a
     VENDOR's reply onto an order), so threading a borrower's reply onto the
     loan is not something this can honestly promise. Their officer is who they
     would reply to anyway; with no active officer the system's own monitored
     default applies, exactly as it does for every other email here. */
  const replyTo = loan.lo_email || undefined;

  const sent = [];
  const failed = [];
  for (const to of wanted) {
    try {
      const { token } = await conditionLink.mintLink({
        ltLoanId: String(loan.id),
        borrowerId: String(loan.borrower_id),
        email: to,
        createdBy: actorId || null,
      }, client);
      // Their own first name only when the address IS theirs; an extra address
      // the desk typed is greeted plainly rather than as the borrower.
      const firstName = to === borrowerEmail(loan) ? data.firstName : null;
      const built = conditionLink.buildOutstandingEmail({
        items: outstanding.items, token, data: { ...data, firstName }, note: cleanNote,
      });
      const r = await email.sendMail({
        to,
        subject: built.subject,
        html: built.html,
        text: built.text,
        replyTo,
        from: loan.lo_name && email.fromWithName ? email.fromWithName(loan.lo_name) : undefined,
        _ctx: { ltLoanId: String(loan.id), type: 'lt_conditions_outreach', audience: 'borrower' },
      });
      if (r && r.ok) sent.push(to);
      else {
        failed.push({
          email: to,
          reason: r && r.skipped
            ? 'Email sending is turned off in this environment.'
            : 'The email provider did not accept it.',
        });
      }
    } catch (_) {
      failed.push({ email: to, reason: 'The email could not be sent.' });
    }
  }

  if (!sent.length) {
    return { ok: false, status: 502, error: failed[0] ? failed[0].reason : 'Nothing could be sent.', failed };
  }
  return { ok: true, sent, failed, items: outstanding.items.length };
}

/**
 * REVOKE ONE LINK — the email was forwarded, or the deal moved on.
 *
 * SCOPED TO THE LOAN IN THE URL. Without the `lt_loan_id` term this would revoke
 * any link in the table by id, including a SHORT-TERM one, from a long-term
 * route — which is exactly the cross-product reach the separation rules exist to
 * stop. It is also why the row is matched rather than merely updated blind.
 */
async function revokeLink({ loanId, linkId, actorId }, client = db) {
  try {
    const r = await client.query(
      `UPDATE condition_links SET revoked_at = now(), revoked_by = $3
        WHERE id = $2::uuid AND lt_loan_id = $1::uuid AND revoked_at IS NULL
        RETURNING id, sent_to_email`,
      [String(loanId), String(linkId), actorId || null],
    );
    if (!r.rows[0]) return { ok: false, status: 404, error: 'That link was not found on this loan (or it is already revoked).' };
    return { ok: true, revoked: r.rows[0].id, email: r.rows[0].sent_to_email };
  } catch (_) {
    return { ok: false, status: 503, error: 'PILOT could not revoke that link just now. Try again in a moment.' };
  }
}


module.exports = {
  outstandingFor,
  outreachPreview,
  sendOutreach,
  revokeLink,
  _internals: { outstandingFrom, propertyLine, borrowerEmail, borrowerFirst, emailData, blockers, loadLoan },
};
