'use strict';
/**
 * Sitewire push orchestrator — the guarded, journaled, idempotent path that creates a
 * PILOT-managed property + budget in Sitewire on the funded + Request-a-draw click.
 *
 * Invariants enforced at write time (research doc §11.3), never clamped:
 *   · Σ exploded job items == frozen rehab_budget (G-RECON) — else BLOCK + park.
 *   · a cell already bound to a Sitewire id becomes an UPDATE, never a 2nd create (idempotent).
 *   · read-after-write: re-GET the budget and assert the total persisted (G-RAW).
 * Guards park in sync_review_queue instead of guessing; every write is journaled to
 * sitewire_write_log; a rolling volume circuit breaker stops runaways.
 *
 * PILOT manages ONLY what it creates (only-ours rule): before creating a property we
 * check for a loan-number collision with the pre-existing Sitewire back-catalog and
 * park it (G-DUPEPROP) rather than duplicate or adopt.
 */
const db = require('../db');
const cfg = require('../config');
const client = require('./client');
const T = require('./transforms');
const M = require('./mapper');
const rehab = require('../lib/rehab-budget');

// ---- journal every write (before/after) ----
async function journal(e) {
  try {
    await db.query(
      `INSERT INTO sitewire_write_log (application_id, sitewire_property_id, sitewire_budget_id, entity, entity_id, idempotency_key, field, old_value, new_value, changed, blocked, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [e.appId || null, e.propertyId || null, e.budgetId || null, e.entity || null, e.entityId || null,
       e.idem || null, e.field || null, e.oldValue === undefined ? null : JSON.stringify(e.oldValue),
       e.newValue === undefined ? null : JSON.stringify(e.newValue), e.changed !== false, !!e.blocked, e.source || 'push']);
  } catch (err) {
    // The audit trail must never go dark silently — a real Sitewire write with no journal row
    // is a compliance hole. Warn loudly (the write itself already happened; we don't undo it).
    console.warn(`[sitewire] JOURNAL WRITE FAILED (Sitewire write proceeded, audit row missing) entity=${e.entity} field=${e.field}: ${db.describeError ? db.describeError(err) : err.message}`);
  }
}

// ---- park a stuck/ambiguous state for a human (never guess, never silently drop) ----
// `dedupe` differentiates DISTINCT failures that share a reason class (e.g. a bind failure on
// line A vs line B) so they don't collapse into one row and lose the second failure's detail.
// GO-FORWARD ONLY error handling (owner-directed 2026-07-20): a file only enters the sync-review ERROR
// QUEUE (and the bidirectional reconcile/findings workflow) once PILOT has actually pushed it — i.e. it
// has a live created Sitewire property. Everything that can go wrong BEFORE that (no Scope of Work, a
// budget that doesn't tie out, an unmatched capital partner, an incomplete address, a loan already in
// Sitewire that PILOT didn't create, the unit/type advisories) is a SETUP problem on a not-yet-managed
// file. Those are recorded ON THE FILE and shown in its own draw section — NEVER as a global error row or
// an email — so an old funded file nobody has pushed can't clutter the review queue. Once the push
// succeeds the setup_status is cleared and normal error handling takes over.
const SITEWIRE_BIRTH_REASONS = new Set([
  'sitewire_missing_loan_number', 'sitewire_no_budget', 'sitewire_no_sow', 'sitewire_units_note',
  'sitewire_budget_mismatch', 'sitewire_capital_partner_unmatched', 'sitewire_address_incomplete',
  'sitewire_type_unmapped', 'sitewire_dupe_check_failed', 'sitewire_loan_already_in_sitewire',
  'sitewire_property_rejected', 'sitewire_bind_missing_property',
]);

// Is this file under PILOT draw management yet? True only once a push bound a live Sitewire property.
/* PURE (no DB / no network): the loan-number collision decision. Returns the pre-existing Sitewire property
 * that carries `loanNumber`, or null if none — EXCLUDING any id in `resetIds` (properties PILOT itself created
 * for this file and then reset/deactivated, so a delete-and-re-push isn't blocked by its own old copy). Only
 * ever skips ids WE recorded as our own reset; a genuine hand-entered property PILOT never created is always
 * returned (→ park, never adopt). Unit-tested. */
function collisionProperty(all, loanNumber, resetIds) {
  if (loanNumber == null || loanNumber === '') return null;
  const skip = new Set((Array.isArray(resetIds) ? resetIds : []).map(String));
  return (Array.isArray(all) ? all : []).find(
    (p) => p && String(p.loan_number || '') === String(loanNumber) && !skip.has(String(p.id))) || null;
}

async function isManaged(appId) {
  try { const lk = await getLink(appId); return !!(lk && lk.sitewire_property_id); } catch (_) { return false; }
}

// Record a BIRTH-phase setup outcome on the file itself (raw.setup_status) instead of the global review
// queue. matched_by='created' with sitewire_property_id STILL NULL — reconcile/portfolio ignore a
// null-property link, so nothing is followed until a real push binds a property. Cleared on success.
async function recordSetupStatus(appId, { reason, cls, current, proposed, preexisting }) {
  const status = { reason: String(reason), class: cls };
  if (current != null) status.file_value = String(current);
  if (proposed != null) status.sow_value = String(proposed);
  if (preexisting != null) status.preexisting_property_id = String(preexisting);
  const raw = { setup_status: status };
  try {
    await db.query(
      `INSERT INTO sitewire_property_links (application_id, matched_by, state, raw, updated_at)
       VALUES ($1,'created','pending',$2::jsonb, now())
       ON CONFLICT (application_id) DO UPDATE
         SET raw = COALESCE(sitewire_property_links.raw,'{}'::jsonb) || $2::jsonb, updated_at=now()`,
      [appId, JSON.stringify(raw)]);
  } catch (err) {
    console.warn(`[sitewire] could not record setup status (app=${appId}, reason="${reason}"): ${db.describeError ? db.describeError(err) : err.message}`);
  }
  return null;
}

async function park({ appId, reason, fieldKey = 'sitewire', current = null, proposed = null, dedupe = null, notify = true }) {
  const cls = String(reason).split(':')[0];
  // Birth-phase problem on a file PILOT hasn't managed yet → record on the file, never the error queue.
  if (fieldKey === 'sitewire' && SITEWIRE_BIRTH_REASONS.has(cls) && !(await isManaged(appId))) {
    // Non-blocking advisories (unit-count note, unmapped type) don't stop the push — it proceeds past
    // them — so they must NOT set a "setup hasn't completed" status. Drop them silently on an unmanaged
    // file (a real blocker later in the same push, or a successful push, is what the file reflects).
    if (cls === 'sitewire_units_note' || cls === 'sitewire_type_unmapped') return null;
    const preexisting = cls === 'sitewire_loan_already_in_sitewire' ? current : null;
    return recordSetupStatus(appId, { reason, cls, current, proposed, preexisting });
  }
  // The shared open-review unique index is (COALESCE(task_id,''), field_key, direction,
  // COALESCE(proposed_value,'')) and does NOT include application_id. Stamp a per-(file,
  // reason-class, instance) key into task_id (no FK; unused by sitewire rows) so distinct
  // files / reasons / instances never collide on the index and none is silently swallowed.
  const taskKey = `sitewire:${appId}:${cls}${dedupe ? ':' + String(dedupe).slice(0, 80) : ''}`;
  try {
    const existing = await db.query(
      `SELECT id FROM sync_review_queue WHERE task_id=$1 AND field_key=$2 AND status='open' LIMIT 1`, [taskKey, fieldKey]);
    if (existing.rowCount > 0) return existing.rows[0].id;
    const r = await db.query(
      `INSERT INTO sync_review_queue (application_id, task_id, direction, field_key, current_value, proposed_value, reason, status)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6,'open') RETURNING id`,
      [appId, taskKey, fieldKey, current == null ? null : String(current), proposed == null ? null : String(proposed), reason]);
    const rid = r.rows[0].id;
    // Advisory notes (units mismatch, unmapped type) set notify:false — they appear in the review list
    // but don't email the LO, so a file with several advisories doesn't send several blank-looking emails.
    if (notify) { try { await require('../lib/sync-review').notifyLoanOfficer(rid); } catch (_) {} }
    return rid;
  } catch (err) {
    // A concurrent insert may have raced us to the same task_id — return THAT row rather than
    // letting this park vanish (the unique-index collision must never silently drop a review).
    try { const ex = await db.query(`SELECT id FROM sync_review_queue WHERE task_id=$1 AND field_key=$2 AND status='open' LIMIT 1`, [taskKey, fieldKey]); if (ex.rowCount) return ex.rows[0].id; } catch (_) {}
    console.warn(`[sitewire] PARK FAILED to record a review row (app=${appId}, reason="${reason}"): ${db.describeError ? db.describeError(err) : err.message}`);
    return null;
  }
}

// ---- rolling 10-minute volume circuit breaker (shared across every write path) ----
async function circuitCheck(n = 1) {
  let r;
  try {
    r = await db.query(`SELECT count(*)::int AS c FROM sitewire_write_log WHERE created_at > now() - interval '10 minutes' AND blocked=false`);
  } catch (err) {
    // Fail CLOSED: if we can't read the breaker counter we must NOT let the write proceed
    // unguarded (a runaway during DB trouble could otherwise bypass the cap). Throw retryable
    // so the durable queue re-attempts once the DB recovers.
    const e = new Error(`SITEWIRE_CIRCUIT_CHECK_FAILED: ${db.describeError ? db.describeError(err) : err.message}`);
    e.retryable = true; throw e;
  }
  if ((r.rows[0].c + n) > cfg.sitewireMaxWrites10min) {
    const e = new Error(`SITEWIRE_CIRCUIT_OPEN: >${cfg.sitewireMaxWrites10min} writes/10min`);
    e.code = 'SITEWIRE_CIRCUIT_OPEN'; throw e;
  }
}

// Normalize a partner/note-buyer name to the link-table key form: lowercased, non-alphanumerics
// stripped (no spaces) — the SAME convention as sitewire_partner_links.label_norm and the /rules
// dropdown, so a link written from the UI is found by the resolver.
const linkNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// Common corporate suffixes/fillers — stripped only when SUGGESTING a fuzzy match (never when
// binding), so "Fidelis" can suggest "Fidelis Investments LLC" and "Blue Lake" → "Blue Lake Capital".
const CP_STOPWORDS = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'capital', 'investments', 'investment', 'partners', 'partner', 'group', 'holdings', 'holding',
  'lending', 'loans', 'loan', 'financial', 'finance', 'fund', 'funding', 'ventures', 'realty',
  'real', 'estate', 'properties', 'property', 'llp', 'lp', 'the', 'of', 'and']);
const coreKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  .split(' ').filter((t) => t && !CP_STOPWORDS.has(t)).join('');

// ---- resolve the capital-partner id from our free-text lender label (G-CP) ----
// Order: a human-CONFIRMED link (durable, owner-approved) → an exact directory match → a fuzzy
// CANDIDATE (never auto-bound — owner's #1 never-guess rule). A confirmed link is the smart-link
// chokepoint: "Fidelis" binds to "Fidelis Investments LLC" only because a human confirmed it.
async function resolveCapitalPartnerId(lenderLabel) {
  const label = String(lenderLabel || '').trim();
  if (!label) return { id: null, ambiguous: false };
  const key = linkNorm(label);

  // 1) confirmed link wins. sitewire_id NULL = an explicit "no Sitewire partner" (handled externally).
  const link = key ? (await db.query(`SELECT sitewire_id FROM sitewire_partner_links WHERE label_norm=$1`, [key])).rows[0] : null;
  if (link) {
    if (link.sitewire_id != null) return { id: Number(link.sitewire_id), ambiguous: false, linked: true };
    return { id: null, ambiguous: false, linked: true, noPartner: true };
  }

  const rows = (await db.query(`SELECT sitewire_id, name, on_our_lender FROM sitewire_capital_partners`)).rows;
  // 2) exact directory match (normalized) auto-binds. Sitewire's directory can carry the SAME name
  //    under more than one id (a duplicate partner entry) — after the owner renamed our note-buyer
  //    labels to match Sitewire exactly (2026-07-20), a duplicate directory name is the one thing that
  //    would otherwise PARK an otherwise-perfect exact match as ambiguous. When an exact name matches
  //    more than one directory id, prefer the one attached to OUR lender (on_our_lender) — that's the
  //    partner we actually work with, which is a fact, not a guess. Only a true tie with no single
  //    on-our-lender winner stays ambiguous (never-guess).
  const exact = rows.filter((r) => linkNorm(r.name) === key);
  if (exact.length === 1) return { id: Number(exact[0].sitewire_id), ambiguous: false };
  if (exact.length > 1) {
    const ours = exact.filter((r) => r.on_our_lender);
    if (ours.length === 1) return { id: Number(ours[0].sitewire_id), ambiguous: false, dedupedByLender: true };
    return { id: null, ambiguous: true };
  }

  // 3) fuzzy is NOT auto-bound (that would be a guess). Surface the single best CANDIDATE so the UI
  // can suggest it and the admin one-click confirms it into a durable link. Try a suffix-tolerant
  // core-token match first ("Fidelis" ~ "Fidelis Investments LLC"), then a plain substring.
  const ck = coreKey(label);
  const coreMatch = ck ? rows.filter((r) => coreKey(r.name) === ck) : [];
  if (coreMatch.length === 1) return { id: null, ambiguous: false, candidate: Number(coreMatch[0].sitewire_id), candidateName: coreMatch[0].name };
  const contains = rows.filter((r) => { const n = linkNorm(r.name); return n && key && (n.includes(key) || key.includes(n)); });
  if (contains.length === 1) return { id: null, ambiguous: false, candidate: Number(contains[0].sitewire_id), candidateName: contains[0].name };
  return { id: null, ambiguous: (coreMatch.length > 1 || contains.length > 1) };
}

// ---- resolve the inspection + fee rule ----
// Keyed by the NOTE-BUYER label first (so a partner that isn't in the Sitewire directory — e.g. one
// handled externally — still matches), then by the resolved Sitewire capital_partner_id (legacy rules),
// then the global default. Program-specific beats the partner-wide rule at each step.
async function resolveRule(lenderLabel, capitalPartnerId, program) {
  const rows = (await db.query(`SELECT * FROM sitewire_inspection_rules`)).rows;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const L = norm(lenderLabel);
  const byLabel = (pg) => (L ? rows.find((r) => r.partner_label && norm(r.partner_label) === L && ((r.program || null) === (pg || null))) : null);
  const byCp = (cp, pg) => (cp != null ? rows.find((r) => (r.capital_partner_id == cp) && ((r.program || null) === (pg || null))) : null);
  const global = rows.find((r) => !r.partner_label && r.capital_partner_id == null && !r.program);
  return byLabel(program) || byLabel(null) || byCp(capitalPartnerId, program) || byCp(capitalPartnerId, null) || global || null;
}

// ---- the draw coordinator's Sitewire user id (default Lisa Katz) ----
async function resolveCoordinatorId() {
  try {
    const r = await db.query(`SELECT sitewire_user_id FROM staff_users WHERE sitewire_user_id IS NOT NULL AND is_active ORDER BY updated_at DESC LIMIT 1`);
    // Phase 1: default coordinator id from config; a per-file override arrives later.
    return cfg.sitewireDefaultCoordinatorId || (r.rows[0] && r.rows[0].sitewire_user_id) || null;
  } catch (_) { return cfg.sitewireDefaultCoordinatorId || null; }
}

// ---- load the file + its SOW payload ----
async function loadFile(appId) {
  const a = (await db.query(
    `SELECT a.id, a.ys_loan_number, a.property_address, a.property_type, a.loan_type, a.rehab_type,
            a.units, a.lender, a.status, a.actual_closing, a.borrower_id,
            b.email AS borrower_email, l.llc_name,
            pr.program AS registered_program
       FROM applications a
       LEFT JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN product_registrations pr ON pr.application_id = a.id AND pr.is_current
      WHERE a.id=$1 AND a.deleted_at IS NULL`, [appId])).rows[0];
  if (!a) return null;
  const sow = (await db.query(
    `SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appId])).rows[0];
  a.sow_payload = sow ? sow.tool_payload : null;
  return a;
}

async function getLink(appId) {
  return (await db.query(`SELECT * FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0] || null;
}

// Resolve the inspection method for a file: the coordinator's per-file choice (link.inspection_method)
// if set, else the rule's DEFAULT (auto virtual/physical). The choice is validated against what the
// rule ALLOWS — a stored method the rule no longer allows falls back to an allowed one (never a
// method the capital partner forbids). Returns { method, feeKind, feeCents, allowVirtual, allowPhysical }.
function resolveInspection(link, rule) {
  const dflt = (rule && rule.inspection_method) || 'mobile';
  const allowVirtual = !rule || rule.allow_virtual !== false;
  const allowPhysical = !rule || rule.allow_physical !== false;
  let method = (link && link.inspection_method) || dflt;
  if (method === 'mobile' && !allowVirtual) method = allowPhysical ? 'traditional' : dflt;
  if (method === 'traditional' && !allowPhysical) method = allowVirtual ? 'mobile' : dflt;
  const feeKind = T.feeKindFor(method);
  const ruleFeeRaw = rule ? (feeKind === 'physical' ? (rule.fee_cents_physical != null ? rule.fee_cents_physical : rule.fee_cents_virtual) : rule.fee_cents_virtual) : 29900;
  // Belt-and-suspenders: clamp the rule fee to a finite, non-negative amount so a bad stored fee
  // (e.g. a negative physical fee that slipped in) can NEVER push a negative processing_fee_cents.
  const ruleFeeN = Number(ruleFeeRaw);
  const ruleFee = Number.isFinite(ruleFeeN) && ruleFeeN >= 0 ? ruleFeeN : (feeKind === 'physical' && rule && Number.isFinite(Number(rule.fee_cents_virtual)) && Number(rule.fee_cents_virtual) >= 0 ? Number(rule.fee_cents_virtual) : 29900);
  // The coordinator's per-file fee override (Start-draw screen) wins over the rule fee when set.
  // NULL / negative / non-finite falls back to the rule fee — a bad value can never zero the fee.
  const override = link && link.fee_cents_override != null ? Number(link.fee_cents_override) : null;
  const overridden = override != null && Number.isFinite(override) && override >= 0;
  const feeCents = overridden ? override : ruleFee;
  return { method, feeKind, feeCents, ruleFeeCents: Number(ruleFee), overridden, allowVirtual, allowPhysical };
}

/**
 * Birth push for a funded file. Returns { ok, skipped?, parked?, propertyId?, budgetId? }.
 * force=true bypasses the master switch (used by an admin manual push, still guarded).
 */
async function pushFile(appId, opts = {}) {
  if (!cfg.sitewireEnabled && !opts.force) return { skipped: 'sitewire disabled' };
  // The write gate is NOT bypassable by force (staging safety) — only dry-run lets a
  // push proceed with writes off (it validates the bodies + logs, sends nothing).
  if (!cfg.sitewireOutboundEnabled && !cfg.sitewireDryrun) return { skipped: 'sitewire outbound disabled (set SITEWIRE_OUTBOUND_ENABLED=1 or SITEWIRE_DRYRUN=1)' };
  const a = await loadFile(appId);
  if (!a) return { skipped: 'file not found/deleted' };
  if (a.status !== 'funded' && !opts.allowUnfunded) return { skipped: 'file not funded' };

  // Resolve the capital partner + inspection/fee rule up front. resolveRule matches by the note-buyer
  // LABEL first, so a "handled externally" partner is recognized even when it isn't in the Sitewire
  // directory. A handled-externally partner runs its own draws — the file is NEVER pushed to Sitewire,
  // so skip BEFORE any budget/SOW/units check, so a file we will never send can't queue spurious review
  // rows. This is intentional, not an error — skip, don't park.
  const program = /gold/i.test(String(a.registered_program || '')) ? 'gold' : 'standard';
  const cp = await resolveCapitalPartnerId(a.lender);
  const rule = await resolveRule(a.lender, cp.id, program);
  if (rule && rule.handled_externally) return { skipped: 'handled_externally', partner: a.lender || null };

  // G-LOAN
  if (!a.ys_loan_number) { await park({ appId, reason: 'sitewire_missing_loan_number: file has no YS loan number to push' }); return { parked: 'missing_loan_number' }; }

  // required frozen budget (the reconcile target)
  const budgetDollars = await rehab.requiredRehabBudget(appId);
  if (budgetDollars == null || Number(budgetDollars) <= 0) { await park({ appId, reason: 'sitewire_no_budget: no frozen rehab budget set — register the product first' }); return { parked: 'no_budget' }; }
  const budgetCents = Math.round(Number(budgetDollars) * 100);
  if (!a.sow_payload || !a.sow_payload.state) { await park({ appId, reason: 'sitewire_no_sow: no Scope of Work saved to explode into a budget' }); return { parked: 'no_sow' }; }

  // G-UNITS (owner-directed 2026-07-20 — "use physical building units"): send the PHYSICAL building unit
  // count and NEVER hard-block on a file-vs-SOW disagreement. A property can legitimately be a 4-family
  // where the borrower only works the exterior + one unit — the SOW then models fewer/other unit sections
  // than the building physically has, and that is NOT an error. The physical count = the LARGER of the
  // file's unit count and the SOW's unit count: it is always >= every per-unit budget/media line the
  // explosion references (those use the SOW's unit count), so Sitewire can never carry a "Unit N" line for
  // a unit the property doesn't physically have; units with no work simply carry no budget lines. A
  // disagreement only raises a NON-BLOCKING advisory (deduped) so staff can fix a stale file count — the
  // push PROCEEDS (no return/park). The exploded-budget→frozen-budget tie-out (G-RECON) is the real gate.
  const sowUnits = M.unitCount(a.sow_payload.state);
  const fileUnits = (a.units != null && Number(a.units) > 0) ? Number(a.units) : 0;
  const physicalUnits = Math.max(1, fileUnits, sowUnits);
  if (fileUnits > 0 && fileUnits !== sowUnits) {
    // current/proposed drive the review card's "expected · found" line — anchor them to the REAL
    // discrepancy (Scope-of-Work unit count vs the file's unit count), NOT file-vs-physical (which are
    // often equal and read as a confusing "expected 2 · found 2"). Owner-directed 2026-07-20.
    await park({ appId, dedupe: 'units', notify: false, reason: `sitewire_units_note: the file lists ${fileUnits} unit(s) but the Scope of Work is built for ${sowUnits} — pushing the physical building count of ${physicalUnits} unit(s) (units with no work carry no budget lines). Update the file's unit count in the application if ${physicalUnits} is wrong.`, current: String(fileUnits), proposed: String(sowUnits) });
  }

  // explode + G-RECON (must tie to the frozen budget to the cent BEFORE any write)
  // absorb ≤$1 percentage-rounding drift into contingency/GC so a validly signed-off SOW
  // isn't wrongly parked (audit S4); a real mismatch beyond tolerance still blocks below.
  const ex = M.reconcileToBudget(M.explodeSow(a.sow_payload.state, {}), budgetCents);
  M.uniquifyNames(ex.items); // re-dedupe: reconcileToBudget may append a 'Contingency' line after the first pass
  if (ex.total_cents !== budgetCents) {
    await park({ appId, reason: `sitewire_budget_mismatch: exploded SOW total ${T.usd(ex.total_cents)} != frozen budget ${T.usd(budgetCents)}`, current: budgetCents, proposed: ex.total_cents });
    return { parked: 'budget_mismatch' };
  }

  // capital partner (G-CP) already resolved above (cp + rule). If it didn't resolve to a Sitewire id,
  // park for review — never guess a partner.
  if (!cp.id) {
    const why = cp.candidate ? `partially matched "${cp.candidateName}" — confirm it's the right partner` : `${cp.ambiguous ? 'matched multiple' : 'matched no'} Sitewire capital partner`;
    await park({ appId, reason: `sitewire_capital_partner_unmatched: lender label "${a.lender || '(blank)'}" ${why}`, current: a.lender, proposed: cp.candidate ? String(cp.candidate) : null });
    return { parked: 'capital_partner' };
  }
  // method = coordinator's per-file choice ?? rule default, validated against what the rule allows
  const existingLink = await getLink(appId);
  const insp = resolveInspection(existingLink, rule);
  const inspectionMethod = insp.method;
  const feeCents = insp.feeCents;
  const coordinatorId = await resolveCoordinatorId();

  // address (G-ADDR handled by catching Sitewire's 422 below)
  const addr = T.addressForSitewire(a.property_address);
  if (!addr || !addr.street || !addr.city || !addr.state || !addr.zip) {
    await park({ appId, reason: 'sitewire_address_incomplete: property address is missing street/city/state/zip', current: JSON.stringify(a.property_address || {}) });
    return { parked: 'address' };
  }
  const devType = T.developmentType(a.property_type);
  const consType = T.constructionType(a.loan_type, a.rehab_type);

  const propertyFields = {
    loan_number: a.ys_loan_number,
    capital_partner_id: Number(cp.id),                 // pg bigint -> number (Sitewire expects an integer)
    inspection_method: inspectionMethod,
    require_sitewire_inspector: !!(rule && rule.require_sitewire_inspector),
    require_capital_partner_approval: !!(rule && rule.require_capital_partner_approval),
    allow_reallocation: !!(rule && rule.allow_reallocation),
    processing_fee_cents: Number(feeCents),
    default_draw_coordinator_id: coordinatorId != null ? Number(coordinatorId) : null,
    draw_checklist_template_id: cfg.sitewireDefaultChecklistTemplateId,
    address: addr,
  };
  // never send a null/NaN field (guardNoUnsafeWrite rejects non-finite values and would block the WHOLE
  // push) — omit a coordinator/checklist id that isn't a finite number (e.g. a mistyped env var).
  if (!Number.isFinite(propertyFields.default_draw_coordinator_id)) delete propertyFields.default_draw_coordinator_id;
  if (!Number.isFinite(propertyFields.draw_checklist_template_id)) delete propertyFields.draw_checklist_template_id;
  propertyFields.total_units = physicalUnits;
  if (devType) propertyFields.development_type = devType;
  if (consType) propertyFields.construction_type = consType;
  // G-ENUM: a property/construction type we couldn't map is LEFT BLANK (never guessed) — but raise
  // an advisory review so someone sets it in Sitewire, rather than it silently going unset. Non-blocking
  // (the push still proceeds — these are optional Sitewire fields); deduped so it can't spam the queue.
  if (a.property_type && !devType) await park({ appId, reason: `sitewire_type_unmapped: property type "${a.property_type}" didn't map to a Sitewire development_type — left blank, set it in Sitewire if needed`, dedupe: 'devtype', notify: false });
  if ((a.loan_type || a.rehab_type) && !consType) await park({ appId, reason: `sitewire_type_unmapped: loan/rehab type "${a.loan_type || ''}/${a.rehab_type || ''}" didn't map to a Sitewire construction_type — left blank, set it in Sitewire if needed`, dedupe: 'construction', notify: false });
  if (a.llc_name) propertyFields.borrower_entity_name = a.llc_name;

  let link = existingLink;
  let property, propertyId, budgetId;

  // G-BIRTH: serialize the birth (dupe-check + create + link) per file with a per-file advisory lock on
  // a dedicated connection, so two concurrent callers — the coordinator's inline Start push and the worker
  // draining the borrower's queued request-a-draw, or a double-click — can't BOTH create a Sitewire
  // property for the same loan (a duplicate would violate the only-ours rule; G-RAW can't catch it because
  // the budget ids differ). Only the CREATE path needs it; an update of an already-linked file is idempotent.
  let lockConn = null;
  const lockKey = `sw-birth:${appId}`;
  try {
    if (!link || !link.sitewire_property_id) {
      lockConn = await db.getClient();
      await lockConn.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      link = await getLink(appId); // re-read UNDER the lock — the race loser now sees the winner's link and updates
    }

    // G-DUPEPROP: if still not linked and a Sitewire property already carries our loan number, park (never adopt/duplicate)
    if (!link || !link.sitewire_property_id) {
      let existing = null;
      try {
        const all = await client.listProperties();
        // Pick a colliding property by loan number, EXCLUDING any this file previously created and reset
        // (tombstoned in raw.reset_property_ids) — so delete-and-re-push works while a genuine pre-existing
        // property PILOT never created still parks. Pure + tested (collisionProperty).
        existing = collisionProperty(all, a.ys_loan_number, ((link && link.raw) || {}).reset_property_ids);
      } catch (e) {
        if (e.retryable) throw e; // transient → the queue retries the whole push
        // A NON-retryable failure of the dupe check must NEVER fall through to create — that
        // would risk a duplicate property (violating only-ours). Park instead of guessing safe.
        await park({ appId, reason: `sitewire_dupe_check_failed: could not verify loan ${a.ys_loan_number} isn't already in Sitewire (${e.message}) — not creating, to avoid a duplicate` });
        return { parked: 'dupe_check_failed' };
      }
      if (existing) {
        // GO-FORWARD ONLY (owner-directed 2026-07-20): this loan number is already on a property in Sitewire
        // that PILOT did NOT create. PILOT never adopts or follows a pre-existing property — it manages only
        // what it pushes. So don't duplicate and don't adopt: park for a human decision. To bring it under
        // PILOT management, delete that property in Sitewire and push a fresh copy from this file.
        await park({ appId, reason: `sitewire_loan_already_in_sitewire: loan ${a.ys_loan_number} is already on a Sitewire property (${existing.id}) that PILOT didn't create — PILOT won't duplicate or follow it. To manage the draw process here, delete it in Sitewire and push a fresh copy from this file, or keep them separate.`, current: String(existing.id) });
        return { parked: 'dupe_property' };
      }
    }

    await circuitCheck(1);
    try {
      if (link && link.sitewire_property_id) {
        property = await client.updateProperty(link.sitewire_property_id, propertyFields);
      } else {
        property = await client.createProperty(propertyFields);
      }
    } catch (e) {
      // A deterministic 422/400 must PARK (never retry-loop the queue on a body Sitewire will keep rejecting).
      if (e.status === 422 || e.status === 400) { await park({ appId, reason: `sitewire_property_rejected: Sitewire ${e.status} on the property (likely address geocode / bad field) — ${JSON.stringify(e.body || {}).slice(0, 200)}` }); return { parked: 'property_' + e.status }; }
      throw e; // transient -> queue retries
    }
    if (property && property.__dryrun) return { dryrun: true, stage: 'property' };
    propertyId = (property && property.id) || (link && link.sitewire_property_id) || null;
    // A re-push (UPDATE) of an already-created property may return a response that omits budget.id — fall
    // back to the id we stored on the first push, so a re-push doesn't false-park on "no budget id".
    budgetId = (property && property.budget && property.budget.id) || (link && link.sitewire_budget_id) || null;
    // A 200 that came back without the ids we need to bind the crosswalk is NOT a success — never
    // proceed with undefined ids or write a link row we can't reconcile (G-RAW / E-RAW-NOID).
    if (!propertyId || !budgetId) {
      await park({ appId, reason: `sitewire_bind_missing_property: Sitewire returned a property with no ${propertyId ? 'budget id' : 'property id'} — cannot bind. Response: ${JSON.stringify(property || {}).slice(0, 200)}` });
      return { parked: 'no_ids' };
    }
    await journal({ appId, propertyId, budgetId, entity: 'property', entityId: propertyId, field: 'property', newValue: propertyFields, source: link ? 'push' : 'create' });

    // upsert the link
    await db.query(
      `INSERT INTO sitewire_property_links (application_id, sitewire_property_id, sitewire_budget_id, capital_partner_id, matched_by, state, pushed_at, raw, updated_at)
       VALUES ($1,$2,$3,$4,'created','live',now(),$5,now())
       ON CONFLICT (application_id) DO UPDATE SET sitewire_property_id=EXCLUDED.sitewire_property_id, sitewire_budget_id=EXCLUDED.sitewire_budget_id, capital_partner_id=EXCLUDED.capital_partner_id, state='live', pushed_at=now(),
         raw = (COALESCE(sitewire_property_links.raw,'{}'::jsonb) - 'setup_status') || EXCLUDED.raw, updated_at=now()`,
      [appId, propertyId, budgetId, cp.id, JSON.stringify({ inspectionMethod, feeCents })]);
    link = await getLink(appId);
  } finally {
    if (lockConn) {
      let unlockErr = null;
      try { await lockConn.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]); } catch (e) { unlockErr = e; }
      // if the unlock failed, DESTROY the connection (pass the error) — never return a still-lock-holding
      // session to the pool.
      lockConn.release(unlockErr || undefined);
    }
  }

  // assign borrower (best-effort; parks on 422)
  if (a.borrower_email) {
    await circuitCheck(1); // count this write toward the breaker so a runaway re-push loop still halts here
    try {
      const res = await client.assignBorrower(propertyId, a.borrower_email);
      if (!(res && res.__dryrun)) await journal({ appId, propertyId, entity: 'borrower', field: 'contact_email', newValue: a.borrower_email, source: 'push' });
    } catch (e) {
      if (e.retryable) throw e; // transient → the queue retries the whole push
      // Any NON-retryable failure (422/400/403/404/409/…) must PARK, never be silently swallowed —
      // Sitewire owns borrower draw submission, so an unassigned borrower can't submit and someone
      // must be told (never-silently-drop).
      await park({ appId, reason: `sitewire_borrower_assign_failed: could not assign borrower ${a.borrower_email} (Sitewire ${e.status || 'error'})` });
    }
  }

  // push the budget/job-items via the crosswalk. PILOT only ever manages properties it created, so the
  // crosswalk is always PILOT's own (born on this push) — a clean explode → create → bind → verify.
  const budgetResult = await pushBudget(appId, budgetId, ex, budgetCents);
  return { ok: true, propertyId, budgetId, budget: budgetResult };
}

/**
 * Push the exploded budget through the crosswalk (create/update/delete), capture ids by
 * unique name, journal, and read-after-write verify the total (G-RAW/G-RECON).
 */
async function pushBudget(appId, budgetId, ex, budgetCents) {
  // Serialize budget pushes per file with a per-file advisory lock so two concurrent births (coordinator
  // Start inline + the worker draining the borrower's request) can't both bind the same crosswalk and
  // create duplicate Sitewire job items. The loser blocks, then re-reads the crosswalk (now bound) inside
  // pushBudgetInner → no creates → unchanged. Same leak-safe lock/release(err) pattern as the birth.
  const lockConn = await db.getClient();
  const lockKey = `sw-budget:${appId}`;
  try {
    await lockConn.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    return await pushBudgetInner(appId, budgetId, ex, budgetCents);
  } finally {
    let unlockErr = null;
    try { await lockConn.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]); } catch (e) { unlockErr = e; }
    lockConn.release(unlockErr || undefined);
  }
}
async function pushBudgetInner(appId, budgetId, ex, budgetCents) {
  const links = (await db.query(
    `SELECT id, sow_line_key, section_token, sitewire_job_item_id, budgeted_cents, name FROM sitewire_job_item_links WHERE application_id=$1 AND sitewire_budget_id=$2`,
    [appId, budgetId])).rows;
  const diff = M.diffBudget(ex.items, links);

  // Sitewire LOCKS a line's name once a draw references it — renaming it 422s the WHOLE budget
  // PATCH, which would block unrelated cents changes batched in the same push (audit M2). So a line
  // that already has a draw request is re-budgeted but NEVER renamed (the cents change still goes;
  // only the cosmetic rename is skipped). Look up the drawn job-item ids once.
  const drawn = new Set((await db.query(
    `SELECT DISTINCT r.sitewire_job_item_id FROM sitewire_draw_requests r
       JOIN sitewire_draws d ON d.sitewire_draw_id = r.sitewire_draw_id
      WHERE d.application_id=$1 AND r.sitewire_job_item_id IS NOT NULL`, [appId])).rows.map((x) => Number(x.sitewire_job_item_id)));

  // build the PATCH job_items array (creates: no id; updates: id+fields; deletes: id+_destroy)
  const job_items = [];
  for (const c of diff.creates) {
    const ji = { name: c.name, budgeted_cents: c.budgeted_cents };
    if (c.required_image_count != null) ji.required_image_count = c.required_image_count;
    if (c.required_video_count != null) ji.required_video_count = c.required_video_count;
    if (c.mandatory) ji.mandatory = true;
    job_items.push(ji);
  }
  for (const u of diff.updates) {
    const ji = { id: u.sitewire_job_item_id, budgeted_cents: u.budgeted_cents };
    // rename only if changed AND the line isn't locked by an existing draw (else Sitewire 422s the batch)
    if ((u.prev_name || '') !== (u.name || '') && !drawn.has(Number(u.sitewire_job_item_id))) ji.name = u.name;
    job_items.push(ji);
  }
  for (const d of diff.deletes) job_items.push({ id: d.sitewire_job_item_id, _destroy: true });

  if (!job_items.length) return { unchanged: true };
  await circuitCheck(job_items.length);

  let updated;
  try {
    updated = await client.updateBudget(budgetId, { job_items, draw_eligible: true, funding_ratio: 100, funding_threshold_cents: 0 });
  } catch (e) {
    // A deterministic 422/400 parks (never retry-loop a body Sitewire will keep rejecting).
    if (e.status === 422 || e.status === 400) { await park({ appId, reason: `sitewire_budget_rejected (${e.status}): ${JSON.stringify(e.body || {}).slice(0, 220)}` }); return { parked: 'budget_' + e.status }; }
    throw e;
  }
  if (updated && updated.__dryrun) return { dryrun: true, wouldSend: job_items.length };

  // capture ids (G-BIND). A NEW line binds to the response item with its unique name. A line that
  // was ALREADY bound (update/unchanged) keeps its KNOWN id — we must NOT re-find it by name, because
  // a rename suppressed on a drawn line (M2) makes Sitewire echo the OLD name, which the desired-name
  // lookup would miss (false "bind_missing" + stale crosswalk cents). For those we refresh cents by id
  // and store the name Sitewire actually holds (old name when the rename was suppressed, else the new).
  const respByName = new Map();
  for (const ji of (updated.job_items || [])) {
    if (!respByName.has(ji.name)) respByName.set(ji.name, ji);
    else respByName.set(ji.name, null); // duplicate name -> ambiguous
  }
  const linkByKey = new Map();
  for (const l of links) linkByKey.set(`${l.sow_line_key} ${l.section_token}`, l);
  for (const c of ex.items) {
    const existing = linkByKey.get(`${c.sow_line_key} ${c.section_token}`);
    let jiId, storedName;
    if (existing && existing.sitewire_job_item_id != null) {
      jiId = existing.sitewire_job_item_id;
      const renameSuppressed = drawn.has(Number(jiId)) && (existing.name || '') !== (c.name || '');
      storedName = renameSuppressed ? existing.name : c.name; // match what Sitewire actually holds
    } else {
      const ji = respByName.get(c.name);
      if (ji === undefined) { await park({ appId, reason: `sitewire_bind_missing: created line "${c.name}" not found in response — cannot bind id`, dedupe: c.name }); continue; }
      if (ji === null) { await park({ appId, reason: `sitewire_bind_ambiguous: line name "${c.name}" appears twice — cannot bind id`, dedupe: c.name }); continue; }
      jiId = ji.id; storedName = c.name;
    }
    await db.query(
      `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sow_line_key, section_token, unit_index, sitewire_job_item_id, name, budgeted_cents, is_media_item, state, last_response_hash, last_pushed_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'live',$10,now(),now())
       ON CONFLICT (application_id, sow_line_key, section_token) DO UPDATE SET sitewire_job_item_id=EXCLUDED.sitewire_job_item_id, name=EXCLUDED.name, budgeted_cents=EXCLUDED.budgeted_cents, is_media_item=EXCLUDED.is_media_item, state='live', last_response_hash=EXCLUDED.last_response_hash, last_pushed_at=now(), updated_at=now()`,
      [appId, budgetId, c.sow_line_key, c.section_token, c.unit_index, jiId, storedName, c.budgeted_cents, !!c.is_media_item, T.stableHash({ n: storedName, b: c.budgeted_cents })]);
  }
  // process deletes in the crosswalk
  for (const d of diff.deletes) await db.query(`UPDATE sitewire_job_item_links SET state='deleted', updated_at=now() WHERE id=$1`, [d.id]);
  await journal({ appId, budgetId, entity: 'budget', entityId: budgetId, field: 'job_items', newValue: { creates: diff.creates.length, updates: diff.updates.length, deletes: diff.deletes.length }, source: 'push' });

  // read-after-write (G-RAW): re-GET and assert the total AND each line persisted to the cent.
  try {
    const fresh = await client.getBudget(budgetId);
    // An ABSENT total is not a pass — "returned 200 but the field we verify against is missing" must
    // never be treated as success (that's exactly the failure G-RAW exists to catch). Park as unverifiable.
    if (!fresh || fresh.total_budgeted_cents == null) {
      await park({ appId, reason: `sitewire_total_unverified: Sitewire budget re-read returned no total to check — cannot confirm it saved`, current: budgetId });
      return { parked: 'verify_failed' };
    }
    if (Number(fresh.total_budgeted_cents) !== budgetCents) {
      await park({ appId, reason: `sitewire_total_drift: Sitewire budget total ${T.usd(fresh.total_budgeted_cents)} != expected ${T.usd(budgetCents)} after write`, current: fresh.total_budgeted_cents, proposed: budgetCents });
      return { parked: 'total_drift' };
    }
    // Per-line assertion by id: a coercion that preserved the TOTAL but shifted cents BETWEEN lines
    // still corrupts the schedule of values. Compare each bound crosswalk line to the returned item by id.
    const freshById = new Map();
    for (const ji of (fresh.job_items || [])) if (ji && ji.id != null) freshById.set(Number(ji.id), ji);
    if (freshById.size) {
      for (const l of (await db.query(`SELECT sitewire_job_item_id, budgeted_cents FROM sitewire_job_item_links WHERE application_id=$1 AND sitewire_budget_id=$2 AND state='live'`, [appId, budgetId])).rows) {
        const ji = freshById.get(Number(l.sitewire_job_item_id));
        if (ji && ji.budgeted_cents != null && Number(ji.budgeted_cents) !== Number(l.budgeted_cents)) {
          await park({ appId, reason: `sitewire_line_drift: job item ${l.sitewire_job_item_id} is ${T.usd(ji.budgeted_cents)} in Sitewire, expected ${T.usd(l.budgeted_cents)}`, current: ji.budgeted_cents, proposed: l.budgeted_cents });
          return { parked: 'line_drift' };
        }
      }
    }
  } catch (e) {
    // If we can't confirm the write persisted, do NOT report success silently (there is no
    // budget re-verify in the reconcile poll to catch it later). Park it for a human to confirm.
    await park({ appId, reason: `sitewire_total_unverified: could not re-read the Sitewire budget to confirm it saved (${e.message}) — needs a manual check`, current: budgetId });
    return { parked: 'verify_failed' };
  }
  return { ok: true, created: diff.creates.length, updated: diff.updates.length, deleted: diff.deletes.length };
}

const LIFECYCLE_STATES = new Set(['active', 'finished', 'paid_off']);

/**
 * Set the draw-project lifecycle on a PILOT-managed file and (when writes are on) sync it to Sitewire.
 *   'finished'  → the draw process is complete (no more draws expected)
 *   'paid_off'  → the loan is paid off / closed out
 *   'active'    → re-open a finished/paid-off project
 * finished/paid_off DEACTIVATE the Sitewire property (`inactive=true`) so no further borrower draws can be
 * submitted; 'active' re-activates it. GO-FORWARD ONLY — only a file PILOT actually pushed (matched_by=
 * 'created' + a live property) can be closed out. The PILOT-side state is always recorded (the desk view is
 * PILOT's own, and the money ledger works with Sitewire off); the Sitewire deactivate rides the same guarded
 * client used by every other write — circuit-broken, journaled, read-after-write verified, park-on-failure.
 */
async function setPropertyLifecycle(appId, state, staffId = null) {
  if (!LIFECYCLE_STATES.has(state)) return { error: 'invalid_state' };
  const link = await getLink(appId);
  // only-ours: a pre-existing / unmanaged file has no created+live property to close out.
  if (!link || !link.sitewire_property_id || link.matched_by !== 'created') return { error: 'not_managed' };
  const canSync = cfg.sitewireEnabled && (cfg.sitewireOutboundEnabled || cfg.sitewireDryrun);
  // Idempotent no-op — but ONLY when there is nothing left to do. If the state already matches AND it's
  // already synced to Sitewire (or we still can't sync), skip. If it matches but was recorded while writes
  // were OFF (synced=false) and we CAN sync now, fall THROUGH and actually push the deactivate — otherwise a
  // change made while staged-off would never reach Sitewire (audit SF-1). '<> false' treats a legacy NULL as
  // synced so pre-existing rows don't re-drive.
  if (link.lifecycle_state === state && (link.lifecycle_synced !== false || !canSync)) return { ok: true, state, unchanged: true };

  const inactive = state !== 'active';   // finished/paid_off deactivate; active re-activates
  let sitewire = 'skipped';
  // The Sitewire deactivate needs BOTH the master switch and the write gate (or dry-run). With writes off we
  // still record the PILOT-side state — the desk reflects it — and mark synced=false so the worker backfill
  // (backfillUnsyncedLifecycleOnce) / a manual re-click pushes it once writing is on.
  if (canSync) {
    await circuitCheck(1);
    let property;
    try {
      property = await client.updateProperty(link.sitewire_property_id, { inactive });
    } catch (e) {
      if (e.retryable) throw e;   // transient → let the caller/queue retry, PILOT state not yet changed
      // NOTE (intentional divergence from pushFile, which parks only on 422/400): park on ANY non-retryable
      // error here (e.g. a deterministic 404) rather than dead-lettering — a lifecycle write is a single
      // idempotent field flip a human can re-drive, so parking for review is the safer failure mode.
      await park({ appId, reason: `sitewire_lifecycle_failed: could not set property ${link.sitewire_property_id} inactive=${inactive} in Sitewire (${e.status || 'error'})` });
      return { parked: 'lifecycle_' + (e.status || 'error') };
    }
    if (property && property.__dryrun) { sitewire = 'dryrun'; }
    else {
      // read-after-write: re-GET and confirm `inactive` persisted. FAIL CLOSED,
      // mirroring the budget push (pushBudgetInner treats an absent verify field
      // as unverified): only a POSITIVE match (`inactive` came back a boolean and
      // equals what we set) counts as synced. A mismatch parks; a throwing GET or
      // an absent/non-boolean `inactive` is NOT proof it stuck — leave the row
      // lifecycle_synced=false so backfillUnsyncedLifecycleOnce re-drives the
      // (idempotent) deactivate, so a paid-off property can't silently stay active.
      let verified = false;
      try {
        const fresh = await client.getProperty(link.sitewire_property_id);
        if (fresh && typeof fresh.inactive === 'boolean') {
          if (fresh.inactive !== inactive) {
            await park({ appId, reason: `sitewire_lifecycle_verify_failed: Sitewire property ${link.sitewire_property_id} did not persist inactive=${inactive}` });
            return { parked: 'verify_failed' };
          }
          verified = true;
        }
      } catch (e) { console.warn('[sitewire] lifecycle verify GET failed (will re-drive):', e && e.message); }
      await journal({ appId, propertyId: link.sitewire_property_id, entity: 'property', entityId: link.sitewire_property_id, field: 'inactive', oldValue: !inactive, newValue: inactive, source: 'lifecycle' });
      sitewire = verified ? 'synced' : 'unverified';
    }
  }
  // record the PILOT-side lifecycle state (always — PILOT is the source of record for the desk + ledger).
  // synced=true ONLY when the deactivate really reached Sitewire; a 'skipped' (writes off) or 'dryrun'
  // (validated, nothing sent) leaves it false so the backfill re-drives it.
  await db.query(
    `UPDATE sitewire_property_links SET lifecycle_state=$2, lifecycle_at=now(), lifecycle_by=$3, lifecycle_synced=$4, updated_at=now()
      WHERE application_id=$1`, [appId, state, staffId, sitewire === 'synced']);
  return { ok: true, state, inactive, sitewire };
}

/**
 * Reset a file's draw setup so the coordinator can start over / re-push (owner-directed 2026-07-20 — a
 * delete-and-re-push control for testing). Sitewire has NO delete endpoint, so this does the closest safe
 * thing: (1) DEACTIVATES the Sitewire property (`inactive=true`, guarded) so it accepts no more draws, then
 * (2) UNLINKS it in PILOT — the property id is TOMBSTONED into raw.reset_property_ids so the next push skips
 * only THIS previously-created copy in the loan-number collision check (a genuine pre-existing property PILOT
 * never created still parks — the go-forward/only-ours rule is never weakened), the link's property/budget
 * ids are cleared, and every mirrored Sitewire draw/finding/media/crosswalk row for the file is removed so
 * `notLinked` becomes true and the Start-draw card (with all push options) reappears. The money LEDGER
 * (`draw_disbursements`) and lien waivers are KEPT — financial records are never destroyed by a reset. Only
 * a file PILOT actually created can be reset (`not_managed` otherwise). Requires manage_draws at the route.
 */
async function resetDrawSetup(appId, staffId = null) {
  const link = await getLink(appId);
  if (!link || link.matched_by !== 'created') return { error: 'not_managed' };
  const oldPropId = link.sitewire_property_id;
  if (!oldPropId) {
    // Nothing was ever pushed (setup_status-only row) — just clear any birth-phase status so it's a clean slate.
    await db.query(`UPDATE sitewire_property_links SET raw = COALESCE(raw,'{}'::jsonb) - 'setup_status', state='pending', updated_at=now() WHERE application_id=$1`, [appId]);
    return { ok: true, was_managed: false, sitewire: 'skipped' };
  }
  // (1) deactivate in Sitewire — best-effort so a testing reset is never blocked by a transient Sitewire issue;
  // the property id is tombstoned regardless, so the re-push is clean either way.
  const canSync = cfg.sitewireEnabled && (cfg.sitewireOutboundEnabled || cfg.sitewireDryrun);
  let sitewire = 'skipped', deactivated = false;
  if (canSync) {
    try {
      await circuitCheck(1);
      const property = await client.updateProperty(oldPropId, { inactive: true });
      if (property && property.__dryrun) { sitewire = 'dryrun'; }
      else {
        await journal({ appId, propertyId: oldPropId, entity: 'property', entityId: oldPropId, field: 'inactive', oldValue: false, newValue: true, source: 'reset' });
        sitewire = 'synced'; deactivated = true;
      }
    } catch (e) { sitewire = 'failed'; console.warn(`[sitewire] reset: could not deactivate property ${oldPropId} (app=${appId}): ${e && e.message}`); }
  }
  // (2) unlink + tombstone + clear the mirror, atomically. Children before parents; money ledger untouched.
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM draw_finding_lines WHERE finding_id IN (SELECT id FROM draw_findings WHERE application_id=$1)`, [appId]);
    await c.query(`DELETE FROM draw_findings WHERE application_id=$1`, [appId]);
    await c.query(`DELETE FROM draw_media WHERE application_id=$1`, [appId]);
    await c.query(`DELETE FROM sitewire_draw_requests WHERE sitewire_draw_id IN (SELECT sitewire_draw_id FROM sitewire_draws WHERE application_id=$1)`, [appId]);
    await c.query(`DELETE FROM sitewire_draws WHERE application_id=$1`, [appId]);
    await c.query(`DELETE FROM sitewire_job_item_links WHERE application_id=$1`, [appId]);
    await c.query(
      `UPDATE sitewire_property_links
          SET sitewire_property_id=NULL, sitewire_budget_id=NULL, state='pending', pushed_at=NULL,
              lifecycle_state='active',
              raw = jsonb_set(COALESCE(raw,'{}'::jsonb) - 'setup_status', '{reset_property_ids}',
                              COALESCE(raw->'reset_property_ids','[]'::jsonb) || to_jsonb($2::text)),
              updated_at=now()
        WHERE application_id=$1`, [appId, String(oldPropId)]);
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { c.release(); }
  return { ok: true, was_managed: true, old_property_id: oldPropId, sitewire, deactivated };
}

/* Live read of Sitewire's borrower-invite state for a managed file (owner-directed 2026-07-20 — "see whether
   Sitewire invited the borrower"). Sitewire owns the invite email + its status; we surface the state it exposes
   on the property (`borrower.status`: unassigned → invited → assigned). Best-effort: null/unavailable when
   Sitewire reads are off or the call fails. Staff-only (the route is manage_draws). */
async function getBorrowerInviteStatus(appId) {
  const link = await getLink(appId);
  if (!link || !link.sitewire_property_id || link.matched_by !== 'created') return { managed: false };
  if (!cfg.sitewireEnabled) return { managed: true, available: false, reason: 'sitewire_off' };
  try {
    const p = await client.getProperty(link.sitewire_property_id);
    const b = (p && p.borrower) || {};
    return { managed: true, available: true, status: b.status || 'unassigned', contact_email: b.contact_email || null };
  } catch (e) { return { managed: true, available: false, reason: (e && e.message) || 'error' }; }
}

/* (Re)send the Sitewire borrower invite by re-asserting the borrower's contact email on the property — the
   same guarded write the push uses (Sitewire sends its own invite on assign). Mirrors a real Sitewire action
   we couldn't previously trigger on demand. GO-FORWARD ONLY (managed file) + guarded/journaled. */
async function resendBorrowerInvite(appId) {
  const link = await getLink(appId);
  if (!link || !link.sitewire_property_id || link.matched_by !== 'created') return { error: 'not_managed' };
  const a = await loadFile(appId);
  if (!a || !a.borrower_email) return { error: 'no_borrower_email' };
  if (!(cfg.sitewireEnabled && (cfg.sitewireOutboundEnabled || cfg.sitewireDryrun))) return { error: 'writes_off' };
  await circuitCheck(1);
  try {
    const res = await client.assignBorrower(link.sitewire_property_id, a.borrower_email);
    if (res && res.__dryrun) return { ok: true, sitewire: 'dryrun', email: a.borrower_email };
    await journal({ appId, propertyId: link.sitewire_property_id, entity: 'borrower', field: 'contact_email', newValue: a.borrower_email, source: 'resend_invite' });
    return { ok: true, sitewire: 'synced', email: a.borrower_email };
  } catch (e) {
    if (e.retryable) return { error: 'transient' };
    return { error: 'sitewire_' + ((e && e.status) || 'error') };
  }
}

/* Sitewire's pipeline / "quick-notify" status labels — the tags a draw can be moved through (e.g. "Sent to
   wire department"). Live read; [] when Sitewire is off. (owner-directed 2026-07-20 — mirror every Sitewire
   action into PILOT.) */
async function listQuickNotifyStatuses() {
  if (!cfg.sitewireEnabled) return [];
  try {
    const r = await client.listQuickNotifyStatuses();
    const arr = Array.isArray(r) ? r : (r && (r.quick_notify_statuses || r.data)) || [];
    return (Array.isArray(arr) ? arr : []).map((s) => ({ id: s.id, name: s.name || s.label || String(s.id) }));
  } catch (_) { return []; }
}

/* Set a draw's pipeline/quick-notify status in Sitewire (the same status control Sitewire's own UI has),
   through the guarded path: circuit check -> updateDraw -> read-after-write -> journal -> store locally.
   GO-FORWARD ONLY (a managed draw on this file). Passing null clears it. */
async function setDrawQuickNotify(appId, drawId, statusId) {
  const own = (await db.query(`SELECT sitewire_draw_id FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId])).rows[0];
  if (!own) return { error: 'draw_not_on_file' };
  if (!(cfg.sitewireEnabled && (cfg.sitewireOutboundEnabled || cfg.sitewireDryrun))) return { error: 'writes_off' };
  const sid = (statusId == null || statusId === '') ? null : Number(statusId);
  if (sid != null && !Number.isFinite(sid)) return { error: 'bad_status' };
  // A pipeline status can only be MOVED between real statuses, never CLEARED to null: the guarded client
  // (guardNoUnsafeWrite) refuses any null-bearing body outright (a field-clearing null is never sent), so a
  // "clear to none" write is impossible by design. Reject it cleanly here instead of letting it throw an
  // opaque unsafe-write 502.
  if (sid == null) return { error: 'clear_unsupported' };
  await circuitCheck(1);
  try {
    const res = await client.updateDraw(drawId, { quick_notify_status_id: sid });
    if (res && res.__dryrun) return { ok: true, sitewire: 'dryrun', quick_notify_status_id: sid };
    // read-after-write: re-GET the draw and confirm the status persisted.
    let confirmed = sid;
    try {
      const fresh = await client.getDraw(drawId);
      const got = fresh && (fresh.quick_notify_status_id !== undefined ? fresh.quick_notify_status_id : (fresh.draw && fresh.draw.quick_notify_status_id));
      if (got !== undefined) confirmed = got == null ? null : Number(got);
    } catch (_) { /* verify best-effort; reconcile re-checks */ }
    await db.query(`UPDATE sitewire_draws SET quick_notify_status_id=$3, updated_at=now() WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId, confirmed]);
    await journal({ appId, entity: 'draw', entityId: drawId, field: 'quick_notify_status_id', newValue: confirmed, source: 'quick_notify' });
    return { ok: true, sitewire: 'synced', quick_notify_status_id: confirmed };
  } catch (e) { if (e && e.retryable) return { error: 'transient' }; return { error: 'sitewire_' + ((e && e.status) || 'error') }; }
}

/* The Sitewire property's own documents (whatever the borrower/inspector uploaded on Sitewire's side) — a
   LIVE read of property.documents[]. We surface them (name + open link) so the coordinator sees everything
   Sitewire holds without leaving PILOT. Read-only; [] when off / not managed. URLs are Sitewire's (may expire). */
async function getSitewireDocuments(appId) {
  const link = await getLink(appId);
  if (!link || !link.sitewire_property_id || link.matched_by !== 'created') return { managed: false, documents: [] };
  if (!cfg.sitewireEnabled) return { managed: true, available: false, documents: [] };
  try {
    const p = await client.getProperty(link.sitewire_property_id);
    const docs = (p && (p.documents || (p.property && p.property.documents))) || [];
    const safeUrl = (u) => { try { const x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : null; } catch (_) { return null; } };
    return { managed: true, available: true, documents: (Array.isArray(docs) ? docs : []).map((d) => ({
      name: d.name || d.filename || d.title || 'Document',
      url: safeUrl(d.url || d.src || d.download_url || d.file_url), // only http(s) — never a javascript:/data: href
      kind: d.kind || d.type || d.document_type || null,
      uploaded_at: d.created_at || d.uploaded_at || d.inserted_at || null,
    })) };
  } catch (e) { return { managed: true, available: false, documents: [], error: (e && e.message) || 'error' }; }
}

module.exports = { pushFile, pushBudget, setPropertyLifecycle, resetDrawSetup, collisionProperty, getBorrowerInviteStatus, resendBorrowerInvite, listQuickNotifyStatuses, setDrawQuickNotify, getSitewireDocuments, park, journal, circuitCheck, resolveCapitalPartnerId, resolveRule, resolveInspection, resolveCoordinatorId, getLink, loadFile, isManaged, recordSetupStatus, SITEWIRE_BIRTH_REASONS, LIFECYCLE_STATES };
