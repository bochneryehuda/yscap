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
const link = require('./link');
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

  let investorLoanNumber = null; let investorName = null;
  try {
    const { rows: inv } = await db.query(
      `SELECT investor_loan_number, COALESCE(accurate_name, shorthand_name) AS investor_name
         FROM lt_loan_investors WHERE loan_id = $1::uuid`, [loanId]);
    if (inv[0]) { investorLoanNumber = inv[0].investor_loan_number; investorName = inv[0].investor_name; }
  } catch (_) { /* optional table */ }

  const appUrl = String(process.env.APP_URL || 'https://yscap.onrender.com').replace(/\/$/, '');
  const bag = {
    loan, prop, borrower, coborrower, residence, priorResidence,
    ex: ex || {},
    officer, processor,
    investorLoanNumber, investorName,
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
    before = await writer.getTask(loan.clickup_task_id);
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
    await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldKey: '__card', oldValue: cardProgramLabel(before), newValue: null, changed: false, blocked: true, source: opts.source || 'scoped_push' });
    return { ok: false, skipped: 'short_term_card' };
  }

  const ex = await readExtras(loan.encompass_loan_guid);
  const bag = await loadBag(loanId, { ex });
  if (!bag) return { ok: false, skipped: 'no_such_loan' };

  const options = taskOptionsMap(before);
  let fields = mapper.buildTaskFields(bag, options);

  // A scoped push carries ONLY its own edit.
  const onlyIds = opts.only ? mapper.resolveOnly(opts.only) : null;
  if (onlyIds) fields = fields.filter((f) => onlyIds.has(f.id));

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

    // G20 — ANY change to an existing DOB is a human decision.
    if (mapper.isDobChange(f.id, oldVal, f.value) && !opts.approvedReview) {
      out.blocked++;
      await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldId: f.id, fieldKey: f.key, oldValue: oldVal, newValue: f.value, changed: false, blocked: true, source: opts.source || 'scoped_push' });
      await queueReview({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldKey: mapper.PII_REVIEW_KEY[f.id] || f.key, currentValue: mapper.reviewPreview(f.id, oldVal), proposedValue: mapper.reviewPreview(f.id, f.value), reason: 'dob_change_blocked_pending_review' });
      continue;
    }

    // G19 — the PII overwrite shield: fill a blank, never rewrite a difference.
    if (mapper.PII_OVERWRITE_SHIELD[f.id] && !oldBlank && !opts.approvedReview) {
      out.blocked++;
      await journalFieldWrite({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldId: f.id, fieldKey: f.key, oldValue: oldVal, newValue: f.value, changed: false, blocked: true, source: opts.source || 'scoped_push' });
      await queueReview({ ltLoanId: loanId, taskId: loan.clickup_task_id, fieldKey: mapper.PII_REVIEW_KEY[f.id] || f.key, currentValue: mapper.reviewPreview(f.id, oldVal), proposedValue: mapper.reviewPreview(f.id, f.value), reason: 'pii_overwrite_blocked' });
      continue;
    }

    if (!oldBlank) overwrites++;

    if (dryRun() && !writeEnabled()) {
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

  if (!dryRun() || writeEnabled()) {
    await db.query(
      `UPDATE lt_loans SET clickup_pushed_at = now(), clickup_push_error = NULL, updated_at = now()
        WHERE id = $1::uuid`, [loanId]);
  }
  return out;
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

  if (dryRun() && !writeEnabled()) {
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

  return { ok: true, created: true, taskId, listId, linked, fields: fields.length };
}

// ── The worker passes ────────────────────────────────────────────────────────
/** Linked, confirmed loans whose mirror moved since the last push. */
async function pushPass({ limit } = {}) {
  if (!writer.configured()) return { ok: true, skipped: 'not_configured' };
  if (!writeEnabled() && !dryRun()) return { ok: true, skipped: 'off' };
  const cap = Math.max(1, parseInt(process.env.LT_CLICKUP_PUSH_PER_PASS || String(limit || 5), 10) || 5);
  const { rows } = await db.query(
    `SELECT l.id FROM lt_loans l
      WHERE l.clickup_task_id IS NOT NULL
        AND COALESCE(l.clickup_link_confidence, 'confirmed') = 'confirmed'
        AND ${trash.notTrashSql('l')}
        AND (l.clickup_pushed_at IS NULL OR l.encompass_synced_at > l.clickup_pushed_at)
      ORDER BY l.clickup_pushed_at ASC NULLS FIRST, l.encompass_last_modified DESC
      LIMIT $1`, [cap]);
  const out = { ok: true, considered: rows.length, pushed: 0, problems: [] };
  for (const r of rows) {
    try {
      const res = await pushLoan(r.id, { source: 'full_repush' });
      if (res && res.ok) out.pushed++;
      else if (res && res.skipped) out.problems.push({ loanId: r.id, skipped: res.skipped });
    } catch (e) {
      out.problems.push({ loanId: r.id, error: String((e && e.message) || e).slice(0, 200), retryable: !!(e && e.retryable) });
      try {
        await db.query('UPDATE lt_loans SET clickup_push_error = $2, updated_at = now() WHERE id = $1::uuid',
          [r.id, String((e && e.message) || e).slice(0, 500)]);
      } catch (_) { /* best-effort */ }
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
  const { rows } = await db.query(
    `SELECT l.id FROM lt_loans l
      WHERE l.clickup_task_id IS NULL
        AND ${trash.notTrashSql('l')}
        AND l.created_at >= $2::date
        AND l.loan_number IS NOT NULL AND l.loan_number <> ''
        AND l.encompass_synced_at IS NOT NULL
      ORDER BY l.created_at ASC
      LIMIT $1`, [cap, createSince()]);
  const out = { ok: true, considered: rows.length, created: 0, skipped: [], problems: [] };
  for (const r of rows) {
    try {
      const res = await createForLoan(r.id);
      if (res && res.created) out.created++;
      else if (res && res.skipped) out.skipped.push({ loanId: r.id, reason: res.skipped });
    } catch (e) {
      out.problems.push({ loanId: r.id, error: String((e && e.message) || e).slice(0, 200) });
      try {
        await db.query('UPDATE lt_loans SET clickup_push_error = $2, updated_at = now() WHERE id = $1::uuid',
          [r.id, String((e && e.message) || e).slice(0, 500)]);
      } catch (_) { /* best-effort */ }
      if (e && e.code === 'CLICKUP_CIRCUIT_OPEN') break;
    }
  }
  if (!rows.length) out.note = 'no new files awaiting a card';
  return out;
}

module.exports = {
  pushLoan, createForLoan, pushPass, createPass,
  writeEnabled, dryRun,
  _internals: {
    circuitCheck, countWrite, seedBreakerFromDb, breakerLimit,
    journalFieldWrite, queueReview, resolvePerson, providerTextSafe, geoFor,
    loadBag, readExtras, cardProgramLabel, taskFieldValue, taskOptionsMap,
    staffTableEntryByEmail,
    _resetBreaker: () => { _writeTimes = []; _breakerSeeded = false; },
    _seedWrites: (times) => { _writeTimes = times.slice(); _breakerSeeded = true; },
  },
};
