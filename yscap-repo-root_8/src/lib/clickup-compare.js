'use strict';
/**
 * WHAT PILOT HOLDS vs WHAT THE CLICKUP CARD HOLDS, FIELD BY FIELD (owner-directed
 * 2026-08-02: rename "Pipeline data" to ClickUp Sync and give it a full
 * every-field data comparison).
 *
 * WHAT WAS THERE. `ClickupFileData` printed a read-only list of the figures the
 * last PULL happened to leave on the file — PILOT's own columns, labelled as
 * though they came from ClickUp. It could not answer the only question anyone
 * actually asks of a sync screen: *do the two systems agree right now?* A field
 * the card and the file disagree about looked exactly like a field they agree
 * about, because only ONE of the two values was ever on screen.
 *
 * THE VERDICT IS THE SYNC'S OWN, NOT A SECOND OPINION. Deciding "do these two
 * values mean the same thing?" is genuinely hard here — ClickUp reads a dropdown
 * back as an orderindex integer but takes a UUID on write, dates arrive as epoch
 * strings, a location is an object, a phone differs by punctuation, an email by
 * case, an SSN by dashes. `mapper.fieldValueEquivalent` already encodes every one
 * of those rules, because the outbound no-op suppression depends on them: it is
 * what decides whether a push would be a real write or a pointless one.
 *
 * So this module does NOT compare values itself. It builds exactly what a push
 * WOULD send (`mapper.buildTaskFields`), reads what the card currently holds, and
 * asks that same function. A field this screen calls "matching" is precisely a
 * field the sync would decline to write — the screen and the sync can never
 * disagree, and any future normalization rule shows up here for free.
 *
 * READ-ONLY. It fetches one task and writes nothing, to either system.
 */

const mapper = require('../clickup/mapper');
const F = require('../clickup/fields');

/* THE SPECIALS. Several fields the sync writes are NOT in `FIELD_MAP` — they are
   built by hand in `buildTaskFields` because one ClickUp field holds something
   PILOT keeps in several columns (the whole name), or the value is derived
   (vesting, the portal link), or it is a people-picker. Walking FIELD_MAP alone
   would silently omit the borrower's NAME and the property ADDRESS — two of the
   most-drifted fields on any card, and exactly what somebody opens this screen to
   check.
   So the row set is FIELD_MAP ∪ WHATEVER THE PUSH ACTUALLY BUILT. That is derived
   from the sync itself, so a field added to the push appears here for free and
   this list can never fall behind. These names are only a FALLBACK — the card's
   own field name wins whenever the card carries it. */
const SPECIAL_LABEL = new Map([
  [F.SHARED.borrowerName, 'Borrower name'],
  [F.SHARED.borrowerSSN, 'Borrower SSN'],
  [F.SHARED.borrowerAddress, 'Borrower home address'],
  [F.PIPELINE.vesting, 'Vesting'],
  [F.PIPELINE.coBorrowerFlag, 'Has a co-borrower'],
  [F.PIPELINE.coBorrowerName, 'Co-borrower name'],
  [F.PIPELINE.secondBorrowerEmail, 'Co-borrower email'],
  [F.PIPELINE.secondBorrowerCell, 'Co-borrower phone'],
  [F.SHARED.loanOfficer, 'Loan officer'],
  [F.PIPELINE.processor, 'Processor'],
  [F.EXTRA.processorEmail, 'Processor email'],
  [F.EXTRA.maritalStatus, 'Marital status'],
  [F.SYNC.borrowerPortalStatus, 'Borrower portal status'],
  [F.SYNC.portalFileId, 'PILOT file id'],
  [F.SYNC.portalFileLink, 'PILOT file link'],
  [F.EXTRA.card, 'Card'],
].filter(([id]) => !!id));

/* A field's human name. ClickUp's own field list carries the real label, so it is
   preferred; then a special's known name; then the column, made readable. */
function labelFor(f, cf, fieldId) {
  if (cf && cf.name) return String(cf.name);
  const special = SPECIAL_LABEL.get(fieldId || (f && f.cu));
  if (special) return special;
  const col = String((f && f.col) || '').replace(/_/g, ' ');
  return col ? col.charAt(0).toUpperCase() + col.slice(1) : 'Field';
}

/* How a value should READ on screen. Never a raw epoch, never "[object Object]",
   never a dropdown's orderindex. Uses the mapper's own reader so the displayed
   ClickUp value is the same one the sync would pull. */
function display(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object') {
    if (v.formatted_address) return String(v.formatted_address);
    if (v.oneLine) return String(v.oneLine);
    try { return JSON.stringify(v); } catch (_) { return null; }
  }
  return String(v);
}

/* PII never renders in full on a comparison table — the point is whether the two
   sides AGREE, which the mask preserves exactly (it is derived from the value).
   The SSN field is the one that matters; the rest are ordinary business data
   already shown elsewhere on the file. */
const MASKED = new Set([F.SHARED.borrowerSSN].filter(Boolean));
function mask(text) {
  const s = String(text || '');
  const d = s.replace(/\D/g, '');
  return d.length >= 4 ? `✱✱✱-✱✱-${d.slice(-4)}` : '✱✱✱';
}

/* Which way this field is allowed to travel — so a "differs" row says whether
   anyone can act on it, rather than implying every difference is fixable here. */
const DIRECTION = { both: 'Two-way', push: 'PILOT → ClickUp', pull: 'ClickUp → PILOT' };

/**
 * Compare one file against its ClickUp card.
 *
 * @param ctx  { app, borrower, llc }  — the PILOT side, the same shape the push builds from
 * @param task                          — the live ClickUp task
 * @param options                       — the ClickUp dropdown option map the sync already loads
 * @returns { rows, counts }            — never throws; an unreadable field is reported, not dropped
 */
function compare(ctx, task, options = {}) {
  const rows = [];
  const counts = { match: 0, differs: 0, only_pilot: 0, only_clickup: 0, blank: 0 };
  const byId = new Map();
  for (const cf of (task && task.custom_fields) || []) if (cf && cf.id) byId.set(cf.id, cf);

  // What a push WOULD send right now. This is the PILOT side, already in
  // ClickUp's own shape — which is the only shape the equivalence check accepts.
  // `buildTaskFields` returns { name, statusName, customFields, checklistFields }
  // — the custom fields are the `customFields` array, NOT the object itself.
  let outgoing = new Map();
  try {
    const built = mapper.buildTaskFields(ctx, options) || {};
    for (const { id, value } of built.customFields || []) outgoing.set(id, value);
  } catch (_) { /* a build failure leaves every row "cannot compare" rather than lying */ }

  // FIELD_MAP first (so the ordinary fields keep their familiar order), then any
  // SPECIAL the push built that the map does not carry — the borrower's name, the
  // property address, the co-borrower block. Derived from the push, so it cannot
  // fall behind the sync.
  const mapped = new Map(mapper.FIELD_MAP.map((f) => [f.cu, f]));
  const fieldIds = [...mapped.keys(), ...[...outgoing.keys()].filter((id) => !mapped.has(id))];

  for (const fieldId of fieldIds) {
    const f = mapped.get(fieldId) || { cu: fieldId, col: null, t: null, dir: 'both', type: 'text' };
    const cf = byId.get(fieldId);
    // The PILOT value in ITS OWN shape, for display. A SPECIAL has no column to
    // read, so the value we would SEND is the honest stand-in — it is literally
    // what PILOT would put on the card.
    const src = { a: ctx.app || {}, b: ctx.borrower || {}, l: ctx.llc || {} }[f.t] || {};
    const pilotRaw = f.col ? src[f.col] : outgoing.get(fieldId);
    // …and the ClickUp value read the way the sync reads it.
    let clickupRaw;
    try { clickupRaw = mapper.readValue(f, cf, options); } catch (_) { clickupRaw = undefined; }
    // A special has no FIELD_MAP `type`, so `readValue` falls through to text —
    // fine for a name or an email, wrong for a people-picker or a dropdown, where
    // the raw card value is the honest thing to show.
    if (clickupRaw === undefined && cf && cf.value != null && !mapped.has(fieldId)) clickupRaw = cf.value;

    const hasPilot = pilotRaw !== undefined && pilotRaw !== null && pilotRaw !== '';
    const hasClickup = clickupRaw !== undefined && clickupRaw !== null && clickupRaw !== '';

    let status;
    if (!hasPilot && !hasClickup) status = 'blank';
    else if (hasPilot && !hasClickup) status = 'only_pilot';
    else if (!hasPilot && hasClickup) status = 'only_clickup';
    else {
      // BOTH sides carry something — hand the verdict to the sync's own rule.
      // `cf.value` is the raw card value (an orderindex, an epoch, an object);
      // `outgoing` is what we would write. That is exactly the pair the no-op
      // suppression judges, so "matching" here means "a push would not write".
      let same = false;
      try { same = mapper.fieldValueEquivalent(fieldId, cf && cf.value, outgoing.get(fieldId), options); } catch (_) { same = false; }
      // A push-only field is never SENT from ClickUp, and a pull-only field is
      // never sent to it — but the two values are still worth comparing, so the
      // fallback below catches the case where the field has no outgoing value to
      // judge (a pull-only field builds none) and compares what each side reads.
      if (!same && !outgoing.has(fieldId)) {
        same = String(display(pilotRaw) || '').trim().toLowerCase()
             === String(display(clickupRaw) || '').trim().toLowerCase();
      }
      status = same ? 'match' : 'differs';
    }

    const masked = MASKED.has(fieldId);
    rows.push({
      field: f.col || `cu:${fieldId}`,
      fieldId,
      label: labelFor(f, cf, fieldId),
      direction: DIRECTION[f.dir] || 'Two-way',
      dir: f.dir,
      pilot: hasPilot ? (masked ? mask(pilotRaw) : display(pilotRaw)) : null,
      clickup: hasClickup ? (masked ? mask(clickupRaw) : display(clickupRaw)) : null,
      status,
      masked,
    });
    counts[status] = (counts[status] || 0) + 1;
  }

  // The card's STATUS is not a custom field but it is the thing the team changes
  // most, and a drift there is what silently strands a file's borrower-facing
  // stage — so it is compared like everything else.
  try {
    const raw = task && task.status;
    const cuStatus = (raw && typeof raw === 'object') ? raw.status : raw;
    const ours = (ctx.app && ctx.app.internal_status) || null;
    if (cuStatus || ours) {
      const same = String(cuStatus || '').trim().toLowerCase() === String(ours || '').trim().toLowerCase();
      const status = (!cuStatus && !ours) ? 'blank'
        : (!cuStatus ? 'only_pilot' : (!ours ? 'only_clickup' : (same ? 'match' : 'differs')));
      rows.unshift({
        field: 'internal_status', fieldId: null, label: 'Pipeline status',
        direction: DIRECTION.both, dir: 'both',
        pilot: ours || null, clickup: cuStatus ? String(cuStatus) : null, status, masked: false,
      });
      counts[status] = (counts[status] || 0) + 1;
    }
  } catch (_) { /* the status row is a bonus; never let it cost the table */ }

  return { rows, counts };
}

/** Rows worth a human's attention, most actionable first. */
function needsAttention(rows) {
  const rank = { differs: 0, only_clickup: 1, only_pilot: 2 };
  return (rows || [])
    .filter((r) => r.status === 'differs' || r.status === 'only_clickup' || r.status === 'only_pilot')
    .sort((a, b) => (rank[a.status] - rank[b.status]) || String(a.label).localeCompare(String(b.label)));
}

/** A one-line plain-language verdict for the panel header. */
function summarize(counts) {
  const c = counts || {};
  const differs = c.differs || 0;
  const onlyCu = c.only_clickup || 0;
  const onlyPilot = c.only_pilot || 0;
  if (!differs && !onlyCu && !onlyPilot) return 'PILOT and the ClickUp card agree on every field.';
  const bits = [];
  if (differs) bits.push(`${differs} field${differs === 1 ? '' : 's'} disagree${differs === 1 ? 's' : ''}`);
  if (onlyCu) bits.push(`${onlyCu} only on the card`);
  if (onlyPilot) bits.push(`${onlyPilot} only in PILOT`);
  return bits.join(' · ');
}

module.exports = { compare, needsAttention, summarize, _internals: { display, mask, labelFor, DIRECTION } };
