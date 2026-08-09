'use strict';
/**
 * Class Valuation callbacks — what to DO with an event they push us.
 *
 * The receiver (routes/class-webhook.js) is deliberately dumb: authenticate, store,
 * answer 200. Everything that requires judgement is here, off the request path, so a
 * slow decision can never cost us a delivery (their guide, p.6: "your endpoint should
 * respond within 30 seconds").
 *
 * ── THE VERSION PROBLEM, WHICH IS THE WHOLE REASON THIS FILE IS CAREFUL ──────────
 *
 * We order on either UAD 2.6 (`POST /orders`) or UAD 3.6 (`POST /v2/orders`), per
 * order. **Their callback does not say which.** Every event carries exactly the same
 * shape whichever version the order was placed on — `orderId`, our `referenceNumber`,
 * `eventName`, `sent`, `created`, `data` — and callbacks are registered per
 * ORGANIZATION, so one registration serves both versions.
 *
 * That matters because a follow-up read is NOT version-neutral: `GET /orders/{id}`
 * and `GET /v2/orders/{id}` describe the same order in different vocabularies
 * (`propertyTypeEnum` vs `propertyType`, a free-text vs a typed occupancy, the
 * renamed GSE references). Reading a 3.6 order through the 2.6 path does not error —
 * it answers in the other vocabulary, and anything keyed on a field name quietly
 * finds nothing.
 *
 * So the rule is: **the version comes from OUR order row, never from the event, and
 * never from the current default.** `class_orders.api_version` is written when the
 * order is placed (db/490). When it is genuinely unknown — an order placed before
 * that table existed, or an event for an order we never placed — the event is still
 * RECORDED and any version-specific call is DECLINED rather than guessed. Falling
 * back to the configured default would be the worst of the three options: it is
 * right most of the time, which is exactly what makes the wrong answer invisible.
 *
 * ── WHAT IS SAFE TO DO WITHOUT KNOWING THE VERSION ─────────────────────────────
 *
 * Everything the event itself tells us. Their status, reason, appointment, due date,
 * inspection date, assigned vendor, fee and paid flag all arrive INSIDE the payload
 * in the same shape on both versions, so applying them needs no version at all. Only
 * a follow-up FETCH does — which is why the two are separated below.
 */

const db = require('../db');
const client = require('./client');

// Their documented event names (guide pp.59-65). An event outside this list is still
// stored — a vendor adding one must never cost us the record — but nothing acts on it.
const EVENTS = [
  'NewAttachments', 'StatusChanged', 'NewNotes', 'SetAppointment', 'ScannerEvents',
  'DesktopEvents', 'AssignedToVendor', 'OrderPaid', 'CustomFieldsSet',
  'ClientFeeChanged', 'PaymentLinkSentToBorrower', 'ClientDueDateChanged',
  'AvmReport', 'AvmData', 'InspectionCompleted',
];

// Their StatusChanged values (guide p.60) -> the word our desk uses. `Resume` is an
// event, not a resting state: a resumed order is simply active again.
const STATUS = {
  active: 'in_process',
  onhold: 'on_hold',
  resume: 'in_process',
  completed: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

const text = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };
// Their datetimes are ISO UTC. An unparseable one is dropped rather than stored as
// an epoch-zero date that would read as "1970" on the screen.
function when(v) {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
// Retry policy for a delivery we could not interpret. Six attempts over roughly two
// hours: long enough that a transient failure (a database blip, a lock) recovers on
// its own, short enough that a genuinely malformed payload stops being asked about.
const MAX_ATTEMPTS = 6;
const backoffSeconds = (attempt) => Math.min(3600, 30 * Math.pow(2, Math.max(0, attempt - 1)));
// How long a claimed delivery is held before it becomes due again (see `drain`).
// Long enough that no ordinary event is worked twice, short enough that a process
// killed mid-drain does not strand its batch for long. A completed row sets
// `processed_at` and leaves the queue regardless, so this only ever governs a crash.
const CLAIM_LEASE_SECONDS = 120;

// Cents, as a bigint the column can actually hold. A number past that range does not
// merely round badly — it serialises in exponent notation ("1e+32"), Postgres refuses
// it, and the whole event fails and is retried forever. An amount we cannot store is
// not an amount we can believe, so it is dropped rather than clamped to a wrong figure.
const MAX_CENTS = 9007199254740991;   // Number.MAX_SAFE_INTEGER, well inside bigint
const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const c = Math.round(n * 100);
  return Number.isSafeInteger(c) && Math.abs(c) <= MAX_CENTS ? c : null;
};

/**
 * Find the order an event belongs to. Their id first (exact, and unique once we have
 * it), our reference number second (which is what arrives before their id has been
 * written back, and on any order placed by hand outside PILOT).
 *
 * Returns null rather than throwing — an event for an order we do not know is a
 * record to keep, not an error to raise.
 */
async function findOrder(dbc, { classOrderId, referenceNumber }) {
  const q = dbc || db;
  if (classOrderId) {
    const r = await q.query('SELECT * FROM class_orders WHERE class_order_id = $1', [String(classOrderId)]);
    if (r.rows[0]) return r.rows[0];
  }
  if (referenceNumber) {
    // OUR reference is the file's LOAN NUMBER, so it is shared by EVERY Class order on
    // that file — it identifies the file, never the order. Taking the newest was wrong
    // in the ordinary case rather than an edge one: re-order a file and the first
    // order's completion lands on the second, which may be on the other UAD version.
    //
    // So a reference-only match is used only when it is UNAMBIGUOUS. Orders that can
    // still receive events are preferred, because a completed or cancelled order is
    // not what a live event is about; if that still leaves more than one, we refuse
    // and the event is kept UNMATCHED. An unmatched event is visible and recoverable
    // (their id arrives on a later event, and refreshOrder can be run by hand); an
    // event applied to the WRONG order is silent and corrupts two orders at once.
    const r = await q.query(
      `SELECT * FROM class_orders WHERE reference_number = $1`, [String(referenceNumber)]);
    if (r.rows.length === 1) return r.rows[0];
    if (r.rows.length > 1) {
      const live = r.rows.filter((o) => o.status !== 'completed' && o.status !== 'cancelled');
      if (live.length === 1) return live[0];
      return null;   // genuinely ambiguous — never guess which order they meant
    }
  }
  return null;
}

/**
 * WHICH VERSION IS THIS ORDER ON? The one question every follow-up depends on.
 *
 * `{ version, uad, known }`. `known:false` means we must not make a version-specific
 * call — see the header. It is deliberately NOT filled in from the configured
 * default: an order placed last month on 2.6 does not become a 3.6 order because
 * somebody flipped the default today.
 */
function versionOf(order) {
  const v = order && order.api_version;
  if (v === 'v1' || v === 'v2') {
    return { version: v, uad: order.uad || (v === 'v2' ? '3.6' : '2.6'), known: true };
  }
  return { version: null, uad: null, known: false };
}

/**
 * Apply one event to its order row. PURE-ish: it reads the payload and returns the
 * column changes, so the whole mapping is unit-testable with no database and no
 * network. Nothing here needs the version — see the header.
 */
function changesFor(eventName, payload) {
  const d = (payload && payload.data && typeof payload.data === 'object') ? payload.data : {};
  const at = when(payload && (payload.created || payload.sent));
  const out = { last_event_at: at || new Date().toISOString() };

  switch (eventName) {
    case 'StatusChanged': {
      // Their key is `StatusName` (capital S) in the docs; accept the lower-cased
      // spelling too, because a payload that differs by case would otherwise leave
      // the order silently stuck on its old status.
      const raw = text(d.StatusName || d.statusName);
      const mapped = raw ? STATUS[raw.toLowerCase()] : null;
      if (mapped) out.status = mapped;
      out.status_reason = text(d.Reason || d.reason);
      const url = text(d.InvisionUrl || d.invisionUrl || d.InvisionURL);
      if (url) out.invision_url = url;
      break;
    }
    case 'SetAppointment':
      out.appointment_date = when(d.appointmentDate || d.AppointmentDate);
      out.due_date = when(d.dueDate || d.DueDate) || undefined;
      if (out.due_date === undefined) delete out.due_date;
      break;
    case 'ClientDueDateChanged':
      out.due_date = when(d.DueDate || d.dueDate);
      break;
    case 'InspectionCompleted':
      out.inspected_at = when(d.InspectedDate || d.inspectedDate);
      if (!out.status) out.status = 'inspected';
      break;
    case 'AssignedToVendor':
      out.assigned_vendor = {
        email: text(d.userEmail || d.UserEmail),
        firstName: text(d.firstName || d.FirstName),
        lastName: text(d.lastName || d.LastName),
      };
      out.status = 'assigned';
      break;
    case 'OrderPaid':
      out.paid_at = at || new Date().toISOString();
      break;
    case 'ClientFeeChanged': {
      const n = money(d.NewAmountValue != null ? d.NewAmountValue : d.newAmountValue);
      if (n != null) out.client_fee_cents = n;
      break;
    }
    default:
      break;   // recorded, nothing to change on the order row
  }
  return out;
}

/**
 * The attachments an event announced. Their NewAttachments payload documents a
 * SINGLE `data.orderId` / `data.name` / `data.contentType`, but the parallel
 * NewNotes event documents `data` as an ARRAY — so both shapes are accepted rather
 * than betting on one. Nothing is invented: a payload with no name yields nothing.
 */
function attachmentsFrom(payload) {
  const d = payload && payload.data;
  const list = Array.isArray(d) ? d : (d && typeof d === 'object' ? [d] : []);
  return list
    .filter((a) => a && typeof a === 'object')   // a null/scalar element is not an attachment
    .map((a) => ({
      name: text(a.name || a.Name),
      contentType: text(a.contentType || a.ContentType),
      attachmentId: text(a.attachmentId || a.id || a.Id),
    }))
    .filter((a) => a.name || a.attachmentId);
}

/**
 * The notes an event delivered. Their NewNotes payload documents `data` as an ARRAY
 * of `{noteId, content}` (guide p.60); a single object is accepted too, for the same
 * reason the attachment reader accepts both — betting on one shape is how a real
 * message goes missing. A note with no id AND no content is not a note.
 */
function notesFrom(payload) {
  const d = payload && payload.data;
  const list = Array.isArray(d) ? d : (d && typeof d === 'object' ? [d] : []);
  return list
    .filter((n) => n && typeof n === 'object')   // a null/scalar element is not a note
    .map((n) => ({
      noteId: text(n.noteId || n.NoteId || n.id || n.Id),
      content: text(n.content || n.Content),
      // THE NOTE'S OWN STAMP, AND ONLY ITS OWN. This used to fall back to the
      // ENVELOPE's `created`, which is when THIS DELIVERY was sent — different on
      // every retry. Once the stamp became part of a note's identity that made a
      // re-delivery look like a new message and put the same words on the thread
      // twice. It is also the wrong value to show a reader: the row's own `created_at`
      // already records when we received it, so a borrowed delivery time added
      // nothing and disagreed with what the OTHER writer (messages.syncNotes) stores
      // for the same note.
      created: when(n.created || n.Created),
    }))
    .filter((n) => n.noteId || n.content);
}

/**
 * Process ONE stored event. Never throws — a failure is recorded on the row and the
 * next drain retries it, because a callback we cannot interpret must not become a
 * callback we lose.
 */
async function processEvent(row, { dbc } = {}) {
  const q = dbc || db;
  const payload = row.payload || {};
  const eventName = row.event_name;
  try {
    const order = await findOrder(q, {
      classOrderId: row.class_order_id,
      referenceNumber: row.reference_number,
    });

    if (order) {
      const changes = changesFor(eventName, payload);
      const cols = Object.keys(changes);
      if (cols.length) {
        const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
        const vals = cols.map((c) => (changes[c] && typeof changes[c] === 'object' && !(changes[c] instanceof Date)
          ? JSON.stringify(changes[c]) : changes[c]));
        await q.query(`UPDATE class_orders SET ${sets} WHERE id = $1`, [order.id, ...vals]);
      }

      // Their id may reach us for the first time on a callback (we place the order
      // and they answer with it, but a hand-placed order has no row until now).
      if (!order.class_order_id && row.class_order_id) {
        await q.query(
          `UPDATE class_orders SET class_order_id = $2 WHERE id = $1 AND class_order_id IS NULL`,
          [order.id, String(row.class_order_id)]);
      }

      // THEIR SIDE OF THE CONVERSATION. NewNotes is how a reply reaches us without
      // anybody polling — the same thread the desk types into. Their note ids make
      // this idempotent, so a retried delivery cannot duplicate a message.
      if (eventName === 'NewNotes') {
        for (const n of notesFrom(payload)) {
          // THE GUARD HAS TO COVER A NOTE WITH NO ID. `uq_class_notes_vendor_id` is a
          // PARTIAL index, so `ON CONFLICT (class_note_id)` arbitrates nothing when
          // their note carries no id — and their guide allows exactly that (content,
          // no noteId). The claim in `drain` is what stops two drains racing; this is
          // the second layer, and it is the one that also covers a genuine RE-delivery
          // of an id-less note days later. Same message, same order, same direction is
          // the same message: `IS NOT DISTINCT FROM` so a NULL body compares equal to
          // a NULL body rather than to nothing.
          await q.query(
            `INSERT INTO class_notes (class_order_row, application_id, class_note_id, direction, content, vendor_created_at)
             SELECT $1::bigint, $2::uuid, $3::text, 'ToClient', $4::text, $5::timestamptz
              WHERE $3::text IS NOT NULL
                 OR NOT EXISTS (
                      SELECT 1 FROM class_notes
                       WHERE class_order_row = $1::bigint
                         AND direction = 'ToClient'
                         AND class_note_id IS NULL
                         AND content IS NOT DISTINCT FROM $4::text
                         -- THE VENDOR'S OWN TIMESTAMP IS PART OF THE IDENTITY, so a
                         -- genuine nudge days later that repeats the same wording is
                         -- a NEW message and still lands. Without it the guard was a
                         -- permanent swallow: same words, ever, meant dropped in
                         -- silence. (With no timestamp on either there is nothing left
                         -- to tell them apart, and one row is the safe reading.)
                         AND vendor_created_at IS NOT DISTINCT FROM $5::timestamptz)
             ON CONFLICT (class_note_id) WHERE class_note_id IS NOT NULL DO NOTHING`,
            [order.id, order.application_id, n.noteId, n.content, n.created]);
        }
      }

      if (eventName === 'NewAttachments') {
        for (const a of attachmentsFrom(payload)) {
          // Same hole, mirrored: `uq_class_attach_name` is partial on `name`, so an
          // announcement carrying an id and NO name is arbitrated by nothing. Their id
          // identifies it when the name cannot; with neither, one nameless idless
          // announcement per order is all we will record, which is the safe reading —
          // the desk's job here is "there is a document to fetch", not a count.
          await q.query(
            `INSERT INTO class_attachments (class_order_row, application_id, name, content_type, class_attachment_id)
             SELECT $1::bigint, $2::uuid, $3::text, $4::text, $5::text
              WHERE $3::text IS NOT NULL
                 OR NOT EXISTS (
                      SELECT 1 FROM class_attachments
                       WHERE class_order_row = $1::bigint
                         AND name IS NULL
                         AND class_attachment_id IS NOT DISTINCT FROM $5::text)
             ON CONFLICT (class_order_row, name) WHERE name IS NOT NULL DO NOTHING`,
            [order.id, order.application_id, a.name, a.contentType, a.attachmentId]);
        }
      }
    }

    await q.query(
      `UPDATE class_callback_events
          SET processed_at = now(), process_error = NULL,
              class_order_row = COALESCE(class_order_row, $2),
              application_id  = COALESCE(application_id, $3)
        WHERE id = $1`,
      [row.id, order ? order.id : null, order ? order.application_id : null]);
    return { ok: true, matched: !!order, version: versionOf(order) };
  } catch (e) {
    // A FAILURE MUST STEP OUT OF THE QUEUE. Recording the error alone left the row
    // `processed_at IS NULL` and first in `ORDER BY received_at`, so one delivery we
    // could not interpret sat at the head of every batch forever — and the receiver
    // drains at limit 25, so 25 of them and nothing live is processed by anything but
    // the poller. Backing off is what keeps one bad payload from being an outage.
    const attempt = Number(row.attempts || 0) + 1;
    const dead = attempt >= MAX_ATTEMPTS;
    await q.query(
      `UPDATE class_callback_events
          SET process_error   = $2,
              attempts        = $3,
              next_attempt_at = now() + ($4 || ' seconds')::interval,
              dead_at         = CASE WHEN $5 THEN now() ELSE NULL END
        WHERE id = $1`,
      [row.id, String((e && e.message) || e).slice(0, 500), attempt, String(backoffSeconds(attempt)), dead],
    ).catch(() => {});
    if (dead) {
      // Given up on, never deleted — the delivery is still evidence, and it stays
      // queryable. Said out loud because nothing else will say it.
      console.warn(`[class] callback ${row.id} (${row.event_name}) given up after ${attempt} attempts:`,
        String((e && e.message) || e).slice(0, 200));
    }
    // The raw text is kept for the worker and the log; `message` is what any screen
    // that ever renders this would show.
    return { ok: false, error: 'callback_failed', detail: String((e && e.message) || e).slice(0, 500),
      message: 'An update from the appraisal company could not be recorded. It will be retried.',
      attempts: attempt, dead };
  }
}

/**
 * Drain the inbox. Bounded, oldest first, and it never throws — this runs from the
 * receiver's `setImmediate` and from a poller, and neither may be taken down by one
 * malformed delivery.
 */
async function drain({ limit = 100 } = {}) {
  let done = 0, failed = 0, dead = 0;
  try {
    // A ROW IS CLAIMED BEFORE IT IS WORKED, and that is not a refinement — it is the
    // difference between a message appearing once on the desk and appearing four
    // times. The receiver fires this from `setImmediate` on EVERY accepted delivery,
    // and Class pushes in bursts, so two drains running at once is the ordinary case,
    // not a race worth discounting. Reading `WHERE processed_at IS NULL` and only
    // stamping it at the END let both drains pick up the same stored event and both
    // insert its notes; measured on a real database, one delivery carrying ONE vendor
    // message produced four to seven rows on the thread, and the unread badge counted
    // every one of them.
    //
    // The claim is a LEASE written into `next_attempt_at`, so it needs no new column:
    // `FOR UPDATE SKIP LOCKED` stops two drains selecting the same row inside the same
    // instant, and pushing the row's due time out stops the second drain's next pass
    // from picking it up again. Nothing is lost if we die mid-work — the lease simply
    // expires and the row is due again — and `attempts` is deliberately NOT bumped
    // here, so a crash costs a retry, not one of the six tries before a delivery is
    // given up on.
    const r = await db.query(
      `WITH due AS (
         SELECT id FROM class_callback_events
          WHERE processed_at IS NULL
            AND dead_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY next_attempt_at ASC NULLS FIRST, received_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE class_callback_events e
          SET next_attempt_at = now() + ($2 || ' seconds')::interval
         FROM due
        WHERE e.id = due.id
       RETURNING e.*`,
      [Math.max(1, Math.min(500, limit)), String(CLAIM_LEASE_SECONDS)]);
    for (const row of r.rows) {
      const out = await processEvent(row);
      if (out.ok) done++; else { failed++; if (out.dead) dead++; }
    }
  } catch (e) {
    console.warn('[class] callback drain failed:', e && e.message);
  }
  return { processed: done, failed, dead };
}

/**
 * The deliveries we gave up on. There is no screen for these yet; this is what makes
 * them answerable at all, and it is why a dead row is flagged rather than deleted.
 */
async function deadLetter({ limit = 50 } = {}) {
  const r = await db.query(
    `SELECT id, event_name, class_order_id, reference_number, attempts, process_error, received_at, dead_at
       FROM class_callback_events
      WHERE dead_at IS NOT NULL
      ORDER BY dead_at DESC
      LIMIT $1`, [Math.max(1, Math.min(500, limit))]);
  return r.rows;
}

/**
 * Re-read an order from Class — THE call that must be version-matched.
 *
 * Refuses (rather than guessing) when we do not know which version the order was
 * placed on. The refusal is a returned reason, not a throw: the caller is usually a
 * best-effort follow-up and must not be broken by an order it cannot identify.
 */
async function refreshOrder(order) {
  const v = versionOf(order);
  if (!v.known) {
    return { ok: false, reason: 'version_unknown',
      message: 'This order has no recorded form version, so we cannot safely ask Class about it — the two versions answer in different field names.' };
  }
  if (!order.class_order_id) return { ok: false, reason: 'no_class_order_id' };
  if (!client.configured().enabled) return { ok: false, reason: 'disabled' };
  try {
    const body = await client.order(order.class_order_id, { version: v.version });
    return { ok: true, version: v, order: body };
  } catch (e) {
    return { ok: false, reason: 'lookup_failed', detail: String((e && e.message) || e).slice(0, 500),
      message: 'That order could not be read from the appraisal company just now. Please try again in a moment.' };
  }
}

module.exports = {
  EVENTS, STATUS,
  findOrder, versionOf, changesFor, attachmentsFrom, notesFrom,
  processEvent, drain, deadLetter, refreshOrder,
  _internals: { when, money, text, backoffSeconds, MAX_ATTEMPTS },
};
