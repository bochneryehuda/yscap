'use strict';
/**
 * LONG-TERM — the ClickUp PUSH pipeline: field updates on linked cards, and
 * task CREATION for new Encompass files.
 *
 * BY-VALUE COPY of the RTL orchestrator's proven machinery
 * (src/clickup/orchestrator.js) under the CLICKUP WRITER'S INHERITANCE sanction
 * (owner, 2026-08-23 — docs/LONG-TERM-AUTHORIZED-COPIES.md): read-before-write
 * with fail-closed scoped pushes, per-field no-op suppression, the PII
 * overwrite shield, fill-only mode, the write journal, the volume circuit
 * breaker with its boot seed, the overwrite-storm alarm, push-failure
 * accounting, and the create-then-link flow. Zero RTL logic imports — the two
 * authorized DATA imports (src/clickup/routing.js staff table) are facts about
 * the tenant, and `src/lib/address-canon.js` is the ledger-authorized geocoder.
 *
 * THE OWNER'S SPEC (2026-08-23): new Encompass file → create a linked ClickUp
 * task in the officer's folder with the ysportal stamp; field changes → update
 * the linked cards; the ~45-field mapping lives in mapper.js.
 *
 * POSTURE — everything here is OFF until the owner turns it on:
 *   LT_CLICKUP_WRITE_ENABLED   blank = OFF (a write that has never happened
 *                              does not default itself on — the stamp.js rule)
 *   LT_CLICKUP_WRITE_DRYRUN    build + log the exact plan, send nothing
 *   LT_CLICKUP_CREATE_SINCE    only a loan DISCOVERED on/after this day may
 *                              gain a brand-new card (default 2026-08-24) — the
 *                              owner asked for NEW files; creating cards for
 *                              the 486-loan back book would flood the folders.
 *   LT_CLICKUP_PUSH_PER_PASS / LT_CLICKUP_CREATE_PER_PASS  bounded batches.
 *   LT_CLICKUP_MAX_FIELD_WRITES_10MIN  the circuit breaker (default 300,
 *                              floor 50), seeded from lt_clickup_write_log.
 *
 * WHAT A PUSH WILL NEVER DO (the §10 NEVER list, enforced in code): clear a
 * field, delete or rename a task, create from a scoped push, write past a
 * failed pre-read, write a placeholder, rewrite a differing PII identity field
 * (fill-only + review), change an existing DOB (review), rewrite an occupied
 * LOCATION (fill-only for every location, the mapper's documented posture),
 * write to a short-term card, write to a trashed loan's card, or exceed the
 * breaker. A lossy push is never marked done.
 */

const db = require('../db');
const writer = require('./writer-client');
const registry = require('./registry');
const mapper = require('./mapper');
const T = require('./transforms');
const ltRouting = require('./routing');
const program = require('./program');
const trash = require('../trash');
const statusEngine = require('./status-engine');
const statusPush = require('./status-push');
const rtlStaff = require('../../clickup/routing');   // DATA import — authorized in the ledger
const addressCanon = require('../../lib/address-canon'); // authorized import (read-only lookup)

// ── Switches (read at CALL time — the link.js discipline) ────────────────────
const writeEnabled = () => String(process.env.LT_CLICKUP_WRITE_ENABLED || '').trim() === '1';
const dryRun = () => String(process.env.LT_CLICKUP_WRITE_DRYRUN || '').trim() === '1';
const createSince = () => String(process.env.LT_CLICKUP_CREATE_SINCE || '2026-08-24').trim();

// ── The volume circuit breaker (G24) — LT's own budget, seeded on boot ──────
const BREAKER_WINDOW_MS = 10 * 60 * 1000;
function breakerLimit() {
  const n = parseInt(process.env.LT_CLICKUP_MAX_FIELD_WRITES_10MIN || '300', 10);
  return Math.max(50, Number.isFinite(n) ? n : 300);
}
let _writeTimes = [];
let _breakerSeeded = false;
let _breakerWarnedAt = 0;
async function seedBreakerFromDb() {
  if (_breakerSeeded) return;
  _breakerSeeded = true;
  try {
    const { rows } = await db.query(
      `SELECT created_at FROM lt_clickup_write_log
        WHERE blocked = false AND created_at > now() - interval '10 minutes'`);
    for (const r of rows) _writeTimes.push(new Date(r.created_at).getTime());
  } catch (_) { /* a missing table never blocks the seed — the window simply starts empty */ }
}
function circuitCheck() {
  const cutoff = Date.now() - BREAKER_WINDOW_MS;
  _writeTimes = _writeTimes.filter((t) => t > cutoff);
  if (_writeTimes.length >= breakerLimit()) {
    if (Date.now() - _breakerWarnedAt > 60000) {
      _breakerWarnedAt = Date.now();
      console.warn(`[lt-clickup-push] CIRCUIT OPEN — ${_writeTimes.length} field writes in 10 minutes (limit ${breakerLimit()}). Pushes refuse until the window drains.`);
    }
    const e = new Error(`ClickUp write circuit open: ${_writeTimes.length} writes in 10 minutes (limit ${breakerLimit()}).`);
    e.code = 'CLICKUP_CIRCUIT_OPEN';
    e.retryable = true;
    throw e;
  }
}
const countWrite = () => { _writeTimes.push(Date.now()); };

// ── The write journal (G22) — best-effort, masked, append-only ───────────────
async function journalFieldWrite({ ltLoanId, taskId, fieldId, fieldKey, oldValue, newValue, changed, blocked, source }) {
  try {
    const mask = (fid, v) => {
      if (v === undefined) return null;
      if (fid === mapper.CU.borrowerSSN) return T.maskSSN(String(v == null ? '' : v));
      return v == null ? null : v;
    };
    await db.query(
      `INSERT INTO lt_clickup_write_log (lt_loan_id, task_id, field_id, field_key, old_value, new_value, changed, blocked, source)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
      [ltLoanId || null, String(taskId), fieldId || null, fieldKey || null,
        JSON.stringify(mask(fieldId, oldValue)), JSON.stringify(mask(fieldId, newValue)),
        changed !== false, blocked === true, source || null]);
  } catch (e) {
    console.warn('[lt-clickup-push] journal write failed (push unaffected):', (e && e.message) || e);
  }
}

// ── The review queue (G19/G20) — a blocked identity write asks a human ───────
async function queueReview({ ltLoanId, taskId, fieldKey, currentValue, proposedValue, reason }) {
  try {
    await db.query(
      `INSERT INTO lt_clickup_review_queue (lt_loan_id, task_id, direction, field_key, current_value, proposed_value, reason)
       VALUES ($1::uuid, $2, 'outbound', $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [ltLoanId || null, String(taskId), String(fieldKey),
        currentValue == null ? null : String(currentValue),
        proposedValue == null ? null : String(proposedValue), String(reason)]);
  } catch (e) {
    console.warn('[lt-clickup-push] review queue write failed:', (e && e.message) || e);
  }
}

// ── Officer / processor → ClickUp numeric user id (G29: no staff_users write) ─
let _teamMembers = null;
let _teamMembersAt = 0;
async function liveMemberIdByEmail(email) {
  const want = String(email || '').toLowerCase().trim();
  if (!want) return null;
  const now = Date.now();
  if (!_teamMembers || now - _teamMembersAt > 10 * 60 * 1000) {
    try {
      const out = await writer.getTeams();
      _teamMembers = [];
      for (const t of (out && out.teams) || []) {
        for (const m of t.members || []) {
          const u = m && m.user;
          if (u && u.id && u.email) _teamMembers.push({ id: Number(u.id), email: String(u.email).toLowerCase().trim() });
        }
      }
      _teamMembersAt = now;
    } catch (_) { return null; }
  }
  const hit = _teamMembers.find((m) => m.email === want);
  return hit ? hit.id : null;
}

function staffTableEntryByEmail(email) {
  const want = String(email || '').toLowerCase().trim();
  if (!want) return null;
  const list = Array.isArray(rtlStaff.CLICKUP_STAFF) ? rtlStaff.CLICKUP_STAFF : [];
  return list.find((e) => {
    const a = String(e.staffEmail || '').toLowerCase().trim();
    const b = String(e.clickupEmail || '').toLowerCase().trim();
    return (a && a === want) || (b && b === want);
  }) || null;
}

/**
 * A file person (from lt_loan_contacts) -> { name, email, clickupUserId }.
 * The ladder: the linked PILOT staff row's clickup_user_id (sql-read
 * authorized), the RTL staff DATA table by either email, then the live member
 * list. A person nobody can place keeps their name/email and no id — the
 * users field is OMITTED, never guessed (§5.3).
 */
async function resolvePerson(contact) {
  if (!contact) return null;
  const out = { name: contact.encompass_name || null, email: contact.encompass_email || null, clickupUserId: null };
  const staffId = contact.override_staff_id || contact.staff_id;
  if (staffId) {
    try {
      const { rows } = await db.query(
        'SELECT email, clickup_user_id, full_name FROM staff_users WHERE id = $1::uuid', [staffId]);
      if (rows[0]) {
        if (rows[0].email) out.email = rows[0].email;
        if (rows[0].full_name) out.name = rows[0].full_name;
        if (rows[0].clickup_user_id) out.clickupUserId = Number(rows[0].clickup_user_id);
      }
    } catch (_) { /* read-only convenience — never fails a push */ }
  }
  if (!out.clickupUserId) {
    for (const email of [out.email, contact.encompass_email]) {
      const hit = staffTableEntryByEmail(email);
      if (hit && hit.clickupUserId) { out.clickupUserId = Number(hit.clickupUserId); break; }
    }
  }
  if (!out.clickupUserId) {
    for (const email of [out.email, contact.encompass_email]) {
      const id = await liveMemberIdByEmail(email);
      if (id) { out.clickupUserId = id; break; }
    }
  }
  return out;
}

// ── Geocoding (fill-only locations; provider text adopted only when SAFE) ────
/**
 * May the geocoder's formatted text stand in for ours? FRESH, deliberately
 * tiny LT rule capturing the two measured corruption classes (the RTL
 * Piscataway incident): the provider must keep our HOUSE NUMBER, and must not
 * contradict a ZIP we already hold. Anything else keeps OUR text with the
 * provider's coordinates.
 */
function providerTextSafe(ours, provider) {
  const houseOf = (t) => { const m = String(t || '').trim().match(/^(\d+[A-Za-z]?)\b/); return m ? m[1].toLowerCase() : null; };
  const zipOf = (t) => { const m = String(t || '').match(/\b(\d{5})(?:-\d{4})?\b(?!.*\d{5})/); return m ? m[1] : null; };
  const oh = houseOf(ours); const ph = houseOf(provider);
  if (!oh || !ph || oh !== ph) return false;
  const oz = zipOf(ours); const pz = zipOf(provider);
  if (oz && pz && oz !== pz) return false;
  return true;
}

async function geoFor(parts) {
  const line = [parts.street, parts.city, [parts.state, parts.zip].filter(Boolean).join(' ')]
    .map((x) => String(x || '').trim()).filter(Boolean).join(', ');
  if (!line || !String(parts.street || '').trim()) return null;
  let g = null;
  try { g = await addressCanon.geocode(line); } catch (_) { g = null; }
  if (!g || g.lat == null || g.lng == null) return null;
  const providerText = String(g.formatted || '').trim();
  const formatted = providerText && providerTextSafe(line, providerText) ? providerText : line;
  return { lat: Number(g.lat), lng: Number(g.lng), formatted_address: formatted };
}

// ── Live Encompass extras at push time ───────────────────────────────────────
async function readExtras(guid) {
  let client;
  try { client = require('../encompass/client'); } catch (_) { return {}; }
  try {
    if (!client.configured || !client.configured()) return {};
    if (typeof client.fieldReaderSplit === 'function') {
      return await client.fieldReaderSplit(guid, mapper.EX_FIELD_IDS);
    }
    return await client.fieldReader(guid, mapper.EX_FIELD_IDS);
  } catch (e) {
    // Encompass down → the push proceeds MIRROR-ONLY: absent live values are
    // simply not written (never cleared), and the next pass tries again.
    console.warn('[lt-clickup-push] live Encompass read failed — pushing mirror-only:', (e && e.message) || e);
    return {};
  }
}

// ── Assemble the mapper's bag for one loan ───────────────────────────────────
async function loadBag(loanId, { ex = null, forCreate = false } = {}) {
  const { rows: loans } = await db.query('SELECT * FROM lt_loans WHERE id = $1::uuid', [loanId]);
  const loan = loans[0];
  if (!loan) return null;
  const { rows: props } = await db.query('SELECT * FROM lt_properties WHERE loan_id = $1::uuid', [loanId]);
  const prop = props[0] || {};

  // Parties: the borrower pair (if the mirror has read it).
  let borrower = null; let coborrower;
  try {
    const { rows: pairs } = await db.query(
      `SELECT p.* FROM lt_parties p JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid ORDER BY bp.pair_number ASC, p.role`, [loanId]);
    if (pairs.length) {
      borrower = pairs.find((p) => p.role === 'borrower') || null;
      coborrower = pairs.find((p) => p.role === 'coborrower') || null;   // null = KNOWN none
    } else {
      coborrower = undefined;                                            // parties never read
    }
  } catch (_) { borrower = null; coborrower = undefined; }

  let residence = null; let priorResidence = null;
  if (borrower) {
    try {
      const { rows: res } = await db.query(
        'SELECT * FROM lt_residences WHERE party_id = $1::uuid', [borrower.id]);
      residence = res.find((r) => r.residency_type === 'current') || null;
      priorResidence = res.find((r) => r.residency_type === 'prior') || null;
    } catch (_) { /* optional */ }
  }

  // Officer + processor from the file's own contact rows.
  let officer = null; let processor = null;
  try {
    const { rows: contacts } = await db.query(
      `SELECT * FROM lt_loan_contacts WHERE loan_id = $1::uuid AND role IN ('loan_officer','processor')`, [loanId]);
    officer = await resolvePerson(contacts.find((c) => c.role === 'loan_officer'));
    processor = await resolvePerson(contacts.find((c) => c.role === 'processor'));
  } catch (_) { /* omitted, never guessed */ }

  let investorLoanNumber = null; let investorName = null; let investorChannel = null;
  try {
    const { rows: inv } = await db.query(
      `SELECT investor_loan_number, COALESCE(accurate_name, shorthand_name) AS investor_name, funding_channel
         FROM lt_loan_investors WHERE loan_id = $1::uuid`, [loanId]);
    if (inv[0]) {
      investorLoanNumber = inv[0].investor_loan_number;
      investorName = inv[0].investor_name;
      investorChannel = inv[0].funding_channel;
    }
  } catch (_) { /* optional table */ }

  // The milestone ladder (db/623) — what the status engine keys on.
  let ladder = [];
  try {
    const { rows } = await db.query(
      `SELECT milestone_name, position, done FROM lt_loan_milestones
        WHERE loan_id = $1::uuid ORDER BY position`, [loanId]);
    ladder = rows;
  } catch (_) { /* no ladder read yet — the engine claims nothing */ }

  const appUrl = String(process.env.APP_URL || 'https://yscap.onrender.com').replace(/\/$/, '');
  const bag = {
    loan, prop, borrower, coborrower, residence, priorResidence,
    ex: ex || {},
    officer, processor,
    investorLoanNumber, investorName, investorChannel, ladder,
    portalFileId: loan.id,
    portalFileLink: `${appUrl}/portal/#/long-term/file/${loan.id}`,
    subjectGeo: null, borrowerGeo: null, priorGeo: null,
  };

  // Geocode only what could actually be written (create: everything; push:
  // push() re-checks blankness before writing, so a wasted geocode is cheap
  // but a missing one loses a fill — resolve all three when the parts exist).
  bag.subjectGeo = await geoFor({ street: prop.street, city: prop.city, state: prop.state, zip: prop.zip });
  if (residence) bag.borrowerGeo = await geoFor(residence);
  if (priorResidence) bag.priorGeo = await geoFor(priorResidence);
  if (!bag.priorGeo && !forCreate) {
    const st = bag.ex && bag.ex.FR0326;
    if (st && String(st).trim()) {
      bag.priorGeo = await geoFor({ street: bag.ex.FR0326, city: bag.ex.FR0306, zip: bag.ex.FR0315 });
    }
  }
  return bag;
}

// ── Card-side helpers ────────────────────────────────────────────────────────
function taskFieldValue(task, fieldId) {
  const cf = (task && task.custom_fields) || [];
  const f = cf.find((x) => x && x.id === fieldId);
  return f ? f.value : undefined;
}
function taskOptionsMap(task) {
  const map = {};
  for (const f of (task && task.custom_fields) || []) {
    if (f && f.type_config && Array.isArray(f.type_config.options)) map[f.id] = f.type_config.options;
  }
  return map;
}
/** The card's *Program label (dropdowns read as orderindex ints). */
function cardProgramLabel(task) {
  const cf = ((task && task.custom_fields) || []).find((x) => x && x.id === mapper.CU.program);
  if (!cf) return null;
  const opts = (cf.type_config && cf.type_config.options) || [];
  if (cf.value == null || cf.value === '') return null;
  if (typeof cf.value === 'object' && cf.value.name) return cf.value.name;
  return T.dropdownIndexToLabel(opts, cf.value);
}

const LOCATION_FIELD_IDS = new Set([mapper.CU.subjectAddress, mapper.CU.borrowerAddress, mapper.CU.priorAddress]);

// ── THE PUSH: field updates on one linked card ───────────────────────────────
/**
 * pushLoan(loanId, opts)
 *   opts.only          logical keys — a SCOPED push writes those fields alone
 *   opts.fillOnly      write only provably blank fields (sweep posture, G21)
 *   opts.approvedReview  a human approved a review — the shield steps aside
 *                        for exactly the approved field
 *   opts.source        journal source: 'scoped_push' | 'full_repush'
 * Returns { ok, wrote, suppressed, blocked, reasons } or throws retryable.
 */
/**
 * The ONE derivation of the status the card should carry (#39), shared by the
 * push and by the section route's compare view (pre-merge audit round 2, obs 7
 * — the two used to carry byte-identical copies of this block, a drift risk).
 *
 * ANSWERED beats UNREAD (the defect-1 class, status side): the engine's
 * Submittal fork gets a real channel label only when the live field was
 * ANSWERED ('CX.TABLEFUNDER' key present — '' means answered-blank) or the
 * mirror holds a channel; otherwise null, and the engine claims nothing
 * rather than asserting the non-del default during an outage.
 */
/* ── The status watermark (db/626) ──────────────────────────────────────────
 * A status write needs a milestone that FIRED since the last one answered.
 * 'observed_baseline' is excluded in SQL, not in JS: a first sighting is where
 * the loan already WAS, and treating it as a move is how every newly mirrored
 * loan would write a status nobody asked for. */
async function readStatusWatermark(loanId) {
  const { rows } = await db.query(
    `SELECT l.clickup_status_event_at AS watermark,
            (SELECT max(e.observed_at) FROM lt_milestone_events e
              WHERE e.loan_id = l.id AND e.event_type = 'observed_entered') AS latest_entered
       FROM lt_loans l WHERE l.id = $1::uuid`, [String(loanId)]);
  const r = rows[0] || {};
  return { watermark: r.watermark || null, latestEntered: r.latest_entered || null };
}

/** Answer the event. `stampTo` is the event's own observed_at (never now()), so
 *  an event that lands mid-pass is not silently swallowed by a later stamp. */
async function stampStatusWatermark(loanId, stampTo) {
  if (!stampTo) return;
  try {
    await db.query(
      `UPDATE lt_loans SET clickup_status_event_at = GREATEST($2::timestamptz, COALESCE(clickup_status_event_at, $2::timestamptz)),
              updated_at = now()
        WHERE id = $1::uuid`, [String(loanId), stampTo instanceof Date ? stampTo.toISOString() : String(stampTo)]);
  } catch (e) {
    // A watermark that fails to advance costs a repeated question next pass,
    // never a wrong write — so it may not fail the push that already landed.
    console.warn('[lt-clickup-push] status watermark not stamped:', (e && e.message) || e);
  }
}

/** Put a status disagreement in front of a person. The db/625 partial unique
 *  index dedupes one OPEN row per (task, field, proposal), so a pass that keeps
 *  finding the same disagreement refreshes rather than stacking questions. */
/** @returns {Promise<boolean>} whether the row actually landed — the caller
 *  consumes the milestone only if it did, or a failed INSERT would leave the
 *  event spent with nothing anywhere recording it. */
async function raiseStatusReview({ loanId, taskId, current, proposed, reason }) {
  try {
    await db.query(
      `INSERT INTO lt_clickup_review_queue (lt_loan_id, task_id, direction, field_key, current_value, proposed_value, reason)
       VALUES ($1::uuid, $2, 'outbound', '__status', $3, $4, $5)
       ON CONFLICT (task_id, field_key, direction, (COALESCE(proposed_value, ''))) WHERE status = 'open'
       DO UPDATE SET current_value = EXCLUDED.current_value, reason = EXCLUDED.reason`,
      [String(loanId), String(taskId), current || null, proposed || null, String(reason || '').slice(0, 500)]);
    return true;
  } catch (e) {
    console.warn('[lt-clickup-push] status review not raised:', (e && e.message) || e);
    return false;
  }
}

/** A disagreement that has RESOLVED closes its own rows. Without this the
 *  standing list grows one row per proposal the engine ever wanted and never
 *  shrinks — a screen showing the same file several times over, with proposals
 *  that stopped being true weeks ago. Resolved, never deleted: the row is the
 *  record that PILOT once disagreed, and somebody may want to see it. */
async function closeStatusReviews(taskId) {
  try {
    const { rowCount } = await db.query(
      `UPDATE lt_clickup_review_queue
          SET status = 'resolved', resolved_at = now()
        WHERE task_id = $1 AND field_key = '__status' AND direction = 'outbound' AND status = 'open'`,
      [String(taskId)]);
    return rowCount || 0;
  } catch (e) {
    console.warn('[lt-clickup-push] status reviews not closed:', (e && e.message) || e);
    return 0;
  }
}

function desiredStatusFor(bag, loan) {
  const liveAnswered = !!(bag.ex && ('CX.TABLEFUNDER' in bag.ex));
  const mirrorChannel = bag.investorChannel != null && String(bag.investorChannel).trim() !== '';
  return statusEngine.desiredStatus({
    ladder: bag.ladder,
    folder: loan.loan_folder,
    f1393: bag.ex && bag.ex['1393'],
    channelLabel: (liveAnswered || mirrorChannel)
      ? mapper._internals.channelLabel(liveAnswered ? bag.ex['CX.TABLEFUNDER'] : bag.investorChannel)
      : null,
  });
}

async function pushLoan(loanId, opts = {}) {
  await seedBreakerFromDb();
  if (!writer.configured()) return { ok: false, skipped: 'not_configured' };
  if (!writeEnabled() && !dryRun()) return { ok: false, skipped: 'off' };

  const { rows: loans } = await db.query(
    `SELECT l.*, ${trash.notTrashSql('l')} AS not_trash FROM lt_loans l WHERE l.id = $1::uuid`, [loanId]);
  const loan = loans[0];
  if (!loan) return { ok: false, skipped: 'no_such_loan' };
  if (!loan.not_trash) return { ok: false, skipped: 'trashed' };          // §10.18

  // G16 — a scoped push NEVER creates: an unlinked loan is reported, not carded.
  if (!loan.clickup_task_id) {
    return { ok: false, skipped: 'unlinked' };
  }
  if (loan.clickup_link_confidence && loan.clickup_link_confidence !== 'confirmed') {
    return { ok: false, skipped: 'link_not_confirmed' };                  // a probable card is not written
  }

  circuitCheck();

  // G17 — pre-read, fail CLOSED. The suppression + shields cannot evaluate blind.
  let before;
  try {
    before = await writer.getTask(loan.clickup_task_id, { includeSubtasks: true });
  } catch (e) {
    const err = new Error(`ClickUp pre-read failed for task ${loan.clickup_task_id}: ${(e && e.message) || e}`);
    err.code = 'CLICKUP_PREREAD_FAILED';
    err.retryable = true;
    throw err;
  }

  // §10.18 — never write to a card that is not a long-term card. The loan side
  // is definitively long-term (only LT files are mirrored) and the link is
  // CONFIRMED, so an unset *Program is an LT card missing its label (this push
  // fills it); a positively SHORT-TERM label refuses.
  const cls = program.classifyProgram(cardProgramLabel(before), {});
  if (cls.product === program.PRODUCT.SHORT) {
    // A DRY RUN journals nothing durable (pre-merge audit round 2, defect 2a):
    // the rehearsal reports the refusal in its result, and only a REAL pass
    // writes the blocked-write journal row.
    if (!dryRun()) {
      await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldKey: '__card', oldValue: cardProgramLabel(before), newValue: null, changed: false, blocked: true, source: opts.source || 'scoped_push' });
    }
    return { ok: false, skipped: 'short_term_card' };
  }

  const ex = await readExtras(loan.encompass_loan_guid);
  const bag = await loadBag(loanId, { ex });
  if (!bag) return { ok: false, skipped: 'no_such_loan' };

  // THE WATERMARK IS READ WITH THE BAG, NOT WITH THE DECISION (pre-merge audit
  // 2026-08-24). The bag is what `desiredStatus` answers from, and the event that
  // justifies that answer must be one the bag can already see. Reading
  // `latestEntered` later — after every field write, the subtask sync and a
  // getList — meant a milestone that landed DURING the push was consumed by the
  // stamp while the PREVIOUS milestone's status was the one written: the newer
  // move was then "already answered" and never pushed at all. Demonstrated, not
  // theorised. Binding both reads to this instant closes it: an event arriving
  // after this line is simply not seen, so it is still waiting on the next pass.
  let statusMark = null;
  try { statusMark = await readStatusWatermark(loanId); } catch (_) { statusMark = null; }

  const options = taskOptionsMap(before);
  let fields = mapper.buildTaskFields(bag, options);

  // A scoped push carries ONLY its own edit.
  const onlyIds = opts.only ? mapper.resolveOnly(opts.only) : null;
  if (onlyIds) fields = fields.filter((f) => onlyIds.has(f.id));

  // A SUBTASK-SCOPED push (a review approval on the co-borrower's subtask):
  // ONLY the subtask sync runs, for exactly the named co-borrower field keys.
  // The parent loop, the status assert and the pushed_at stamp are all skipped
  // — approving one blocked subtask field must not become a full repush with
  // the shield down everywhere.
  const subtaskKeys = opts.subtaskOnly
    ? new Set((Array.isArray(opts.subtaskOnly) ? opts.subtaskOnly : [opts.subtaskOnly]).map(String))
    : null;
  if (subtaskKeys) fields = [];

  const out = { ok: true, wrote: 0, suppressed: 0, blocked: 0, failed: [], plan: [] };
  let overwrites = 0;

  for (const f of fields) {
    const oldVal = taskFieldValue(before, f.id);

    // G18 — no-op suppression through the per-type equivalence.
    if (mapper.fieldValueEquivalent(f.id, oldVal, f.value, options, opts)) { out.suppressed++; continue; }

    const oldBlank = mapper.isBlankClickupValue(oldVal);

    // Locations are FILL-ONLY, always (the mapper's documented posture).
    if (LOCATION_FIELD_IDS.has(f.id) && !oldBlank) { out.suppressed++; continue; }

    // G21 — a sweep nobody asked for may only ADD.
    if (opts.fillOnly && !oldBlank) { out.suppressed++; continue; }

    // G20 — ANY change to an existing DOB is a human decision. A DRY RUN
    // reports the block in the plan and writes NOTHING (audit 2026-08-24: a
    // rehearsal was seeding real review-queue + journal rows).
    if (mapper.isDobChange(f.id, oldVal, f.value) && !opts.approvedReview) {
      out.blocked++;
      if (dryRun()) { out.plan.push({ field: f.name, key: f.key, wouldBlock: 'dob_change_blocked_pending_review' }); continue; }
      await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldId: f.id, fieldKey: f.key, oldValue: oldVal, newValue: f.value, changed: false, blocked: true, source: opts.source || 'scoped_push' });
      await queueReview({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldKey: mapper.PII_REVIEW_KEY[f.id] || f.key, currentValue: mapper.reviewPreview(f.id, oldVal), proposedValue: mapper.reviewPreview(f.id, f.value), reason: 'dob_change_blocked_pending_review' });
      continue;
    }

    // G19 — the PII overwrite shield: fill a blank, never rewrite a difference.
    if (mapper.PII_OVERWRITE_SHIELD[f.id] && !oldBlank && !opts.approvedReview) {
      out.blocked++;
      if (dryRun()) { out.plan.push({ field: f.name, key: f.key, wouldBlock: 'pii_overwrite_blocked' }); continue; }
      await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldId: f.id, fieldKey: f.key, oldValue: oldVal, newValue: f.value, changed: false, blocked: true, source: opts.source || 'scoped_push' });
      await queueReview({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldKey: mapper.PII_REVIEW_KEY[f.id] || f.key, currentValue: mapper.reviewPreview(f.id, oldVal), proposedValue: mapper.reviewPreview(f.id, f.value), reason: 'pii_overwrite_blocked' });
      continue;
    }

    if (!oldBlank) overwrites++;

    // DRYRUN wins over the write switch — a rehearsal never sends.
    if (dryRun()) {
      out.plan.push({ field: f.name, key: f.key, wouldWrite: mapper.reviewPreview(f.id, typeof f.value === 'object' ? JSON.stringify(f.value) : f.value) });
      continue;
    }

    circuitCheck();
    try {
      await writer.setField(loan.clickup_task_id, f.id, f.value);
      countWrite();
      out.wrote++;
      await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldId: f.id, fieldKey: f.key, oldValue: oldVal, newValue: f.value, changed: true, blocked: false, source: opts.source || 'scoped_push' });
    } catch (e) {
      // G23 — a lossy push is never marked done. PII-free accounting.
      out.failed.push({ fieldId: f.id, key: f.key, status: e && e.status, code: e && e.code, retryable: !!(e && e.retryable), message: String((e && e.message) || e).slice(0, 160) });
      await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldId: f.id, fieldKey: f.key, oldValue: oldVal, newValue: f.value, changed: false, blocked: true, source: opts.source || 'scoped_push' });
    }
  }

  // THE CO-BORROWER SUBTASK (#40, owner-directed): a file with a co-borrower
  // carries their own SUBTASK under the loan card — the second borrower's
  // personal + contact fields, on the same field ids the primary uses (the
  // shield + DOB gate key on those ids, so the co-borrower's identity gets the
  // same protection). Found by NAME on every push (stateless + idempotent) and
  // created once when missing. Full pushes only.
  if ((subtaskKeys || !onlyIds) && bag.coborrower) {
    try {
      await syncCoBorrowerSubtask({ loanId, loan, bag, before, options, out, opts, subtaskKeys });
    } catch (e) {
      console.warn('[lt-clickup-push] co-borrower subtask sync skipped:', (e && e.message) || e);
    }
  }

  // THE STATUS (#39 as CORRECTED by the owner on 2026-08-24). The card's status
  // follows a milestone FIRING — it is never re-asserted to reconcile a card.
  // The rule, and the reason the old one was wrong, live in status-push.js;
  // everything here is the IO half. A SCOPED push (a review approval re-pushing
  // one field) deliberately does not touch status.
  if (!onlyIds && !subtaskKeys) {
    try {
      const desired = desiredStatusFor(bag, loan);
      const current = String((before.status && before.status.status) || '').trim();

      const watermark = statusMark && statusMark.watermark;
      const latestEntered = statusMark && statusMark.latestEntered;

      // THE LIST IS READ ONLY WHEN THE DECISION CAN ACTUALLY NEED IT. Reading it
      // up front cost a ClickUp GET on EVERY full push — including dry runs and
      // the agree/baseline/none cases, which return before touching the order —
      // five wasted reads a pass against a shared budget, forever.
      let listRead = false;
      let names = null;
      const readList = async () => {
        if (listRead) return names;
        listRead = true;
        try {
          const listId = before.list && before.list.id;
          const listInfo = listId ? await writer.getList(listId) : null;
          const sts = (listInfo && listInfo.statuses) || null;
          if (!Array.isArray(sts) || !sts.length) return (names = null);
          // AN UNUSABLE `orderindex` MAKES THE ORDER UNKNOWN, NEVER RANK 0
          // (pre-merge audit 2026-08-24). `Number(undefined) || 0` and
          // `Number('abc') || 0` both collapse to 0, which pulls that status to
          // the FRONT of the ladder; sort is stable, so everything else keeps its
          // place and nothing signals a thing. Demonstrated: with one status
          // missing its orderindex, a move the true order calls BACKWARDS was
          // written. This module's own posture is that an unprovable direction is
          // treated as backwards, so an order we cannot trust must be no order.
          const usable = sts.every((st) => Number.isFinite(Number(st && st.orderindex)));
          if (!usable) return (names = null);
          names = sts.slice()
            .sort((a, b) => Number(a.orderindex) - Number(b.orderindex))
            .map((st) => String(st.status || ''));
        } catch (_) { names = null; }
        return names;
      };

      // Peek with no order first; only a decision that turns on DIRECTION pays
      // for the read, and it is then re-decided with the real order.
      let d = statusPush.decideStatusPush({
        desired, current, watermark, latestEntered, statusOrder: null, now: new Date(),
      });
      if (d.act === 'review' || d.act === 'push') {
        await readList();
        d = statusPush.decideStatusPush({
          desired, current, watermark, latestEntered, statusOrder: names, now: new Date(),
        });
      }
      out.statusDecision = { act: d.act, reason: d.reason };

      if (d.act === 'push') {
        // Statuses are LIST-level: a status the list does not carry is SKIPPED
        // and journaled, never invented (the §4.3 discipline).
        const exact = (names || []).find((n) => n.trim().toLowerCase() === String(d.to).toLowerCase()) || null;
        if (dryRun()) {
          out.plan.push({ field: '__status', wouldWrite: d.to, reason: d.reason });
        } else if (!exact) {
          // A PUSH THAT COULD NOT LAND STILL GETS A PERSON (pre-merge audit
          // 2026-08-24). This branch consumes the event, so without a review row
          // the milestone would vanish with nothing in front of anybody — every
          // OTHER refusal raises one. It is reachable in two ways that read very
          // differently, so the reason must not claim more than we know: the list
          // genuinely lacks the status, or the list could not be read at all
          // (`names` null — a transient getList failure), which for a BACKWARD_OK
          // status skips the direction test and arrives straight here.
          const couldNotRead = !Array.isArray(names) || !names.length;
          out.statusSkipped = { wanted: d.to, reason: couldNotRead ? 'status_list_unreadable' : 'status_not_on_list' };
          await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldKey: '__status', oldValue: current, newValue: d.to, changed: false, blocked: true, source: opts.source || 'full_repush' });
          const raised = await raiseStatusReview({
            loanId,
            taskId: loan.clickup_task_id,
            current,
            proposed: d.to,
            reason: couldNotRead
              ? `a milestone fired wanting "${d.to}", but PILOT could not read the card's ClickUp list to write it`
              : `a milestone fired wanting "${d.to}", but that status is not on the card's ClickUp list — PILOT never invents one`,
          });
          // WHICH OF THE TWO DECIDES WHETHER THE EVENT IS SPENT. A list we could
          // not READ is transient — a 502 on GET /list turns the owner's one
          // carve-out (reassigning a processor) into a permanent no-op if we
          // consume the milestone for it — so the event survives for the next
          // pass, exactly as a failed write does. A status genuinely NOT ON the
          // list is a configuration problem that will not fix itself on a retry,
          // so that one is answered by raising it and consumed. And if the review
          // row itself failed to land, nothing anywhere records the milestone, so
          // it is never consumed.
          if (couldNotRead || !raised) d.stamp = false;
        } else {
          circuitCheck();
          try {
            await writer.updateTask(loan.clickup_task_id, { status: exact });
            countWrite();
            out.statusWrote = { from: current, to: exact, reason: d.reason };
            await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldKey: '__status', oldValue: current, newValue: exact, changed: true, blocked: false, source: opts.source || 'full_repush' });
            // The card now holds what the ladder implies, so any question this
            // loan was asking is answered and leaves the list.
            const closed = await closeStatusReviews(loan.clickup_task_id);
            if (closed) out.statusReviewsClosed = closed;
          } catch (e) {
            out.failed.push({ key: '__status', status: e && e.status, code: e && e.code, retryable: !!(e && e.retryable), message: String((e && e.message) || e).slice(0, 160) });
            await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldKey: '__status', oldValue: current, newValue: exact, changed: false, blocked: true, source: opts.source || 'full_repush' });
            // The event is NOT consumed when the write failed — the next pass
            // must be free to try again, or one ClickUp blip would swallow a
            // real milestone permanently.
            d.stamp = false;
          }
        }
      } else if (d.act === 'review') {
        out.statusReview = { current: d.current, proposed: d.proposed, reason: d.reason };
        // A status the LIST does not carry keeps its own distinct report — it is
        // somebody adding a status in ClickUp, not a workflow judgement — and it
        // is journaled as a blocked write exactly as it always was.
        if (d.notOnList) {
          out.statusSkipped = { wanted: d.proposed, reason: 'status_not_on_list' };
          if (!dryRun()) await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldKey: '__status', oldValue: d.current, newValue: d.proposed, changed: false, blocked: true, source: opts.source || 'full_repush' });
        }
        if (!dryRun()) {
          const raised = await raiseStatusReview({ loanId, taskId: loan.clickup_task_id, current: d.current, proposed: d.proposed, reason: d.reason });
          // Same rule as the push branch: a milestone is only ever answered by a
          // row that actually landed.
          if (!raised) d.stamp = false;
        }
      } else if (d.act === 'agree' && !dryRun()) {
        // THE DISAGREEMENT IS OVER — close its rows. Whether the card caught up
        // by itself, somebody set it by hand, or Encompass moved to meet it, the
        // question this loan was raising is answered and must leave the list.
        const closed = await closeStatusReviews(loan.clickup_task_id);
        if (closed) out.statusReviewsClosed = closed;
      }

      // A DRY RUN never moves the watermark — a rehearsal that consumed the
      // event would make the real pass skip the very milestone it was proving.
      if (d.stamp && !dryRun()) await stampStatusWatermark(loanId, d.stampTo);
    } catch (e) {
      // The engine claiming nothing (or a broken read) must never fail the
      // field push that already landed.
      console.warn('[lt-clickup-push] status step skipped:', (e && e.message) || e);
    }
  }

  // G25 — the overwrite-storm alarm: loud, never blocking.
  if (overwrites > 10) {
    console.warn(`[lt-clickup-push] OVERWRITE STORM on task ${loan.clickup_task_id}: ${overwrites} existing values rewritten in one push — check the mirror before trusting this.`);
  }

  if (out.failed.length) {
    const allTransient = out.failed.every((f) => f.retryable);
    const e = new Error(`ClickUp push wrote ${out.wrote} of ${out.wrote + out.failed.length} fields on task ${loan.clickup_task_id}.`);
    e.code = 'CLICKUP_FIELD_WRITES_FAILED';
    e.retryable = allTransient;
    e.failed = out.failed;
    throw e;
  }

  // A dry run never stamps — the drain must keep offering the loan until a
  // REAL clean push lands. Neither does a SCOPED push (audit 2026-08-24, obs 3):
  // clickup_pushed_at means "the whole card was synced", and a one-field review
  // approval stamping it would drain the loan out of the refresh queue with the
  // rest of its mirror movement unpushed.
  if (!dryRun() && !onlyIds && !subtaskKeys) {
    await db.query(
      `UPDATE lt_loans SET clickup_pushed_at = now(), clickup_push_error = NULL, updated_at = now()
        WHERE id = $1::uuid`, [loanId]);
  }
  return out;
}

/** The co-borrower's profile subtask: find by name, create once, then push
 *  the co fields with the SAME per-field guards a primary field gets. */
async function syncCoBorrowerSubtask({ loanId, loan, bag, before, options, out, opts, subtaskKeys = null }) {
  const coName = [bag.coborrower.first_name, bag.coborrower.middle_name, bag.coborrower.last_name, bag.coborrower.name_suffix]
    .filter(Boolean).join(' ').trim();
  if (!coName || T.isPlaceholderName(coName)) return;
  let coFields = mapper.buildCoBorrowerFields(bag, options);
  // A subtask-SCOPED push carries only its own approved keys.
  if (subtaskKeys) coFields = coFields.filter((f) => subtaskKeys.has(f.key));
  if (!coFields.length) return;

  const subtasks = Array.isArray(before.subtasks) ? before.subtasks : [];
  const existing = subtasks.find((st) => {
    try { return mapper._internals.sameNameLoose(String(st.name || ''), coName); } catch (_) { return false; }
  });

  if (!existing) {
    // A scoped approval NEVER creates (G16's spirit): the review was raised on
    // an existing subtask; with the subtask gone there is nothing to approve.
    if (subtaskKeys) { out.subtaskSkipped = 'subtask_missing'; return; }
    if (dryRun()) { out.plan.push({ field: '__co_subtask', wouldWrite: `create subtask "${coName}" with ${coFields.length} fields` }); return; }
    circuitCheck();
    const listId = before.list && before.list.id;
    if (!listId) return;
    const made = await writer.createTask(listId, {
      name: coName,
      parent: String(loan.clickup_task_id),
      custom_fields: coFields.map((f) => ({ id: f.id, value: f.value })),
    });
    countWrite();
    const subId = made && made.id ? String(made.id) : null;
    out.coSubtaskCreated = subId;
    for (const f of coFields) {
      await journalFieldWrite({ ltLoanId: loanId, taskId: subId || 'co-subtask', fieldId: f.id, fieldKey: f.key, oldValue: undefined, newValue: f.value, changed: true, blocked: false, source: 'create' });
    }
    return;
  }

  // The subtask exists — pre-read it and push the co fields under the SAME
  // guards (equivalence, the PII fill-only shield, the DOB gate).
  let subBefore;
  try {
    subBefore = await writer.getTask(existing.id);
  } catch (_) {
    // An unreadable subtask waits for the next pass — never written blind. It is
    // reported DISTINCTLY from a missing one (audit round 3, O12): both correctly
    // leave an approval unresolved, but "we could not read it" and "it is gone"
    // send a person to two different places.
    out.subtaskSkipped = 'subtask_unreadable';
    return;
  }
  for (const f of coFields) {
    const oldVal = taskFieldValue(subBefore, f.id);
    if (mapper.fieldValueEquivalent(f.id, oldVal, f.value, options, opts)) { out.suppressed++; continue; }
    const oldBlank = mapper.isBlankClickupValue(oldVal);
    if (mapper.isDobChange(f.id, oldVal, f.value) && !opts.approvedReview) {
      out.blocked++;
      if (dryRun()) { out.plan.push({ field: `${f.name} [subtask]`, key: f.key, wouldBlock: 'dob_change_blocked_pending_review' }); continue; }
      await journalFieldWrite({ ltLoanId: loanId, taskId: existing.id, fieldId: f.id, fieldKey: f.key, oldValue: oldVal, newValue: f.value, changed: false, blocked: true, source: opts.source || 'full_repush' });
      await queueReview({ ltLoanId: loanId, taskId: existing.id, fieldKey: f.key, currentValue: mapper.reviewPreview(f.id, oldVal), proposedValue: mapper.reviewPreview(f.id, f.value), reason: 'dob_change_blocked_pending_review' });
      continue;
    }
    if (mapper.PII_OVERWRITE_SHIELD[f.id] && !oldBlank && !opts.approvedReview) {
      out.blocked++;
      if (dryRun()) { out.plan.push({ field: `${f.name} [subtask]`, key: f.key, wouldBlock: 'pii_overwrite_blocked' }); continue; }
      await journalFieldWrite({ ltLoanId: loanId, taskId: existing.id, fieldId: f.id, fieldKey: f.key, oldValue: oldVal, newValue: f.value, changed: false, blocked: true, source: opts.source || 'full_repush' });
      await queueReview({ ltLoanId: loanId, taskId: existing.id, fieldKey: f.key, currentValue: mapper.reviewPreview(f.id, oldVal), proposedValue: mapper.reviewPreview(f.id, f.value), reason: 'pii_overwrite_blocked' });
      continue;
    }
    if (dryRun()) { out.plan.push({ field: `${f.name} [subtask]`, key: f.key, wouldWrite: mapper.reviewPreview(f.id, f.value) }); continue; }
    circuitCheck();
    try {
      await writer.setField(existing.id, f.id, f.value);
      countWrite();
      out.wrote++;
      await journalFieldWrite({ ltLoanId: loanId, taskId: existing.id, fieldId: f.id, fieldKey: f.key, oldValue: oldVal, newValue: f.value, changed: true, blocked: false, source: opts.source || 'full_repush' });
    } catch (e) {
      out.failed.push({ fieldId: f.id, key: f.key, status: e && e.status, code: e && e.code, retryable: !!(e && e.retryable), message: String((e && e.message) || e).slice(0, 160) });
      await journalFieldWrite({ ltLoanId: loanId, taskId: existing.id, fieldId: f.id, fieldKey: f.key, oldValue: oldVal, newValue: f.value, changed: false, blocked: true, source: opts.source || 'full_repush' });
    }
  }
}

// ── THE CREATE: a brand-new Encompass file gets its card (§7) ────────────────
async function firstListId(folderId) {
  const out = await writer.getFolderLists(folderId);
  const lists = (out && out.lists) || [];
  return lists.length ? String(lists[0].id) : null;
}

async function createForLoan(loanId) {
  await seedBreakerFromDb();
  if (!writer.configured()) return { ok: false, skipped: 'not_configured' };
  if (!writeEnabled() && !dryRun()) return { ok: false, skipped: 'off' };

  const { rows: loans } = await db.query(
    `SELECT l.*, ${trash.notTrashSql('l')} AS not_trash FROM lt_loans l WHERE l.id = $1::uuid`, [loanId]);
  const loan = loans[0];
  if (!loan) return { ok: false, skipped: 'no_such_loan' };
  if (!loan.not_trash) return { ok: false, skipped: 'trashed' };
  if (loan.clickup_task_id) return { ok: false, skipped: 'already_linked' };
  if (T.isPlaceholderLoanNumber(loan.loan_number)) return { ok: false, skipped: 'placeholder_loan_number' };

  const ex = await readExtras(loan.encompass_loan_guid);
  const bag = await loadBag(loanId, { ex, forCreate: true });

  const officerName = bag.officer && bag.officer.name;
  let folder = ltRouting.folderForOfficer(officerName);
  if (!folder && bag.officer && bag.officer.email) {
    const entry = staffTableEntryByEmail(bag.officer.email);
    if (entry && entry.pipeline) folder = { pipeline: String(entry.pipeline) };
  }
  // null ⇒ DO NOT CREATE (LT routing's contract): a card in a guessed folder is
  // a file the office cannot find. Reported, never silent.
  if (!folder) return { ok: false, skipped: 'no_officer_folder', officer: officerName || null };

  const borrowerName = String(loan.borrower_name || '').trim();
  if (!borrowerName || T.isPlaceholderName(borrowerName)) return { ok: false, skipped: 'no_borrower_name' };
  const addr = [bag.prop.street, bag.prop.city].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
  const name = addr ? `${borrowerName} - ${addr}` : borrowerName;

  circuitCheck();

  const listId = await firstListId(folder.pipeline);
  if (!listId) return { ok: false, skipped: 'no_list_in_folder', folder: folder.pipeline };

  const options = await registry.optionMap(listId);
  const fields = mapper.buildTaskFields(bag, options);
  const custom_fields = fields.map((f) => ({ id: f.id, value: f.value }));

  // DRYRUN wins over the write switch — a rehearsal never creates.
  if (dryRun()) {
    return { ok: true, dryRun: true, wouldCreate: { name, listId, fields: fields.map((f) => f.key) } };
  }

  // Status omitted — ClickUp assigns the list's first status ('starting' on
  // the officer lists), which is the owner's create-at-starting rule (§7.4).
  const created = await writer.createTask(listId, { name, custom_fields });
  countWrite();
  const taskId = created && created.id ? String(created.id) : null;
  if (!taskId) {
    const e = new Error('ClickUp createTask answered without a task id.');
    e.retryable = false;
    throw e;
  }
  for (const f of fields) {
    await journalFieldWrite({ ltLoanId: loanId, taskId, fieldId: f.id, fieldKey: f.key, oldValue: undefined, newValue: f.value, changed: true, blocked: false, source: 'create' });
  }

  // Post-create linking — atomic + race-safe (WHERE clickup_task_id IS NULL);
  // the db/618 partial unique index turns a race into a per-row refusal.
  const url = created.url ? String(created.url) : null;
  const customId = created.custom_id ? String(created.custom_id) : null;
  let linked = false;
  try {
    const { rowCount } = await db.query(
      `UPDATE lt_loans
          SET clickup_task_id = $2, clickup_custom_id = $3, clickup_url = $4,
              clickup_linked_at = now(), clickup_link_source = 'created',
              clickup_link_confidence = 'confirmed', clickup_stamped_at = now(),
              clickup_stamp_error = NULL, clickup_pushed_at = now(), clickup_push_error = NULL,
              updated_at = now()
        WHERE id = $1::uuid AND clickup_task_id IS NULL`,
      [loanId, taskId, customId, url]);
    linked = rowCount > 0;
  } catch (e) {
    console.warn('[lt-clickup-push] created task but the link write failed:', (e && e.message) || e);
  }
  try {
    await db.query(
      `INSERT INTO lt_clickup_link_log (id, lt_loan_id, action, to_task_id, confidence, source, reason)
       VALUES (gen_random_uuid(), $1::uuid, 'created', $2, 'confirmed', 'writer', $3)`,
      [loanId, taskId, `card created in folder ${folder.pipeline} for ${officerName || 'unknown officer'}`]);
  } catch (_) { /* trail is best-effort */ }

  // A CARD PILOT JUST MINTED STARTS WHERE THE LOAN IS (pre-merge audit
  // 2026-08-24). The card opens at the list's FIRST status, and the event-driven
  // rule would then leave it there: the first push finds a NULL watermark and
  // baselines, and every push after that finds no NEWER milestone event, because
  // the loan's own history predates the card. A late-stage loan given a card by
  // the admin "Create New Task" button would sit at "starting" until its next
  // milestone fired — which may be never.
  //
  // The owner's rule protects a team's own work on a card ("a team that had moved
  // a card forward watched PILOT move it back"). There is no such work on a card
  // that did not exist a second ago, so this ONE write is not a reconcile — it is
  // the card's opening position. The watermark is taken in the same breath, so
  // nothing further is written until a real milestone fires.
  try {
    // The bag this create was built from — re-loading it would be a second read
    // of the same loan and could answer differently mid-create.
    const want = bag ? desiredStatusFor(bag, { ...loan, clickup_task_id: taskId }) : null;
    if (want && want.status && !dryRun()) {
      const listInfo = await writer.getList(listId);
      const names = ((listInfo && listInfo.statuses) || []).map((st) => String(st.status || ''));
      const exact = names.find((n) => n.trim().toLowerCase() === String(want.status).toLowerCase()) || null;
      const opened = String((listInfo && listInfo.statuses && listInfo.statuses[0] && listInfo.statuses[0].status) || '').trim();
      if (exact && exact.toLowerCase() !== opened.toLowerCase()) {
        circuitCheck();
        await writer.updateTask(taskId, { status: exact });
        countWrite();
        await journalFieldWrite({ ltLoanId: loanId, taskId, fieldKey: '__status', oldValue: opened || null, newValue: exact, changed: true, blocked: false, source: 'create' });
      }
    }
  } catch (e) {
    // The card exists and its fields landed; an opening status that could not be
    // set must never turn a successful create into a failure — but it must not
    // vanish either, so it is raised for a person (pre-merge audit 2026-08-24:
    // the first cut let the throw skip past the stamp, which left the watermark
    // NULL, sent the next push through the baseline branch, and lost the opening
    // status permanently — the exact failure this block was written to prevent).
    console.warn('[lt-clickup-push] opening status not set on the new card:', (e && e.message) || e);
    if (!dryRun()) {
      await raiseStatusReview({
        loanId,
        taskId,
        current: null,
        proposed: null,
        reason: `the card was created, but PILOT could not set its opening status: ${String((e && e.message) || e).slice(0, 200)}`,
      });
    }
  }

  // TAKEN ON EVERY PATH, INCLUDING THE FAILED ONE, AND DELIBERATELY OUTSIDE THE
  // TRY. A NULL watermark sends the next push through the baseline branch, which
  // writes nothing and takes the watermark anyway — so leaving it NULL here does
  // not buy a retry, it just loses the opening status quietly one pass later.
  try { if (!dryRun()) await stampStatusWatermark(loanId, new Date()); } catch (_) { /* best-effort */ }

  return { ok: true, created: true, taskId, listId, linked, fields: fields.length };
}

// ── The worker passes ────────────────────────────────────────────────────────
/** Linked, confirmed loans whose mirror moved since the last push. */
async function pushPass({ limit } = {}) {
  if (!writer.configured()) return { ok: true, skipped: 'not_configured' };
  if (!writeEnabled() && !dryRun()) return { ok: true, skipped: 'off' };
  const cap = Math.max(1, parseInt(process.env.LT_CLICKUP_PUSH_PER_PASS || String(limit || 5), 10) || 5);
  // A LOAN WITH A RECORDED PROBLEM SORTS LAST (pre-merge audit 2026-08-24,
  // defect 3). `NULLS FIRST` alone let a handful of never-pushable heads (a
  // deleted card, a short-term-classified card — pushed_at stays NULL forever)
  // occupy the whole cap every pass and starve every healthy refresh behind
  // them. clickup_push_error is the durable "this one has a problem" stamp:
  // healthy loans always outrank stamped ones, stamped ones still retry when
  // no healthy work remains, and a clean full push clears the stamp.
  const { rows } = await db.query(
    `SELECT l.id FROM lt_loans l
      WHERE l.clickup_task_id IS NOT NULL
        AND COALESCE(l.clickup_link_confidence, 'confirmed') = 'confirmed'
        AND ${trash.notTrashSql('l')}
        AND (l.clickup_pushed_at IS NULL OR l.encompass_synced_at > l.clickup_pushed_at)
      ORDER BY (l.clickup_push_error IS NOT NULL) ASC, l.clickup_pushed_at ASC NULLS FIRST, l.encompass_last_modified DESC
      LIMIT $1`, [cap]);
  const out = { ok: true, considered: rows.length, pushed: 0, problems: [] };
  for (const r of rows) {
    try {
      const res = await pushLoan(r.id, { source: 'full_repush' });
      if (res && res.ok) out.pushed++;
      else if (res && res.skipped) {
        out.problems.push({ loanId: r.id, skipped: res.skipped });
        // A PER-LOAN refusal (a short-term card, a link that lost its
        // confidence) is stamped so the loan sinks behind healthy work — a
        // GLOBAL stand-down (off / not_configured cannot reach here; pushLoan
        // answers those before the loan is read) never is. A DRY RUN stamps
        // nothing (audit round 2, defect 2b): a rehearsal must not reorder
        // the REAL queue — its skips live in this pass result alone.
        if (!dryRun() && res.skipped !== 'off' && res.skipped !== 'not_configured') {
          try {
            await db.query('UPDATE lt_loans SET clickup_push_error = $2, updated_at = now() WHERE id = $1::uuid',
              [r.id, `push skipped: ${res.skipped}`]);
          } catch (_) { /* best-effort */ }
        }
      }
    } catch (e) {
      out.problems.push({ loanId: r.id, error: String((e && e.message) || e).slice(0, 200), retryable: !!(e && e.retryable) });
      // A GLOBAL STAND-DOWN IS NOT THIS LOAN'S PROBLEM (audit round 3, O9). The
      // breaker is open for the whole writer, so stamping the loan it happened to
      // reach demotes a perfectly healthy file into the stamped cohort and sinks
      // it behind every real problem — the same reasoning the `skipped` branch
      // above already applies to 'off' and 'not_configured'.
      if (!dryRun() && !(e && e.code === 'CLICKUP_CIRCUIT_OPEN')) {
        try {
          await db.query('UPDATE lt_loans SET clickup_push_error = $2, updated_at = now() WHERE id = $1::uuid',
            [r.id, String((e && e.message) || e).slice(0, 500)]);
        } catch (_) { /* best-effort */ }
      }
      if (e && e.code === 'CLICKUP_CIRCUIT_OPEN') break;   // the window has to drain — stop the pass
    }
  }
  if (!rows.length) out.note = 'nothing to push';
  return out;
}

/** Brand-new files (discovered after the go-live day) that still have no card. */
async function createPass({ limit } = {}) {
  if (!writer.configured()) return { ok: true, skipped: 'not_configured' };
  if (!writeEnabled() && !dryRun()) return { ok: true, skipped: 'off' };
  const cap = Math.max(1, parseInt(process.env.LT_CLICKUP_CREATE_PER_PASS || String(limit || 2), 10) || 2);
  // NO HEAD-OF-LINE STARVATION (pre-merge audit 2026-08-24, defect 2). The old
  // shape — LIMIT cap, oldest first, nothing stamped on a skip — meant two
  // permanently-unskippable heads (an officer with no folder, a placeholder
  // borrower) re-selected forever and no newer file EVER got a card. Now:
  //  · loans with a recorded problem sort LAST (fresh files always come first),
  //  · a SKIP is stamped onto clickup_push_error so it sinks on the next pass,
  //  · the SCAN window is wider than the create budget, and skips do not spend
  //    it — but the scan itself is bounded (each attempt costs an Encompass
  //    read), so a pass can never fan out unbounded.
  const scan = Math.max(cap, 10);
  const maxAttempts = Math.max(cap * 3, 6);
  // THE STAMPED COHORT ROTATES (pre-merge audit round 2, defect 1). Ordering
  // the stamped loans by static created_at let >=maxAttempts permanently-
  // skipping older heads spend the whole attempt budget every pass, so a
  // stamped loan whose problem was later FIXED was never attempted again —
  // deterministically, forever. Every skip/error stamp touches updated_at, so
  // ordering the stamped cohort by updated_at ASC makes each pass take the
  // least-recently-ATTEMPTED loans first: attempted heads sink, and every
  // stamped loan comes round within ceil(cohort/attempts) passes. Fresh
  // (unstamped) loans still come first, oldest first, exactly as before.
  const { rows } = await db.query(
    `SELECT l.id FROM lt_loans l
      WHERE l.clickup_task_id IS NULL
        AND ${trash.notTrashSql('l')}
        AND l.created_at >= $2::date
        AND l.loan_number IS NOT NULL AND l.loan_number <> ''
        AND l.encompass_synced_at IS NOT NULL
      ORDER BY (l.clickup_push_error IS NOT NULL) ASC,
               (CASE WHEN l.clickup_push_error IS NOT NULL THEN l.updated_at END) ASC,
               l.created_at ASC
      LIMIT $1`, [scan, createSince()]);
  const out = { ok: true, considered: rows.length, created: 0, skipped: [], problems: [] };
  let attempts = 0;
  for (const r of rows) {
    if (out.created >= cap || attempts >= maxAttempts) break;
    attempts++;
    try {
      const res = await createForLoan(r.id);
      if (res && res.created) out.created++;
      else if (res && res.skipped) {
        out.skipped.push({ loanId: r.id, reason: res.skipped });
        // Stamp PER-LOAN reasons so this loan stops blocking the queue head; a
        // global stand-down ('off') must never sink every loan at once. The
        // stamp is advisory ordering only — the loan is still selected (last,
        // rotating) and retried, and a successful create clears it below. A
        // DRY RUN stamps nothing (audit round 2, defect 2b): a rehearsal must
        // not reorder the REAL queue.
        if (!dryRun() && res.skipped !== 'off' && res.skipped !== 'not_configured') {
          try {
            await db.query('UPDATE lt_loans SET clickup_push_error = $2, updated_at = now() WHERE id = $1::uuid',
              [r.id, `create skipped: ${res.skipped}`]);
          } catch (_) { /* best-effort */ }
        }
      }
    } catch (e) {
      out.problems.push({ loanId: r.id, error: String((e && e.message) || e).slice(0, 200) });
      // A GLOBAL STAND-DOWN IS NOT THIS LOAN'S PROBLEM (audit round 3, O9). The
      // breaker is open for the whole writer, so stamping the loan it happened to
      // reach demotes a perfectly healthy file into the stamped cohort and sinks
      // it behind every real problem — the same reasoning the `skipped` branch
      // above already applies to 'off' and 'not_configured'.
      if (!dryRun() && !(e && e.code === 'CLICKUP_CIRCUIT_OPEN')) {
        try {
          await db.query('UPDATE lt_loans SET clickup_push_error = $2, updated_at = now() WHERE id = $1::uuid',
            [r.id, String((e && e.message) || e).slice(0, 500)]);
        } catch (_) { /* best-effort */ }
      }
      if (e && e.code === 'CLICKUP_CIRCUIT_OPEN') break;
    }
  }
  if (!rows.length) out.note = 'no new files awaiting a card';
  return out;
}

module.exports = {
  pushLoan, createForLoan, pushPass, createPass, desiredStatusFor,
  writeEnabled, dryRun, createSince,
  _internals: {
    readStatusWatermark, stampStatusWatermark, raiseStatusReview, closeStatusReviews,
    circuitCheck, countWrite, seedBreakerFromDb, breakerLimit,
    journalFieldWrite, queueReview, resolvePerson, providerTextSafe, geoFor,
    loadBag, readExtras, cardProgramLabel, taskFieldValue, taskOptionsMap,
    staffTableEntryByEmail,
    _resetBreaker: () => { _writeTimes = []; _breakerSeeded = true; },
    _unseed: () => { _writeTimes = []; _breakerSeeded = false; },
    _windowSize: () => _writeTimes.length,
    _seedWrites: (times) => { _writeTimes = times.slice(); _breakerSeeded = true; },
  },
};
