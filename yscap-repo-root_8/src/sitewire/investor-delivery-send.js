'use strict';
/**
 * INVESTOR DELIVERY — the IO half (owner-directed 2026-08-03).
 *
 * ./investor-delivery.js decides the money, the wording and who may receive it, with no database
 * in reach. This module is everything that touches the world: the investor's contacts, the four
 * documents that ride along, the send itself, and the durable record of what went out.
 *
 * WHAT THE INVESTOR RECEIVES, and why each one:
 *   1. the INSPECTOR's own report      — the third party's word, not ours (Sitewire's per-draw PDF,
 *                                        or the physical inspector's paperwork on a Trinity /
 *                                        TrustPoint file — whichever inspected this draw)
 *   2. OUR branded draw report (PDF)   — photos + per-line approvals + the release breakdown
 *   3. the draw packet (Excel)         — the whole schedule of values with this draw on every line
 *   4. the signed wire instructions     — the borrower's own DocuSign form, so the investor can pay
 *
 * NOTHING IS EVER SILENTLY DROPPED — INTERNALLY. Anything that cannot be attached comes back in
 * `skipped` WITH A REASON on the send response, is stored on the delivery record, and is read back
 * into the desk's delivery history. It is deliberately NOT said in the email itself (owner-directed 2026-08-13: "even if
 * it's not attached, it shouldn't say 'Hey, this was not attached' — it makes it unprofessional"),
 * because that read as an apology to a capital partner for our own plumbing. An investor quietly
 * one document short is still the failure this exists to avoid — the team is the one told.
 *
 * OUR report is built FRESH at send time at email size (~5 MB for a 100-photo draw instead of
 * ~25 MB) and is never filed as a document; the full-quality copy on the file is untouched.
 */

const db = require('../db');
const cfg = require('../config');
const storage = require('../lib/storage');
const email = require('../lib/email');
const template = require('../lib/email/template');
const F = require('../lib/fields');
const rollupMod = require('./rollup');
const drawReport = require('./draw-report');
const { buildDrawPacket } = require('./draw-packet');
const { buildXlsx } = require('../lib/xlsx');
const recipients = require('../lib/draw-recipients');
const drawLabel = require('../lib/draw-label');   // "Draw 2" — the ONE way a draw is named
const fieldRegistry = require('../lib/conditions/field-registry');
const ACCEPT = require('../lib/document-acceptance');
const ID = require('./investor-delivery');
const drawAttachments = require('./draw-attachments');   // invoices/receipts/photos filed on a draw
const attachPlan = require('../lib/attachments/plan');   // what can travel, and why anything cannot
const shareLink = require('../lib/attachments/share-link');

/**
 * The plan, without the bytes — safe to put on an HTTP response.
 *
 * Everything a coordinator needs to decide with: what is going, what was compressed and by how
 * much, what is not going and WHY, and the one remedy that would fix each omission.
 */
function publicPlan(plan) {
  return {
    attach: plan.attach.map((a) => ({
      key: a.key, what: a.what, filename: a.filename, bytes: a.bytes,
      compression: a.compression || null,
    })),
    links: plan.links.map((l) => ({ key: l.key, what: l.what, filename: l.filename, bytes: l.bytes })),
    omitted: plan.omitted,
    total_bytes: plan.totalBytes, budget_bytes: plan.budget,
    compressed_n: plan.compressedCount, saved_bytes: plan.savedBytes,
    needs_consent: plan.needsConsent,
    summary: attachPlan.omissionSummary(plan),
  };
}

const N = (x) => Number(x || 0) || 0;

// The address the investor sees and replies to. Deliberately the shared draw desk, not a person:
// the owner's rule is that this comes from our general draw email and is signed by the coordinator.
// Resend sends as any address on our verified domain; a Graph mailbox ignores `from` and sends as
// itself, so the Reply-To carries the desk either way.
const DESK = recipients.DRAW_DESK_INBOX;
function deskFrom() { return `"YS Capital — Draw Desk" <${DESK}>`; }

// Per-provider attachment budget. Graph rejects inline attachments past ~3 MB, so it gets a much
// smaller ceiling — the same split closing-prep.js uses.
function budgetBytes() {
  const graph = String(cfg.emailProvider || '').toLowerCase() === 'graph';
  const mb = Number(process.env.INVESTOR_ATTACH_BUDGET_MB) || (graph ? 2.5 : 20);
  return Math.max(1, mb) * 1024 * 1024;
}

/**
 * The note-buyer KEY a contact list is stored under.
 *
 * `normNoteBuyer` is deliberately EXACT across this codebase (loosening it would let a look-alike
 * name export another buyer's data tape — tapes/buyer-rule.js), so the owner's real label
 * "Fidelis Investors LLC" normalizes to `fidelisinvestorsllc`, not `fidelis`. Rather than loosen
 * the shared normalizer, we reuse the shared PREFIX helper the repo already blessed for exactly
 * this buyer (`isFidelisNoteBuyer`, db/337) to fold every Fidelis spelling onto one canonical key.
 * A future buyer that needs the same treatment gets a helper in field-registry — never a fuzzy
 * match invented here.
 */
function investorKeyFor(lender) {
  const raw = String(lender == null ? '' : lender).trim();
  if (!raw) return null;
  try { if (fieldRegistry.isFidelisNoteBuyer(raw)) return 'fidelis'; } catch (_) { /* fall through */ }
  // EMCAP is folded the same way and for the same reason: the production label is
  // "EMCAP Financial", which normNoteBuyer (deliberately EXACT) turns into
  // 'emcapfinancial', so a contact list saved under 'emcap' would never be found
  // on a real file. Both folds reuse a helper blessed in field-registry — never a
  // fuzzy match invented here, because the EXPORT direction is where an
  // over-match ships one buyer's tape to another. db/602 moves any row already
  // saved under an unfolded EMCAP key onto 'emcap'.
  try { if (fieldRegistry.isEmcapNoteBuyer(raw)) return 'emcap'; } catch (_) { /* fall through */ }
  const key = fieldRegistry.normNoteBuyer(raw);
  return key || null;
}

/**
 * The saved contacts for a note buyer (active only), in a stable order.
 *
 * `purpose` says WHICH conversation — 'draw' (the team that releases construction
 * money) or 'tape' (the desk that reviews a new file for purchase). They are
 * different people, and reading one list for the other is the bug db/602 fixed
 * (owner-reported 2026-08-21: "It's automatically filling in the FileContacts as
 * those same as the draw. It's a different contact."). It DEFAULTS to 'draw', so
 * every caller that predates the split reads exactly what it always read.
 *
 * Never throws — an unreadable book is an empty list, and the caller refuses to
 * send with no recipients rather than sending somewhere unintended.
 */
async function contactsForNoteBuyer(lender, opts = {}) {
  const key = investorKeyFor(lender);
  if (!key) return [];
  const purpose = opts.purpose === 'tape' ? 'tape' : 'draw';
  try {
    const r = await db.query(
      `SELECT id, label, email, name, role FROM investor_delivery_contacts
        WHERE label_norm = $1 AND active = true AND $2 = ANY(purposes)
        ORDER BY lower(email)`, [key, purpose]);
    return r.rows;
  } catch (_) { return []; }
}

/** Every buyer that has contacts saved — for the settings screen. */
async function allContacts() {
  const r = await db.query(
    `SELECT id, label_norm, label, email, name, role, active, purposes, created_at
       FROM investor_delivery_contacts ORDER BY label_norm, lower(email)`);
  return r.rows;
}

// ---------------------------------------------------------------------------
// ATTACHMENTS
// ---------------------------------------------------------------------------

/** Read a stored document's bytes. Returns null (never throws) when it can't be read. */
async function readDoc(row) {
  if (!row || !row.storage_ref) return null;
  try {
    // storage.read takes the ref alone — the provider composite handles the s3→local fallback.
    const buf = await storage.read(row.storage_ref);
    return buf && buf.length ? buf : null;
  } catch (_) { return null; }
}

/**
 * Gather the delivery's documents IN PRIORITY ORDER — most important first.
 *
 * WHAT CHANGED HERE ON 2026-08-14, and why it matters more than it looks. This function used to do
 * two jobs: find the documents, AND decide which of them fit in one email. The second job was a
 * plain first-fit over this priority-ordered list, which means an oversized document was skipped
 * and the loop moved on — so on the draw that prompted this work the 30 MB inspection report and
 * our 25 MB report were both dropped while the 12 KB spreadsheet and the 127 KB wire form went out.
 * A priority order used only to decide who gets dropped FIRST is pointing backwards.
 *
 * So the fitting is gone from here entirely. This function now only FINDS things, and every
 * document it cannot produce carries a machine-readable `code` instead of a discarded exception:
 *
 *   { key, what, filename, contentType, buf }            — found it, and
 *   { key, what, filename, error: { code, reason } }     — why there is nothing.
 *
 * `lib/attachments/plan.js` then compresses what does not fit, drops only what genuinely cannot be
 * carried, and reports every omission with a remedy. See that file for the four rules.
 *
 * The inspector's report is looked up two ways because a draw is inspected EITHER through Sitewire
 * (a virtual inspection — its per-draw PDF is archived into `draw_media`) OR by a physical
 * inspector whose paperwork arrives as TrustPoint documents. A file can carry both; both are sent.
 *
 * `items` / `skipped` are kept on the return for the surfaces (and tests) that already read them;
 * `candidates` is the ordered list the planner consumes.
 */
async function gatherAttachments(appId, drawId, mode) {
  const items = [];
  const skipped = [];
  // Every omission, with the code that makes the audit log queryable. `push` keeps the legacy
  // `skipped` array in step so nothing that already reads it changes behaviour.
  const missing = [];
  const miss = (key, what, code, reason, filename) => {
    missing.push({ key, what, filename: filename || null, error: { code, reason } });
    skipped.push({ what, reason: reason || code });
  };

  // --- 1. the inspector's own report -------------------------------------------------
  let inspectorFound = false;
  try {
    // Only the NEWEST Sitewire report (owner-directed 2026-08-11): a refresh runs
    // before this send, so after a dispute a NEW draw_media 'draw_pdf' row exists
    // alongside the old one — we deliver the most recent version, never the stale
    // pre-dispute PDF. (An unchanged draw dedups by content hash, so there is only
    // one row anyway.)
    const pdfs = (await db.query(
      `SELECT id, storage_ref, storage_provider, content_type FROM draw_media
        WHERE application_id=$1 AND sitewire_draw_id=$2 AND kind='draw_pdf'
        ORDER BY archived_at DESC LIMIT 1`, [appId, drawId])).rows;
    for (const m of pdfs) {
      const buf = await readDoc(m);
      if (!buf) { miss('inspection', 'Inspection report', 'unreadable', 'the stored copy could not be read', `inspection-report-draw-${drawId}.pdf`); continue; }
      inspectorFound = true;
      items.push({ key: 'inspection', what: 'Inspection report', filename: `inspection-report-draw-${drawId}.pdf`, contentType: 'application/pdf', buf });
    }
  } catch (_) { /* fall through to the physical-inspection lookup */ }

  // The physical inspector's paperwork (Trinity / TrustPoint), keyed on ITS OWN draw number —
  // the two systems number draws independently, so this must never be resolved from the Sitewire
  // number (the same trap borrowerFindingAttachments documents in routes/sitewire.js).
  try {
    const tp = (await db.query(
      `SELECT number FROM trustpoint_draws WHERE sitewire_draw_id=$1::bigint AND application_id=$2`,
      [String(drawId), appId])).rows[0];
    if (tp && tp.number != null) {
      const rows = (await db.query(
        `SELECT id, filename, storage_ref, storage_provider FROM documents
          WHERE application_id=$1 AND is_current AND doc_kind='draw_inspection_report'
            AND filename LIKE 'trustpoint-draw-' || $2 || '-%'
          ORDER BY created_at DESC LIMIT 4`, [appId, String(tp.number)])).rows;
      for (const d of rows) {
        const buf = await readDoc(d);
        if (!buf) { miss(`inspection_tp_${d.id}`, `Inspection paperwork (${d.filename})`, 'unreadable', 'the stored copy could not be read', d.filename); continue; }
        inspectorFound = true;
        items.push({ key: `inspection_tp_${d.id}`, what: 'Inspection paperwork', filename: d.filename, contentType: 'application/pdf', buf });
      }
    }
  } catch (_) { /* trustpoint_draws may not exist on an older database — not fatal */ }

  if (!inspectorFound) miss('inspection', 'Inspection report', 'not_on_file', "the inspector's report has not been archived for this draw yet");

  // --- 2. our own branded report ------------------------------------------------------
  // BUILT FRESH, AT EMAIL SIZE, AND NEVER FILED (owner-directed 2026-08-13: "while you click
  // Deliver to Investor it should take all the photos and redraw a new report on a much more
  // compressed version that should definitely fit in all the email versions").
  //
  // The report we KEEP embeds page-sized photos and runs ~25 MB on a 100-photo draw — right for
  // the copy on the file, too big for any mailbox (Gmail refuses over 25 MB RECEIVED, and email
  // encoding inflates a file by about a third on the way out). This copy embeds the ~700px
  // rendition instead: same report, every photo, ~5 MB.
  //
  // It is NEVER stored — see buildReportBytes for the three traps that made a second stored
  // report the wrong answer. The full-quality report on the file is untouched by this.
  //
  // FALLING BACK IS DELIBERATE, NOT A LEFTOVER: a draw whose photos have no compact rendition yet
  // (the background worker is paced, so a freshly archived draw can be ahead of it) still gets a
  // report — just a larger one, which the budget below then judges on its merits. Sending a
  // bigger report is a far better failure than sending none.
  let reportRendition = null;
  try {
    const built = await drawReport.buildReportBytes(appId, {
      sitewireDrawId: drawId, scope: 'draw', mode: 'staff', rendition: 'compact',
    });
    if (built && built.bytes && built.bytes.length) {
      reportRendition = { rendition: built.rendition, bytes: built.bytes.length, photos: built.photoCount, omitted: built.photosOmitted };
      items.push({ key: 'report', what: 'PILOT draw report', filename: built.filename, contentType: 'application/pdf', buf: built.bytes, rendition: built.rendition });
    } else miss('report', 'PILOT draw report', 'build_failed', 'there is no draw data to build a report from yet');
  } catch (e) {
    // THE MESSAGE IS KEPT. This was a bare `catch (_)` that reported "the report could not be built"
    // and threw the actual error away — so when the report genuinely failed, nothing anywhere could
    // say why, on the screen or in the log. The reason a coordinator reads is still plain English;
    // the developer detail rides beside it.
    miss('report', 'PILOT draw report', 'build_failed',
      `the report could not be built for this draw${e && e.message ? ` (${String(e.message).slice(0, 120)})` : ''}`);
  }

  // --- 3. the draw packet (Excel) -----------------------------------------------------
  try {
    const buf = buildXlsx(await buildDrawPacket(appId, drawId), `Draw ${drawId}`);
    // `compressible: false` — a .xlsx is already a deflate ZIP and has nothing to win.
    if (buf && buf.length) items.push({ key: 'packet', what: 'Draw packet', filename: `draw-packet-${drawId}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf, compressible: false });
    else miss('packet', 'Draw packet', 'build_failed', 'the packet came back empty');
  } catch (e) {
    miss('packet', 'Draw packet', 'build_failed',
      `the packet could not be built${e && e.message ? ` (${String(e.message).slice(0, 120)})` : ''}`);
  }

  // --- 4. the borrower's signed wire instructions --------------------------------------
  // The signed wire form tells the investor WHERE to send the borrower's money, so it
  // belongs ONLY on an INVESTOR_DIRECT delivery — the investor is releasing straight to
  // the borrower and needs it. On a REIMBURSEMENT delivery WE have already wired the
  // borrower and the investor is only paying US back, so the borrower's wire form must
  // NOT be sent to the investor (owner-directed 2026-08-05: "if we are requesting
  // reimbursement for us, you should not attach the borrower's wire draw form … If we
  // are asking for the investor to release it directly to the borrower, then that
  // form's signed, executed version should be sent to the investor").
  if (mode === 'investor_direct') {
    try {
      // Deliver the ACCEPTED wire form — a DocuSign copy OR a manually-uploaded one (both are
      // draw_request_signed; the manual one is told apart only by source_type). Selecting the
      // newest ACCEPTED current copy (not just the newest current) keeps what is DELIVERED in
      // lock-step with what the money gate (wireFormStatus) approved: if two current copies ever
      // coexist, the investor never receives an unaccepted one.
      const w = (await db.query(
        `SELECT id, filename, storage_ref, storage_provider FROM documents
          WHERE application_id=$1 AND is_current AND doc_kind='draw_request_signed' AND ${ACCEPT.ACCEPTED_SQL('')}
          ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
      const buf = w ? await readDoc(w) : null;
      if (buf) items.push({ key: 'wire', what: 'Signed wire instructions', filename: w.filename || 'wire-instructions-signed.pdf', contentType: 'application/pdf', buf });
      else if (w) miss('wire', 'Signed wire instructions', 'unreadable', 'the stored copy could not be read', w.filename);
      else miss('wire', 'Signed wire instructions', 'not_on_file', 'the accepted wire instructions form is not on file yet');
    } catch (_) { miss('wire', 'Signed wire instructions', 'unreadable', 'the stored copy could not be read'); }

    // --- 5. the wire-recipient entity's operating agreement. A NEW-entity wire attaches the
    // agreement accepted on the wire condition (owner-directed 2026-08-05: "attach the OA to the
    // investor email when the investor receives it"); a KNOWN-entity wire attaches the ACCEPTED
    // agreement from that entity's own profile slot (owner-directed 2026-08-26: "automatically
    // bring in the operating agreement from that particular entity profile if it has one") — the
    // fallback lives inside acceptedOaForInvestor, one definition. A wire to the borrower
    // personally attaches nothing. Only an ACCEPTED agreement is ever sent (db/424).
    try {
      const drawOa = require('../lib/esign/draw-oa');
      const oa = await drawOa.acceptedOaForInvestor(db, appId);
      if (oa) {
        const buf = await readDoc(oa);
        if (buf) items.push({ key: 'oa', what: 'Operating agreement (wire recipient)', filename: oa.filename || 'operating-agreement.pdf', contentType: 'application/pdf', buf });
        else miss('oa', 'Operating agreement (wire recipient)', 'unreadable', 'the stored copy could not be read', oa.filename);
      }
      // No OA condition / no accepted agreement → the wire is to the borrower or the subject LLC;
      // nothing to attach, and nothing to report as missing.
    } catch (_) { /* the OA is an extra only on a new-entity wire — never block the delivery */ }
  }

  // --- 6. the supporting documents attached to this draw --------------------------------
  // Invoices, receipts and extra photos a coordinator (or the borrower) filed on the draw —
  // typically the proof behind an override (owner-directed 2026-08-09: "when we override
  // something, we should be able to add invoices, receipts, or additional photos, and that should
  // also be delivered to the investor on investor delivery"). They sit AFTER the reports in
  // priority order deliberately: the inspector's report and ours are what the investor funds
  // against; these are the backup. Only an ACCEPTED document travels — a borrower's upload nobody
  // has reviewed is not something we vouch for to an investor (db/424).
  try {
    const rows = (await db.query(
      `SELECT da.category, da.note, d.id, d.filename, d.content_type, d.storage_ref, d.storage_provider, d.review_status
         FROM draw_attachments da JOIN documents d ON d.id = da.document_id
        WHERE da.application_id=$1 AND da.sitewire_draw_id=$2 AND d.is_current
        ORDER BY da.created_at ASC, da.id ASC`, [appId, drawId])).rows;
    for (const a of rows) {
      const label = `${drawAttachments.CATEGORY_LABEL[a.category] || 'Supporting document'} — ${a.filename}`;
      const key = `support_${a.id}`;
      if (a.review_status !== 'accepted') {
        miss(key, label, 'not_accepted', 'it has not been accepted yet — review it first and re-send', a.filename);
        continue;
      }
      const buf = await readDoc(a);
      if (!buf) { miss(key, label, 'unreadable', 'the stored copy could not be read', a.filename); continue; }
      items.push({ key, what: label, filename: a.filename, contentType: a.content_type || 'application/octet-stream', buf });
    }
  } catch (_) { /* an older database has no draw_attachments — never block the delivery */ }

  // --- 7. ground-up plans & permits ------------------------------------------------------
  // Owner-directed 2026-08-18: "either way, it should be included as part of the investor
  // draw delivery." The approved plans + building permits — what the construction the
  // investor is funding is AUTHORIZED to build — from the closing condition AND the
  // first-draw condition, ACCEPTED only (db/424: a document nobody vouched for never goes
  // to an investor), deduped by content hash inside acceptedPlansForInvestor so the
  // pre-filled first-draw COPY never ships beside its identical original. Placed AFTER the
  // supporting documents so it never displaces the inspector's report or ours in the
  // priority order the attachment plan walks. Ground-up files only; a rehab file reports
  // nothing at all here (never a false "missing").
  try {
    const plans = await require('./plans-permits').acceptedPlansForInvestor(appId);
    for (const p of plans) {
      const key = `plans_${p.id}`;
      const buf = await readDoc(p);
      if (!buf) { miss(key, 'Plans & permits', 'unreadable', 'the stored copy could not be read', p.filename); continue; }
      items.push({ key, what: 'Plans & permits', filename: p.filename || 'plans-permits.pdf', contentType: p.content_type || 'application/octet-stream', buf });
    }
  } catch (_) { /* plans are evidence about the project — never block the delivery itself */ }

  // THE FITTING USED TO HAPPEN HERE AND NO LONGER DOES — see the header. What is returned is the
  // ordered candidate list; lib/attachments/plan.js decides what can be carried, compressing before
  // it drops anything and never letting a small file displace an important one.
  //
  // `reportRendition` is carried so the delivery ROW can record which rendering of the report
  // actually went out — the compact copy is never filed as a document, so this is the only place
  // that answers "what did that investor receive?" later.
  return {
    candidates: [...items, ...missing],
    items, skipped, reportRendition,
    totalBytes: items.reduce((n, i) => n + i.buf.length, 0),
    budgetBytes: budgetBytes(),
  };
}

// ---------------------------------------------------------------------------
// WIRE FORM GATE
// ---------------------------------------------------------------------------

/**
 * The signed WIRE FORM's review state on the FILE (the wire instructions are the same across
 * every draw, so this is a file-level check — once accepted, every later draw is cleared).
 *
 * The borrower's DocuSign wire form files onto the draw_cond_signed_request condition
 * (doc_kind draw_request_signed); a coordinator may also upload a corrected version onto that
 * same condition. Either way, the money can only move once ONE correct version has been
 * ACCEPTED — the owner's "accept one version, reject the rest, before the first draw goes to
 * the investor". Acceptance uses the ONE shared definition (document-acceptance), so this gate
 * and the sign-off gate can never disagree about what "accepted" means.
 *
 * FAILS OPEN on a read error: a database blip must never make a delivery permanently
 * impossible — the finding-agreed and note-buyer checks are the primary money gates, and the
 * coordinator is in the loop clicking send.
 *
 * Returns { present, accepted, rejectedOnly }.
 */
async function wireFormStatus(appId) {
  try {
    const item = (await db.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`,
      [appId, `draw:request:${appId}`])).rows[0];
    const wireItemId = item ? item.id : null;
    const r = (await db.query(
      `SELECT
         count(*) FILTER (WHERE ${ACCEPT.ACCEPTED_SQL('d')}) AS accepted,
         count(*) FILTER (WHERE COALESCE(d.review_status,'pending') = 'rejected') AS rejected,
         count(*) AS total
       FROM documents d
      WHERE d.application_id=$1 AND d.is_current
        AND (d.doc_kind='draw_request_signed' OR ($2::uuid IS NOT NULL AND d.checklist_item_id=$2))`,
      [appId, wireItemId])).rows[0] || {};
    const total = Number(r.total) || 0;
    const rejected = Number(r.rejected) || 0;
    const accepted = Number(r.accepted) > 0;
    return { present: total > 0, accepted, rejectedOnly: total > 0 && !accepted && rejected === total };
  } catch (_) {
    return { present: false, accepted: true, rejectedOnly: false };   // fail OPEN
  }
}

// ---------------------------------------------------------------------------
// PREVIEW + SEND
// ---------------------------------------------------------------------------

/** Everything the desk needs to show BEFORE anyone clicks send. Never throws. */
async function deliveryPreview(appId, drawId) {
  const app = (await db.query(
    `SELECT a.ys_loan_number AS loan_no, a.lender AS note_buyer, a.property_address->>'oneLine' AS address,
            NULLIF(btrim(b.full_name),'') AS borrower_name, b.email AS borrower_email,
            cb.email AS co_borrower_email
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
      WHERE a.id = $1`, [appId])).rows[0] || {};

  const finding = (await db.query(
    `SELECT id, status, funding_mode, accepted_at, accepted_via, resolved_at
       FROM draw_findings WHERE application_id=$1 AND sitewire_draw_id=$2`, [appId, drawId])).rows[0] || null;

  const link = (await db.query(
    `SELECT investor_funding_mode FROM sitewire_property_links
      WHERE application_id=$1 AND matched_by='created' LIMIT 1`, [appId])).rows[0] || {};

  // HAS THIS LOAN ACTUALLY BEEN SOLD? Read BEFORE the mode, because since 2026-08-13 it decides
  // the mode rather than merely commenting on it (see below). Best-effort: an unreadable state
  // leaves the file's own setting exactly as it was.
  let soldState = null;
  try { soldState = await require('./release-party').releaseStateFor(db, appId, { sitewireDrawId: drawId }); }
  catch (_) { soldState = null; }

  // AN UNSOLD LOAN IS RELEASED BY US (owner-directed 2026-08-13): *"if it's not yet sold, then it
  // should always be set up that we release the net amount"*. Applied through the SAME pure rule
  // the draw desk and the money ledger use, so the figures in this email can never contradict the
  // card the coordinator was just looking at — an investor who has not bought the loan is not
  // wiring this borrower. A sold loan (or one the desk is processing as sold) keeps the file's own
  // setting, whichever way it points.
  const configuredMode = ID.resolveFundingMode({
    drawMode: finding && finding.funding_mode,
    fileMode: link.investor_funding_mode,
  });
  const enforced = soldState
    ? require('./release-party').enforcedMode({ mode: configuredMode, sold: soldState.soldEffective })
    : { mode: configuredMode, forced: false };
  const mode = enforced.mode;

  // The SAME money the report and the packet were built from — never re-derived here.
  let money = ID.investorMoney({}, mode);
  let drawNumber = null;
  try {
    const rl = await rollupMod.loadRollup(db, appId);
    const d = (rl.draws || []).find((x) => Number(x.sitewire_draw_id) === Number(drawId));
    if (d) { money = ID.investorMoney(d, mode); drawNumber = d.number; }
  } catch (_) { /* the preview still renders; the blockers below say what is missing */ }
  // The rollup is the fast path; when it could not be read (or carries no number for this draw)
  // fall back to the ONE number resolver, so the investor's subject stops silently degrading to
  // the anonymous "Draw request". Still never guesses — null stays null.
  if (drawNumber == null) {
    drawNumber = await drawLabel.drawNumberFor(db, appId, { sitewireDrawId: drawId });
  }

  const contacts = await contactsForNoteBuyer(app.note_buyer);
  const wireForm = await wireFormStatus(appId);
  const [coordinators, officerEmails] = await Promise.all([
    recipients.coordinatorsOrDesk(appId).catch(() => []),
    recipients.fileLoanOfficerEmails(appId).catch(() => []),
  ]);
  const rcpt = ID.composeRecipients({
    investorEmails: contacts.map((c) => c.email),
    coordinatorEmails: coordinators.map((c) => c.email),
    officerEmails,
    deskEmail: DESK,
    borrowerEmails: [app.borrower_email, app.co_borrower_email],
  });

  // PLANS & PERMITS BEFORE THE FIRST DRAW (owner-directed 2026-08-18): read once here,
  // carried on the preview so the send's re-check judges the SAME state it showed.
  let plansPermits = null;
  try { plansPermits = await require('./plans-permits').status(appId); } catch (_) {}
  const blockers = ID.deliveryBlockers({ finding, investorContacts: contacts, noteBuyer: app.note_buyer, mode, wireForm, plansPermits });

  // THE BADGE IS STILL NEVER A BLOCKER. It is deliberately kept OUT of `blockers`, so `can_send`
  // is untouched and the send is never refused over it; the screen shows it beside the button and
  // the coordinator decides — and now it also explains the figures, since an unsold loan has
  // already moved the mode to "we release" above. A table-funded loan carries no badge at all,
  // which is the whole point: otherwise every Fidelis delivery would nag about a date that is
  // never coming. (`soldState` is read further up, because the mode depends on it.)

  const history = (await db.query(
    // `attachments` + `skipped` ride along deliberately: the email no longer names what it could
    // not carry (owner-directed 2026-08-13), so the desk's own history is where our team reads it.
    `SELECT id, funding_mode, investor_total_cents, to_borrower_cents, to_us_cents, to_emails,
            status, error, sent_at, sent_by, attachments, skipped
       FROM draw_investor_deliveries WHERE application_id=$1 AND sitewire_draw_id=$2
      ORDER BY sent_at DESC LIMIT 10`, [appId, drawId])).rows;

  // THE EXACT WORDING THE SEND RENDERS (owner-directed 2026-08-26: "it should populate a
  // full preview ... fully editable"). Same pure ID.deliveryEmail + the same template — only
  // the attachment-inventory lines are absent, because the plan is built at SEND time (it
  // renders the PDF report + the Excel packet, which a page load must not pay for); the
  // screen says the attachments are listed at send. Best-effort — an error hides the
  // editable body, never the preview.
  let previewEmail = null;
  try {
    const wording = ID.deliveryEmail({
      loanNo: app.loan_no, address: app.address, drawNumber,
      borrowerName: app.borrower_name || null, coordinatorName: null, inspectionBy: null,
    }, money);
    const r2 = template.render({
      title: 'Draw request for funding', kicker: 'Draw delivery',
      intro: wording.intro, meta: [...wording.rows, ...wording.detail],
      callout: { title: 'What we are asking for', body: wording.ask, tone: 'action' },
      note: wording.signOff, replyable: true,
    });
    previewEmail = { subject: wording.subject, text: r2.text };
  } catch (_) { previewEmail = null; }

  return {
    draw_id: Number(drawId), draw_number: drawNumber,
    email: previewEmail,
    note_buyer: app.note_buyer || null,
    note_buyer_key: investorKeyFor(app.note_buyer),
    address: app.address || null, loan_no: app.loan_no || null,
    borrower_name: app.borrower_name || null,
    finding_status: finding ? finding.status : null,
    accepted_via: finding ? finding.accepted_via : null,
    funding_mode: mode,
    funding_mode_source: (finding && ID.MODES.includes(String(finding.funding_mode || ''))) ? 'draw'
      : (ID.MODES.includes(String(link.investor_funding_mode || '')) ? 'file' : 'default'),
    money,
    contacts,
    wire_form: wireForm,
    // carried so the send's re-check judges the SAME plans-&-permits state it showed
    plans_permits: plansPermits,
    to: rcpt.to, cc: rcpt.cc,
    blockers,
    // `can_send` reads ONLY the blockers. The sold warning below is advisory by the owner's own
    // rule and must never creep into this — if it ever needs to stop a send, that is a new
    // owner decision, not a line moved.
    can_send: blockers.length === 0,
    sold: soldState ? soldState.sold : null,
    sold_label: soldState ? soldState.soldLabel : null,
    sold_via: soldState ? soldState.soldVia : null,
    sold_warning: soldState ? soldState.warning : null,
    history,
  };
}

/**
 * SEND the delivery. The caller has already confirmed (the route requires an explicit
 * `confirm:true` naming the investor) and has file access + manage_draws.
 *
 * The blockers are re-checked HERE, not trusted from the preview the screen fetched earlier: the
 * borrower could have been un-accepted, or the contacts edited, between the two calls.
 */
async function sendInvestorDelivery(appId, drawId, {
  staffId = null, staffName = null, mode = null, note = null,
  // THE CONSENT GATE (owner-directed 2026-08-14). Absent, a delivery that cannot carry all of its
  // documents REFUSES with a 409 naming each one and why. Set, the coordinator has been shown that
  // list and chosen to send anyway — which is recorded on the delivery row, in the email audit and
  // in the log line, so "it should not be ignored blindly" holds in the record and not just on the
  // screen.
  acknowledgeOmissions = false,
  // Documents the coordinator chose to send as a PILOT link instead of an attachment.
  shareLinkKeys = [],
  // "Compress harder and retry" — a ceiling on how far the compressor may go.
  compressLevel = null,
  // Build the plan and return it WITHOUT sending. What the desk calls to show the picture before
  // anybody commits to anything.
  preflight = false,
  // A hand-edited subject/body from the compose preview (owner-directed 2026-08-26),
  // landed through the ONE lib/email/manual-override chokepoint below.
  override = null,
} = {}) {
  // REFRESH FROM SITEWIRE FIRST (owner-directed 2026-08-11: "when we click Deliver
  // to Investor, that button — before actually delivering — should run a refresh
  // from Sitewire: refresh our figures, pull the new Sitewire PDF, and THAT PDF is
  // what's delivered"). A dispute may have changed the approved figures, which
  // regenerates Sitewire's report; without this the investor got the stale
  // pre-dispute copy. Best-effort: if Sitewire is unreachable we deliver the
  // freshest we already hold rather than block the delivery.
  try { await drawReport.refreshDrawFromSitewire(appId, drawId); }
  catch (e) { console.warn(`[sitewire] pre-delivery refresh failed (draw=${drawId}): ${e && e.message}`); }

  const pre = await deliveryPreview(appId, drawId);

  // An explicit mode on the request wins for THIS send (the desk offers the switch right beside
  // the button); otherwise the resolved per-draw/per-file/default mode stands.
  const useMode = ID.MODES.includes(String(mode || '')) ? String(mode) : pre.funding_mode;

  // Re-check the blockers AGAINST THE MODE THIS SEND WILL USE — never trust the preview's list,
  // which was computed for the resolved mode and may need different things (a manual delivery needs
  // no investor contacts; an emailed one does).
  const blockers = ID.deliveryBlockers({
    finding: pre.finding_status ? { status: pre.finding_status } : null,
    investorContacts: pre.contacts, noteBuyer: pre.note_buyer, mode: useMode, wireForm: pre.wire_form,
    plansPermits: pre.plans_permits || null,
  });
  if (blockers.length) { const e = new Error(blockers[0]); e.status = 422; e.blockers = blockers; throw e; }

  const money = ID.investorMoney(pre.money, useMode);
  const noteText = String(note == null ? '' : note).trim().slice(0, 2000) || null;

  // MANUAL — the coordinator delivered to the investor outside PILOT. Record it (so the "deliver to
  // the investor" reminders stop and the history shows it) and stop here: no email is composed or
  // sent, and no documents are gathered. The money figures are still stored for the record.
  // A PREFLIGHT MAY NEVER WRITE, and on a MANUAL delivery that has to be checked HERE rather than
  // alongside the attachment plan further down. A manual delivery returns early — it composes no
  // email and gathers no documents — so a preflight on one would have fallen straight into the
  // INSERT below and RECORDED A DELIVERY NOBODY SENT. There is nothing to plan in that mode, so an
  // empty plan is the honest answer. (The non-manual preflight returns after the plan is built.)
  if (preflight && useMode === 'manual') {
    return {
      preflight: true, funding_mode: 'manual', money,
      plan: { attach: [], links: [], omitted: [], total_bytes: 0, budget_bytes: budgetBytes(),
        compressed_n: 0, saved_bytes: 0, needs_consent: false, summary: null, manual: true },
      linkWarnings: shareLink.LINK_WARNINGS,
    };
  }

  if (useMode === 'manual') {
    const rec = (await db.query(
      `INSERT INTO draw_investor_deliveries
         (application_id, sitewire_draw_id, funding_mode, note_buyer_label, note_buyer_key,
          requested_cents, approved_cents, fee_cents, retainage_held_cents,
          to_borrower_cents, to_us_cents, investor_total_cents,
          to_emails, cc_emails, attachments, skipped, status, note, sent_by)
       VALUES ($1,$2,'manual',$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'sent',$12,$13)
       RETURNING id, sent_at`,
      [appId, drawId, pre.note_buyer, pre.note_buyer_key,
        money.requested_cents, money.approved_cents, money.fee_cents, money.retainage_held_cents,
        money.to_borrower_cents, money.to_us_cents, money.investor_total_cents,
        noteText, staffId])).rows[0];
    return {
      id: rec.id, sent_at: rec.sent_at, funding_mode: 'manual', money,
      to: [], cc: [], attachments: [], skipped: [], manual: true, note: noteText,
    };
  }

  // ── THE ATTACHMENTS, AND THE CONSENT GATE ─────────────────────────────────────────────────
  // (owner-directed 2026-08-14: "when you click send an email if there's an attachment that cannot
  // be attached, you need to say clearly what cannot be attached and why. If the person still wants
  // to send it, they can send it, but it should not be ignored blindly.")
  //
  // The plan is built HERE rather than in deliveryPreview on purpose: building it means generating
  // the report and the packet, which is far too expensive to do on every page load. So the flow is
  // — press Send, we work out exactly what can travel, and if anything cannot we REFUSE and hand
  // the desk the whole picture. The coordinator then compresses harder, turns something into a
  // PILOT link, or knowingly sends it short. Every one of those is recorded.
  const { candidates, skipped: gatherSkipped, reportRendition } = await gatherAttachments(appId, drawId, useMode);

  const wantLinks = new Set((Array.isArray(shareLinkKeys) ? shareLinkKeys : []).map(String));
  const plan = await attachPlan.buildAttachmentPlan(candidates, {
    budgetBytes: budgetBytes(),
    // "Compress and retry" simply asks for a harder ceiling; unset, the planner still compresses as
    // far as it needs to and stops at the first level that fits.
    maxLevel: compressLevel || undefined,
    shareLinkKeys: wantLinks,
  });

  // PREFLIGHT — show the picture, send nothing. Returned before any link is minted, so looking is
  // free of side effects.
  if (preflight) {
    return { preflight: true, funding_mode: useMode, money, plan: publicPlan(plan), linkWarnings: shareLink.LINK_WARNINGS };
  }

  if (plan.needsConsent && !acknowledgeOmissions) {
    // NOT AN ERROR — a question. The desk gets the full plan so it can name every document, say why
    // in plain words, and offer the remedy that fits each one.
    const e = new Error(attachPlan.omissionSummary(plan));
    e.status = 409;
    e.code = 'attachments_incomplete';
    e.plan = publicPlan(plan);
    e.linkWarnings = shareLink.LINK_WARNINGS;
    throw e;
  }

  // Mint the PILOT links the coordinator asked for. A link that cannot be created falls back to
  // being reported as an omission rather than vanishing — never a silent nothing.
  const links = [];
  for (const l of plan.links) {
    const made = await shareLink.createShareLink({
      applicationId: appId, buf: l.buf, filename: l.filename, contentType: l.contentType,
      purpose: 'investor_delivery', label: l.what, createdBy: staffId,
    });
    if (made) links.push({ ...made, what: l.what, key: l.key });
    else plan.omitted.push({ key: l.key, what: l.what, filename: l.filename, code: 'build_failed',
      reason: 'a PILOT link could not be created for it', remedy: 'retry', bytes: l.bytes });
  }

  const items = plan.attach;
  // `plan.omitted` is already the COMPLETE list — the planner turns every candidate that arrived
  // with an `error` into an omission and adds the ones that could not be made to fit — so this is
  // the one source, not a merge of two that could disagree. Shape kept for the delivery row and the
  // desk's history, now carrying the code and the remedy as well as the sentence.
  const skipped = plan.omitted.map((m) => ({ what: m.what, reason: m.reason, code: m.code, remedy: m.remedy, bytes: m.bytes }));
  void gatherSkipped;   // retained above only for the legacy shape gatherAttachments still returns

  let inspectionBy = null;
  try {
    const tp = (await db.query(`SELECT 1 FROM trustpoint_draws WHERE sitewire_draw_id=$1::bigint AND application_id=$2`, [String(drawId), appId])).rows[0];
    inspectionBy = tp ? 'Physical inspection' : 'Third-party inspection';
  } catch (_) { /* optional detail */ }

  const wording = ID.deliveryEmail({
    loanNo: pre.loan_no, address: pre.address, drawNumber: pre.draw_number,
    borrowerName: pre.borrower_name, coordinatorName: staffName, inspectionBy,
  }, money);

  const meta = [...wording.rows, ...wording.detail];
  const lines = [wording.intro];
  // WHAT WE SENT, NOT WHAT WE COULDN'T (owner-directed 2026-08-13: "even if it's not attached, it
  // shouldn't say 'Hey, this was not attached' — it makes it unprofessional").
  //
  // This used to append "Not attached: PILOT draw report (too large to attach to one email — send
  // it separately). Let us know and we will send it over." — an apology for our own plumbing, in a
  // letter to a capital partner, ending by asking THEM to chase US. It now names what IS enclosed
  // and stops there.
  //
  // NOTHING IS LOST INTERNALLY, which is what makes this safe rather than a cover-up: every skipped
  // item and its reason is returned to the caller on the send, written to
  // `draw_investor_deliveries.skipped`, and read back into the desk's delivery history — so our
  // team can always answer "what did that email actually carry?". It is simply no longer said out
  // loud to the investor. And since 2026-08-14 it is known BEFORE the send too, not discovered
  // after it: the consent gate above refuses rather than quietly sending short, so a coordinator
  // has seen this exact list and either fixed it or accepted it on the record.
  if (items.length) {
    lines.push('Enclosed: ' + items.map((it) => it.what).join(', ') + '.');
  }
  // A document too large to attach travels as a PILOT link instead. It is named the same way an
  // attachment is, so the reader sees one list of what came with the email rather than having to
  // work out that something is missing.
  if (links.length) {
    lines.push(`${links.length === 1 ? 'One document is' : `${links.length} documents are`} too large to attach, so ${links.length === 1 ? 'it is' : 'they are'} linked below — the link opens the document directly, no sign-in needed.`);
  }

  // template.render returns { subject, html, text } — take BOTH bodies from it so the HTML and the
  // plain-text alternative are generated from one set of inputs and can never say different things.
  // Our own subject wins (render's is built from `title`).
  // The links go in the NOTE beside the attachment list, so the reader sees one inventory of what
  // came with this email rather than an attachment list that quietly omits two documents. ONE
  // variable, because the override re-render below must carry the SAME note: an edited body used
  // to be re-rendered with no note at all, so the PILOT link URLs — which live ONLY here —
  // silently vanished from an email whose delivery record still claimed they were sent
  // (post-merge audit W5). The inventory is not editable words; it is what the email carries.
  const inventoryNote = `Attached: ${items.map((i) => i.what).join(', ') || (links.length ? 'see the links below' : 'no documents could be attached')}.`
    + (links.length ? `\n\n${links.map((l) => `${l.what}: ${l.url}`).join('\n')}` : '')
    + `\n\n${wording.signOff}`;
  const rendered = template.render({
    title: 'Draw request for funding',
    kicker: 'Draw delivery',
    intro: lines.join(' '),
    meta,
    callout: { title: 'What we are asking for', body: wording.ask, tone: 'action' },
    note: inventoryNote,
    replyable: true,
  });
  // A hand-edited subject/body lands through the ONE manual-override chokepoint
  // (owner-directed 2026-08-26); no override -> byte-identical to before. The
  // attachments themselves are never editable — only the words around them, which is
  // exactly why the inventory note rides opts.note into the edited-body re-render.
  const builtEmail = require('../lib/email/manual-override').applyOverride(
    { subject: wording.subject, html: rendered.html, text: rendered.text }, override,
    { title: 'Draw request for funding', note: inventoryNote });
  const html = builtEmail.html;
  const text = builtEmail.text;

  let status = 'sent';
  let errText = null;
  // THE UNIQUE REPLY-TO (owner-directed 2026-08-18: "when sending out an email
  // to an investor, it should have a unique reply-to … open up the inbox in the
  // investor delivery to see the investor's response. It should also be
  // delivered to the team"). Reply-To is the file's own file+<id>@ address, so
  // the investor's reply fans out to everyone assigned to the file AND is
  // captured into the file's Email Center — the desk falls back only when no
  // inbound reply domain is configured (then replies still reach the humans at
  // draws@). The team is already visibly on the email itself (pre.cc).
  //
  // `threadKey` pins this send to the SAME conversation key an inbound
  // "Re: <subject>" reply derives (email-log normalizes both through
  // normalizeSubject), and is stored on the delivery row below so the desk's
  // delivery card can show the investor's actual replies.
  const FA = require('../lib/file-address');
  const emailLog = require('../lib/email-log');
  const uniqueReplyTo = FA.fileReplyTo(appId) || DESK;
  const threadKey = emailLog.threadKeyFor(appId, builtEmail.subject);
  try {
    await email.sendMail({
      to: pre.to,
      cc: pre.cc,
      from: deskFrom(),
      replyTo: uniqueReplyTo,
      subject: builtEmail.subject,
      text,
      html,
      attachments: items.map((i) => ({ filename: i.filename, content: i.buf.toString('base64'), contentType: i.contentType })),
      // THE AUDIT RIDES WITH THE SEND (db/550). The chokepoint writes `omitted` + `attach_summary`
      // onto the email_messages row and prints the [email-attach] log line, so "which documents did
      // that investor actually get, and why not the others?" is answerable from the audit log and
      // from a log search — not only from this one table that one card reads.
      _ctx: {
        applicationId: appId, type: 'draw_investor_delivery', audience: 'staff', threadKey,
        ...attachPlan.auditFrom(plan, {
          links_n: links.length,
          // WHO knowingly sent it short, and when. This is the record behind "if the person still
          // wants to send it, they can — but it should not be ignored blindly".
          consent: plan.omitted.length
            ? { by: staffId || null, name: staffName || null, at: new Date().toISOString(), note: noteText || null }
            : null,
        }),
      },
    });
  } catch (e) {
    status = 'error';
    errText = String((e && e.message) || 'send failed').slice(0, 500);
  }

  const rec = (await db.query(
    `INSERT INTO draw_investor_deliveries
       (application_id, sitewire_draw_id, funding_mode, note_buyer_label, note_buyer_key,
        requested_cents, approved_cents, fee_cents, retainage_held_cents,
        to_borrower_cents, to_us_cents, investor_total_cents,
        to_emails, cc_emails, attachments, skipped, status, error, note, sent_by, thread_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id, sent_at`,
    [appId, drawId, useMode, pre.note_buyer, pre.note_buyer_key,
      money.requested_cents, money.approved_cents, money.fee_cents, money.retainage_held_cents,
      money.to_borrower_cents, money.to_us_cents, money.investor_total_cents,
      F.jsonbText(pre.to), F.jsonbText(pre.cc),
      // WHICH RENDERING WENT OUT is recorded per item. The compact report is built into the email
      // and never filed as a document, so this row is the only lasting answer to "what did the
      // investor actually receive?".
      // `compression` and `link` ride along so the history can say WHY a 25 MB report arrived as a
      // 4 MB one, and which documents travelled as a link rather than an attachment.
      F.jsonbText([
        ...items.map((i) => ({ filename: i.filename, what: i.what, bytes: i.bytes || (i.buf ? i.buf.length : null), rendition: i.rendition || null, compression: i.compression || null })),
        ...links.map((l) => ({ filename: l.filename, what: l.what, bytes: l.bytes, link: l.url, expires_at: l.expiresAt })),
      ]),
      F.jsonbText(skipped), status, errText, noteText, staffId, threadKey])).rows[0];

  if (status === 'error') { const e = new Error(errText || 'the delivery email could not be sent'); e.status = 502; throw e; }

  return {
    id: rec.id, sent_at: rec.sent_at, funding_mode: useMode, money,
    to: pre.to, cc: pre.cc,
    attachments: items.map((i) => ({ filename: i.filename, what: i.what, bytes: i.bytes || (i.buf ? i.buf.length : null), rendition: i.rendition || null, compression: i.compression || null })),
    links: links.map((l) => ({ what: l.what, filename: l.filename, url: l.url, expiresAt: l.expiresAt, bytes: l.bytes })),
    skipped,
    plan: publicPlan(plan),
    // Which rendering of OUR report went out, and how many photos it carried — the compact copy is
    // never filed, so this is the only place that answers it.
    reportRendition,
  };
}

module.exports = {
  investorKeyFor, contactsForNoteBuyer, allContacts,
  gatherAttachments, deliveryPreview, sendInvestorDelivery, wireFormStatus,
  DESK, deskFrom, budgetBytes, publicPlan,
};
