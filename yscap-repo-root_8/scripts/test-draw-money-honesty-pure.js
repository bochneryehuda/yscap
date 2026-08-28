#!/usr/bin/env node
'use strict';
/**
 * THE AMOUNT DOCTRINE, PINNED (owner-directed 2026-08-10, YSCAP258134746: the inspector
 * approved NOTHING and the borrower's findings email led "Requested $24,750 — under review"
 * while its own callout promised "$0 is wired to you").
 *
 * ONE amount travels the draw and keeps updating — requested → inspector-approved (an explicit
 * $0 IS an answer) → final/released — and every email states the CURRENT one. The two defects
 * this pins:
 *   · `drawFigures` gated the approval headline on `approved > 0` (missing-vs-zero conflation),
 *     so an inspector's explicit $0 was demoted back to a stale "Requested" headline;
 *   · the deliver route's callout gated its wire promise on `net_release_cents != null` — which
 *     is ALWAYS a number — so it promised "$0 is wired to you" off an unknown-or-zero approval.
 *
 * Plus the attachment corruption (a raw Buffer where every provider expects base64 — the
 * unopenable PDF) and the facts-label honesty ("(this draw counted)" claimed while the draw's
 * money was not in the committed figure). Pure — no DB.
 */
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-key-for-wire-capture';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const { drawFigures, drawFacts } = require('../src/lib/email/draw-email');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- A. the explicit-$0 answer
const zero = drawFigures({
  requested_cents: 2475000, approved_cents: 0, not_approved_cents: 2475000,
  net_release_cents: 0, fee_cents: 29900, has_inspector_amounts: true,
  is_released: false, is_final_approved: false,
}, { borrower: true });
ok('A1 an inspector\'s explicit $0 LEADS as the answer it is', zero.primary.label === 'Approved on this draw' && zero.primary.value === '$0');
ok('A2 and says the money stays on the budget', /stays on the budget/.test(String(zero.primary.sub)));
ok('A3 the request is the supporting figure, not the headline', zero.secondary.some((s) => s.label === 'Requested' && s.value === '$24,750'));
ok('A4 nothing anywhere promises a wire', !JSON.stringify(zero).match(/wired|released/i));

// ---------------------------------------------------------------- B. a genuinely unanswered draw
const unknown = drawFigures({
  requested_cents: 2475000, approved_cents: 0, not_approved_cents: 0,
  net_release_cents: 0, fee_cents: 29900, has_inspector_amounts: false,
  is_released: false, is_final_approved: false,
}, { borrower: true });
ok('B1 an unanswered draw leads with the request', unknown.primary.label === 'Requested' && unknown.primary.value === '$24,750');
ok('B2 marked under review, promising nothing', unknown.primary.sub === 'under review' && !JSON.stringify(unknown).match(/wired/i));

// ---------------------------------------------------------------- C. a real approval is unchanged
const approvedM = drawFigures({
  requested_cents: 5000000, approved_cents: 3345000, not_approved_cents: 1655000,
  net_release_cents: 3315100, fee_cents: 29900, has_inspector_amounts: true,
  is_released: false, is_final_approved: false,
}, { borrower: true });
ok('C1 a real approval still leads with the approved amount', approvedM.primary.label === 'Approved on this draw' && approvedM.primary.value === '$33,450');

// A FINAL approval whose inspector amount is 0 must not fabricate a release headline.
const finalZero = drawFigures({
  requested_cents: 2475000, approved_cents: 0, not_approved_cents: 2475000,
  net_release_cents: 0, fee_cents: 29900, has_inspector_amounts: true,
  is_released: false, is_final_approved: true,
}, { borrower: true });
ok('C2 a final approval at $0 states $0, never "Requested" and never a release', finalZero.primary.value === '$0' && finalZero.primary.label === 'Approved on this draw');

// ---------------------------------------------------------------- D. the facts label is a CLAIM
const P = { budget: 9130000, drawn: 0, committed: 0, available: 9130000 };
const notCounted = drawFacts({ money: { requested_cents: 2475000, is_released: false }, rollup: { project: P }, borrower: false });
ok('D1 a draw whose money is NOT in committed never claims "(this draw counted)"',
  notCounted.rows.some((r) => r.label === 'Still available') && !notCounted.rows.some((r) => /this draw counted/.test(r.label)));
ok('D2 and a heads-up row says the detail has not synced', notCounted.rows.some((r) => /isn’t counted|isn't counted/.test(String(r.value))));
const counted = drawFacts({ money: { requested_cents: 2475000, is_released: false }, rollup: { project: { budget: 9130000, drawn: 0, committed: 2475000, available: 6655000 } }, borrower: false });
ok('D3 a counted draw keeps the honest claim', counted.rows.some((r) => r.label === 'Still available (this draw counted)'));
ok('D4 …and no heads-up row', !counted.rows.some((r) => /isn’t counted|isn't counted/.test(String(r.value))));

// ---------------------------------------------------------------- E. attachments survive the wire
// The corrupted-PDF class: a Buffer stringified where base64 is expected. Assert on the WIRE
// PAYLOAD (a passing send against the noop provider proves nothing — investor-delivery lesson).
(async () => {
  const resend = require('../src/lib/email/resend');
  const pdfBytes = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\nbinary-tail-\x00\x01\x02', 'latin1');
  let captured = null;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { captured = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ id: 'x' }), text: async () => '{}' }; };
  try {
    await resend.sendMail({ to: 'a@example.com', subject: 's', text: 't', html: '<p>t</p>',
      attachments: [{ filename: 'r.pdf', content: pdfBytes }, { filename: 'b.pdf', content: pdfBytes.toString('base64') }] });
  } catch (e) { ok('E0 resend send did not throw', false); }
  global.fetch = realFetch;
  ok('E1 the wire payload carries attachments', !!captured && Array.isArray(captured.attachments) && captured.attachments.length === 2);
  const rt = (c) => { try { return Buffer.from(String(c), 'base64'); } catch (_) { return Buffer.alloc(0); } };
  ok('E2 a Buffer attachment round-trips byte-for-byte (the corrupted-PDF bug)',
    captured && rt(captured.attachments[0].content).equals(pdfBytes));
  ok('E3 a base64-string attachment is untouched',
    captured && rt(captured.attachments[1].content).equals(pdfBytes));

  // ---------------------------------------------------------------- F. source contracts
  const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const graph = src('src/lib/email/graph.js');
  ok('F1 graph.js carries the same Buffer→base64 belt', /Buffer\.isBuffer\(a\.content\) \? a\.content\.toString\('base64'\)/.test(graph));
  // The deliver core moved to the shared chokepoint src/sitewire/deliver-findings.js (owner-directed
  // 2026-08-14 borrower-delivery autopilot) so the manual button and the autopilot build ONE borrower
  // email. These contracts follow the code to its new home.
  const deliverMod = src('src/sitewire/deliver-findings.js');
  ok('F2 the deliver core\'s release promise is gated on a KNOWN inspector answer',
    /d\.has_inspector_amounts && d\.net_release_cents != null && Number\(d\.net_release_cents\) > 0/.test(deliverMod));
  ok('F3 the inspector-$0 callout exists and promises nothing', /approved \$0 this time, so confirming accepts the results — nothing is wired/.test(deliverMod));
  // The regex used to pin the local variable's NAME (`content`), which broke the moment the gather
  // was refactored onto the shared attachment planner (2026-08-14) even though the contract it
  // exists to protect never moved. It now states the contract itself, in both directions: whatever
  // the buffer is called it must be base64-encoded, and a raw Buffer must never be handed over.
  // (Both providers do String(a.content) expecting base64; a Buffer stringifies as a lossy UTF-8
  // decode of PDF binary and never opens.)
  ok('F4 the findings attachments are produced as base64, never a raw Buffer',
    /content: [\w.]+\.toString\('base64'\)/.test(deliverMod)
    && !/content: (?:buf|content|bytes)\s*[,}]/.test(deliverMod));
  ok('F5 the Sitewire inspector PDF is sourced from the durable draw_media archive',
    /kind='draw_pdf' AND storage_ref IS NOT NULL/.test(deliverMod));
  /* F6 — THE BYTES DECIDE THE TYPE, never the CDN's archived header.
     media-archive stores whatever content type the Sitewire CDN happened to send —
     routinely `application/octet-stream` or nothing — and under nosniff a non-image
     type makes the browser REFUSE to render perfectly good JPEG bytes (owner-reported
     2026-08-10: every photo tile came up broken).

     THIS ASSERTION USED TO NAME THE IMPLEMENTATION (`sniffKind(buf)`), and it fired
     on 2026-08-23 when that private mime table was folded into the one shared media
     door — a change that STRENGTHENED the property, because the private table covered
     only images and the same defect had reappeared on videos ("those videos are
     blacked out"). A guard that names a call rather than a property fails on the fix
     for the bug it is guarding. So it now asserts the property in both places: this
     route must serve through the shared door, and that door must derive the type from
     the bytes. */
  const pub = src('src/routes/draw-findings-public.js');
  const doorSrc = src('src/lib/media-headers.js');
  ok('F6 the public media route serves through the one media door (no private copy of the rule)',
    /serveMedia\(req, res, buf,/.test(pub) && !/sniffKind\(buf\)/.test(pub));
  ok('F6b that door derives the content type from the BYTES, not the stored header (nosniff-safe)',
    /function sniffMediaMime\(buf\)/.test(doorSrc)
    && /const sniffed = buf \? sniffMediaMime\(buf\) : null;/.test(doorSrc));

  // ---------------------------------------------------------------- G. the PER-LINE tri-state
  // (db/518) A finding line the inspector never ANSWERED is not a line the inspector DENIED.
  // The findings snapshot stores NULL — never a coerced 0 — and every per-line surface says
  // "not reviewed" instead of "Approved $0". Source contracts, same style as section F.
  const rec = src('src/sitewire/reconcile.js');
  ok('G1 fetchDrawFindings keeps a missing inspector answer as NULL',
    /const appr = rawAppr == null \? null : rawAppr;/.test(rec)
    && !/const appr = r\.approved_cents == null \? 0 :/.test(rec));
  ok('G2 …and the persist stores it as NULL, never a denied-$0',
    /ln\.approved_cents == null \? null : ln\.approved_cents/.test(rec));
  ok('G3 an unanswered line has no not-approved figure either',
    /appr == null \? null : Math\.max\(0, req - appr\)/.test(rec)
    && /approvedCents == null \? null : Math\.max\(0, \(ln\.requested_cents \|\| 0\) - approvedCents\)/.test(rec));
  const rep = src('src/sitewire/draw-report.js');
  ok('G4 the branded report says "not reviewed" on an unanswered line',
    /const answered = l\.approved_cents != null;/.test(rep) && /not yet reviewed/.test(rep));
  const pkt = src('src/sitewire/draw-packet.js');
  ok('G5 the Excel packet leaves an unanswered line\'s approved cell BLANK, never 0.00',
    /f\.approved_cents == null \? '' : c\(f\.approved_cents\)/.test(pkt));
  const acceptPg = src('app-v2/src/screens/DrawAccept.jsx');
  ok('G6 the borrower accept page says "Not reviewed yet", never $0',
    /Not reviewed yet/.test(acceptPg) && /const answered = l\.approved_cents != null;/.test(acceptPg));
  const bdraws = src('app-v2/src/components/BorrowerDraws.jsx');
  ok('G7 the borrower results table too', /Not reviewed yet/.test(bdraws));
  const deliver = src('src/routes/sitewire.js');
  ok('G8 the findings email\'s per-line grid too',
    /not yet reviewed/.test(deliverMod) && /l\.approved_cents == null \?/.test(deliverMod));
  // The dispute lifecycle must not leak the denied-$0 lie either (pre-merge audit of db/518):
  ok('G9 a rejected dispute on an unreviewed line never emails "kept at $0"',
    /still awaiting the inspector/.test(deliver)
    && /l\.dispute_desired_cents != null && l\.approved_cents != null \?/.test(deliver));
  ok('G10 the decided-dispute preserve arm keeps NULL as NULL, never a stamped 0',
    /cur\.approved_cents == null \? null : Number\(cur\.approved_cents\)/.test(rec));
  ok('G11 an omitted per-request amount falls back to the request DETAIL before reading as unanswered',
    /detail\.approved_cents != null \? detail\.approved_cents : null/.test(rec));
  ok('G12 retired lines never join the findings email grid',
    /FROM draw_finding_lines WHERE finding_id=\$1 AND retired_at IS NULL ORDER BY id/.test(deliverMod));

  console.log(`test-draw-money-honesty-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
