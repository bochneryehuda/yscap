'use strict';
/**
 * LONG-TERM — THE VERIFICATION OF RENT DESK.
 *
 * Owner-directed 2026-08-30, in their own words: *"the VOR needs to be on the exact
 * blank form that I sent you … leave the landlord's sections blank and required on
 * DocuSign … be able to preview and edit the PDF before sending … send by DocuSign,
 * by email attachment, or both … and if it comes back filled in by hand, void the
 * envelope."* The form is items 1 to 9 of the owner's own blank and nothing below
 * the "To Be Completed By Landlord" bar — see `vor/fields.js` for the corrected
 * rule and why the first reading of it was wrong.
 *
 * ── THE PREVIEW IS THE DOCUMENT ─────────────────────────────────────────────
 *
 * `preview()` and `send()` render from the SAME data through the SAME builder, so
 * "what you saw is what went out" is a property of the arrangement rather than a
 * promise. Nothing stores a rendered PDF as the source of truth.
 *
 * ── EVERY ANCHOR IS PROVEN PRESENT BEFORE ANYTHING IS SENT ──────────────────
 *
 * A DocuSign anchor tab lands on a string printed in the document, and the shared
 * client sets `anchorIgnoreIfNotPresent: 'true'` — right for its own optional tabs
 * and exactly wrong here, because a missing anchor would silently drop a REQUIRED
 * question and the landlord would return a form with a blank we then have to chase.
 * So `send()` renders the PDF, reads the text back out of it, and REFUSES when an
 * anchor is missing. It fails closed: a document we cannot read is not one we send.
 *
 * ── A MANUAL RETURN VOIDS THE ENVELOPE, AND THE RECORD SURVIVES THE PROVIDER ─
 *
 * The owner's reason is the rule: there must never be a second, half-signed copy in
 * flight. So recording a manual return voids every envelope still out. The void is
 * recorded in OUR row FIRST and the provider is told after: if DocuSign is
 * unreachable the return is still recorded and the envelope still reads as voided
 * here, with the failure kept on the row — the opposite order would let an outage
 * lose the fact that a person filled the form in.
 *
 * SEPARATION: lt_* on the long-term pool, plus three authorized shared modules —
 * the DocuSign transport, the mail sender (through the orders desk) and storage.
 */
const db = require('../db');
const cfg = require('../config');
const docusign = require('../../lib/integrations/docusign');
const F = require('./fields');
const { buildVorPdf } = require('./pdf');
const vorData = require('./data');
const orders = require('../orders/desk');

const FILENAME = 'verification-of-rent.pdf';
const SUBJECT = 'Verification of rent';

/** The envelope states that are still OUT — the ones a manual return must stop. */
const LIVE_ENVELOPE = ['created', 'sent', 'delivered'];

/** Is DocuSign wired up at all? A desk that offers a button nothing can answer is
    worse than one that says the feature is not configured. */
function docusignReady() {
  try { return !!docusign.configured(); } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/**
 * The form's current data: the prefill, with whatever a person has edited on top.
 *
 * The row is created lazily on first SAVE, never on read — a read that writes is a
 * read that cannot be done from a report or a screen refresh.
 */
async function loadForm(loanId, client = db) {
  const id = String(loanId);
  const pre = await vorData.prefill(id, client);
  if (!pre) return null;
  let row = null;
  try {
    row = (await client.query(
      `SELECT id, data, reviewed_by, reviewed_at, updated_at FROM lt_vor_forms WHERE loan_id = $1::uuid`,
      [id])).rows[0] || null;
  } catch (e) {
    // An unreadable saved form must never be silently replaced by the prefill —
    // that would show a processor their own corrections gone and invite them to
    // type them again over the top.
    return { unreadable: [...(pre.unreadable || []), 'saved_form'], data: pre.data, prefill: pre.data, landlord: pre.landlord, borrowerRents: pre.borrowerRents, saved: null };
  }
  const saved = (row && row.data) || {};
  return {
    formId: row ? row.id : null,
    data: vorData.mergeSaved(pre.data, saved),
    prefill: pre.data,
    saved,
    reviewedAt: row ? row.reviewed_at : null,
    reviewedBy: row ? row.reviewed_by : null,
    landlord: pre.landlord,
    borrowerRents: pre.borrowerRents,
    unreadable: pre.unreadable || [],
  };
}

/**
 * Save the edits.
 *
 * ONLY our own fields are stored (`cleanOurData` drops a landlord key at the door —
 * answering for the landlord is the one thing a rent verification may never do),
 * and the write is an UPSERT on the unique index rather than a read-then-insert:
 * two processors opening the desk at the same moment both read "no form yet", and
 * the loser of that race is the edit that disappears.
 */
async function saveForm(loanId, raw, staffId, client = db) {
  const id = String(loanId);
  const data = F.cleanOurData(raw);
  const row = (await client.query(
    `INSERT INTO lt_vor_forms (loan_id, data, reviewed_by, reviewed_at)
     VALUES ($1::uuid, $2::jsonb, $3, now())
     ON CONFLICT (loan_id) DO UPDATE
        SET data = lt_vor_forms.data || EXCLUDED.data,
            reviewed_by = EXCLUDED.reviewed_by,
            reviewed_at = now(),
            updated_at = now()
     RETURNING id, data`,
    [id, JSON.stringify(data), staffId || null])).rows[0];
  return { ok: true, formId: row.id, data: row.data };
}

/** Render the form as it stands. Same builder, same data as the send. */
async function preview(loanId, client = db) {
  const form = await loadForm(loanId, client);
  if (!form) return null;
  const pdf = await buildVorPdf(form.data);
  return { pdf, filename: FILENAME, data: form.data, missing: F.missing(form.data) };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Everything that would stop a send, as CODES — the screen turns them into
 * sentences beside the field they belong to rather than printing one long
 * paragraph a person has to translate back.
 */
const BLOCKER_TEXT = {
  file: 'This loan could not be read, so nothing was sent.',
  unreadable: 'Part of this file could not be read just now, so the form may be short a detail. Try again in a moment.',
  fields: 'Some of our own answers are still blank. Fill them in on the form above.',
  landlord: 'There is no landlord on this file yet. Add their contact details first.',
  landlord_email: 'The landlord has no email address on their card, so there is nowhere to send this.',
  docusign_off: 'DocuSign is not connected on this deployment, so the form can only go as an email attachment.',
  anchors: 'The form did not render its signature markers, so DocuSign would ask the landlord for nothing. Nothing was sent.',
  in_flight: 'A form is already out with this landlord. Void it first, or record what came back.',
};

/** What is stopping a send of this method, in order of what a person fixes first. */
function blockersFor({ form, method, envelopes }) {
  const out = [];
  if (!form) return ['file'];
  if ((form.unreadable || []).length) out.push('unreadable');
  if (F.missing(form.data).length) out.push('fields');
  const ll = form.landlord;
  if (!ll) out.push('landlord');
  else if (!ll.email) out.push('landlord_email');
  if ((method === 'docusign' || method === 'both') && !docusignReady()) out.push('docusign_off');
  if ((envelopes || []).some((e) => LIVE_ENVELOPE.includes(e.status))) out.push('in_flight');
  return out;
}

/** Read every anchor back OUT of the rendered PDF. Fails closed: a document we
    cannot read is one we do not send. `unpdf` is an ordinary npm dependency, so
    this needs no crossing and no dynamic require. */
async function anchorsPresent(pdf) {
  let text = '';
  try {
    const { extractText } = require('unpdf');
    const r = await extractText(new Uint8Array(pdf), { mergePages: true });
    text = String((r && r.text) || r || '');
  } catch (e) {
    return { ok: false, missing: F.allAnchors(), reason: 'unreadable' };
  }
  const missing = F.allAnchors().filter((a) => !text.includes(a));
  return { ok: missing.length === 0, missing };
}

/**
 * Send the form.
 *
 * @param {object} opts
 *   method  'docusign' | 'email' | 'both'   (the owner's three)
 *   staffId who pressed it
 *   from    { name, email } — the person the email comes FROM (send-as-user)
 */
async function send(loanId, opts = {}) {
  const client = opts.db || db;
  const id = String(loanId);
  const method = ['docusign', 'email', 'both'].includes(opts.method) ? opts.method : null;
  if (!method) return { ok: false, reason: 'method', message: 'Choose DocuSign, email, or both.' };

  const form = await loadForm(id, client);
  const envelopes = await listEnvelopes(id, client);
  const blockers = blockersFor({ form, method, envelopes });
  if (blockers.length) {
    return { ok: false, reason: blockers[0], blockers, message: BLOCKER_TEXT[blockers[0]] || 'This cannot be sent yet.' };
  }

  const pdf = await buildVorPdf(form.data);

  // The anchor proof runs for BOTH docusign and both — and deliberately not for an
  // email-only send, where there are no tabs and the landlord fills the blanks in
  // by hand.
  if (method !== 'email') {
    const anchors = await anchorsPresent(pdf);
    if (!anchors.ok) {
      return { ok: false, reason: 'anchors', blockers: ['anchors'], missing: anchors.missing, message: BLOCKER_TEXT.anchors };
    }
  }

  const result = { ok: true, method, docusign: null, email: null };

  if (method === 'docusign' || method === 'both') {
    result.docusign = await sendEnvelope({ loanId: id, form, pdf, method, staffId: opts.staffId, client });
    if (!result.docusign.ok) return { ok: false, reason: 'docusign', message: result.docusign.message, docusign: result.docusign };
  }

  if (method === 'email' || method === 'both') {
    result.email = await sendAttachment({ loanId: id, form, pdf, from: opts.from, staffId: opts.staffId, force: !!opts.force });
    // An email that fails after the envelope went out is NOT a failed send: the
    // landlord already has the signable copy. It is reported, never rolled back —
    // voiding a live envelope because a courtesy copy bounced would be worse.
    if (!result.email.ok && method === 'email') {
      return { ok: false, reason: 'email', message: result.email.message, email: result.email };
    }
  }

  return result;
}

/** Create + send the DocuSign envelope. */
async function sendEnvelope({ loanId, form, pdf, method, staffId, client }) {
  const ll = form.landlord || {};
  /* CLAIM FIRST, SEND SECOND. The row exists before the provider is called, so a
     response we never see leaves a row we can reconcile rather than a landlord who
     has the form and a desk that thinks nothing was sent. */
  const claim = (await client.query(
    `INSERT INTO lt_vor_envelopes (loan_id, form_id, status, recipient_name, recipient_email, send_method, sent_by)
     VALUES ($1::uuid, $2, 'created', $3, $4, $5, $6)
     RETURNING id`,
    [loanId, form.formId || null, ll.name || null, ll.email || null,
      method === 'both' ? 'both' : 'docusign', staffId || null])).rows[0];

  const tabs = F.tabsForLandlord();
  let def;
  try {
    def = docusign.buildEnvelopeDefinition({
      documents: [{ base64: pdf.toString('base64'), name: 'Verification of Rent', documentId: 1 }],
      signers: [{
        email: ll.email,
        name: ll.name || 'Landlord',
        recipientId: 1,
        /* NOT a captive recipient: a landlord has no PILOT login, so DocuSign emails
           them directly. The 2026-08-21 "one signing email, from PILOT" rule is
           about CAPTIVE recipients (clientUserId set), where DocuSign's own email
           leads to a page they cannot sign on. It does not apply here, and setting
           clientUserId would leave this landlord with no way in at all. */
        tabsByDoc: { 1: tabs },
      }],
      // Item 7's "Account in the name of" is the applicant, which is who the
      // landlord recognises — the subject property never appears on this form.
      subject: `${SUBJECT} — ${form.data.account_name || 'loan applicant'}`,
      emailBlurb: 'A short form to confirm a tenant’s rent. Every question is required; it takes a minute.',
      customFields: { textCustomFields: [{ name: 'pilot_lt_vor_loan', value: String(loanId), show: 'false' }] },
      status: 'sent',
    });
  } catch (e) {
    await failEnvelope(client, claim.id, e);
    return { ok: false, reason: 'build', message: (e && e.message) || 'The envelope could not be built.' };
  }

  try {
    const res = await docusign.createEnvelope(def, { idempotencyKey: `lt-vor-${claim.id}` });
    await client.query(
      `UPDATE lt_vor_envelopes SET envelope_id = $2, status = 'sent', sent_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
      [claim.id, String(res.envelopeId)]);
    return { ok: true, id: claim.id, envelopeId: String(res.envelopeId), to: ll.email };
  } catch (e) {
    await failEnvelope(client, claim.id, e);
    return { ok: false, reason: 'provider', message: (e && e.message) || 'DocuSign refused the envelope.' };
  }
}

async function failEnvelope(client, rowId, e) {
  try {
    await client.query(
      `UPDATE lt_vor_envelopes SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
      [rowId, String((e && e.message) || e).slice(0, 500)]);
  } catch (_) { /* the send already failed; losing the note must not mask that */ }
}

/**
 * Send the form as a plain email attachment, through the SHARED order letter — the
 * same sender, the same send-as-user rule, the same per-order reply address, so a
 * landlord's reply carrying the filled-in form files itself onto the loan exactly as
 * a title company's return does.
 */
async function sendAttachment({ loanId, form, pdf, from, staffId, force }) {
  try {
    const res = await orders.place(loanId, 'vor', {
      staffId,
      from,
      force,
      note: 'The form is attached. Please complete Part III and send it back to this address.',
      attachments: [{ filename: FILENAME, content: pdf.toString('base64') }],
    });
    /* The orders desk answers `{ok:false, error}` — its OWN refusals are quoted
       verbatim rather than re-worded, including "this has already been ordered, use
       Follow up", which is the right answer to a second click and is the same one
       every other order gives. */
    if (!res || res.ok === false) {
      return { ok: false, reason: (res && res.reason) || 'send', message: (res && res.error) || 'The email could not be sent.' };
    }
    return { ok: true, to: res.to || null, ambiguous: !!res.ambiguous, warning: res.warning || null };
  } catch (e) {
    return { ok: false, reason: 'send', message: (e && e.message) || 'The email could not be sent.' };
  }
}

// ---------------------------------------------------------------------------
// What came back
// ---------------------------------------------------------------------------

async function listEnvelopes(loanId, client = db) {
  try {
    return (await client.query(
      `SELECT id, envelope_id, status, recipient_name, recipient_email, send_method,
              sent_at, completed_at, void_reason, voided_at, last_error, created_at
         FROM lt_vor_envelopes WHERE loan_id = $1::uuid ORDER BY created_at DESC`,
      [String(loanId)])).rows;
  } catch (_) { return []; }
}

async function listReturns(loanId, client = db) {
  try {
    return (await client.query(
      `SELECT id, envelope_id, source, answers, filename, note, created_at
         FROM lt_vor_returns WHERE loan_id = $1::uuid ORDER BY created_at DESC`,
      [String(loanId)])).rows;
  } catch (_) { return []; }
}

/**
 * Record a form that came back some other way — emailed, faxed, handed over —
 * and VOID every envelope still in flight.
 *
 * The owner's reason is the rule: there must never be a second, half-signed copy
 * out there. OUR row is written first and the provider told after, so a DocuSign
 * outage cannot lose the fact that the landlord answered.
 */
async function recordManualReturn(loanId, opts = {}, client = db) {
  const id = String(loanId);
  const note = String(opts.note || '').trim();
  if (note.length < 4) {
    return { ok: false, reason: 'note', message: 'Say in a few words how the form came back — it is the only record afterwards.' };
  }

  const live = (await listEnvelopes(id, client)).filter((e) => LIVE_ENVELOPE.includes(e.status));

  const ret = (await client.query(
    `INSERT INTO lt_vor_returns (loan_id, envelope_id, source, answers, storage_ref, filename, recorded_by, note)
     VALUES ($1::uuid, $2, 'manual', $3::jsonb, $4, $5, $6, $7)
     RETURNING id`,
    [id, live[0] ? live[0].id : null, JSON.stringify(opts.answers && typeof opts.answers === 'object' ? opts.answers : {}),
      opts.storageRef || null, opts.filename || null, opts.staffId || null, note])).rows[0];

  const reason = `A completed form came back another way: ${note}`.slice(0, 200);
  const voided = [];
  for (const e of live) {
    await client.query(
      `UPDATE lt_vor_envelopes SET status = 'voided', void_reason = $2, voided_at = now(), updated_at = now() WHERE id = $1`,
      [e.id, reason]);
    voided.push({ id: e.id, envelopeId: e.envelope_id, provider: null });
    if (!e.envelope_id || !docusignReady()) continue;
    try {
      await docusign.voidEnvelope(e.envelope_id, reason);
      voided[voided.length - 1].provider = 'voided';
    } catch (err) {
      // The envelope reads as voided HERE regardless — recorded, never silent, so
      // somebody can retire it by hand at DocuSign.
      const msg = String((err && err.message) || err).slice(0, 500);
      voided[voided.length - 1].provider = `failed: ${msg}`;
      try {
        await client.query(`UPDATE lt_vor_envelopes SET last_error = $2, updated_at = now() WHERE id = $1`, [e.id, msg]);
      } catch (_) { /* nothing further to do */ }
    }
  }

  return { ok: true, returnId: ret.id, voided };
}

/**
 * Apply a status the provider reported. Called by the long-term claim on the shared
 * DocuSign webhook, and safe to call again with the same status — Connect
 * redelivers freely, and the unique index on a completed return is what stops two
 * "the landlord signed" rows appearing on one envelope.
 */
async function applyEnvelopeStatus(envelopeId, status, opts = {}) {
  const client = opts.db || db;
  const eid = String(envelopeId || '').trim();
  if (!eid) return { ok: false, reason: 'no_envelope' };
  const row = (await client.query(
    `SELECT id, loan_id, status FROM lt_vor_envelopes WHERE envelope_id = $1 LIMIT 1`, [eid])).rows[0];
  if (!row) return { ok: false, reason: 'untracked' };

  const next = String(status || '').toLowerCase();
  const known = ['sent', 'delivered', 'completed', 'declined', 'voided'];
  if (!known.includes(next)) return { ok: true, ignored: next || 'unknown' };

  /* A VOIDED envelope never moves again. A late 'delivered' for an envelope a manual
     return already stopped would otherwise put it back in flight and re-arm the
     "already out with this landlord" refusal on a loan that is finished. */
  if (row.status === 'voided') return { ok: true, ignored: 'already_voided' };

  await client.query(
    `UPDATE lt_vor_envelopes
        SET status = $2,
            completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
            updated_at = now()
      WHERE id = $1`,
    [row.id, next]);

  if (next !== 'completed') return { ok: true, status: next };

  await client.query(
    `INSERT INTO lt_vor_returns (loan_id, envelope_id, source, answers, filename, note)
     VALUES ($1::uuid, $2, 'docusign', $3::jsonb, $4, $5)
     ON CONFLICT (envelope_id) WHERE source = 'docusign' AND envelope_id IS NOT NULL
     DO NOTHING`,
    [row.loan_id, row.id, JSON.stringify(opts.answers && typeof opts.answers === 'object' ? opts.answers : {}),
      FILENAME, 'The landlord signed the form on DocuSign.']);

  return { ok: true, status: next, recorded: true };
}

/**
 * Ask DocuSign about every envelope still out.
 *
 * THE WEBHOOK IS A NUDGE, THE POLL IS THE CORRECTNESS MACHINERY — the same reading
 * the appraisal desks take of their vendors. A Connect delivery can be lost, dropped
 * by a deploy mid-request, or rejected while an HMAC key is being rotated, and the
 * failure is SILENT: the landlord signs, nobody hears, and the condition sits open
 * with a form somebody thinks is still out. This closes that.
 *
 * Bounded per pass, oldest first, and it never throws — a reconcile is a background
 * pass and one unreachable envelope must not stop the rest.
 */
async function reconcileOpenEnvelopes(opts = {}) {
  const client = opts.db || db;
  const limit = Number(opts.limit) > 0 ? Math.min(200, Number(opts.limit)) : 25;
  if (!docusignReady()) return { ok: true, skipped: 'docusign_off', checked: 0 };

  let rows = [];
  try {
    rows = (await client.query(
      `SELECT id, envelope_id, status FROM lt_vor_envelopes
        WHERE envelope_id IS NOT NULL AND status = ANY($2)
        ORDER BY COALESCE(sent_at, created_at) ASC
        LIMIT $1`,
      [limit, LIVE_ENVELOPE])).rows;
  } catch (e) {
    return { ok: false, reason: 'unreadable', message: String((e && e.message) || e).slice(0, 200) };
  }

  const out = { ok: true, checked: rows.length, moved: 0, failed: 0, reasons: [] };
  for (const r of rows) {
    try {
      const env = await docusign.getEnvelope(r.envelope_id, { include: 'recipients,tabs' });
      const status = String((env && env.status) || '').toLowerCase();
      if (!status || status === r.status) continue;
      const answers = answersFromEnvelope(env);
      const applied = await applyEnvelopeStatus(r.envelope_id, status, { answers, db: client });
      if (applied && applied.ok && !applied.ignored) out.moved += 1;
    } catch (e) {
      out.failed += 1;
      // NAMED, never a bare count: "25 checked" cannot tell a working pass from one
      // that is failing on every row.
      out.reasons.push(String((e && e.message) || e).slice(0, 120));
    }
  }
  return out;
}

/** The landlord's typed answers, keyed by our own field keys — `tabLabel` IS the
    field key, which is why `fields.js` sets it and nothing else may. */
function answersFromEnvelope(env) {
  try {
    const recips = docusign.parseRecipients(env) || [];
    const signer = recips.find((r) => r && r.textValues && Object.keys(r.textValues).length) || recips[0];
    const vals = (signer && signer.textValues) || {};
    const out = {};
    for (const f of F.landlordFields()) {
      if (vals[f.key] != null && String(vals[f.key]).trim() !== '') out[f.key] = String(vals[f.key]).trim();
    }
    return out;
  } catch (_) { return {}; }
}

/** Everything the desk screen needs, in one read. */
async function state(loanId, client = db) {
  const form = await loadForm(loanId, client);
  if (!form) return null;
  const envelopes = await listEnvelopes(loanId, client);
  const returns = await listReturns(loanId, client);
  const methods = ['docusign', 'email', 'both'].map((m) => ({
    method: m,
    blockers: blockersFor({ form, method: m, envelopes }),
  }));
  return {
    data: form.data,
    prefill: form.prefill,
    fields: F.FIELDS,
    parts: F.PARTS,
    missing: F.missing(form.data),
    landlord: form.landlord,
    borrowerRents: form.borrowerRents,
    reviewedAt: form.reviewedAt,
    unreadable: form.unreadable,
    docusignReady: docusignReady(),
    envelopes,
    returns,
    methods,
    blockerText: BLOCKER_TEXT,
  };
}

module.exports = {
  state, loadForm, saveForm, preview, send, recordManualReturn, applyEnvelopeStatus,
  reconcileOpenEnvelopes, answersFromEnvelope,
  listEnvelopes, listReturns,
  BLOCKER_TEXT, LIVE_ENVELOPE, FILENAME,
  _internals: { blockersFor, anchorsPresent, docusignReady, sendEnvelope, sendAttachment },
};
