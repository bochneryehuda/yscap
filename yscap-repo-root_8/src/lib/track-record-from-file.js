'use strict';
/**
 * A DEAL WE FUNDED GOES ON THE BORROWER'S TRACK RECORD (owner-reported
 * 2026-08-02: "I don't think it's really taking all the addresses from previous
 * stuff that the borrower did with us and adding them automatically on the track
 * record. That should be enhanced that it should really work … as not verified").
 *
 * THE GAP, and it is the biggest one in the track record: PILOT imported a
 * borrower's history from ClickUp (`clickup/ingest.upsertTrackRecord`, on a
 * CLOSED card) and from Encompass (`encompass/enrich.addTrackRecordIfAbsent`, on
 * a closed loan) — but a loan PILOT ITSELF funded was never written anywhere.
 * Both funded doors in `routes/staff.js` seeded the post-closing checklist and
 * handed off to the draw coordinator; neither told the borrower's own record
 * that they had just done a deal with us. So the deals we know the most about
 * were the ones missing from their experience.
 *
 * THE RULES IT INHERITS, none of them new:
 *   · ONLY A CLOSED DEAL (owner-directed 2026-07-27). `funded` is that, so this
 *     is the third and last automatic writer, and all three are closed-only.
 *   · NEVER VERIFIED. `is_verified=false`, `inferred=true` — it is a lead for the
 *     team to confirm, and the frozen 3-year experience window plus the
 *     experience CONDITION still decide what it counts toward.
 *   · NEVER A DUPLICATE. It goes through `track-record-key.matchTrackRecord`, the
 *     same chokepoint every other writer now uses, so re-funding, a re-run, or a
 *     property the borrower had already typed in produces ONE line.
 *   · FILL, NEVER OVERWRITE. On a line that already exists it only fills blanks;
 *     a figure or a note a human put there is never touched.
 *
 * BOTH PEOPLE GET IT. A co-borrower did the deal too, so the line is written for
 * the primary AND the co-borrower — their experience is counted per borrower
 * (`experience.countBorrowersExperience` sums the file's borrowers), and leaving
 * the co-borrower off would under-count them on their own next file.
 *
 * Best-effort everywhere: it is called from the funded status doors and must
 * NEVER be able to fail a funding.
 */

const db = require('../db');
const TRK = require('./track-record-key');

const NOTE = 'Added automatically from a loan YS Capital funded; unverified';
const ORIGIN = 'pilot_funded';

/** What kind of deal was this, from what the file already says. Always inferred. */
function dealTypeOf(app) {
  const purpose = String(app.loan_type || '').toLowerCase();
  // A refinance means they KEPT it — a hold. A purchase we funded reads as a
  // flip unless the file itself says the exit is a rental.
  if (/refi/.test(purpose)) return 'fix-and-hold';
  if (/hold|rental|dscr/.test(purpose)) return 'fix-and-hold';
  return 'flip';
}

/* The figures worth carrying over. A refinance has no purchase price by rule
   (deal-basis, 2026-08-02), so its basis is the as-is value. */
function figuresOf(app) {
  const refi = /refi/i.test(String(app.loan_type || ''));
  return {
    purchase_price: refi ? null : (app.purchase_price ?? null),
    purchase_date: app.acquisition_date || null,
    rehab_amount: app.rehab_budget ?? null,
    current_value: refi ? (app.as_is_value ?? null) : null,
    property_type: app.property_type || null,
  };
}

/**
 * Put this funded file's property on every borrower's track record.
 * Returns a summary; never throws.
 */
async function addFromFundedFile(appId, client = db) {
  const out = { added: 0, filled: 0, skipped: [], ok: true };
  try {
    const app = (await client.query(
      `SELECT id, borrower_id, co_borrower_id, property_address, loan_type, property_type,
              purchase_price, as_is_value, rehab_budget, acquisition_date, actual_closing,
              llc_id, status, deleted_at
         FROM applications WHERE id=$1`, [appId])).rows[0];
    if (!app) return { ...out, ok: false, skipped: ['no_file'] };
    if (app.deleted_at) return { ...out, skipped: ['deleted'] };
    if (app.status !== 'funded') return { ...out, skipped: ['not_funded'] };
    if (!TRK.trackRecordKey(app.property_address)) return { ...out, skipped: ['no_readable_address'] };

    const figures = figuresOf(app);
    const people = [app.borrower_id, app.co_borrower_id].filter(Boolean);
    for (const borrowerId of people) {
      const mine = (await client.query(
        `SELECT id, property_address, address_key FROM track_records WHERE borrower_id=$1`, [borrowerId])).rows;
      const existing = TRK.matchTrackRecord(mine, app.property_address);

      if (existing) {
        /* Already on the record — from ClickUp, from Encompass, or because the
           borrower typed it in themselves. FILL the blanks only; a value that is
           already there is somebody's answer and is never overwritten. */
        const fill = Object.entries(figures).filter(([, v]) => v != null);
        if (!fill.length) { out.skipped.push('already_present'); continue; }
        const sets = fill.map(([c], i) => `${c} = COALESCE(${c}, $${i + 2})`).join(', ');
        const r = await client.query(
          `UPDATE track_records SET ${sets}, updated_at = now() WHERE id = $1`,
          [existing.id, ...fill.map(([, v]) => v)]);
        if (r.rowCount) out.filled += 1;
        continue;
      }

      await client.query(
        /* entered_by_kind/at stamped here rather than left to db/458's boot backfill
           (which would read 'system' from `origin` on the next deploy) — until then
           the row said "we don't know who entered this", which is never read as
           reviewed but does hide it from provenance-aware surfaces. */
        `INSERT INTO track_records
           (borrower_id, llc_id, property_address, address_key, deal_type, inferred,
            is_verified, origin, notes, purchase_price, purchase_date, rehab_amount,
            current_value, property_type, entered_by_kind, entered_at)
         VALUES ($1,$2,$3,$4,$5,true,false,$6,$7,$8,$9,$10,$11,$12,'system',now())`,
        [borrowerId, app.llc_id || null, JSON.stringify(app.property_address),
         TRK.trackRecordKey(app.property_address), dealTypeOf(app), ORIGIN, NOTE,
         figures.purchase_price, figures.purchase_date, figures.rehab_amount,
         figures.current_value, figures.property_type]);
      out.added += 1;
    }
    return out;
  } catch (e) {
    // A funding must never fail because a track-record line could not be written.
    return { ...out, ok: false, reason: (e && e.message) || 'error' };
  }
}

/**
 * PREVIOUS AND FUTURE. Every file PILOT has ALREADY funded is missing from its
 * borrower's record for the same reason, so a go-forward hook alone would leave
 * the whole back book wrong. Bounded per boot and self-draining: a file whose
 * property is already on every one of its borrowers' records is a no-op, so the
 * pass converges and re-running costs one read per file.
 */
const MARKER = 'track_record_funded_backfill_v1';

async function backfillFundedOnce({ limit = Number(process.env.TRACK_RECORD_FUNDED_BACKFILL || 100) } = {}) {
  const out = { files: 0, added: 0, filled: 0, ok: true };
  try {
    /* A DURABLE CURSOR over application ids, not a "does it already exist"
       predicate. Whether the line is already there can only be answered by
       sameAddress in JS, so SQL cannot filter on it — and a filter that tried
       (`address_key = ANY(...)`) would either re-scan the whole book every boot
       or, worse, stop after a borrower's FIRST funded deal and never write their
       second. The cursor walks every funded file exactly once and then rests;
       addFromFundedFile is idempotent, so a re-walk is harmless. */
    const st = (await db.query(`SELECT value FROM sync_runtime_state WHERE key=$1`, [MARKER])
      .catch(() => ({ rows: [] }))).rows[0];
    const cursor = (st && st.value && st.value.cursor) || null;

    const files = (await db.query(
      `SELECT a.id FROM applications a
        WHERE a.status = 'funded' AND a.deleted_at IS NULL
          AND a.property_address IS NOT NULL
          AND ($2::uuid IS NULL OR a.id > $2)
        ORDER BY a.id LIMIT $1`, [limit, cursor])).rows;

    for (const f of files) {
      const r = await addFromFundedFile(f.id);
      out.files += 1; out.added += r.added || 0; out.filled += r.filled || 0;
    }
    // Ran the whole page → there may be more; otherwise the book is walked.
    const next = files.length === limit ? files[files.length - 1].id : null;
    await db.query(
      `INSERT INTO sync_runtime_state (key, value) VALUES ($1,$2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [MARKER, JSON.stringify({ cursor: next, at: new Date().toISOString() })]).catch(() => {});
    return out;
  } catch (e) {
    return { ...out, ok: false, reason: (e && e.message) || 'error' };
  }
}

module.exports = { addFromFundedFile, backfillFundedOnce, _internals: { dealTypeOf, figuresOf, NOTE, ORIGIN } };
