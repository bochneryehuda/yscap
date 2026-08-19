'use strict';
/**
 * CANDIDATE SOURCES -- what goes ON the wheel, and where each name came from.
 *
 * A spin is a list of WHEELS, and every wheel names one source from this
 * registry. That is the whole seam: the game-type catalog (game-types.js)
 * describes games by naming sources from here, so a new game is a new entry in
 * a list rather than new code, and a source can never be referenced that does
 * not exist (scripts/test-arena-game-types-pure.js fails the build if one is).
 *
 * EVERY SOURCE RETURNS THE SAME SHAPE: { key, label, weight, meta } -- `key`
 * identifies the winner (a staff id, an entry id, a loan file id), `label` is
 * what the wheel says, `weight` is BOTH the slice size and the odds (fair-draw.js
 * uses one number for both, deliberately), and `meta` carries whatever the
 * result card wants to show afterwards.
 *
 * WEIGHTS. Three modes, chosen per spin:
 *   equal    -- everybody gets 1. The default, and the right default: the
 *               research on sales contests is blunt that winner-take-all and
 *               heavily-skewed formats make the middle of the team stop trying.
 *   tickets  -- the admin sets a per-person ticket count on the spin
 *               (`config.weights`). This is the "more activity, better odds,
 *               but everyone still has a chance" format that SalesScreen ships
 *               as its Lottery competition.
 *   entry    -- the weight recorded on the row itself (used by prize wheels).
 * A weight of 0 keeps somebody visible on the wheel but unable to win, which is
 * how "you already won, you are still here" is shown rather than hidden.
 *
 * WHAT IS HONEST ABOUT THE CRM SOURCES, AND WHAT IS NOT AVAILABLE. The owner
 * asked to spin over live work -- "all files that is currently active, all that
 * closed with, and last week" -- and those sources are real: they read the RTL
 * loan pipeline. The owner also asked for call-driven spins ("whoever had a
 * call more than 10 minutes, you can show me a call log"). THERE IS NO CALL LOG
 * IN THIS SYSTEM -- no dialer integration, no talk-time field, nothing to read.
 * Rather than invent a number, those games run on CLAIMS: a person says what
 * they did, attaches the proof, and a super admin approves it before that name
 * reaches the wheel (`qualifier_claimants` below). If a dialer is ever
 * connected, it becomes one more source in this registry and the games that use
 * it stop needing the human step -- nothing else changes.
 *
 * PRODUCT SEPARATION. The file sources read the RTL `applications` table ONLY.
 * No Long-Term table is read, no Long-Term module is imported.
 *
 * READ-ONLY. Nothing in this file writes anything, anywhere.
 */

/**
 * The database is required LAZILY, exactly as lib/flags.js does and for the
 * same reason: this module is also the CATALOG the admin console and the
 * game-type registry read, and requiring `pg` at load time would drag a
 * database into a pure test that only wants the list of sources. `require` is
 * cached, so this costs nothing after the first call.
 */
function db() { return require('../../db'); }

/** Scopes exist so the UI can offer the right sources for the right wheel. */
const SCOPES = ['people', 'prizes', 'qualifiers', 'files'];

// ---------------------------------------------------------------------------
// weights
// ---------------------------------------------------------------------------

const WEIGHT_MODES = [
  { key: 'equal',   label: 'Everyone equal', hint: 'One slice each. The fairest, and the recommended default.' },
  { key: 'tickets', label: 'Tickets earned', hint: 'Chances earned from challenges set the size of each slice. More tickets, better odds -- but everyone still has a chance.' },
  { key: 'entry',   label: 'As recorded',    hint: 'Use the weight saved on each row (prize wheels use this).' },
];
const WEIGHT_MODE_KEYS = WEIGHT_MODES.map((m) => m.key);

/**
 * The weight for one candidate. In 'tickets' mode `config.weights` is the
 * map freezeRoster builds FROM THE arena_tickets LEDGER at freeze time
 * (1 + the person's chances), with any admin-typed entry laid over it — an
 * explicit number is a decision and wins. An unknown id is worth ONE, not
 * zero: a person with no ledger row and no typed number must not silently
 * become unable to win.
 */
function weightFor(mode, id, recorded, config) {
  const m = WEIGHT_MODE_KEYS.includes(mode) ? mode : 'equal';
  if (m === 'entry') {
    // A MISSING weight is worth ONE, not zero -- the same rule as the ticket
    // branch below and for the same reason: a blank must never silently make
    // somebody unable to win. Only an EXPLICIT zero means zero. (Number(null)
    // is 0, so without this guard a null column would quietly disqualify a
    // real entry; the rules test caught exactly that.)
    if (recorded === null || recorded === undefined || recorded === '') return 1;
    const w = Number(recorded);
    return Number.isInteger(w) && w >= 0 ? w : 1;
  }
  if (m === 'tickets') {
    const raw = (config && config.weights && config.weights[String(id)]);
    if (raw === undefined || raw === null || raw === '') return 1;
    const w = Math.floor(Number(raw));
    return Number.isFinite(w) && w >= 0 ? w : 1;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// helpers shared by the people sources
// ---------------------------------------------------------------------------

/** Staff ids the session was limited to, or null meaning "the whole roster". */
async function sessionMemberIds(sessionId) {
  if (!sessionId) return null;
  const r = await db().query(
    `SELECT staff_id FROM arena_session_members
      WHERE session_id = $1 AND removed_at IS NULL`, [sessionId]);
  return r.rows.length ? r.rows.map((x) => x.staff_id) : null;
}

/** Everyone who has already won anything in this session (for elimination modes). */
async function priorWinnerIds(sessionId) {
  if (!sessionId) return new Set();
  const r = await db().query(`SELECT DISTINCT staff_id FROM arena_awards WHERE session_id = $1`, [sessionId]);
  return new Set(r.rows.map((x) => String(x.staff_id)));
}

function personLabel(row) {
  return String(row.full_name || row.email || 'Unnamed').trim();
}

/**
 * Apply the two pool-wide rules every people source shares, in this order:
 *   1. drop anyone the session excluded,
 *   2. set the weight,
 *   3. handle a previous winner -- REMOVED from the wheel, or left on it at
 *      weight 0 so the room can see they were not quietly deleted. Which one
 *      is the admin's choice (`config.removeWinner`), because both readings of
 *      "they already won" are legitimate and the room should be told which is
 *      in force.
 */
function shapePeople(rows, { config, weightMode, memberIds, winners }) {
  const allowed = memberIds ? new Set(memberIds.map(String)) : null;
  const out = [];
  for (const row of rows) {
    const id = String(row.id);
    if (allowed && !allowed.has(id)) continue;
    const alreadyWon = winners.has(id);
    if (alreadyWon && config.removeWinner === 'remove') continue;
    const w = alreadyWon && config.removeWinner === 'zero' ? 0 : weightFor(weightMode, id, row.weight, config);
    out.push({
      key: id,
      label: personLabel(row),
      weight: w,
      meta: { staffId: id, role: row.role || null, alreadyWon, title: row.title || null },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

const SOURCES = [
  // ---- people ------------------------------------------------------------
  {
    key: 'checked_in',
    scope: 'people',
    label: 'Everyone who checked in on time',
    hint: 'The people who checked in to THIS spin before the cutoff and were approved. This is the Elementix Day default.',
    async build(ctx) {
      const r = await db().query(
        `SELECT s.id, s.full_name, s.email, s.role, s.title
           FROM arena_checkins c
           JOIN staff_users s ON s.id = c.staff_id
          WHERE c.spin_id = $1 AND c.status = 'approved' AND s.is_active = true
            AND s.is_external IS NOT TRUE
          ORDER BY c.checked_in_at, s.full_name`, [ctx.spin.id]);
      return shapePeople(r.rows, ctx);
    },
  },
  {
    key: 'checked_in_any',
    scope: 'people',
    label: 'Everyone who checked in (approved or not)',
    hint: 'Every check-in, including the ones nobody has decided on yet. Useful when you are not screening entries.',
    async build(ctx) {
      const r = await db().query(
        `SELECT s.id, s.full_name, s.email, s.role, s.title
           FROM arena_checkins c
           JOIN staff_users s ON s.id = c.staff_id
          WHERE c.spin_id = $1 AND c.status <> 'rejected' AND s.is_active = true
            AND s.is_external IS NOT TRUE
          ORDER BY c.checked_in_at, s.full_name`, [ctx.spin.id]);
      return shapePeople(r.rows, ctx);
    },
  },
  {
    key: 'session_members',
    scope: 'people',
    label: 'Everyone in this session',
    hint: 'The people picked for the session when it was set up -- no check-in needed.',
    async build(ctx) {
      const r = await db().query(
        `SELECT s.id, s.full_name, s.email, s.role, s.title
           FROM arena_session_members m
           JOIN staff_users s ON s.id = m.staff_id
          WHERE m.session_id = $1 AND m.removed_at IS NULL AND s.is_active = true
            AND s.is_external IS NOT TRUE
          ORDER BY s.full_name`, [ctx.session.id]);
      return shapePeople(r.rows, { ...ctx, memberIds: null });
    },
  },
  {
    key: 'selected_staff',
    scope: 'people',
    label: 'The people I pick for this spin',
    hint: 'Exactly the names you tick on this spin, nobody else.',
    async build(ctx) {
      const ids = (ctx.config.staffIds || []).map(String).filter(Boolean);
      if (!ids.length) return [];
      const r = await db().query(
        `SELECT id, full_name, email, role, title FROM staff_users
          WHERE id = ANY($1::uuid[]) AND is_active = true AND is_external IS NOT TRUE
          ORDER BY full_name`, [ids]);
      return shapePeople(r.rows, { ...ctx, memberIds: null });
    },
  },
  {
    key: 'all_loan_officers',
    scope: 'people',
    label: 'Every loan officer',
    hint: 'Everyone whose role is Loan Officer and who is still active.',
    async build(ctx) {
      const r = await db().query(
        `SELECT id, full_name, email, role, title FROM staff_users
          WHERE role = 'loan_officer' AND is_active = true AND is_external IS NOT TRUE
          ORDER BY full_name`);
      return shapePeople(r.rows, ctx);
    },
  },
  {
    key: 'all_staff',
    scope: 'people',
    label: 'The whole team',
    hint: 'Everyone with an active internal login. Brokers are never included.',
    async build(ctx) {
      const r = await db().query(
        `SELECT id, full_name, email, role, title FROM staff_users
          WHERE is_active = true AND is_external IS NOT TRUE
          ORDER BY full_name`);
      return shapePeople(r.rows, ctx);
    },
  },
  {
    key: 'qualifier_claimants',
    scope: 'people',
    label: 'Everyone who claimed the qualifier that just won',
    hint: 'Use this as the SECOND wheel after a qualifier wheel: it spins between the people whose claim for that qualifier was approved.',
    needsPreviousDraw: 'qualifiers',
    async build(ctx) {
      // The qualifier this wheel narrows to is the one the PREVIOUS wheel
      // landed on. If that has not happened yet the pool is legitimately empty
      // -- an empty pool is refused loudly by the spin runner, never guessed.
      const qualifierId = ctx.previousWinnerKey || (ctx.config && ctx.config.qualifierId);
      if (!qualifierId) return [];
      const r = await db().query(
        `SELECT s.id, s.full_name, s.email, s.role, s.title
           FROM arena_claims c
           JOIN staff_users s ON s.id = c.staff_id
          WHERE c.qualifier_id = $1 AND c.status = 'approved' AND s.is_active = true
            AND s.is_external IS NOT TRUE
          ORDER BY c.created_at, s.full_name`, [qualifierId]);
      return shapePeople(r.rows, ctx);
    },
  },

  // ---- qualifiers --------------------------------------------------------
  {
    key: 'qualifiers',
    scope: 'qualifiers',
    label: 'The things somebody could have done',
    hint: 'The list you wrote for this spin -- "a call over ten minutes", "a tough rejection", "closed a deal". The wheel picks WHICH one wins, then a second wheel picks who did it.',
    async build(ctx) {
      const r = await db().query(
        `SELECT q.id, q.label, q.description, q.weight,
                (SELECT count(*) FROM arena_claims c
                  WHERE c.qualifier_id = q.id AND c.status = 'approved') AS claimants
           FROM arena_qualifiers q
          WHERE q.spin_id = $1
          ORDER BY q.seq, q.label`, [ctx.spin.id]);
      const onlyClaimed = ctx.config.qualifiersMustHaveClaimants !== false;
      return r.rows
        // A qualifier nobody claimed cannot produce a winner on the next wheel,
        // so by default it is kept OFF the wheel rather than landed on and then
        // apologised for. An admin can switch that off to show the full list.
        .filter((q) => !onlyClaimed || Number(q.claimants) > 0)
        .map((q) => ({
          key: String(q.id),
          label: String(q.label),
          weight: weightFor(ctx.weightMode === 'tickets' ? 'entry' : ctx.weightMode, q.id, q.weight, ctx.config),
          meta: { qualifierId: String(q.id), description: q.description || null, claimants: Number(q.claimants) },
        }));
    },
  },

  // ---- prizes ------------------------------------------------------------
  {
    key: 'approved_entries',
    scope: 'prizes',
    label: 'The prizes people asked for (approved)',
    hint: 'Everything the team typed in for this spin that you accepted. This is the Elementix Day default for the prize wheel.',
    async build(ctx) {
      const r = await db().query(
        `SELECT e.id, e.label, e.detail, e.kind, e.value_cents, e.weight, e.staff_id,
                s.full_name AS asked_by
           FROM arena_entries e
           LEFT JOIN staff_users s ON s.id = e.staff_id
          WHERE e.spin_id = $1 AND e.status = 'approved'
          ORDER BY e.created_at`, [ctx.spin.id]);
      return r.rows.map((e) => ({
        key: String(e.id),
        label: String(e.label),
        weight: weightFor(ctx.weightMode === 'tickets' ? 'entry' : ctx.weightMode, e.id, e.weight, ctx.config),
        meta: {
          entryId: String(e.id), kind: e.kind, valueCents: Number(e.value_cents) || 0,
          detail: e.detail || null, askedBy: e.asked_by || null, askedByStaffId: e.staff_id ? String(e.staff_id) : null,
        },
      }));
    },
  },
  {
    key: 'prize_catalog',
    scope: 'prizes',
    label: 'The prize list in settings',
    hint: 'The standing prize list an admin keeps in the Arena settings -- no typing needed on the day.',
    async build(ctx) {
      const kinds = Array.isArray(ctx.config.prizeKinds) && ctx.config.prizeKinds.length
        ? ctx.config.prizeKinds : ['personal', 'business', 'perk'];
      const r = await db().query(
        `SELECT id, label, description, kind, value_cents FROM arena_prizes
          WHERE is_active = true AND kind = ANY($1::text[])
          ORDER BY sort_order, label`, [kinds]);
      return r.rows.map((p) => ({
        key: String(p.id),
        label: String(p.label),
        weight: 1,
        meta: { prizeId: String(p.id), kind: p.kind, valueCents: Number(p.value_cents) || 0, detail: p.description || null },
      }));
    },
  },
  {
    key: 'custom_list',
    scope: 'prizes',
    label: 'A list I type right now',
    hint: 'Anything at all, one per line. The quickest way to run a one-off wheel.',
    async build(ctx) {
      const raw = ctx.config.customList;
      const lines = Array.isArray(raw) ? raw : String(raw || '').split('\n');
      return lines
        .map((s) => String(s).trim())
        .filter(Boolean)
        .map((label, i) => ({ key: `custom:${i}`, label, weight: 1, meta: { custom: true } }));
    },
  },

  // ---- loan files (the CRM-connected spins) -------------------------------
  // These read the RTL loan pipeline. `applications` only -- no Long-Term table
  // is touched, and nothing here writes.
  {
    key: 'active_files',
    scope: 'files',
    label: 'Every loan file that is live right now',
    hint: 'The files in the pipeline today, each labelled with its borrower and its officer.',
    async build(ctx) {
      const r = await db().query(
        `SELECT a.id, a.ys_loan_number, a.loan_amount, a.status, a.loan_officer_id,
                COALESCE(a.loan_officer_name, o.full_name) AS officer,
                b.full_name AS borrower
           FROM applications a
           LEFT JOIN staff_users o ON o.id = a.loan_officer_id
           LEFT JOIN borrowers  b ON b.id = a.borrower_id
          WHERE a.deleted_at IS NULL
            AND a.actual_closing IS NULL
            AND COALESCE(a.status, '') NOT IN ('closed', 'cancelled', 'declined', 'withdrawn')
          ORDER BY a.created_at DESC
          LIMIT $1`, [fileLimit(ctx)]);
      return shapeFiles(r.rows, ctx);
    },
  },
  {
    key: 'closed_files_window',
    scope: 'files',
    label: 'Files that closed recently',
    hint: 'Everything that actually closed inside the number of days you choose -- "last week" is 7.',
    async build(ctx) {
      const days = Math.max(1, Math.min(365, Math.floor(Number(ctx.config.windowDays) || 7)));
      const r = await db().query(
        `SELECT a.id, a.ys_loan_number, a.loan_amount, a.status, a.loan_officer_id,
                a.actual_closing,
                COALESCE(a.loan_officer_name, o.full_name) AS officer,
                b.full_name AS borrower
           FROM applications a
           LEFT JOIN staff_users o ON o.id = a.loan_officer_id
           LEFT JOIN borrowers  b ON b.id = a.borrower_id
          WHERE a.deleted_at IS NULL
            AND a.actual_closing IS NOT NULL
            AND a.actual_closing >= (CURRENT_DATE - ($1::int))
          ORDER BY a.actual_closing DESC
          LIMIT $2`, [days, fileLimit(ctx)]);
      return shapeFiles(r.rows, ctx);
    },
  },
  {
    key: 'officers_of_active_files',
    scope: 'people',
    label: 'The officers who have live files',
    hint: 'Spins between the loan officers who actually have something in the pipeline right now. An officer with more live files gets more slices if you turn tickets on.',
    async build(ctx) {
      const r = await db().query(
        `SELECT s.id, s.full_name, s.email, s.role, s.title, count(a.id)::int AS weight
           FROM staff_users s
           JOIN applications a ON a.loan_officer_id = s.id
          WHERE s.is_active = true AND s.is_external IS NOT TRUE
            AND a.deleted_at IS NULL AND a.actual_closing IS NULL
            AND COALESCE(a.status, '') NOT IN ('closed', 'cancelled', 'declined', 'withdrawn')
          GROUP BY s.id, s.full_name, s.email, s.role, s.title
          ORDER BY s.full_name`);
      // In 'tickets' mode the file COUNT is the ticket count -- that is the
      // whole point of this source -- unless the admin typed their own numbers.
      const rows = ctx.weightMode === 'tickets' && !(ctx.config && ctx.config.weights)
        ? r.rows.map((x) => ({ ...x })) : r.rows;
      const mode = ctx.weightMode === 'tickets' && !(ctx.config && ctx.config.weights) ? 'entry' : ctx.weightMode;
      return shapePeople(rows, { ...ctx, weightMode: mode });
    },
  },
];

/** How many files a file wheel may hold. A wheel of 4,000 slices is unreadable;
 *  the cap is stated in the result so a truncated pool is never silent. */
function fileLimit(ctx) {
  const n = Math.floor(Number(ctx.config && ctx.config.maxCandidates) || 60);
  return Math.max(2, Math.min(500, n));
}

function shapeFiles(rows, ctx) {
  return rows.map((a) => ({
    key: String(a.id),
    label: `${a.ys_loan_number || 'No number'} - ${a.borrower || 'Unnamed borrower'}`,
    weight: weightFor(ctx.weightMode === 'entry' ? 'equal' : ctx.weightMode, a.id, 1, ctx.config),
    meta: {
      applicationId: String(a.id),
      loanNumber: a.ys_loan_number || null,
      officer: a.officer || null,
      officerStaffId: a.loan_officer_id ? String(a.loan_officer_id) : null,
      status: a.status || null,
      closedOn: a.actual_closing || null,
    },
  }));
}

const SOURCE_KEYS = SOURCES.map((s) => s.key);
const SOURCE_BY_KEY = Object.fromEntries(SOURCES.map((s) => [s.key, s]));

/**
 * Build one wheel's candidate list.
 *
 * FAILS CLOSED AND LOUDLY. An unknown source key throws rather than returning
 * an empty wheel: a wheel with nobody on it that spins anyway is the single
 * worst outcome here -- it would announce a winner that means nothing.
 */
async function buildPool(sourceKey, ctx) {
  const src = SOURCE_BY_KEY[sourceKey];
  if (!src) throw new Error(`Unknown wheel source "${sourceKey}"`);
  const memberIds = ctx.memberIds !== undefined ? ctx.memberIds : await sessionMemberIds(ctx.session && ctx.session.id);
  const winners = ctx.winners !== undefined ? ctx.winners : await priorWinnerIds(ctx.session && ctx.session.id);
  const full = {
    ...ctx,
    memberIds,
    winners,
    config: ctx.config || {},
    weightMode: ctx.weightMode || (ctx.config && ctx.config.weightMode) || 'equal',
  };
  const list = await src.build(full);
  return { source: src.key, scope: src.scope, candidates: list };
}

/** The catalog the admin console renders, with no database involved. */
function describeSources() {
  return SOURCES.map((s) => ({
    key: s.key, scope: s.scope, label: s.label, hint: s.hint,
    needsPreviousDraw: s.needsPreviousDraw || null,
  }));
}

module.exports = {
  SCOPES, SOURCES, SOURCE_KEYS, SOURCE_BY_KEY,
  WEIGHT_MODES, WEIGHT_MODE_KEYS, weightFor,
  buildPool, describeSources, sessionMemberIds, priorWinnerIds,
  canonicalPersonLabel: personLabel,
};
