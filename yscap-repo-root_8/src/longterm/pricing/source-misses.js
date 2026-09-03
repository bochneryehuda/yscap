'use strict';
/**
 * THE MISSING-INVESTOR REVIEW — recorded for us, silent for the officer.
 *
 * ── THE OWNER'S DECISION, IN WRITING (2026-09-03) ──────────────────────────
 * Asked what should happen when an investor has been switched to LoanNEX and
 * LoanNEX does not answer for it:
 *
 *   *"final decision on this one is to leave it out silently and send the
 *   notification to the super admin email."*
 *
 * …plus *"a manual review section recording the scenario, which investor LoanNEX
 * missed, and whether Lender Price had it"*, so the cause can be dug into.
 *
 * ── WHY SILENTLY, WHICH IS THE PART WORTH REMEMBERING ──────────────────────
 * The owner's own reasoning: once NQM is locked on LoanNEX, the Lender Price copy
 * of its pricing is second-hand. Falling back to it would put a number on the
 * board from a sheet we have deliberately stopped trusting for that investor —
 * which is worse than the row being absent. So the board says nothing, and the
 * people who can fix it are told out of band.
 *
 * ── WHAT IS RECORDED, AND WHAT IS NEVER ────────────────────────────────────
 * The loan's SHAPE — enough to re-run the search and see the miss again. Never a
 * borrower, never a name, never an address beyond the state and county the
 * pricing itself turns on, never a document. `shapeOf` is the one place that
 * decides, so a caller cannot widen it by handing over a richer object.
 *
 * ── EVERY WRITE IS BEST-EFFORT ─────────────────────────────────────────────
 * A search has already happened by the time any of this runs. A review log that
 * cannot be written, or an email that cannot be sent, costs the record and never
 * the board — every path here swallows its own failure and reports it in the
 * return value.
 *
 * SEPARATION: LT-only. Reads and writes `lt_pricing_source_misses` and reads the
 * shared `staff_users` roster to find who to tell. No RTL table, no RTL module
 * beyond the shared mail transport every long-term desk already sends through.
 */

const db = require('../db');
const cfg = require('../config');
const email = require('../../lib/email');

/** How many rows the review section hands back at once. */
const PAGE = 100;

const reasonOf = (e) => String((e && e.message) || e || 'unknown').slice(0, 300);
const nn = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * THE LOAN'S SHAPE, AND NOTHING ELSE.
 *
 * ⛔ AN ALLOWLIST, NEVER A REDACTION. Copying a scenario and deleting the fields we
 * happen to think are personal is how the next field added to the search quietly
 * ends up in a log. Only the keys named here are ever recorded, so a scenario that
 * grows a borrower's name tomorrow records nothing new by default.
 */
function shapeOf(sc) {
  const s = sc || {};
  const out = {
    purpose: s.purpose || null,
    state: s.state || null,
    county: s.county || s.countyName || null,
    propertyType: s.propertyType || null,
    units: nn(s.units),
    value: nn(s.value),
    loan: nn(s.loan),
    ltv: nn(s.ltv),
    fico: nn(s.fico),
    dscr: nn(s.dscr),
    termYears: nn(s.termYears != null ? s.termYears : s.term),
    interestOnly: s.interestOnly === true ? true : (s.interestOnly === false ? false : null),
    prepayMonths: nn(s.prepayMonths),
    // The ZIP is the pricing input the county is derived FROM, so it is kept — it is
    // a fact about the property, not about the person, and without it a reviewer
    // cannot re-run the search that produced the miss.
    zip: s.zip ? String(s.zip).slice(0, 10) : null,
  };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

/**
 * RECORD ONE SEARCH'S MISSES.
 *
 * `misses` is the list `general-board` handed out: investors the settings pointed
 * at a sheet, on a search where that sheet ANSWERED and simply did not carry them.
 * A sheet that refused is NOT a miss and must never reach here — that is one
 * outage, not forty missing investors, and the board's own `sources` block carries
 * it.
 *
 * Returns `{ ok, recorded, alerted, problem }`. Never throws.
 */
async function record(misses, opts = {}) {
  const list = (misses || []).map((m) => (typeof m === 'string' ? { key: m } : m)).filter((m) => m && m.key);
  if (!list.length) return { ok: true, recorded: 0, alerted: 0 };
  const source = opts.source || 'loannex';
  const scenario = shapeOf(opts.scenario);
  const note = opts.note ? String(opts.note).slice(0, 500) : null;

  const fresh = [];
  let recorded = 0;
  for (const m of list) {
    try {
      /* ⛔ ONE ROW PER INVESTOR PER DAY, COUNTED. A search asks the sheets once per
         DSCR band, so a single press of Search would otherwise file seven identical
         rows, and one bad afternoon would be two thousand.

         `alerted_at` comes back because it — and NOT "was this row inserted just
         now?" — is the question that decides whether anybody is emailed. See the
         note beside `fresh` below; the two are one rule and drifting them apart is
         what makes giving a claim back pointless. */
      const r = await db.query(
        `INSERT INTO lt_pricing_source_misses
           (investor_key, investor_label, source, other_source_had, scenario, note)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (investor_key, source, seen_day) DO UPDATE
            SET hits = lt_pricing_source_misses.hits + 1,
                last_seen_at = now(),
                -- The newest search's own facts win: a reviewer opening this row wants
                -- the most recent example, not the first one of the day.
                other_source_had = EXCLUDED.other_source_had,
                scenario = EXCLUDED.scenario,
                note = EXCLUDED.note
         RETURNING id, investor_key, investor_label, hits, alerted_at`,
        [m.key, m.label || null, source,
          m.otherSourceHad === true ? true : (m.otherSourceHad === false ? false : null),
          JSON.stringify(scenario), note]);
      recorded += 1;
      const row = r.rows[0];
      /* ⛔ STILL UN-TOLD — the question is NOT "is this row new?".
       *
       * The obvious reading is "email on the first miss of the day", and it is wrong
       * in a way that is silent: `alert()` deliberately gives its claim back when
       * there is nobody configured to tell or the send throws, precisely so the NEXT
       * search can try again. By then the row exists, so every later search is an
       * UPDATE rather than an INSERT — offer only genuinely-inserted rows and the
       * retry never comes, the released claim is never re-offered, and the investor
       * is silently un-reported for the rest of the day over a two-second blip.
       * Giving a claim back is pointless if nothing ever re-claims it.
       *
       * So the stamp answers its own question: "has anybody actually been told?".
       * A row inserted a moment ago has no stamp, so the first miss of the day still
       * alerts exactly as before — that case is a consequence of this rule, not a
       * second one beside it. Two searches finishing at the same second both offer
       * the row and the IS NULL-guarded claim in `alert()` decides which one sends. */
      if (row && row.alerted_at == null) fresh.push(row);
    } catch (e) {
      return { ok: false, recorded, alerted: 0, problem: reasonOf(e) };
    }
  }

  const alerted = fresh.length ? await alert(fresh, { source, scenario }) : 0;
  return { ok: true, recorded, alerted };
}

/** Who to tell. The super admins on the shared roster, plus any address configured for them. */
async function recipients() {
  const out = new Set();
  for (const a of cfg.notifyAdmins || []) if (a) out.add(String(a).trim());
  try {
    const r = await db.query(
      `SELECT email FROM staff_users
        WHERE role = 'super_admin' AND is_active = true AND COALESCE(email,'') <> ''`);
    for (const row of r.rows) out.add(String(row.email).trim());
  } catch { /* an unreadable roster costs the roster half, never the configured half */ }
  return [...out];
}

/**
 * TELL THE SUPER ADMIN, ONCE PER ROW.
 *
 * ⛔ THE CLAIM IS AN `IS NULL`-GUARDED UPDATE, TAKEN BEFORE THE SEND. Two searches
 * finishing at the same second would otherwise both read "not alerted yet" and both
 * send. The row that wins the claim is the one that emails; the loser sends nothing.
 *
 * ⛔ AND A FAILED SEND GIVES THE CLAIM BACK. The stamp means "somebody was told",
 * not "we tried" — leaving it set after a provider error would silence the alert
 * for that investor for the rest of the day over a two-second blip.
 */
async function alert(rows, ctx) {
  let claimed = [];
  try {
    const r = await db.query(
      `UPDATE lt_pricing_source_misses SET alerted_at = now()
        WHERE id = ANY($1::bigint[]) AND alerted_at IS NULL
        RETURNING id, investor_key, investor_label, hits`,
      [rows.map((x) => x.id)]);
    claimed = r.rows;
  } catch { return 0; }
  if (!claimed.length) return 0;

  const to = await recipients();
  if (!to.length) {
    // Nobody to tell is not a silent success: the row keeps its stamp off so the
    // next search re-offers it once somebody is configured.
    try { await db.query('UPDATE lt_pricing_source_misses SET alerted_at = NULL WHERE id = ANY($1::bigint[])', [claimed.map((x) => x.id)]); } catch { /* nothing more to do */ }
    return 0;
  }

  try {
    await email.sendMail({
      to,
      subject: `Pricing: ${sheetName(ctx.source)} did not carry ${claimed.length === 1 ? nameOf(claimed[0]) : `${claimed.length} investors`}`,
      html: bodyHtml(claimed, ctx),
      text: bodyText(claimed, ctx),
      from: cfg.notifyFrom,
      _skipCapture: true,
      _ctx: { type: 'lt_pricing_source_miss', audience: 'staff' },
    });
    return claimed.length;
  } catch {
    try { await db.query('UPDATE lt_pricing_source_misses SET alerted_at = NULL WHERE id = ANY($1::bigint[])', [claimed.map((x) => x.id)]); } catch { /* nothing more to do */ }
    return 0;
  }
}

const SHEETS = { loannex: 'LoanNEX', lenderprice: 'Lender Price' };
const sheetName = (s) => SHEETS[s] || s;
const nameOf = (r) => r.investor_label || r.investor_key;

/** The scenario in words, so the email can be acted on without opening anything. */
function scenarioLine(sc) {
  const bits = [];
  if (sc.purpose) bits.push(sc.purpose);
  if (sc.state) bits.push(sc.county ? `${sc.county}, ${sc.state}` : sc.state);
  if (sc.loan) bits.push(`$${Math.round(sc.loan).toLocaleString('en-US')} loan`);
  if (sc.fico) bits.push(`${sc.fico} FICO`);
  if (sc.dscr) bits.push(`DSCR ${sc.dscr}`);
  return bits.join(' · ') || 'no scenario recorded';
}

function bodyText(rows, ctx) {
  const names = rows.map((r) => `  · ${nameOf(r)}`).join('\n');
  return [
    `${sheetName(ctx.source)} answered a pricing search and did not carry:`,
    '',
    names,
    '',
    `The loan: ${scenarioLine(ctx.scenario)}`,
    '',
    'These investors were left off the board rather than priced from the other',
    'system — once an investor is switched over, the other system\'s copy of its',
    'pricing is second-hand. Nothing was said on the pricing screen.',
    '',
    'The full record, with every scenario, is in the pricing engine\'s settings',
    'under "Investors the second system did not carry".',
  ].join('\n');
}

function bodyHtml(rows, ctx) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const names = rows.map((r) => `<li style="margin:2px 0"><strong>${esc(nameOf(r))}</strong></li>`).join('');
  return [
    `<p style="margin:0 0 10px"><strong>${esc(sheetName(ctx.source))}</strong> answered a pricing search and did not carry:</p>`,
    `<ul style="margin:0 0 12px;padding-left:20px">${names}</ul>`,
    `<p style="margin:0 0 12px">The loan: ${esc(scenarioLine(ctx.scenario))}</p>`,
    '<p style="margin:0 0 12px">These investors were left off the board rather than priced from the other system — once an investor is switched over, the other system&#8217;s copy of its pricing is second-hand. Nothing was said on the pricing screen.</p>',
    '<p style="margin:0">The full record, with every scenario, is in the pricing engine&#8217;s settings under &#8220;Investors the second system did not carry&#8221;.</p>',
  ].join('');
}

/** The review section's own list — newest first, open ones first. */
async function list(opts = {}) {
  const limit = Math.min(Number(opts.limit) || PAGE, PAGE);
  const openOnly = opts.openOnly === true;
  try {
    const r = await db.query(
      `SELECT id::text AS id, investor_key, investor_label, source, seen_day,
              first_seen_at, last_seen_at, hits, other_source_had, scenario, note,
              alerted_at, reviewed_at, reviewed_by, review_note
         FROM lt_pricing_source_misses
        ${openOnly ? 'WHERE reviewed_at IS NULL' : ''}
        ORDER BY (reviewed_at IS NULL) DESC, last_seen_at DESC
        LIMIT $1`, [limit]);
    const rows = r.rows.map((x) => ({ ...x, hits: Number(x.hits) }));
    return { ok: true, rows, openCount: rows.filter((x) => !x.reviewed_at).length };
  } catch (e) {
    // A review log that cannot be read is reported as such — never as an empty
    // list, which would read as "nothing has ever gone wrong".
    return { ok: false, rows: [], openCount: 0, problem: reasonOf(e) };
  }
}

/** Mark one row looked at, with the reviewer's own note. Un-review by passing `reviewed:false`. */
async function review(id, opts = {}) {
  try {
    const done = opts.reviewed === false ? null : new Date();
    /* ⛔ `$2::timestamptz` IS NOT DECORATION. The same placeholder is both ASSIGNED to
       a column and asked `IS NULL` inside a CASE, and Postgres plans the CASE without
       the assignment's type in hand — so an uncast $2 fails the whole statement with
       "could not determine data type of parameter $2", which this function's own catch
       turns into a plain `save_failed` and a reviewer who cannot mark anything read. */
    const r = await db.query(
      `UPDATE lt_pricing_source_misses
          SET reviewed_at = $2::timestamptz, reviewed_by = $3::uuid,
              review_note = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE $4 END
        WHERE id = $1::bigint
        RETURNING id::text AS id, reviewed_at, review_note`,
      [id, done, opts.staffId || null, opts.note ? String(opts.note).slice(0, 1000) : null]);
    if (!r.rows.length) return { ok: false, error: 'not_found' };
    return { ok: true, row: r.rows[0] };
  } catch (e) {
    return { ok: false, error: 'save_failed', message: reasonOf(e) };
  }
}

module.exports = { record, list, review, shapeOf, recipients, _internals: { alert, scenarioLine, bodyText, bodyHtml, sheetName, PAGE } };
