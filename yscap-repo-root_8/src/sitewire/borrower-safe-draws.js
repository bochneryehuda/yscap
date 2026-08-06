'use strict';

// SINGLE DEFINITION of the borrower-safe DRAW reads (rollup + findings + draw list).
//
// The borrower draw surface hides two kinds of secret from a non-lender reader:
//   · OUR fee income on the project + which inspection tier priced a draw (`rollup.fees`,
//     per-draw `fee_kind`), and the STAFF wording of the net-release sentence; and
//   · every capital-partner / note-buyer NAME, which an appraiser/inspector can drop into a
//     line label, an inspector comment or a media note (scrubbed via `borrower-safe.scrubText`),
//     plus photo GPS.
// Everything the borrower is ENTITLED to see stays — the per-line picture, the per-draw money
// they will actually be paid (net release / released), the inspection photos.
//
// This scrub lived INLINE in the BORROWER draw routes; it is now shared so the BORROWER portal and
// the TPO (broker) portal return the IDENTICAL borrower-safe payload and can never drift — a drift
// here would leak the lender's fee/margin or a capital-partner name to an external broker, the TPO
// #1 risk. The CALLER owns access control (borrower OWN_FILE_SQL / TPO firm scope) AND owns how a
// photo is fetched (the `photoUrl` callback): the BORROWER serves inspection photos through the
// borrower's own per-finding `reply_token` (a public capability that ALSO permits accept/dispute),
// so that token must NEVER reach a read-only broker — the TPO surface passes a firm-scoped media
// URL instead. This module only loads + scrubs; it never emits the reply_token.

// Apply the borrower-safe strip to a `sitewire/rollup.loadRollup` result, in place, and return it:
//   (1) scrub each SOW-line label (a capital-partner name can hide there),
//   (2) drop the per-draw `fee_kind` (our fee schedule) + the STAFF `net_explanation`, re-adding the
//       BORROWER wording from the ONE definition so the screen and the PDF phrase the deduction the
//       same way, and
//   (3) delete `rollup.fees` — our fee income across the project is never borrower/broker-facing.
// Byte-identical to the borrower rollup route's inline strip (proven by the borrower draw tests).
function borrowerSafeRollup(rollup) {
  if (!rollup) return rollup;
  const APPROVAL = require('./approval');            // the ONE wording for what is netted out
  const { scrubText } = require('../lib/borrower-safe');
  const scrub = (s) => (s == null ? null : scrubText(String(s)));
  if (Array.isArray(rollup.lines)) for (const l of rollup.lines) l.label = scrub(l.label);
  if (Array.isArray(rollup.draws)) {
    rollup.draws = rollup.draws.map((d) => {
      // `stage_times` carries the with_investor / capital-partner delivery time (#1045's per-step
      // timeline) — the capital-partner step is never borrower/broker-facing (frozen rule); both
      // surfaces show their own finding-driven stepper instead.
      const { fee_kind, net_explanation, stage_times, ...safe } = d; // eslint-disable-line no-unused-vars
      safe.net_explanation = APPROVAL.netExplanation(d, { borrower: true });
      return safe;
    });
  }
  delete rollup.fees;
  return rollup;
}

// The inspection findings delivered for a file, borrower-safe. Every free-text field a capital-partner
// name could hide in is scrubbed (line name, inspector comments, each media NOTE) and photo GPS is
// dropped; the per-line durable inspection photos are surfaced through the caller's `photoUrl(finding,
// media)` callback — the BORROWER passes its own `reply_token` public URL, the TPO surface passes a
// firm-scoped media URL. The finding's `reply_token` is NEVER placed in the returned object.
async function loadDrawFindings(db, appId, { photoUrl } = {}) {
  const { scrubText } = require('../lib/borrower-safe');
  const scrub = (s) => (s == null ? null : scrubText(String(s)));
  const mkUrl = typeof photoUrl === 'function'
    ? photoUrl
    // default (borrower): the borrower's own per-finding reply_token URL, or null with no token.
    : (f, m) => (f.reply_token ? `/api/public/draw-findings/${f.reply_token}/media/${m.id}` : null);
  const findings = (await db.query(
    `SELECT id, sitewire_draw_id, status, total_requested_cents, total_approved_cents, delivered_at, accepted_at, accepted_via, disputed_at, resolved_at, wire_due_at, reply_token,
            EXISTS (SELECT 1 FROM draw_disbursements dd WHERE dd.sitewire_draw_id=draw_findings.sitewire_draw_id AND dd.kind='draw' AND dd.funded_status='released') AS released
       FROM draw_findings WHERE application_id=$1 ORDER BY delivered_at DESC`, [appId])).rows;
  const out = [];
  for (const f of findings) {
    // Durable inspector media (PILOT's own stored copies) grouped by the draw line — served via the
    // caller's URL builder so an <img>/<video> tag works, and the thumbnail never breaks when
    // Sitewire's pre-signed link expires. GPS is already stripped at archive.
    const durable = (await db.query(
      `SELECT id, sitewire_request_id, kind FROM draw_media WHERE sitewire_draw_id=$1 AND kind IN ('image','video') ORDER BY id`, [f.sitewire_draw_id])).rows;
    const durByReq = new Map();
    for (const m of durable) { const k = String(m.sitewire_request_id); if (!durByReq.has(k)) durByReq.set(k, []); durByReq.get(k).push({ url: mkUrl(f, m), kind: m.kind }); }
    const lines = (await db.query(
      `SELECT id, sitewire_request_id, sow_line_key, unit_index, name, requested_cents, approved_cents, not_approved_cents, inspector_comments, photo_count, video_count, media, dispute_status, dispute_desired_cents, dispute_note
         FROM draw_finding_lines WHERE finding_id=$1 AND retired_at IS NULL ORDER BY id`, [f.id])).rows
      .map((l) => ({
        ...l,
        name: scrub(l.name),
        inspector_comments: scrub(l.inspector_comments),
        photos: (durByReq.get(String(l.sitewire_request_id)) || []).filter((p) => p.url),
        media: Array.isArray(l.media) ? l.media.map((m) => { if (!m || typeof m !== 'object') return m; const { lat, lng, ...mm } = m; return { ...mm, note: scrub(mm.note) }; }) : l.media, // eslint-disable-line no-unused-vars
      }));
    // don't leak the raw token as a top-level field; the per-line photo URLs already carry whatever
    // the caller chose (never the reply_token on the TPO surface).
    const { reply_token, ...fSafe } = f; // eslint-disable-line no-unused-vars
    out.push({ ...fSafe, lines });
  }
  return out;
}

// A per-APPLICATION list of draws (borrower-safe columns only — no fee, no partner). The caller has
// already authorized the file, so this is scoped to the one application id. Mirrors the borrower
// cross-file `/draws` list columns; the borrower's list must show what the INSPECTOR approved, not
// Sitewire's final-approval field (0 until our last click) — see sitewire/approval.js.
async function loadDrawList(db, appId) {
  return (await db.query(
    `SELECT d.sitewire_draw_id, d.number, d.status, d.total_requested_cents, d.total_approved_cents,
            COALESCE((SELECT sum(r.approved_cents) FROM sitewire_draw_requests r WHERE r.sitewire_draw_id = d.sitewire_draw_id),
                     d.total_approved_cents) AS inspector_approved_cents,
            d.submitted_at, d.approved_at,
            (SELECT status FROM draw_findings f WHERE f.sitewire_draw_id=d.sitewire_draw_id) AS findings_status
       FROM sitewire_draws d
      WHERE d.application_id=$1
      ORDER BY d.updated_at DESC NULLS LAST LIMIT 200`, [appId])).rows;
}

module.exports = { borrowerSafeRollup, loadDrawFindings, loadDrawList };
