/**
 * Orders desk (#orders) — build & send the TITLE and INSURANCE order emails.
 *
 * These are the two vendor orders every file needs. The email bodies mirror the
 * owner's Word templates (Title Order Request / Insurance Quote Request): the
 * transaction details, the borrower + entity, the loan amount, and — always —
 * the YS Capital mortgagee clause with the file's LOAN NUMBER (which is why an
 * order can't send until the loan number is on the file, the same gate as the
 * term-sheet package).
 *
 * The order goes TO the vendor (title company / insurance agent) with the
 * borrower, loan officer and processor CC'd (visible, not blind — everyone on the
 * chain sees each other), plus a UNIQUE per-order reply-to (title+/insurance+@)
 * so the vendor's reply and any documents they send back route to the right
 * order. Follow-ups reuse the same thread. Rendering is the shared branded email
 * template (no borrower-portal CTA — the recipients are external), captured into
 * the Email Center by msg_type so each order has its own Gmail-style thread.
 *
 * ── WHERE THE LETTER ITSELF LIVES (2026-08-30) ──────────────────────────────
 *
 * The half of this desk that is genuinely about the LETTER — the body, the
 * mortgagee clause, the recipient rule, the reply-address minting, the threading
 * headers and the send verdict — was lifted, unchanged, into `lib/order-email.js`
 * so the long-term desk can share it rather than grow a second copy (the owner:
 * *"Everything should share the code … If the code is updated, he's also updating
 * it"*). Every one of those names is RE-EXPORTED from here, so this desk and every
 * caller of it behave exactly as they did; the only thing that moved is where the
 * definition lives. What stayed is everything that reads a SHORT-TERM table —
 * `getOrderData`, the blockers, the send bookkeeping and `placeOrder` — because
 * that is this product's data layer and is not shareable.
 */
const db = require('../db');
const cfg = require('../config');
const email = require('./email');
// RCN detection is the ONE shared note-buyer helper (mirrors isFidelis/isEmcap/
// isBlueLake), so the order clause and the underwriting mortgagee-address check
// agree on which files are RCN. normNoteBuyer normalizes exactly as the old local
// copy did (lowercase, non-alphanumerics stripped) — behavior unchanged.
const { isRcnNoteBuyer } = require('./conditions/field-registry');

/* THE LETTER — one definition, shared with the long-term desk. Everything
   destructured here is re-exported at the bottom of this file, so nothing that
   already imports `lib/orders` had to change. */
const orderEmail = require('./order-email');
const {
  ORDER_TYPES, VENDOR_TYPE, ORDER_LABEL,
  MORTGAGEE_CLAUSE, MORTGAGEE_CLAUSE_RCN,
  INSURANCE_COVERAGE_LINES, insuranceDetailMeta,
  money, dayText, transactionType, propertyLine, vendorEmails, vendorGreetName,
  ccBorrowerSettingKey, ccBorrowerDefault, ccHelperSettingKey, ccHelperDefault,
  helperEmails, recipientsFor,
  sendVerdict, isAmbiguousSendFailure, newOrderMessageId, replyOrderSubject,
} = orderEmail;

/** The mortgagee clause LINES for a file, by note buyer (RCN → the servicer clause,
    everyone else → the standard YS Capital clause). The loan number is appended by
    the caller.

    THIS IS THE ONE RULE THE SHARED BUILDER DELIBERATELY DOES NOT KNOW. It is keyed
    on the SHORT-TERM note-buyer registry (`isRcnNoteBuyer`), which has no meaning on
    a long-term loan, so `buildOrderEmail` takes the resolved clause as an input and
    this desk states it on every call. */
function mortgageeClauseFor(lender) {
  return isRcnNoteBuyer(lender) ? MORTGAGEE_CLAUSE_RCN : MORTGAGEE_CLAUSE;
}

/** The order letter for a SHORT-TERM file: the shared builder, told which mortgagee
    clause this file's note buyer takes. Byte-identical to what this desk has always
    produced — every caller (`routes/staff.js`, `routes/tpo.js`) still calls this. */
function buildOrderEmail(kind, data, opts = {}) {
  return orderEmail.buildOrderEmail(kind, data, {
    ...opts,
    mortgageeClause: opts.mortgageeClause || mortgageeClauseFor(data && data.lender),
  });
}

/**
 * Everything an order email/panel needs about a file, in one query. Returns null
 * when the file is missing/archived. Vendor contacts (title + insurance) are
 * joined so the caller knows whether the order can be placed.
 */
async function getOrderData(appId) {
  const r = await db.query(
    `SELECT a.id, a.ys_loan_number, a.property_address, a.loan_type, a.loan_amount, a.lender,
            a.usps_match, a.usps_imported_at,
            a.purchase_price, a.rehab_budget, a.expected_closing, a.est_closing_date,
            a.loan_officer_id, a.processor_id,
            -- The two PERSON ids, so the helper read below can ask for both
            -- borrowers' helpers without a second trip to the applications row.
            a.borrower_id AS borrower_id_ref, a.co_borrower_id AS co_borrower_id_ref,
            b.first_name, b.last_name, b.email AS borrower_email, b.date_of_birth,
            b.cell_phone AS borrower_cell, b.current_address AS borrower_address,
            cb.first_name AS co_first, cb.last_name AS co_last, cb.email AS co_email,
            cb.cell_phone AS co_cell,
            l.llc_name AS entity_name,
            lo.full_name AS lo_name, lo.email AS lo_email, lo.title AS lo_title,
            lo.phone AS lo_phone, lo.cell AS lo_cell, lo.nmls AS lo_nmls,
            pr.full_name AS proc_name, pr.email AS proc_email,
            uspsc.cleared AS usps_condition_cleared
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id AND lo.is_active = true
       LEFT JOIN staff_users pr ON pr.id = a.processor_id AND pr.is_active = true
       /* HAS A HUMAN ANSWERED THE ADDRESS QUESTION? (owner-reported 2026-08-24: "even though
          I'm waiving the USPS condition as an admin ... I approve the exception, but he still
          can't order title and insurance.")

          They could not, and the reason is that the blocker below read ONLY
          applications.usps_imported_at — a stamp written by one thing, importing a
          USPS-standardised address. Waiving the condition does not write it. Approving a
          condition_waiver exception does not write it either: that approval's whole effect is
          the satisfied-write onto the condition (routes/admin-exceptions.js). So BOTH recorded
          ways through ended at the same cleared condition, and the gate was looking somewhere
          else entirely — a refusal whose own remedies cannot produce the state it demands, which
          is the definition of a dead end.

          Every clearance shape counts, because they are all a person deciding the same thing:
          signed off, waived, super-admin overridden (db/344), or made not-required. Scoped to
          the USPS condition BY TEMPLATE CODE, so no other waiver on the file can open this gate.
          Newest instance wins — the engine suppresses duplicates, and a re-created row after a
          re-evaluation is the live one. */
       LEFT JOIN LATERAL (
         SELECT (ci.signed_off_at IS NOT NULL
              OR ci.waived_at     IS NOT NULL
              OR ci.override_at   IS NOT NULL
              OR ci.is_required   = false   -- there is no waived STATUS: checklist_items_status_check
              OR ci.status = 'satisfied') AS cleared
           FROM checklist_items ci
           JOIN checklist_templates t ON t.id = ci.template_id
          WHERE ci.application_id = a.id
            AND t.code = 'usps_address_verification'
          ORDER BY ci.created_at DESC
          LIMIT 1
       ) uspsc ON true
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  const a = r.rows[0];
  if (!a) return null;

  // The vendor contacts linked to THIS file (most-recently used first).
  // `emails`/`phones` are SELECTed alongside the legacy scalars because a vendor
  // may carry several addresses (db/224: a title company with a rundown@ and a
  // closing@, an agent plus their assistant) and the owner's rule is that ALL of
  // them go on the order — see `recipientsFor`.
  const vc = await db.query(
    `SELECT sc.id, sc.contact_type, sc.company_name, sc.contact_name, sc.email, sc.emails, sc.phone, sc.phones
       FROM application_service_contacts l
       JOIN service_contacts sc ON sc.id = l.service_contact_id
      WHERE l.application_id = $1 AND sc.contact_type = ANY($2::text[])
      ORDER BY sc.last_used_at DESC NULLS LAST, sc.updated_at DESC NULLS LAST`,
    [appId, Object.values(VENDOR_TYPE)]);
  const vendorOf = (type) => vc.rows.find((x) => x.contact_type === type) || null;
  /* EVERY OTHER contact of the same type linked to this file (owner-directed
     2026-08-28: "if all of them are listed on the file contact … all of them
     should be looped automatically"). The FIRST (most recently used) stays the
     order's vendor — the To; the rest ride the Cc through recipientsFor. */
  const vendorsExtraOf = (type) => vc.rows.filter((x) => x.contact_type === type).slice(1);

  /* THE BORROWER'S HELPER(S) — the standing second login a borrower authorizes
     (`borrower_assistants`, db/472). Read for BOTH the borrower and the co-borrower,
     because either of them may have set one up, and a co-borrower's helper is as
     much "a helper on this file" as the borrower's is.

     ACTIVE ONLY (`disabled_at IS NULL`) — a revoked helper is a person the borrower
     deliberately cut off, and putting them on a vendor order would be handing a
     revoked party the whole deal. An INVITED-but-not-yet-accepted helper is kept:
     the email address is real and the borrower chose it; they simply have not set a
     password yet, which has nothing to do with whether they should be copied.

     An unreadable read yields NO helpers rather than breaking the order — the CC is
     an addition to a thread, never the thing the order depends on. */
  let helpers = [];
  try {
    const hr = await db.query(
      `SELECT ba.id, ba.name, lower(ba.email) AS email, ba.borrower_id,
              (ba.borrower_id = $2) AS is_primary_borrowers
         FROM borrower_assistants ba
        WHERE ba.borrower_id = ANY($1::uuid[]) AND ba.disabled_at IS NULL
        ORDER BY (ba.borrower_id = $2) DESC, ba.created_at`,
      [[a.borrower_id_ref, a.co_borrower_id_ref].filter(Boolean), a.borrower_id_ref]);
    helpers = hr.rows.map((h) => ({
      id: h.id,
      name: h.name || null,
      email: h.email,
      forCoBorrower: !h.is_primary_borrowers,
    }));
  } catch (_) { /* no helper block rather than a broken order */ }

  const borrowerName = require('./person-name').displayName(a)
    + (a.co_first || a.co_last ? ` & ${[a.co_first, a.co_last].filter(Boolean).join(' ')}` : '');

  return {
    appId: a.id,
    loanNumber: a.ys_loan_number ? String(a.ys_loan_number).toUpperCase() : '',
    hasLoanNumber: !!a.ys_loan_number,
    propertyLine: propertyLine(a.property_address),
    // The property's STATE, for the state-aware rules (the NY title cut, the
    // NY-only settlement-agent order).
    propertyState: ((a.property_address || {}).state || '').toUpperCase() || null,
    transactionType: transactionType(a.loan_type),
    borrowerName: borrowerName || a.borrower_email || 'Borrower',
    borrowerEmail: a.borrower_email || null,
    coBorrowerEmail: a.co_email || null,
    // The borrower's authorized HELPER(S) — see the read above. Always an array
    // (empty when the file has none), so every caller can ask without a null test.
    helpers,
    // The borrower's OWN contact details, for the insurance order's detail block.
    // The mailing address is deliberately the borrower's HOME address — a builder's
    // risk policy on a vacant house cannot be mailed to the vacant house — rendered
    // through the ONE canonical address formatter so the agent reads the same
    // mailing one-line every other surface shows (never a geocoder display name).
    borrowerPhone: a.borrower_cell || a.co_cell || null,
    borrowerMailingAddress: (() => {
      try { return require('./address').canonicalOneLine(a.borrower_address || {}) || null; }
      catch (_) { return null; }
    })(),
    // The estimated closing date, resolved EXACTLY as closing-prep resolves it
    // (the file's confirmed expected closing, else the estimate on the term sheet)
    // so the attorney order and the insurance order can never state two dates.
    expectedClosing: a.expected_closing || a.est_closing_date || null,
    purchasePrice: a.purchase_price != null ? Number(a.purchase_price) : null,
    rehabBudget: a.rehab_budget != null ? Number(a.rehab_budget) : null,
    dob: a.date_of_birth ? new Date(a.date_of_birth).toLocaleDateString('en-US') : '',
    entityName: a.entity_name || '',
    // The note buyer (capital partner), STAFF-ONLY, drives the mortgagee clause on
    // the vendor order — RCN's notes are serviced by Elite Commercial Servicing, so
    // its clause names the servicer's notice address (owner-directed 2026-08-04).
    // Never leaves the order email; borrower-facing surfaces are untouched.
    lender: a.lender || null,
    loanAmount: a.loan_amount != null ? money(a.loan_amount) : '',
    officer: a.lo_name
      ? { name: a.lo_name, title: a.lo_title || 'Loan Officer', email: a.lo_email || null,
          phone: a.lo_cell || a.lo_phone || null, nmls: a.lo_nmls || null }
      : null,
    processor: a.proc_name ? { name: a.proc_name, email: a.proc_email || null } : null,
    // The ADDITIONAL same-type contacts on the file — auto-looped on the Cc.
    vendorsExtra: { title: vendorsExtraOf('title_company'), insurance: vendorsExtraOf('insurance_agent') },
    vendors: { title: vendorOf('title_company'), insurance: vendorOf('insurance_agent'),
      // The NY settlement agent (owner-directed 2026-08-28) — present on the data
      // whatever the closing handling is, so the prepped-but-dormant card can show
      // who would be ordered; the ROUTE decides whether an order may go out.
      settlement: vendorOf('settlement_agent') },
    // The subject address must be the USPS-imported one BEFORE any order goes out —
    // an order transmits the property address to a vendor, and a wrong/unverified
    // address there is expensive to unwind. `uspsGate` is on only when USPS is
    // actually configured and the condition is required (so nothing is blocked in an
    // environment that hasn't turned USPS on).
    uspsImported: !!a.usps_imported_at,
    // A person cleared the USPS condition — by sign-off, waiver, super-admin override, or by
    // making it optional. See the LATERAL above for why this is a SECOND way past the gate and
    // not a replacement: an imported address still satisfies it with nobody having to decide.
    uspsCleared: !!a.usps_condition_cleared,
    uspsGate: uspsGateActive(),
  };
}

// USPS ordering gate is live only when the standardizer is configured AND the
// verify-and-import condition is required. Off ⇒ no order is ever blocked on USPS.
function uspsGateActive() {
  try { return require('./usps-verify').configured() && !!cfg.usps.conditionRequired; }
  catch (_) { return false; }
}

/** What still blocks an order — an empty list means it's ready to send. */
function blockers(kind, data) {
  const out = [];
  if (!data) { out.push('file'); return out; }
  if (!data.hasLoanNumber) out.push('loan_number');
  // "Has an address" is ANY address, not the legacy scalar one. A vendor edited to
  // carry only additional addresses (db/224's `emails` array, with the scalar left
  // null) would otherwise read as having no contact at all and block its own order
  // — a gate refusing on a technicality that the send path itself does not share.
  if (!vendorEmails(kind, data).length) out.push('contact');
  /* No order may be placed until the subject address has been settled — an order transmits it
     to an outside vendor and a wrong one is expensive to unwind. TWO ways it can be settled: a
     USPS-standardised address was imported, or a person with the authority to do so cleared the
     condition. Before 2026-08-24 only the first counted, so waiving the condition (and approving
     the exception that waives it) left the order blocked with no remaining way through. */
  if (data.uspsGate && !data.uspsImported && !data.uspsCleared) out.push('usps');
  return out;
}

/**
 * PUT AN ORDER EMAIL ON THE WIRE, and say plainly what happened. NEVER THROWS.
 *
 * Every door that writes to a title or insurance vendor — place, follow-up, and the
 * Email Center reply — goes through here, so "did it send?" has ONE answer and the
 * bookkeeping each door does can be keyed on it. Before this, each door had its own
 * bare `await email.sendMail(...)` inside a route-wide try/catch, which conflated
 * three different outcomes into one generic "Could not send the order."
 *
 * @returns {Promise<{ok:true, to:string[], cc:string[]} | {ok:false, reason:string, message:string, ambiguous?:boolean}>}
 */
/**
 * @param {object} [thread] the stored order thread state — `{ root, last, subject }`
 *        from file_orders (meta.rootMessageId / meta.lastMessageId + the stored
 *        subject). Absent on the FIRST send (the order itself, which is the root).
 *        When present, this send is a FOLLOW-UP / reply and MUST land in the same
 *        conversation the order was placed on — in the vendor's own inbox, not a
 *        new chain (owner-directed 2026-08-04). Two mechanisms, mirroring
 *        closing-thread: (1) reuse the ORIGINAL order subject with one "Re:" (the
 *        load-bearing part — Resend may rewrite our Message-ID, and the subject is
 *        what mail clients fall back to); (2) RFC threading headers (a Message-ID we
 *        mint + In-Reply-To/References pointing at the last message we sent). The
 *        minted Message-ID is RETURNED so the caller can advance the thread.
 */
async function sendOrderMail({ appId, kind, data, to, cc, replyTo, built, fromName, type, thread, attachments }) {
  const toList = (to || []).filter(Boolean);
  const ccList = (cc || []).filter(Boolean);
  if (!toList.length) {
    return { ok: false, reason: 'contact', message: `Add the ${kind === 'title' ? 'title company' : 'insurance agent'} contact first — there is no one to send the order to.` };
  }
  // The follow-up / reply doors ALWAYS pass `thread` (the place door never does), so
  // its presence — not whether it carries ids — is what marks a reply. This matters
  // for a LEGACY order placed before threading existed: it has no stored Message-ID,
  // but the follow-up must STILL reuse the order subject with "Re:" so it threads by
  // subject in the vendor's inbox.
  const isReply = !!thread;
  const parent = thread && (thread.last || thread.root);
  const messageId = newOrderMessageId(appId, kind);
  const subject = isReply ? (replyOrderSubject(thread.subject || built.subject) || built.subject) : built.subject;
  // Message-ID + an X- marker always ride; Microsoft Graph can carry only X- headers
  // (it drops the RFC threading ones), so the subject reuse above is what threads a
  // Graph-sent chain. In-Reply-To/References are added only when we know the parent's
  // Message-ID (a reply on a thread we anchored) — for Resend.
  const headers = { 'Message-ID': messageId, 'X-Pilot-Order-Thread': `${appId}:${kind}` };
  if (parent) {
    headers['In-Reply-To'] = parent;
    headers.References = (thread.root && thread.root !== parent) ? `${thread.root} ${parent}` : parent;
  }
  let res;
  try {
    res = await email.sendMail({
      to: toList, cc: ccList,
      subject, html: built.html, text: built.text, headers,
      // A staffer's own attachments on a typed reply (owner-directed 2026-08-21). Absent on
      // the PLACE path and on every existing caller, so those sends are byte-identical.
      ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
      replyTo: replyTo || require('./file-address').fileReplyTo(appId) || cfg.replyToDefault || null,
      from: fromName && email.fromWithName ? email.fromWithName(fromName) : undefined,
      _ctx: { applicationId: appId, type, audience: 'staff' },
    });
  } catch (e) {
    // AMBIGUOUS IS NOT FAILED. The provider may have taken it, so the caller must
    // keep whatever it recorded and let a human decide, rather than inviting a
    // re-send that delivers the order to the vendor twice.
    if (isAmbiguousSendFailure(e)) {
      return {
        ok: false, ambiguous: true, reason: 'send_unconfirmed',
        message: 'The order may or may not have gone out — the email provider stopped responding while we were sending. Check the Email Center before re-sending, so the vendor does not get it twice.',
      };
    }
    return { ok: false, reason: 'send_failed', message: 'Could not send the order — the email provider rejected it.' };
  }
  const verdict = sendVerdict(res);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, message: verdict.message };
  return { ok: true, to: toList, cc: ccList, messageId };
}

/**
 * Place (or force-resend) a title/insurance order — the exactly-once claim → send →
 * settle CORE, shared by the staff Orders desk AND the TPO broker order route so this
 * money-adjacent logic lives in ONE place and can never drift between the two doors.
 * The CALLER owns auth, blockers, recipients, the audit row and the HTTP response;
 * this owns only the atomic claim, the send, the rollback-on-failure and the tracking.
 *
 * @param opts {{ appId, kind, data, to, cc, replyTo, built, vendor, actorId,
 *                actorName, ccBorrower, ccHelper, force, existing }}
 * @returns Promise resolving to one of (NEVER throws):
 *   { ok:true }                                   — sent + recorded
 *   { ok:true, ambiguous:true, warning }          — provider stopped responding mid-send
 *   { ok:false, httpStatus, code, error, sent_to?, cc? } — the caller relays verbatim
 */
async function placeOrder(opts) {
  const { appId, kind, data, to, cc, replyTo, built, vendor,
          actorId, actorName, ccBorrower, ccHelper, force, existing } = opts;
  const orderTracking = require('./order-tracking');
  let claimed = null;
  let sendRes = null;
  try {
    // CLAIM FIRST, SEND SECOND — inside ONE transaction, which is what makes an order
    // exactly-once. A failed send ROLLS IT BACK, so nothing is recorded that did not
    // happen and nothing that happened goes unrecorded. (The full reasoning lives with
    // the staff Orders desk, which this was extracted from.)
    const claim = await db.query(
      `INSERT INTO file_orders (application_id, order_type, status, vendor_contact_id, vendor_email, vendor_name, subject, ordered_at, ordered_by, send_count, meta)
       VALUES ($1,$2,'ordered',$3,$4,$5,$6,now(),$7,1,
               jsonb_build_object('ccBorrower', $8::boolean, 'ccHelper', $10::boolean))
       ON CONFLICT (application_id, order_type)
       DO UPDATE SET status='ordered', vendor_contact_id=EXCLUDED.vendor_contact_id, vendor_email=EXCLUDED.vendor_email,
                     vendor_name=EXCLUDED.vendor_name, subject=EXCLUDED.subject, ordered_at=now(),
                     ordered_by=EXCLUDED.ordered_by, send_count=file_orders.send_count+1,
                     -- BOTH footings are stamped in the same breath, so a follow-up
                     -- (which reads this meta) can never keep the borrower's choice
                     -- while losing the helper's.
                     meta=COALESCE(file_orders.meta,'{}'::jsonb)
                          || jsonb_build_object('ccBorrower', $8::boolean, 'ccHelper', $10::boolean),
                     updated_at=now()
         -- THE REAL GUARD, atomic: a second concurrent click blocks on this row,
         -- re-reads 'ordered', matches nothing, and answers 409 instead of sending the
         -- vendor a second copy. A FORCED re-send is allowed past, but only once every
         -- 10 seconds, so a double-click on "force" is one order rather than two.
         WHERE file_orders.status IN ('not_ordered','cancelled')
            OR ($9::boolean AND COALESCE(file_orders.ordered_at, 'epoch'::timestamptz) < now() - interval '10 seconds')
       RETURNING id, status, ordered_at::text AS claim_token`,
      // The stored `vendor_email` is the desk's DISPLAY address (one line on a card),
      // so it is the primary — read through the same folding so it can never name an
      // address the send did not actually use.
      [appId, kind, vendor ? vendor.id : null, require('./vendor-directory').allEmails(vendor)[0] || null,
       (vendor && (vendor.company_name || vendor.contact_name)) || null, built.subject, actorId, ccBorrower, !!force,
       ccHelper == null ? false : !!ccHelper]);
    if (!claim.rows[0]) {
      return { ok: false, httpStatus: 409, code: force ? 'too_soon' : 'already_ordered',
        error: force
          ? `That ${kind} order has just gone out — give it a moment before sending it again.`
          : `This ${kind} order was already sent. Use Follow-up, or force a re-send.` };
    }
    claimed = claim.rows[0];
    sendRes = await sendOrderMail({
      appId, kind, data, to, cc, replyTo, built,
      fromName: actorName, type: `${kind}_order`,
    });
    if (!sendRes.ok && !sendRes.ambiguous) {
      // NOTHING REACHED THE VENDOR — a compare-and-swap unwind of exactly the row we
      // just claimed (same id, same ordered_at, still 'ordered'), restoring the prior
      // snapshot so the aging clock is not reset by a send that never happened.
      await db.query(
        `UPDATE file_orders
            SET status = $3, ordered_at = $4, ordered_by = $5, send_count = $6, updated_at = now()
          WHERE id = $1 AND status = 'ordered' AND ordered_at = $2::timestamptz`,
        [claimed.id, claimed.claim_token,
         (existing && existing.status) || 'not_ordered',
         (existing && existing.ordered_at) || null,
         (existing && existing.ordered_by) || null,
         Number((existing && existing.send_count) || 0)])
        .catch(() => { /* best-effort — the refusal is what matters */ });
      return { ok: false, httpStatus: sendRes.reason === 'contact' ? 400 : 502, code: sendRes.reason, error: sendRes.message };
    }
    // The order now has an owner and a history. AFTER the send, because a failure above
    // releases the claim. An AMBIGUOUS send keeps the claim on purpose.
    await orderTracking.ensureAssignee(appId, kind);
    if (sendRes.messageId) {
      await db.query(
        `UPDATE file_orders
            SET meta = COALESCE(meta,'{}'::jsonb) || jsonb_build_object('rootMessageId', $3::text, 'lastMessageId', $3::text)
          WHERE application_id=$1 AND order_type=$2`,
        [appId, kind, sendRes.messageId]).catch(() => {});
    }
    // Re-sending a FINISHED order is a reopen and must be recorded as one (else the
    // retire sweep puts it straight back to 'completed' and it falls off the desk).
    const wasFinished = !!(existing && existing.status === 'completed');
    await orderTracking.recordEvent({
      applicationId: appId, orderType: kind,
      kind: wasFinished ? 'reopened' : (existing && existing.send_count ? 'resent' : 'placed'),
      actorId, orderId: claimed.id,
      detail: {
        vendor: (vendor && (vendor.company_name || vendor.contact_name)) || null,
        to: (to || []).length, cc: (cc || []).length, force: !!force, unconfirmed: !!sendRes.ambiguous,
        ...(wasFinished ? { reopenedBy: 'resend' } : {}),
      },
    });
    if (wasFinished) {
      await db.query(
        `UPDATE file_orders SET completed_at = NULL, updated_at = now()
          WHERE id = $1 AND status <> 'completed'`, [claimed.id]).catch(() => {});
    }
  } catch (e) {
    // sendOrderMail + recordEvent never throw, so reaching here after a successful send
    // means the BOOKKEEPING failed — never report that as "could not send", or somebody
    // re-sends an order the vendor already has.
    if (sendRes && (sendRes.ok || sendRes.ambiguous)) {
      return { ok: false, httpStatus: 500, code: 'recorded_failed',
        error: 'The order was sent to the vendor, but part of recording it on the file failed. Do NOT re-send — check the Email Center, and tell an administrator.',
        sent_to: to, cc };
    }
    return { ok: false, httpStatus: 500, code: 'send_failed', error: 'Could not send the order.' };
  }
  if (sendRes.ambiguous) return { ok: true, ambiguous: true, warning: sendRes.message };
  return { ok: true };
}

module.exports = {
  ORDER_TYPES, VENDOR_TYPE, ORDER_LABEL,
  getOrderData, blockers, buildOrderEmail, recipientsFor, ccBorrowerDefault, ccBorrowerSettingKey,
  ccHelperDefault, ccHelperSettingKey, helperEmails,
  transactionType, propertyLine, money, dayText,
  INSURANCE_COVERAGE_LINES, insuranceDetailMeta,
  mortgageeClauseFor, isRcnNoteBuyer, MORTGAGEE_CLAUSE, MORTGAGEE_CLAUSE_RCN,
  sendOrderMail, sendVerdict, isAmbiguousSendFailure, vendorEmails,
  newOrderMessageId, replyOrderSubject,
  placeOrder,
};
