'use strict';
/**
 * DRAW + INSPECTION STATUS VOCABULARY (owner-directed 2026-07-27: "the status on our portal right
 * now — inspection scheduled, inspection completed and stuff like that — is not nice enough; we
 * should enrich that to have more statuses available and see more live details").
 *
 * TrustPoint publishes TEN service-order statuses and FIVE draw statuses. The desk was showing two
 * of them, lower-cased and underscore-stripped ("ready_for_review" → "ready for review"), which is
 * a raw database value wearing a costume — it says nothing about what is happening or who is
 * waiting on whom. This module is the ONE place that turns a raw status into something a human
 * reads: a plain label, a tone, what it MEANS, and where it sits on the track from ordered to done.
 *
 * PURE — no DB, no network, no requires. The server attaches the resolved shape to its API
 * responses so the UI never re-derives it (and a status added by TrustPoint tomorrow degrades to a
 * readable fallback rather than a blank chip).
 *
 * TONES map to the PILOT palette the panels already use:
 *   neutral  — nothing is happening yet
 *   gold     — waiting on somebody
 *   teal     — actively in motion
 *   positive — done
 *   bad      — cancelled or failed
 */

// The real inspection track, in order. CANCELLED / ERROR sit off it (step = null) — they are not a
// stage of progress, and drawing them on the track would imply the work is advancing.
const SERVICE_STEPS = ['CREATED', 'PENDING', 'QUOTE_REQUESTED', 'QUOTE_PROVIDED', 'ORDERED', 'READY_FOR_REVIEW', 'COMPLETED'];

const SERVICE = {
  CREATED:          { label: 'Being set up',            tone: 'neutral',  meaning: 'The inspection record exists but has not been ordered yet.' },
  PENDING:          { label: 'Waiting to be ordered',   tone: 'gold',     meaning: 'Ready to order — the draw administrator has not placed it yet.' },
  QUOTE_REQUESTED:  { label: 'Price requested',         tone: 'gold',     meaning: 'A price has been requested from the inspection company.' },
  QUOTE_PROVIDED:   { label: 'Price quoted',            tone: 'gold',     meaning: 'The inspector has quoted a price and is waiting for the go-ahead.' },
  ORDERED:          { label: 'Ordered',                 tone: 'teal',     meaning: 'The inspection is ordered. The inspector will visit the property.' },
  READY_FOR_REVIEW: { label: 'Report in review',        tone: 'teal',     meaning: 'The inspector has been out and their report is being reviewed.' },
  COMPLETED:        { label: 'Inspection complete',     tone: 'positive', meaning: 'The inspection is finished and the findings are in.' },
  CANCEL_REQUESTED: { label: 'Cancellation requested',  tone: 'bad',      meaning: 'Somebody has asked to cancel this inspection.' },
  CANCELLED:        { label: 'Cancelled',               tone: 'bad',      meaning: 'This inspection was cancelled and will not happen.' },
  ERROR:            { label: 'Problem at the inspector', tone: 'bad',     meaning: 'The inspection company reported a problem. The draw desk needs to look.' },
};

const DRAW = {
  DRAFT:     { label: 'Draft',       tone: 'neutral',  meaning: 'Being put together — not submitted for review yet.' },
  IN_REVIEW: { label: 'In review',   tone: 'teal',     meaning: 'Submitted. The draw administrator is reviewing it.' },
  APPROVED:  { label: 'Approved',    tone: 'positive', meaning: 'Approved. The release is being processed.' },
  COMPLETED: { label: 'Completed',   tone: 'positive', meaning: 'Finished — the funds have been sent.' },
  DELETED:   { label: 'Deleted',     tone: 'bad',      meaning: 'This draw was removed by the draw administrator.' },
};

/** Turn an unknown/absent status into something readable rather than a blank chip. */
function fallback(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { code: null, label: 'Not started', tone: 'neutral', meaning: '', known: false, step: null, steps: SERVICE_STEPS.length };
  const label = s.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return { code: s.toUpperCase(), label, tone: 'neutral', meaning: '', known: false, step: null, steps: SERVICE_STEPS.length };
}

function resolve(map, raw, extra) {
  const code = String(raw == null ? '' : raw).trim().toUpperCase();
  const hit = map[code];
  if (!hit) return fallback(raw);
  const step = map === SERVICE ? SERVICE_STEPS.indexOf(code) : -1;
  return {
    code, label: hit.label, tone: hit.tone, meaning: hit.meaning, known: true,
    step: step >= 0 ? step : null, steps: SERVICE_STEPS.length,
    ...(extra || {}),
  };
}

/**
 * A service order's status, ENRICHED with the live detail the desk actually wants to see — the
 * booked visit date, how far along the inspector says the project is, the order number.
 * @param {object} so a `trustpoint_service_orders` row (or a webhook-shaped object)
 */
function serviceStatus(so) {
  const row = so || {};
  const base = resolve(SERVICE, row.status);
  // Only OID 1082 (`date`) is string-parsed by src/db.js; every column read here is
  // TIMESTAMPTZ and arrives as a JS Date, so String(v).slice(0,10) produced a weekday
  // fragment ("Mon Jul 27") with no year — and in LOCAL time, so a near-midnight UTC
  // stamp printed the wrong day. toISOString is UTC-stable and always YYYY-MM-DD.
  const day = (v) => {
    if (!v) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    const t = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);   // already a calendar string
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  const scheduled = day(row.scheduled_at);
  const out = {
    ...base,
    kind: String(row.service_type || 'service').toLowerCase().replace(/_/g, ' '),
    number: row.service_number || null,
    orderedOn: day(row.ordered_at),
    scheduledOn: scheduled,
    completedOn: day(row.completed_at),
    cancelledOn: day(row.cancelled_at),
    progressPct: row.inspector_allowance_rate != null && Number.isFinite(Number(row.inspector_allowance_rate))
      ? Number(row.inspector_allowance_rate) : null,
  };
  // ORDERED splits into two genuinely different states for whoever is chasing it: a visit is on
  // the calendar, or nobody has booked one yet. Saying only "Ordered" hides the question.
  if (base.code === 'ORDERED') {
    out.label = scheduled ? 'Visit scheduled' : 'Ordered — awaiting a visit date';
    out.meaning = scheduled
      ? `The inspector is booked to visit on ${scheduled}.`
      : 'Ordered with the inspection company. No visit date has been set yet.';
  }
  return out;
}

/** A draw's status, in the same shape. */
function drawStatus(draw) {
  const row = draw || {};
  const base = resolve(DRAW, row.status);
  // Only OID 1082 (`date`) is string-parsed by src/db.js; every column read here is
  // TIMESTAMPTZ and arrives as a JS Date, so String(v).slice(0,10) produced a weekday
  // fragment ("Mon Jul 27") with no year — and in LOCAL time, so a near-midnight UTC
  // stamp printed the wrong day. toISOString is UTC-stable and always YYYY-MM-DD.
  const day = (v) => {
    if (!v) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    const t = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);   // already a calendar string
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  return {
    ...base,
    submittedOn: day(row.submitted_at),
    approvedOn: day(row.approved_at),
    completedOn: day(row.completed_at),
    // A wire DATE is the only proof money moved — the same rule the release email now follows.
    // `disbursed_cents` alone is a projection TrustPoint fills in at submission.
    wiredOn: day(row.disbursed_at),
  };
}

/**
 * The file's headline: what is happening on this draw RIGHT NOW, in one sentence. Prefers a live
 * inspection over a settled draw status, because an inspection in motion is the thing anyone
 * looking at the file wants to know about.
 */
// A PROBLEM at the inspector outranks progress. These sit OFF the track (step === null), so a
// headline that only considered on-track steps could never surface them — which meant the one
// state the desk most needs to see ("The inspection company reported a problem") was the one
// state the headline structurally could not say. CANCELLED is deliberately NOT here: a
// cancelled inspection is settled, not an open problem, so the draw's own status leads.
const SERVICE_ALARM = ['ERROR', 'CANCEL_REQUESTED'];

function headline(draw, serviceOrders) {
  const sos = Array.isArray(serviceOrders) ? serviceOrders : [];
  const d = drawStatus(draw);
  const resolved = sos.map(serviceStatus).filter((s) => s.known);
  // 1) anything wrong, worst first
  const alarm = resolved
    .filter((s) => SERVICE_ALARM.includes(s.code))
    .sort((a, b) => SERVICE_ALARM.indexOf(a.code) - SERVICE_ALARM.indexOf(b.code))[0];
  if (alarm) return { label: alarm.label, tone: alarm.tone, meaning: alarm.meaning, from: 'inspection' };
  // 2) otherwise the inspection furthest along the track that is still moving
  const live = resolved
    .filter((s) => s.step != null && s.code !== 'COMPLETED')
    .sort((a, b) => b.step - a.step)[0];
  if (live) return { label: live.label, tone: live.tone, meaning: live.meaning, from: 'inspection' };
  return { label: d.label, tone: d.tone, meaning: d.meaning, from: 'draw' };
}

module.exports = {
  serviceStatus, drawStatus, headline,
  SERVICE_STEPS, _SERVICE: SERVICE, _DRAW: DRAW,
};
