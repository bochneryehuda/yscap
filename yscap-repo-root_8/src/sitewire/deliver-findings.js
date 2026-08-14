'use strict';
/**
 * DELIVER INSPECTION FINDINGS TO THE BORROWER — the ONE chokepoint, plus the AUTOPILOT that fires it.
 *
 * (owner-directed 2026-08-14) Borrower delivery goes on autopilot. After an inspection comes back and
 * the inspector's approved amounts are on the draw, PILOT delivers the findings to the borrower
 * AUTOMATICALLY — the coordinator no longer has to log in and press "Deliver findings to borrower".
 * The borrower still receives the results email to accept / reject / dispute / approve. The manual
 * Deliver / Re-send button stays exactly as it was, for a deliberate re-send. This is the ONLY step
 * that goes on autopilot — approvals, releases and investor delivery all stay manual.
 *
 * WHY THIS MODULE EXISTS. The whole "persist the findings → archive the media → build the branded
 * reports → email the borrower + loop in the team → mark the desk" sequence used to live inline in
 * the HTTP deliver route (POST /files/:id/findings/:drawId/deliver). To auto-deliver from the reconcile
 * poll, that sequence had to become ONE function both callers share, so the manual button and the
 * autopilot can never build two different borrower emails. `deliverFindings` is that function; the
 * route keeps only its own force-redeliver guards and calls it.
 *
 * THE TRIGGER (see decideAutoDeliver):
 *   - FIRST delivery: no findings row yet, the inspector has answered at least one line, and the draw
 *     has reached a ready state for its inspection method. A VIRTUAL (Sitewire) inspection reaches
 *     `pending` already inspected with the per-line amounts on file, so it delivers then. A PHYSICAL
 *     (traditional) file has no Sitewire inspection — `pending` there means "submitted, arrange the
 *     inspection" — so it waits until the coordinator has entered the amounts AND approved the draw
 *     (owner-directed: "waits until the coordinator has approved the draw, then sends").
 *   - AUTO RE-SEND: the findings were already delivered (borrower has NOT accepted/disputed yet) and
 *     the inspector's amount has since moved (a re-inspection). PILOT re-delivers the updated findings
 *     (owner-directed: "auto re-send"). A finding the borrower already acted on is never touched, and
 *     a draw whose money already released is never touched — those stay the coordinator's call.
 *
 * TrustPoint-administered files are DELIBERATELY out of scope here: their borrower delivery already
 * happens automatically on the TrustPoint mirror's own APPROVED transition (src/trustpoint/mirror.js).
 * 'external' files run no draw flow. So this path owns ONLY the Sitewire-operated files.
 *
 * Kill switch: DRAW_BORROWER_AUTODELIVER_ENABLED=0 turns the autopilot off (the manual button and the
 * old "deliver the findings again" coordinator nudge come back). Default ON. Mirrors the sibling
 * DRAW_AUTODELIVER_ENABLED off-switch that gates the artifact build.
 */

const db = require('../db');
const drawReport = require('./draw-report');
const notify = require('../lib/notify');
const rollupMod = require('./rollup');
const approval = require('./approval');
const drawLabel = require('../lib/draw-label');
const { drawEmailBlocks } = require('./draw-email-blocks');
const switches = require('../lib/integrations/switches');

// ---------------------------------------------------------------------------
// The findings email attachments (moved verbatim from the HTTP deliver route)
// ---------------------------------------------------------------------------

const FINDING_ATTACH_MAX_BYTES = 18 * 1024 * 1024;   // keep the whole email deliverable

/** Await `p`, but never longer than `ms` — past the budget the work keeps running to
 *  completion in the background (every step is idempotent + independently caught) and we
 *  carry on. `.unref()` so the timer can't hold the event loop open on the fast path. */
function withBudget(p, ms) {
  return Promise.race([p, new Promise((r) => {
    const t = setTimeout(() => r({ archived: 0, reports: [], pending: true }), ms);
    if (t.unref) t.unref();
  })]);
}

/**
 * A borrower-facing attachment NAME. Never leaks the administrator's name (the filename is
 * rendered in the email body and shown in the recipient's mail client), and never invents a
 * fact — it says only which draw it is and what kind of document it is.
 */
function borrowerSafeAttachmentName(filename, drawNo) {
  const f = String(filename || '');
  const n = drawNo != null ? `-draw-${drawNo}` : '';
  if (f.startsWith('pilot-')) return `inspection-report${n}.pdf`;          // our own branded report
  if (/-inspection-result-document-/.test(f)) return `inspection-findings${n}.pdf`;
  if (/-draw-report-/.test(f)) return `draw-summary${n}.pdf`;
  return `draw-document${n}.pdf`;
}

/**
 * The PDFs that ride along with the borrower's findings email (owner-directed 2026-07-27:
 * "he should receive two PDF attachments in the findings email"):
 *   1. OUR branded borrower report — photos + totals, partner-scrubbed by construction;
 *   2. the ADMINISTRATOR's own inspection paperwork for the same draw.
 *
 * Both are checked against the frozen rule that a note-buyer name must never reach a borrower.
 * Best-effort: any failure returns fewer attachments, never an exception — the findings email must
 * go out even when a PDF is missing (it still links to the full results page).
 */
async function borrowerFindingAttachments(appId, sitewireDrawId) {
  const storage = require('../lib/storage');
  const out = [];
  // Report filenames are keyed on the draw NUMBER (`pilot-draw-2-report-borrower-…`,
  // `trustpoint-draw-2-…`), which is NOT the internal sitewire_draw_id. Resolve it first —
  // preferring the administrator's number when the draws are tied, since both filename
  // families are built from the same number.
  const num = (await db.query(
    `SELECT number AS n FROM sitewire_draws WHERE sitewire_draw_id = $1::bigint AND application_id = $2`,
    [String(sitewireDrawId), appId])).rows[0];
  const drawNo = num && num.n != null ? String(num.n) : null;

  // The two filename families are keyed on DIFFERENT numbers and must be matched separately.
  // OUR report is named from the SITEWIRE draw number; the administrator's paperwork from the
  // TRUSTPOINT one, and the two systems number draws independently (they are tied by AMOUNT in
  // mirror.linkToSitewireIntake, never by number). Resolving one number for both meant that the
  // moment they disagreed our borrower-safe report silently dropped out and ONLY the
  // administrator's staff-sourced PDFs were sent — the exact inverse of what this is for.
  const tpNo = (await db.query(
    `SELECT number FROM trustpoint_draws WHERE sitewire_draw_id = $1::bigint AND application_id = $2`,
    [String(sitewireDrawId), appId])).rows[0];

  // ONLY these two administrator documents may reach a borrower. The allow-list is by DOCUMENT
  // TYPE, not by draw prefix: `/draw_requests/{id}/documents/` also returns a "Service Invoice"
  // (the inspection vendor's bill) and anything else TrustPoint chooses to file there, all named
  // with the same prefix and all stored `visibility='staff_only'`. Only the inspection report and
  // the draw report were decoded and keyword-scanned for a note-buyer name before #876 shipped;
  // sending an unreviewed vendor invoice puts the frozen never-name-a-note-buyer rule on an
  // assumption about a document set TrustPoint controls. Widening this list requires checking the
  // new type the same way.
  const TP_BORROWER_SAFE = ['inspection-result-document', 'draw-report'];

  const rows = (await db.query(
    `SELECT d.id, d.filename, d.storage_ref, d.size_bytes
       FROM documents d
      WHERE d.application_id = $1 AND d.is_current AND d.doc_kind = 'draw_inspection_report'
        AND (
          -- our own BORROWER-safe report for this draw (a staff copy can never match)
          (d.visibility = 'borrower' AND $2::text IS NOT NULL
             AND d.filename LIKE 'pilot-draw-' || $2 || '-report-borrower-%')
          -- the administrator's reviewed paperwork, by draw number AND document type
          OR ($3::text IS NOT NULL AND EXISTS (
                SELECT 1 FROM unnest($4::text[]) t
                 -- ANCHORED on the date+id tail storeDocument always appends, so a document
                 -- type that merely STARTS WITH an allowed one ("Inspection Result Document
                 -- and Service Invoice") can never satisfy a prefix match and ride along.
                 WHERE d.filename LIKE 'trustpoint-draw-' || $3 || '-' || t || '-____-__-__-%'))
        )
      ORDER BY d.created_at DESC`,
    [appId, drawNo, tpNo && tpNo.number != null ? String(tpNo.number) : null, TP_BORROWER_SAFE])).rows;

  const seen = new Set();
  let budget = FINDING_ATTACH_MAX_BYTES;
  for (const r of rows) {
    // one per KIND — the newest wins, so a re-inspection's latest report is the one sent
    const kind = r.filename.startsWith('pilot-') ? 'pilot' : r.filename.replace(/-\d{4}-\d{2}-\d{2}-[^.]*\.pdf$/, '');
    if (seen.has(kind)) continue;
    if (Number(r.size_bytes) > budget) continue;
    try {
      const content = await storage.read(r.storage_ref);
      if (!content || !content.length || content.length > budget) continue;
      // The filename is BORROWER-FACING (rendered in the email body + shown in their mail client),
      // so it is renamed to a neutral, factual name; the stored document keeps its own filename for
      // staff. BASE64, never a raw Buffer — both mail providers do String(a.content) expecting
      // base64, and a Buffer stringifies as a lossy UTF-8 decode of PDF binary (never opens).
      out.push({ filename: borrowerSafeAttachmentName(r.filename, drawNo), content: content.toString('base64'), contentType: 'application/pdf' });
      seen.add(kind);
      budget -= content.length;
    } catch (e) { /* a missing file never blocks the findings email */ }
  }
  // THE SITEWIRE INSPECTOR'S OWN PER-DRAW PDF IS NEVER A `documents` ROW — it lives only in the
  // durable draw_media archive (kind='draw_pdf'), which is where the investor delivery already
  // reads it. Without this arm, a virtual-inspection file could attach at most OUR report while the
  // owner's requirement is BOTH. Distinctly named so it never collides with our branded report.
  try {
    const m = (await db.query(
      `SELECT storage_ref FROM draw_media
        WHERE application_id=$1 AND sitewire_draw_id=$2 AND kind='draw_pdf' AND storage_ref IS NOT NULL
        ORDER BY archived_at DESC LIMIT 1`, [appId, sitewireDrawId])).rows[0];
    if (m) {
      const buf = await storage.read(m.storage_ref);
      if (buf && buf.length && buf.length <= budget) {
        out.push({ filename: `inspector-report${drawNo != null ? `-draw-${drawNo}` : ''}.pdf`,
          content: buf.toString('base64'), contentType: 'application/pdf' });
        budget -= buf.length;
      }
    }
  } catch (_) { /* best-effort — the findings email still goes with whatever attached */ }
  return out;
}

// ---------------------------------------------------------------------------
// The ONE deliver chokepoint — persist + artifacts + borrower email + desk marker
// ---------------------------------------------------------------------------

/**
 * Persist the draw's findings and deliver them to the borrower (and loop in the team). Shared by the
 * manual HTTP route and the autopilot. `persistDrawFindings` is allowed to THROW (an upstream Sitewire
 * outage) so the route can answer 502 and the poll can skip and retry; every step AFTER the persist is
 * independently best-effort and never throws. `opts.source` ('manual' | 'autopilot') is for logging.
 *
 * Returns the persist result plus the delivery outcome:
 *   { ...persistResult, media_archived, reports_ready, reports_pending, attachments_sent,
 *     borrower_emailed, borrower_email_reason }
 */
async function deliverFindings(appId, drawId, opts = {}) {
  const reconcile = require('./reconcile');   // lazy — reconcile lazy-requires us back (no cycle)
  const f = (await db.query(`SELECT a.property_address->>'oneLine' AS address, b.id AS borrower_id, b.email AS borrower_email FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [appId])).rows[0] || {};
  const deliveredTo = { borrower: f.borrower_email || null };
  const result = await reconcile.persistDrawFindings(appId, drawId, deliveredTo);
  const addr = f.address || 'your property';
  const acceptLink = result.reply_token ? `/draw-accept/${result.reply_token}` : `/app/${appId}`;
  // ---- BUILD THE ARTIFACTS BEFORE THE BORROWER EMAIL (owner-directed 2026-07-27) ----
  // The borrower must receive the branded PDFs with the findings. The archive+build runs first,
  // under a bounded budget — if it does not finish in time the email still goes out on schedule,
  // just with links instead of files. Nothing here can fail the delivery: every step is caught.
  const artifacts = await withBudget(
    drawReport.autoDeliverArtifacts(appId, drawId).catch(() => ({ archived: 0, reports: [] })),
    Number(process.env.DRAW_AUTODELIVER_BUDGET_MS) || 20000);
  const findingAttachments = await borrowerFindingAttachments(appId, drawId).catch(() => []);
  let sentThread = null;
  // notifyAppBorrowers (via notifyAppThread) so a co-borrower who can see the file ALSO gets the
  // "results ready" email.
  if (f.borrower_id) {
    const scrub = require('../lib/borrower-safe').scrubText;
    const usd = (c) => '$' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-US');
    // retired_at IS NULL — a soft-retired line (db/242, Sitewire removed the request) must not join
    // the borrower's email grid or its sums; the public + borrower routes already filter.
    // NOTE the key: `persistDrawFindings` returns `finding_id`, not `id`. The inline route this was
    // extracted from queried `[result.id]` (undefined → `finding_id = null` → zero rows), so the
    // per-line grid this block builds never actually rendered in the borrower email. Fixed here to
    // `result.finding_id` so the "here is what the inspector approved on each line" rows appear as
    // intended — the money hero/figures come from drawEmailBlocks and were unaffected.
    const flines = (await db.query(
      `SELECT name, requested_cents, approved_cents, not_approved_cents, photo_count, video_count FROM draw_finding_lines WHERE finding_id=$1 AND retired_at IS NULL ORDER BY id`, [result.finding_id])).rows;
    const totReq = flines.reduce((s, l) => s + (Number(l.requested_cents) || 0), 0);
    const totAppr = flines.reduce((s, l) => s + (Number(l.approved_cents) || 0), 0);
    const photos = flines.reduce((s, l) => s + (Number(l.photo_count) || 0), 0);
    const videos = flines.reduce((s, l) => s + (Number(l.video_count) || 0), 0);
    const CAP = 14; // keep the email readable — a huge draw links out to the full page for the rest
    // WHAT ACTUALLY LANDS IN THEIR ACCOUNT (owner-directed 2026-08-03). Both the release line and the
    // per-line detail come from the SAME rollup the attached report is built from, so the email and
    // its own attachment can never quote different figures. Best-effort: an unreadable rollup simply
    // omits the release line rather than delaying the borrower's results. A release figure exists ONLY
    // when the inspector has answered (has_inspector_amounts) — gating on the same predicate the
    // figures band uses, so the hero and the callout can never tell two different stories.
    let releaseLine = null;
    let inspectorZero = false;
    try {
      const rl = await rollupMod.loadRollup(db, appId);
      const d = (rl.draws || []).find((x) => Number(x.sitewire_draw_id) === Number(drawId));
      if (d && d.has_inspector_amounts && Number(d.approved_cents) <= 0) inspectorZero = true;
      if (d && d.has_inspector_amounts && d.net_release_cents != null && Number(d.net_release_cents) > 0) {
        const deductions = [];
        if (Number(d.fee_cents) > 0) deductions.push(`${usd(d.fee_cents)} draw fee`);
        if (Number(d.retainage_held_cents) > 0) deductions.push(`${usd(d.retainage_held_cents)} retainage held`);
        releaseLine = { label: d.released ? 'Released to you' : 'To be released to you',
          value: `${usd(d.net_release_cents)}${deductions.length ? ` (after the ${deductions.join(' and ')})` : ''}` };
      }
    } catch (_) { /* best-effort — the results email never waits on the money rollup */ }
    // THE RANKED MONEY BLOCK — built from the same rollup the release line above and the attached PDF
    // are built from, so all three agree by construction.
    const blocks = await drawEmailBlocks(db, appId, { sitewireDrawId: drawId, borrower: true }).catch(() => null);
    const meta = [{ label: 'Property', value: addr }];
    if (releaseLine && !(blocks && blocks.figures)) meta.push(releaseLine);
    for (const l of flines.slice(0, CAP)) {
      // TRI-STATE (db/518): a NULL approved amount is "the inspector has not answered this line" — the
      // email says so, never "$0 approved", which reads as denied.
      meta.push({ label: scrub(l.name) || 'Line item',
        value: l.approved_cents == null ? `${usd(l.requested_cents)} requested — not yet reviewed`
          : Number(l.not_approved_cents) > 0 ? `${usd(l.approved_cents)} approved of ${usd(l.requested_cents)}` : `${usd(l.approved_cents)} approved` });
    }
    if (flines.length > CAP) meta.push({ label: `+ ${flines.length - CAP} more line item(s)`, value: 'open the results to see them all' });
    const pv = [];
    if (photos) pv.push(`${photos} photo${photos === 1 ? '' : 's'}`);
    if (videos) pv.push(`${videos} video${videos === 1 ? '' : 's'}`);
    const disputeLink = result.reply_token ? `/draw-accept/${result.reply_token}?tab=dispute` : `/app/${appId}`;
    // ONE email with the whole team visibly on it (owner-directed 2026-08-03). Delivering findings is
    // an explicit send — `_bypassLoGate` (a human OR the autopilot already decided this goes out, the
    // LO curation gate must not silently park it in Drafts) and `evenIfOnHold` (a parked file's draw is
    // still being worked). Borrower notification PREFERENCES still apply.
    sentThread = await notify.notifyAppThread(appId, {
      type: 'draw_findings', title: 'Your inspection is complete — please confirm the amount',
      _bypassLoGate: true, evenIfOnHold: true,
      // The staff copy is STAFF-voiced with a STAFF destination — never the borrower's no-login magic
      // link — and NEUTRAL, because this same copy is the FALLBACK email when the borrower could not be
      // reached, so it must not claim the results "went to the borrower".
      staffTitle: 'Inspection results ready for the borrower — awaiting their confirmation',
      staffBody: `The inspection results for ${addr} are ready for the borrower to accept or dispute. The draw releases once they confirm.`,
      staffLink: `/internal/app/${appId}`, staffCtaLabel: 'Open the file',
      drawTag: await drawLabel.drawTagForRef(db, appId, { sitewireDrawId: drawId }),
      badge: { text: 'Please confirm', tone: 'action' },
      figures: (blocks && blocks.figures) || null,
      facts: (blocks && blocks.facts) || null,
      // The old hero survives only when the rollup could not be read, so the email never loses its
      // headline number.
      hero: (blocks && blocks.figures) ? null
        : { label: 'Approved by the inspector', value: usd(totAppr), sub: `of ${usd(totReq)} requested`, tone: 'positive' },
      body: `Your inspection is complete${pv.length ? ` — ${pv.join(' and ')} on file` : ''}. Here is what the inspector approved on each line. When you’re ready, confirm to release your draw — or push back on any line you disagree with.`,
      meta,
      callout: {
        title: 'What happens when you confirm',
        body: inspectorZero
          ? 'The inspector approved $0 this time, so confirming accepts the results — nothing is wired, and the amounts stay on your budget to draw once the work is done. Disagree? Push back on any line below. Want to look first? Open the results to see every photo and download your inspection report (PDF).'
          : `Confirming ${releaseLine ? `releases your draw — ${releaseLine.value.split(' (')[0]} is wired to you — funds are typically sent within a day or two` : 'accepts the inspection results'}. Want to look first? Open the results to see every photo and download your inspection report (PDF).`,
        tone: 'action',
      },
      applicationId: appId, link: acceptLink, ctaLabel: 'Review & confirm',
      cta2Label: 'Push back on a line', cta2Link: disputeLink,
      attachments: findingAttachments,
    }).catch(() => null);
  }
  // Did the borrower actually receive their copy? `emailedTogether` is the thread's own answer.
  const borrowerEmailed = !!(sentThread && sentThread.emailedTogether);
  const borrowerEmailReason = borrowerEmailed ? null
    : (!f.borrower_id ? 'no_borrower'
      : (sentThread && sentThread.borrowerMailable === false ? 'no_borrower_email'
        : (sentThread ? 'suppressed' : 'send_failed')));
  // In-app desk marker (owner-directed 2026-07-20) — the borrower's own "results ready" email above is
  // the real send; this is a desk marker that TELLS THE TRUTH about the borrower's copy.
  await notify.notifyAppStaff(appId, { type: 'draw_findings', title: 'Draw findings delivered to borrower', inAppOnly: true,
    body: borrowerEmailed
      ? `Inspection findings for ${addr} were delivered to the borrower to accept or dispute.${opts.source === 'autopilot' ? ' (Delivered automatically once the inspection came in.)' : ''}`
      : `Inspection findings for ${addr} were recorded, but the borrower could NOT be emailed (${borrowerEmailReason === 'no_borrower_email' ? 'no email address on file' : 'their copy was blocked or failed'}). Reach them another way — the draw is waiting on their confirmation.`,
    applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
  return { ...result, media_archived: artifacts.archived, reports_ready: artifacts.reports,
    reports_pending: !!artifacts.pending, attachments_sent: findingAttachments.map((a) => a.filename),
    borrower_emailed: borrowerEmailed, borrower_email_reason: borrowerEmailReason };
}

// ---------------------------------------------------------------------------
// The AUTOPILOT — decide whether to auto-deliver / auto-re-send, then do it
// ---------------------------------------------------------------------------

/** Is the borrower-delivery autopilot on? Default ON; DRAW_BORROWER_AUTODELIVER_ENABLED=0 turns it off. */
function autopilotEnabled() { return process.env.DRAW_BORROWER_AUTODELIVER_ENABLED !== '0'; }

/**
 * The Sitewire draw statuses at which the findings are ready for the borrower, per inspection method.
 * A PHYSICAL (traditional) file has no Sitewire inspection — `pending` means "submitted, arrange the
 * inspection" — so it waits until the coordinator has entered the amounts AND approved the draw. A
 * VIRTUAL (Sitewire/mobile) inspection reaches `pending` already inspected, with the per-line amounts
 * on file, so it is ready then. Both are also ready at the later approval states (belt-and-suspenders).
 */
function readyForBorrower(status, method) {
  const s = String(status || '');
  if (method === 'traditional') return s === 'pending_capital_partner' || s === 'approved';
  return s === 'pending' || s === 'pending_capital_partner' || s === 'approved';
}

/**
 * PURE decision: given the draw's state, should the autopilot deliver, re-send, or do nothing?
 * Returns { action: 'deliver' | 'resend' | 'skip', reason }.
 *
 *   autopilotOn       DRAW_BORROWER_AUTODELIVER_ENABLED !== '0'
 *   sitewireReadsOn   the SITEWIRE_ENABLED master switch
 *   platform          'sitewire' | 'trustpoint' | 'external' (only 'sitewire' auto-delivers here)
 *   method            'mobile' (virtual) | 'traditional' (physical) | null
 *   drawStatus        the Sitewire draw status
 *   historical        PILOT's own close-out artifact — never a borrower submission
 *   hasAmounts        the inspector has answered at least one line
 *   currentCents      current per-line inspector-approved sum (from the request mirror)
 *   finding           { status, total_approved_cents } | null
 *   released          a recorded release exists in OUR ledger (money already moved)
 */
function decideAutoDeliver(input) {
  const { autopilotOn, sitewireReadsOn, platform, method, drawStatus, historical,
    hasAmounts, currentCents, finding, released } = input || {};
  if (!autopilotOn) return { action: 'skip', reason: 'autopilot_off' };
  if (!sitewireReadsOn) return { action: 'skip', reason: 'sitewire_off' };
  if (historical) return { action: 'skip', reason: 'historical' };
  // TrustPoint files auto-deliver on the mirror's own APPROVED transition; 'external' files run no
  // draw flow. This path owns ONLY the Sitewire-operated files.
  if (platform !== 'sitewire') return { action: 'skip', reason: 'not_sitewire' };
  if (released) return { action: 'skip', reason: 'released' };            // money moved — never touch
  const fstatus = finding ? String(finding.status || '') : '';
  // A finding the borrower already acted on is the coordinator's call (the manual force-redeliver).
  if (finding && fstatus !== 'delivered') return { action: 'skip', reason: 'finding_' + (fstatus || 'unknown') };
  if (!hasAmounts) return { action: 'skip', reason: 'no_inspector_amounts' };
  if (!finding) {
    return readyForBorrower(drawStatus, method)
      ? { action: 'deliver', reason: 'first_delivery' }
      : { action: 'skip', reason: 'not_ready' };
  }
  // Findings are still 'delivered' (borrower hasn't accepted/disputed). Auto re-send ONLY when the
  // inspector's amount has actually moved since we delivered — comparing the current per-line sum to
  // what the borrower was shown. Equal → nothing to re-send.
  const delivered = Number((finding && finding.total_approved_cents) || 0);
  return Number(currentCents) !== delivered
    ? { action: 'resend', reason: 'amount_changed' }
    : { action: 'skip', reason: 'unchanged' };
}

/**
 * Read the draw's current state from the mirror and, if the autopilot says so, deliver / re-send.
 * Best-effort and fully self-guarded — it must never throw into the reconcile poll. Returns the
 * decision (plus a small `delivered` summary when it acted).
 *
 *   fileCtx     { platform, method } from the reconcile pass (resolveFilePlatform)
 *   opts.firstReconcile   a file's first-ever reconcile baselines silently (go-forward only)
 */
async function maybeAutoDeliver(appId, drawId, fileCtx, opts = {}) {
  try {
    // Go-forward: a file's first-ever reconcile baselines its existing draws silently — never
    // auto-deliver a draw PILOT is only now starting to watch.
    if (opts.firstReconcile) return { action: 'skip', reason: 'first_reconcile' };
    if (drawId == null || !/^\d+$/.test(String(drawId))) return { action: 'skip', reason: 'bad_draw_id' };
    const platform = (fileCtx && fileCtx.platform) || 'sitewire';
    const method = (fileCtx && fileCtx.method) || null;
    const autopilotOn = autopilotEnabled();
    const sitewireReadsOn = switches.on('SITEWIRE_ENABLED');
    // Cheap pre-checks that need no DB — bail before touching the database when we obviously won't act.
    if (!autopilotOn || !sitewireReadsOn || platform !== 'sitewire') {
      return decideAutoDeliver({ autopilotOn, sitewireReadsOn, platform, method, drawStatus: null,
        historical: false, hasAmounts: false, currentCents: 0, finding: null, released: false });
    }
    const draw = (await db.query(
      `SELECT status, total_approved_cents, COALESCE(historical,false) AS historical
         FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId])).rows[0];
    if (!draw) return { action: 'skip', reason: 'no_draw' };
    if (draw.historical) return { action: 'skip', reason: 'historical' };
    const finding = (await db.query(
      `SELECT id, status, total_approved_cents FROM draw_findings WHERE sitewire_draw_id=$1`, [drawId])).rows[0] || null;
    // Short-circuit the most common repeated-poll case: a finding the borrower already acted on.
    if (finding && finding.status !== 'delivered') return { action: 'skip', reason: 'finding_' + finding.status };
    const released = (await db.query(
      `SELECT 1 FROM draw_disbursements WHERE application_id=$1 AND sitewire_draw_id=$2 AND kind='draw' LIMIT 1`,
      [appId, drawId])).rowCount > 0;
    const requests = (await db.query(
      `SELECT approved_cents FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [drawId])).rows;
    let insp = approval.inspectorApproved({ draw, requests });
    // AUTO RE-SEND must compare the current inspector total against what the borrower was SHOWN using
    // the IDENTICAL computation, or it loops. `finding.total_approved_cents` is stored from
    // fetchDrawFindings(...).totals.approved_cents — getDraw PLUS a per-request GET /requests/:id
    // fallback for an amount the draw payload omitted. The mirror read above is getDraw-ONLY, so on a
    // draw whose payload drops a per-request approved_cents that getRequest still carries, the mirror
    // sum sits permanently BELOW the stored total and this would return 'resend' every poll — re-emailing
    // the borrower and resetting the wire clock forever (pre-merge audit 2026-08-14). Only when a
    // still-'delivered' finding's stored total actually DISAGREES with the cheap mirror do we pay one
    // fresh authoritative read and compare like-for-like: equal → it was the mirror's missing fallback,
    // not a real re-inspection → skip. First delivery has no finding to diverge from, so it stays on the
    // cheap mirror; a Sitewire outage keeps the mirror read (never loop, never throw — the manual button
    // still re-sends).
    if (finding && String(finding.status || '') === 'delivered'
        && Number(insp.cents) !== Number((finding && finding.total_approved_cents) || 0)) {
      try {
        const detail = await require('./reconcile').fetchDrawFindings(drawId);
        insp = {
          cents: Number((detail.totals && detail.totals.approved_cents) || 0),
          hasAmounts: (detail.lines || []).some((l) => l && l.approved_cents != null),
          source: 'findings_authoritative',
        };
      } catch (_) { /* Sitewire unreachable — keep the mirror read; never loop, never throw */ }
    }
    const decision = decideAutoDeliver({
      autopilotOn, sitewireReadsOn, platform, method,
      drawStatus: draw.status, historical: !!draw.historical,
      hasAmounts: insp.hasAmounts, currentCents: insp.cents,
      finding, released,
    });
    if (decision.action === 'deliver' || decision.action === 'resend') {
      const out = await deliverFindings(appId, drawId, { source: 'autopilot', autoReason: decision.reason });
      return { ...decision, delivered: { finding_id: out.finding_id, lines: out.lines, borrower_emailed: out.borrower_emailed } };
    }
    return decision;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[sitewire] auto-deliver:', e && e.message);
    return { action: 'skip', reason: 'error', error: e && e.message };
  }
}

module.exports = {
  deliverFindings,
  maybeAutoDeliver,
  decideAutoDeliver,
  autopilotEnabled,
  borrowerFindingAttachments,
  _internals: { withBudget, borrowerSafeAttachmentName, readyForBorrower, FINDING_ATTACH_MAX_BYTES },
};
