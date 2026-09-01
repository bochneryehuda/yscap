'use strict';
/**
 * THE LONG-TERM CONDITIONS ARE CHECKLIST ITEMS NOW — proven against a REAL
 * Postgres, through the REAL boot replay and the REAL sign-off gate.
 *
 * db/652 made `checklist_items` / `documents` accept a fourth owner and NOTHING
 * used it; db/653 + this shipment make the Long-Term condition BE a
 * `checklist_item`, which is what lets the one shared upload/review/serve
 * service be mounted for it at all. This suite is the proof of every claim in
 * that sentence.
 *
 * NAMED `test-lt-…` ON PURPOSE: the separation gate reads a suite's FILENAME as
 * its product identity (`isLtTest`, scripts/check-product-separation.js), and
 * this one names `lt_loans`, `checklist_items.lt_loan_id` and requires
 * `src/longterm/**`. A suite proving a SHARED door from BOTH sides has to be
 * able to name the Long-Term table, and only a `scripts/test-lt-*.js` name may.
 *
 * WHAT IT PINS — every one of these is a way the sharing could be wrong while
 * every screen still looked fine:
 *
 *  A. db/653 applies through the REAL boot replay, TWICE. `ensureSchema` replays
 *     every db/*.sql on every boot, so a statement that is not idempotent is not
 *     a one-off bug — it breaks every deploy from the second one onwards, and it
 *     takes the rest of its own file down with it (one file, one transaction).
 *  B. The owner's 28 conditions seed into `checklist_templates` as
 *     `scope='lt_loan'`, and EVERY enumerated value they carry is one the LIVE
 *     CHECK constraints actually admit — read out of `pg_constraint`, not out of
 *     a copy written down beside the column.
 *  C. Instantiating a loan produces `checklist_items` owned by `lt_loan_id` and
 *     by NOTHING else — `chk_one_owner` counts exactly one, and the RTL owner
 *     columns are NULL on every row.
 *  D. The partial unique index REALLY suppresses a duplicate: a second row for
 *     the same (loan, template) is refused BY THE DATABASE, not by a read the
 *     engine did a moment earlier (db/401 is the incident where that difference
 *     cost real duplicate conditions).
 *  E. THE CONTROL. An RTL application-scoped template and item behave EXACTLY as
 *     before — the same refusal, in the same words, and the new generic
 *     required-slots arm is a no-op for them because RTL writes that column
 *     nowhere. Proven from BOTH sides: the arm answers null, AND the arm really
 *     bites when a row does carry slots.
 *  F. THE POINT OF THE WHOLE PACKAGE. A Long-Term DOCUMENT condition CANNOT be
 *     signed off with nothing uploaded. Before this shipment `signOffGate`
 *     returned null on the first line for any item with no `application_id`, so
 *     the entire gate was a no-op for Long-Term and a document condition signed
 *     off on air.
 *
 * PROBES THE DATABASE FIRST. `ensureSchema` gives up on an unreachable database
 * WITHOUT throwing, so a suite that does not probe prints a confident ok against
 * nothing at all.
 *
 * Run: DATABASE_URL=... node scripts/test-lt-shared-condition-center-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-shared-condition-center-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

const crypto = require('crypto');
const db = require('../src/db');
const { ownerOf, ownerOfRow } = require('../src/lib/condition-owner');
const vocab = require('../src/longterm/conditions-center/vocabulary');
const library = require('../src/longterm/conditions-center/library');
const engine = require('../src/longterm/conditions-center/engine');
const ltWrite = require('../src/longterm/conditions-center/write');
const ltRead = require('../src/longterm/conditions-center/read');
const requiredSlots = require('../src/lib/conditions/required-slots');
const { liveCheckValues } = require('../src/lib/conditions/live-check-values');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const uniq = `ltcc-${process.pid}-${Date.now()}`;

(async () => {
  // THE PROBE. Not decoration: without it an unreachable database produces a
  // green run against nothing.
  await db.query('SELECT 1');

  const { ensureSchema } = require('../src/migrate-boot');

  /* ══════════════════ A. THE MIGRATION, THROUGH THE REAL REPLAY ═════════════ */

  const first = await ensureSchema();
  assert(first.ok === true, 'A1 the first boot replay completes');

  // Every statement in db/653 is ADD COLUMN IF NOT EXISTS or CREATE INDEX IF NOT
  // EXISTS, so a SECOND replay must change nothing and must not throw. A file
  // that throws is logged and SKIPPED — silently — taking every statement after
  // it with it, which is exactly the failure mode this assertion exists for.
  const second = await ensureSchema();
  assert(second.ok === true, 'A2 a second boot replay completes — db/653 is idempotent');

  const cols = (await db.query(
    `SELECT table_name || '.' || column_name AS c
       FROM information_schema.columns
      WHERE (table_name, column_name) IN
            (('checklist_templates','config'),
             ('checklist_items','slots'),
             ('checklist_items','waived_reason'))`)).rows.map((r) => r.c).sort();
  assert(cols.length === 3, `A3 db/653's three columns are live (${cols.join(', ') || 'none'})`);

  const uq = (await db.query(
    `SELECT indexdef FROM pg_indexes
      WHERE indexname = 'uq_checklist_items_lt_one_per_template'`)).rows[0];
  assert(!!uq, 'A4 the partial unique index exists');
  assert(!!uq && /UNIQUE/i.test(uq.indexdef) && /lt_loan_id IS NOT NULL/i.test(uq.indexdef),
    'A5 it is UNIQUE and PARTIAL on lt_loan_id — the RTL rows are untouched by it');

  /* ══════════════ B. THE OWNER'S LIBRARY, IN THE SHARED TABLE ═══════════════ */

  // The vocabulary is checked against the constraints that are ACTUALLY in
  // force, so a migration that narrows one of these columns tomorrow fails HERE
  // rather than as a check violation on somebody's loan file.
  const accepted = await vocab.liveAccepted(db);
  assert(Object.keys(accepted).length === Object.keys(vocab.CONSTRAINT_OF).length,
    `B1 all ${Object.keys(vocab.CONSTRAINT_OF).length} named CHECK constraints were read live`);
  for (const [key, vals] of Object.entries(accepted)) {
    const declared = vocab.ACCEPTED[key].slice().sort().join('|');
    assert(vals.slice().sort().join('|') === declared,
      `B2 the declared ${key} set still equals what the database admits`);
  }

  const verdict = library.verify(accepted);
  assert(verdict.ok === true,
    `B3 the owner's library verifies against the LIVE constraints${verdict.ok ? '' : ` — ${JSON.stringify(verdict.problems.slice(0, 4))}`}`);

  library._resetSeed();
  const seeded = await library.ensureSeeded(db);
  assert(seeded.failed.length === 0,
    `B4 nothing failed to seed${seeded.failed.length ? ` — ${JSON.stringify(seeded.failed.slice(0, 3))}` : ''}`);
  assert(seeded.inserted + seeded.skipped === library.library().length,
    `B5 every one of the ${library.library().length} conditions reached the table`);

  const tpl = (await db.query(
    `SELECT code, scope, audience, category, item_kind, tool_key, is_active, config, auto_apply
       FROM checklist_templates WHERE scope = 'lt_loan' ORDER BY sort_order, code`)).rows;
  /* THE TABLE MAY HOLD MORE ROWS THAN THE LIBRARY, and since db/660 it does.
     A retired condition is `is_active = false` and STAYS in the table — every file
     that carries one points at that row, so deleting it would take their history —
     while the library is what a new database is seeded from and what the engine
     reads. So the count that means something is the ACTIVE one, and the extras are
     asserted to be exactly the retired set rather than waved through. */
  const activeTpl = tpl.filter((r) => r.is_active);
  assert(activeTpl.length === library.library().length,
    `B6 ${activeTpl.length} ACTIVE lt_loan-scoped templates are in checklist_templates, one per condition in the library`);
  assert(tpl.filter((r) => !r.is_active).every((r) => r.config && r.config.enabled === false && r.config.disabledReason),
    'B6b …and every inactive one is a RETIRED condition that says so, rather than a row nobody accounted for');
  assert(tpl.every((r) => r.scope === 'lt_loan'), 'B7 every one carries scope=lt_loan');
  assert(tpl.every((r) => /^lt_/.test(r.code)),
    'B8 every code is lt_-prefixed — a collision with an rtl_ template is impossible by naming');

  // The database ACCEPTED these rows, so the values are admissible by
  // construction; what this asserts is that they are the values the MAPPING
  // says, so nobody has quietly widened a column to make a mismatch fit.
  const badAud = tpl.filter((r) => !accepted.audience.includes(r.audience));
  const badCat = tpl.filter((r) => r.category && !accepted.category.includes(r.category));
  const badKind = tpl.filter((r) => !accepted.item_kind.includes(r.item_kind));
  assert(badAud.length === 0 && badCat.length === 0 && badKind.length === 0,
    'B9 every seeded audience / category / item_kind is one the live constraint admits');

  const docTpl = tpl.filter((r) => r.item_kind === 'document');
  assert(docTpl.length > 0 && docTpl.every((r) => r.tool_key === null),
    'B10 a DOCUMENT condition carries no tool_key — which is what puts it in the gate\'s document arm');
  const nonDoc = tpl.filter((r) => r.item_kind !== 'document');
  assert(nonDoc.every((r) => /^lt_/.test(String(r.tool_key || ''))),
    'B11 a form / order / esign condition carries an lt_ tool_key — kept OUT of the document arm the same way RTL keeps its own tool-backed conditions out');
  assert(activeTpl.every((r) => r.config && typeof r.config === 'object' && r.config.enabled === true),
    'B12 the owner\'s per-condition config survives the move, enabled flag and all');

  // The round trip: what the read gives back is the wording the owner's rules
  // are written in, not the shared table's.
  const one = tpl.find((r) => r.category === 'prior_to_approval');
  assert(!!one && vocab.bucketOf(one.category) === 'prior_to_submission',
    'B13 a prior_to_approval row reads back as the owner\'s prior_to_submission');

  /* ══════════════════════════ fixtures ══════════════════════════════════════ */

  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active)
     VALUES ($1,'Percy Processor','processor',true) RETURNING id`,
    [`${uniq}@example.test`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, status) VALUES ($1,'underwriting') RETURNING id`,
    [borrowerId])).rows[0].id;

  // `lt_loans.id` carries no default — the Long-Term side mints its own ids.
  const ltId = crypto.randomUUID();
  await db.query(
    `INSERT INTO lt_loans (id, loan_number, borrower_name, loan_purpose)
     VALUES ($1::uuid, $2, 'Bo Rrower', 'purchase')`, [ltId, `YSCAP-${uniq}`]);

  const LT = ownerOf('lt_loan', ltId);
  const APP = ownerOf('application', appId);

  /* ═══════════════ C. INSTANTIATING A LOAN — OWNED BY ONE THING ═════════════ */

  const pass = await engine.evaluateLoan(ltId, { skipLock: true });
  assert(pass.ok === true, `C1 the engine ran${pass.ok ? '' : ` — ${pass.degraded}`}`);
  assert(pass.added.length > 0, `C2 it attached ${pass.added.length} conditions to the loan`);

  const items = (await db.query(
    `SELECT ci.id, ci.scope, ci.application_id, ci.borrower_id, ci.llc_id, ci.lt_loan_id, ci.template_id,
            ci.item_kind, ci.tool_key, ci.audience, ci.category, ci.status, ci.is_required, ci.slots,
            ci.origin_kind,
            -- the template CODE, so a fixture can tell the conditions apart by the
            -- name the owner uses rather than by whichever row sorts first
            t.code
       FROM checklist_items ci
       LEFT JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.lt_loan_id = $1::uuid
      ORDER BY ci.sort_order, ci.id`, [ltId])).rows;
  assert(items.length === pass.added.length,
    `C3 ${items.length} checklist_items rows are owned by this lt_loan`);
  assert(items.every((r) => r.scope === 'lt_loan'), 'C4 every one carries scope=lt_loan');
  assert(items.every((r) => r.application_id === null && r.borrower_id === null && r.llc_id === null),
    'C5 and by NOTHING else — every RTL owner column is NULL');
  assert(items.every((r) => {
    const o = ownerOfRow(r);
    return o && o.scope === 'lt_loan' && String(o.id) === String(ltId);
  }), 'C6 the shared owner descriptor reads every row back as this Long-Term loan');
  assert(items.every((r) => r.origin_kind === 'auto'),
    'C7 they are the engine\'s own rows, which is what makes them retractable');

  // The RTL engine selects scope='application'; an lt_loan row is invisible to
  // it by construction. Asserted from the data rather than from the code.
  const leaked = (await db.query(
    `SELECT count(*)::int n FROM checklist_items
      WHERE lt_loan_id IS NOT NULL AND scope <> 'lt_loan'`)).rows[0].n;
  assert(leaked === 0, 'C8 no lt_loan-owned row wears an RTL scope');

  /* ══════════════ D. THE DUPLICATE IS REFUSED BY THE DATABASE ═══════════════ */

  const dupe = items[0];
  let dupeErr = null;
  try {
    await db.query(
      `INSERT INTO checklist_items (scope, lt_loan_id, template_id, label, status)
       VALUES ('lt_loan', $1::uuid, $2::uuid, 'a second copy', 'outstanding')`,
      [ltId, dupe.template_id]);
  } catch (e) { dupeErr = e; }
  assert(dupeErr && dupeErr.code === '23505',
    `D1 a second row for the same (loan, template) is refused by the unique index (${dupeErr ? dupeErr.code : 'INSERTED'})`);

  // The SAME template on a DIFFERENT loan is not a duplicate, and a per-line
  // condition (its own field_key) is allowed its several rows — the COALESCE on
  // field_key in the index is what makes both true.
  const ltId2 = crypto.randomUUID();
  await db.query(
    `INSERT INTO lt_loans (id, loan_number, borrower_name, loan_purpose)
     VALUES ($1::uuid, $2, 'Bo Rrower', 'purchase')`, [ltId2, `YSCAP-${uniq}-b`]);
  let otherLoanOk = true;
  try {
    await db.query(
      `INSERT INTO checklist_items (scope, lt_loan_id, template_id, label, status)
       VALUES ('lt_loan', $1::uuid, $2::uuid, 'same template, other loan', 'outstanding')`,
      [ltId2, dupe.template_id]);
  } catch (_) { otherLoanOk = false; }
  assert(otherLoanOk, 'D2 the same template on ANOTHER loan is not a duplicate');

  let perLineOk = true;
  try {
    await db.query(
      `INSERT INTO checklist_items (scope, lt_loan_id, template_id, field_key, label, status)
       VALUES ('lt_loan', $1::uuid, $2::uuid, 'line-2', 'a per-line instance', 'outstanding')`,
      [ltId, dupe.template_id]);
  } catch (_) { perLineOk = false; }
  assert(perLineOk, 'D3 a per-line instance keyed by field_key is still allowed');

  // A second engine pass must add nothing — the index is the guarantee, the
  // pass is what proves the engine reads it as such rather than erroring.
  const again = await engine.evaluateLoan(ltId, { skipLock: true });
  assert(again.ok === true && again.added.length === 0,
    `D4 a second engine pass adds nothing (added ${again.added.length})`);

  /* ══════════════════ E. THE CONTROL — RTL IS UNTOUCHED ════════════════════ */

  const staffMod = require('../src/routes/staff');
  const gate = staffMod.signOffGate;
  assert(typeof gate === 'function', 'E0 the shared sign-off gate is reachable');

  const rtlDocItem = (await db.query(
    `INSERT INTO checklist_items (scope, application_id, label, audience, item_kind, is_required, status)
     VALUES ('application', $1::uuid, 'RTL insurance binder', 'staff', 'document', true, 'outstanding')
     RETURNING id`, [appId])).rows[0].id;
  const rtlBlock = await gate(rtlDocItem, { kind: 'staff', role: 'processor', id: staffId });
  assert(typeof rtlBlock === 'string' && /cannot be completed with nothing uploaded/.test(rtlBlock),
    `E1 an RTL document condition with nothing uploaded still refuses, in the same words (${JSON.stringify(String(rtlBlock).slice(0, 60))})`);

  const rtlOptional = (await db.query(
    `INSERT INTO checklist_items (scope, application_id, label, audience, item_kind, is_required, status)
     VALUES ('application', $1::uuid, 'RTL optional note', 'staff', 'document', false, 'outstanding')
     RETURNING id`, [appId])).rows[0].id;
  assert((await gate(rtlOptional, { kind: 'staff', role: 'processor', id: staffId })) === null,
    'E2 an OPTIONAL RTL condition still completes empty — that is what optional means');

  // THE NEW GENERIC ARM IS A NO-OP FOR RTL BY CONSTRUCTION, and that is a fact
  // about the DATA, not a promise about a code path: RTL writes
  // `checklist_items.slots` nowhere, so the arm returns on its first line.
  const rtlSlots = (await db.query(
    `SELECT count(*)::int n FROM checklist_items
      WHERE application_id IS NOT NULL AND slots IS NOT NULL`)).rows[0].n;
  assert(rtlSlots === 0, `E3 no application-owned item carries a per-item slot list (${rtlSlots})`);
  assert((await requiredSlots.gateProblem(rtlDocItem, db)) === null,
    'E4 the generic required-slots arm answers null for an RTL condition');

  // …and it genuinely BITES when a row does carry one, so E4 is not a test that
  // passes because the arm is broken.
  await db.query(`UPDATE checklist_items SET slots = $2::jsonb WHERE id = $1`,
    [rtlDocItem, JSON.stringify([{ key: 'binder', label: 'Insurance binder', required: true }])]);
  const armBites = await requiredSlots.gateProblem(rtlDocItem, db);
  assert(typeof armBites === 'string' && /Still waiting on: Insurance binder/.test(armBites),
    `E5 the arm refuses when a row DOES declare a required slot (${JSON.stringify(String(armBites).slice(0, 60))})`);
  // REQUIRED BY DEFAULT — a slot list is a list of what the condition NEEDS, and
  // `required: false` is the deliberate exception. Asserted directly because the
  // owner's own library states the flag on every slot, so the two readings agree
  // on that data and a mutation to `required === true` sails past every other
  // assertion here while turning a typo'd slot list into one that gates on
  // nothing. (Found by running exactly that mutation.)
  await db.query(`UPDATE checklist_items SET slots = $2::jsonb WHERE id = $1`,
    [rtlDocItem, JSON.stringify([{ key: 'binder', label: 'Insurance binder' }])]);
  const armDefault = await requiredSlots.gateProblem(rtlDocItem, db);
  assert(armDefault === requiredSlots.missingSlotsMsg(['Insurance binder']),
    `E5b a slot that does not say otherwise is REQUIRED (${JSON.stringify(String(armDefault).slice(0, 50))})`);
  assert(requiredSlots.missingSlots([{ key: 'x', label: 'Optional extra', required: false }], []).length === 0,
    'E5c …and `required: false` is honoured, so an optional slot never gates');

  await db.query(`UPDATE checklist_items SET slots = NULL WHERE id = $1`, [rtlDocItem]);

  // The three RTL templates that DO carry a slot list keep it on the TEMPLATE,
  // which the arm deliberately never reads — reading it there would have started
  // demanding the criminal report on every file and the appraisal XML on a file
  // whose XML is waived.
  const tplSlots = (await db.query(
    `SELECT code FROM checklist_templates
      WHERE scope = 'application' AND slots IS NOT NULL
        AND slots::text NOT IN ('null','[]') ORDER BY code`)).rows.map((r) => r.code);
  assert(tplSlots.length > 0, `E6 RTL templates still carry their own slot lists (${tplSlots.join(', ')})`);
  const tplSlotItems = (await db.query(
    `SELECT count(*)::int n FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE t.scope = 'application' AND ci.slots IS NOT NULL`)).rows[0].n;
  assert(tplSlotItems === 0, 'E7 …and none of it is copied onto an item, so the generic arm never sees it');

  /* ═════════ F. THE POINT — A LONG-TERM DOCUMENT CONDITION CANNOT SIGN OFF ══ */

  // PICKED DETERMINISTICALLY, and the two halves are picked APART. A condition
  // that declares required slots is refused by the generic slots arm — which
  // runs BEFORE the item is even loaded — so using one here would prove the
  // slots arm rather than the thing this section is about. The first cut of this
  // suite took whichever row the database happened to return first and passed or
  // failed depending on that; a fixture must stage the case it claims to test.
  const reqSlots = (r) => (Array.isArray(r.slots) ? r.slots : []).filter((x) => x && x.required !== false);
  /* AND A THIRD CUT MUST BE MADE, which the first version of this fixture missed:
     exclude the conditions governed by lib/conditions/answers.js. Those are
     `item_kind='document'` on purpose (so that if the answers rule ever stopped
     governing them the gate would fall back to asking for the statement — the safe
     way to be wrong), but the owner said plainly that they need no document at all:
     "you can just select that it's FCI, whatever, and then you don't need anything,
     not an attachment and not a form." The gate therefore ALLOWS them, correctly.
     This section is about the conditions that genuinely do need a document, and
     the earlier fixture picked lt_reo_liabilities — sort_order 1, no slots, and
     governed — so F1..F5 were all demonstrated on the one row that proves the
     opposite of what they claim. */
  const governed = new Set(require('../src/lib/conditions/answers').GOVERNED_CODES);
  const ltDocs = items.filter((r) => r.item_kind === 'document' && r.is_required !== false
    && !governed.has(r.code));
  const ltDoc = ltDocs.find((r) => reqSlots(r).length === 0);
  assert(ltDoc && !governed.has(ltDoc.code),
    `F0 the fixture is a condition that REALLY needs a document (picked ${ltDoc && ltDoc.code})`);
  const ltSlotted = ltDocs.find((r) => reqSlots(r).length > 0);
  assert(!!ltDoc, 'F0 the loan carries a required Long-Term DOCUMENT condition with no named slots');
  // A MISSING FIXTURE MUST FAIL CLEANLY, NOT THROW. A crashing assertion also
  // "fails" and looks exactly like proof, while actually stopping the battery
  // where it stands and reporting a pass rate that means nothing — a mutation of
  // the engine's owner columns did precisely that here before this guard.
  if (!ltDoc) {
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll assertions passed.');
    process.exit(1);
  }

  const ltBlock = await gate(ltDoc.id, { kind: 'staff', role: 'processor', id: staffId });
  assert(typeof ltBlock === 'string' && /cannot be completed with nothing uploaded/.test(ltBlock),
    `F1 IT REFUSES — a Long-Term document condition cannot sign off with nothing uploaded (${JSON.stringify(String(ltBlock).slice(0, 70))})`);
  assert(ltBlock === rtlBlock,
    'F2 …in the SAME sentence the RTL side refuses in — one wording, both products');

  // A document nobody has decided on is not fulfilment either, and the refusal
  // says which problem it is.
  const pendingDoc = (await db.query(
    `INSERT INTO documents (lt_loan_id, checklist_item_id, filename, storage_ref, review_status, is_current, uploaded_by_kind)
     VALUES ($1::uuid, $2::uuid, 'statement.pdf', $3, 'pending', true, 'staff') RETURNING id`,
    [ltId, ltDoc.id, `${uniq}/pending.pdf`])).rows[0].id;
  const pendingBlock = await gate(ltDoc.id, { kind: 'staff', role: 'processor', id: staffId });
  // The wording is asked of the ONE definition rather than retyped here — a
  // hand-copied sentence is a second copy of the wording, and this suite would
  // then be pinning its own transcription rather than the door's answer.
  const docAccept = require('../src/lib/document-acceptance');
  assert(pendingBlock === docAccept.pendingDocsMsg(1, ['statement.pdf']),
    `F3 a PENDING document refuses too, and says so (${JSON.stringify(String(pendingBlock).slice(0, 60))})`);

  await db.query(`UPDATE documents SET review_status='rejected' WHERE id=$1`, [pendingDoc]);
  const rejectedBlock = await gate(ltDoc.id, { kind: 'staff', role: 'processor', id: staffId });
  assert(rejectedBlock === docAccept.ALL_REJECTED_MSG,
    'F4 an all-rejected condition gets the different, actionable refusal — not "upload something" about a document already there');

  await db.query(`UPDATE documents SET review_status='accepted' WHERE id=$1`, [pendingDoc]);
  assert((await gate(ltDoc.id, { kind: 'staff', role: 'processor', id: staffId })) === null,
    'F5 …and it CLEARS once a document is accepted');

  // AND THE PORTED SLOTS RULE REALLY GOVERNS A LONG-TERM CONDITION — the half of
  // the port that RTL has no generic version of. It runs ahead of the document
  // arm, so a condition asking for two named documents refuses by NAME rather
  // than with the generic "upload something".
  if (ltSlotted) {
    const want = reqSlots(ltSlotted).map((x) => x.label || x.key);
    const slotBlock = await gate(ltSlotted.id, { kind: 'staff', role: 'processor', id: staffId });
    assert(slotBlock === requiredSlots.missingSlotsMsg(want),
      `F5b a slot-bearing Long-Term condition is refused BY SLOT NAME (${JSON.stringify(String(slotBlock).slice(0, 60))})`);
  } else {
    assert(false, 'F5b the loan carries a Long-Term condition with named required slots');
  }

  // A non-document Long-Term condition is answered another way and must not be
  // refused for want of a document it never asks for.
  const ltForm = items.find((r) => r.item_kind !== 'document');
  if (ltForm) {
    assert((await gate(ltForm.id, { kind: 'staff', role: 'processor', id: staffId })) === null,
      'F6 a Long-Term form / order condition is not refused for want of a document');
  }

  // The other two owner scopes keep the historical no-op to the byte: they carry
  // no document rules, and widening the gate must not have given them any.
  const llcId = (await db.query(
    `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1::uuid, $2) RETURNING id`,
    [borrowerId, `${uniq} Holdings LLC`])).rows[0].id;
  const llcItem = (await db.query(
    `INSERT INTO checklist_items (scope, llc_id, label, audience, item_kind, is_required, status)
     VALUES ('llc', $1::uuid, 'Operating agreement', 'staff', 'document', true, 'outstanding')
     RETURNING id`, [llcId])).rows[0].id;
  assert((await gate(llcItem, { kind: 'staff', role: 'processor', id: staffId })) === null,
    'F7 an LLC-scoped item still passes the gate untouched — the widening added no rules to the scopes that had none');

  const profileItem = (await db.query(
    `INSERT INTO checklist_items (scope, borrower_id, label, audience, item_kind, is_required, status)
     VALUES ('borrower_profile', $1::uuid, 'Photo ID', 'staff', 'document', true, 'outstanding')
     RETURNING id`, [borrowerId])).rows[0].id;
  assert((await gate(profileItem, { kind: 'staff', role: 'processor', id: staffId })) === null,
    'F8 …and so does a borrower-profile item');

  /* ═══════════ G. THE SIX STATUSES ROUND-TRIP THROUGH THE SHARED FIVE ═══════ */

  // EVERY DOOR IS CALLED THROUGH `tried`, so a statement the database REFUSES is
  // reported as the failing assertion rather than killing the run. A mapping
  // mutated into widening the status column raises a check violation here, and a
  // crash that stops the battery reads as proof while proving nothing.
  const tried = async (fn) => { try { return await fn(); } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 120) }; } };

  const w = await tried(() => ltWrite.waive(ltId, ltDoc.id, staffId, 'the servicer confirmed it in writing'));
  assert(w.ok === true && w.condition && w.condition.status === 'waived',
    `G1 a waive reads back as WAIVED, not as satisfied (${w.ok ? w.condition.status : w.error})`);
  const waived = (await db.query(
    `SELECT status, waived_at, waived_reason, is_required FROM checklist_items WHERE id=$1`,
    [ltDoc.id])).rows[0];
  assert(waived.status === 'satisfied' && waived.waived_at !== null,
    'G2 …stored the way this system already records a waive — satisfied plus the stamp');
  assert(String(waived.waived_reason || '').startsWith('the servicer confirmed'),
    'G3 …with the REASON in its own column (db/653), not buried in free-text notes');
  assert(waived.is_required === true,
    'G4 a waived condition stays REQUIRED — somebody decided against it, which is not the same as it never applying');

  const na = await tried(() => ltWrite.setStatus(ltId, ltDoc.id, 'not_applicable'));
  assert(na.ok === true && na.condition && na.condition.status === 'not_applicable',
    `G5 "did not apply" reads back as itself (${na.ok ? na.condition.status : na.error})`);
  const naRow = (await db.query(
    `SELECT status, waived_at, is_required FROM checklist_items WHERE id=$1`, [ltDoc.id])).rows[0];
  assert(naRow.status === 'satisfied' && naRow.waived_at !== null && naRow.is_required === false,
    'G6 …stored as satisfied + the stamp + is_required=false, exactly as this system already reads a not-applicable condition');

  const ip = await tried(() => ltWrite.setStatus(ltId, ltDoc.id, 'in_progress'));
  assert(ip.ok === true && ip.condition && ip.condition.status === 'in_progress',
    `G7 in_progress round-trips through the shared "requested" rung (${ip.ok ? ip.condition.status : ip.error})`);
  const ipRow = (await db.query(
    `SELECT status, waived_at FROM checklist_items WHERE id=$1`, [ltDoc.id])).rows[0];
  assert(ipRow.status === 'requested' && ipRow.waived_at === null,
    'G8 …and moving off a waive clears the stamp, so no row ever contradicts itself');

  /* ═════════ H. THE READ — THREE NUMBERS, NEVER ONE, AND THE CLIENT'S OWN ══ */

  // The read's statement is ASSEMBLED (`WHERE ${owner descriptor}`), so it is not
  // a statement until a caller builds it and cannot be planned from source — the
  // only way to know the shared table answers it is to run it. That is also what
  // `test-lt-sql-prepared-db.js` requires of every interpolated statement here.
  const view = await ltRead.forLoan(ltId, { audience: 'internal' });
  assert(view.degraded === null, `H1 the read completes against the shared table (${view.degraded || 'ok'})`);
  assert(view.summary.total === items.length + 1,
    `H2 it reads back every condition on the loan (${view.summary.total})`);

  // THE THREE NUMBERS NEVER COLLAPSE. `satisfied`, `waived` and `did not apply`
  // are three different facts, and the last two are the ones asked about a year
  // later — they are recovered from (status, waived_at, is_required), which is
  // the whole reason the mapping is lossless.
  const na2 = await tried(() => ltWrite.setStatus(ltId, ltDoc.id, 'not_applicable'));
  assert(na2.ok === true, 'H3 a condition is marked as never having applied');
  const w2 = await tried(() => ltWrite.waive(ltId, ltSlotted.id, staffId, 'the landlord confirmed it by email'));
  assert(w2.ok === true, 'H4 …and another is waived with a reason');
  const after = await ltRead.forLoan(ltId, { audience: 'internal' });
  assert(after.summary.notApplicable === 1 && after.summary.waived === 1,
    `H5 the read reports them SEPARATELY — ${after.summary.waived} waived, ${after.summary.notApplicable} did not apply (never one number)`);
  assert(after.summary.done === 2, 'H6 …while both still count as no longer work');

  // The client's payload is BUILT for the client rather than an internal one with
  // fields deleted — the internal note, who signed it off and why it was waived
  // are facts about how WE work and are never in it.
  const client = await ltRead.forLoan(ltId, { audience: 'client' });
  const clientRows = client.buckets.flatMap((b) => b.conditions);
  assert(clientRows.length > 0, `H7 a borrower sees the conditions that are theirs (${clientRows.length})`);
  assert(clientRows.every((c) => c.notes === undefined && c.waivedReason === undefined
    && c.satisfiedBy === undefined && c.config === undefined),
    'H8 …and none of the internal facts ride along');

  /* ═════════ I. THE OWNER'S OWN RULE SURVIVES THE SHARED GATE ═══════════════
     Two of these conditions are a CHOICE, not an upload — the owner: "you can just
     select that it's FCI, whatever, and then you don't need anything, not an
     attachment and not a form." They are item_kind='document' deliberately, so a
     gate that only looked at the kind refuses them FOREVER with no way through but
     a super-admin override. That is what the widened gate did before this arm, and
     it disagreed with the Long-Term product door, which allowed the same answer. */
  const ACTOR = { kind: 'staff', role: 'processor', id: staffId };
  const answersLib = require('../src/lib/conditions/answers');
  const governedItems = items.filter((r) => answersLib.GOVERNED_CODES.includes(r.code));
  assert(governedItems.length > 0, `I1 the loan carries the conditions the owner answers another way (${governedItems.length})`);

  /* lt_subject_mortgage_statement is autoApply:'rules', so it is only on a file the
     rules put it on — and it was NOT on this fixture, which meant I2 and I4 below
     silently skipped. A skipped assertion about the owner's headline rule is worth
     nothing, so the condition is attached here on purpose. */
  let fci = governedItems.find((r) => r.code === 'lt_subject_mortgage_statement');
  if (!fci) {
    const tpl = (await db.query(
      `SELECT id FROM checklist_templates WHERE code='lt_subject_mortgage_statement' AND scope='lt_loan'`)).rows[0];
    assert(!!tpl, 'I1a the subject-mortgage template really is in the shared library');
    const id = (await db.query(
      `INSERT INTO checklist_items (template_id, scope, lt_loan_id, label, audience, item_kind, is_required, status)
       VALUES ($1,'lt_loan',$2::uuid,'Subject property mortgage','both','document',true,'outstanding')
       RETURNING id`, [tpl.id, ltId])).rows[0].id;
    fci = { id, code: 'lt_subject_mortgage_statement' };
  }
  assert(!!fci, 'I1b the subject-mortgage condition is on the file, so the assertions below really run');
  {
    /* THE FCI WAY IS NO LONGER A WAIVER (owner-directed 2026-08-31): it answers
       the SERVICER by itself and still asks for the FCI loan number and the
       outstanding balance, which our processor looks up in FCI. Re-pointed at
       that rule, and asserting BOTH halves — a gate that simply stopped honouring
       the way would satisfy the first line and be just as wrong. */
    await db.query("UPDATE checklist_items SET tool_payload=$2 WHERE id=$1",
      [fci.id, JSON.stringify({ way: 'fci_serviced' })]);
    assert(await gate(fci.id, ACTOR) !== null,
      'I2 the FCI answer alone is held until the two numbers our processor looks up are in');
    await db.query("UPDATE checklist_items SET tool_payload=$2 WHERE id=$1",
      [fci.id, JSON.stringify({ way: 'fci_serviced', values: { loan_number: 'FCI-4471', outstanding_balance: 388000 } })]);
    assert(await gate(fci.id, ACTOR) === null,
      'I2b and with them it finishes the subject-mortgage condition — no attachment, no form');
  }
  const reo = governedItems.find((r) => r.code === 'lt_reo_liabilities');
  if (reo) {
    await db.query("UPDATE checklist_items SET tool_payload=$2 WHERE id=$1",
      [reo.id, JSON.stringify({ mortgages: [] })]);
    assert(await gate(reo.id, ACTOR) === null,
      'I3 a file with no mortgages on the credit report is ANSWERED, not blocked');
  }
  // …and the arm is NOT a blanket exemption: an unanswered one is still refused.
  if (fci) {
    await db.query("UPDATE checklist_items SET tool_payload=NULL WHERE id=$1", [fci.id]);
    assert(await gate(fci.id, ACTOR) !== null,
      'I4 …but an UNANSWERED one is still refused — the arm honours the answer, it does not exempt the condition');
  }

  /* ═════════ J. THE RTL CONDITION STUDIO CANNOT REACH LONG-TERM ═════════════
     checklist_templates stopped being one product's table. The Studio read and
     wrote it with no scope filter, so an RTL admin could switch a Long-Term
     condition off, or DELETE it off every Long-Term loan. */
  /* READ THE REAL LIST OFF THE MODULE. Re-declaring it here would assert against
     this suite's own copy and stay green while the production one was widened —
     which is precisely what the first cut of this assertion did: adding 'lt_loan'
     to the module's list broke nothing. */
  const studioScopes = require('../src/routes/admin-conditions').STUDIO_SCOPES;
  assert(Array.isArray(studioScopes) && studioScopes.length > 0,
    'J0 the Studio exposes the scope list it actually uses');
  assert(!studioScopes.includes('lt_loan'),
    `J1 the Studio's own scope list does not include lt_loan (got ${JSON.stringify(studioScopes)})`);
  const reachable = (await db.query(
    `SELECT count(*) c FROM checklist_templates WHERE scope='lt_loan' AND scope = ANY($1)`, [studioScopes])).rows[0].c;
  assert(Number(reachable) === 0, 'J1a …so no Long-Term template is reachable through it');
  /* EVERY DOOR THAT REACHES A TEMPLATE BY ID MUST ALSO NAME THE SCOPE — asserted
     as that PROPERTY, not as a count. The first cut counted occurrences of a
     placeholder string and had to be edited the moment more statements were
     scoped, which is a test that tracks the code's shape instead of its rule.
     Removing the guard from the DELETE alone is the dangerous case
     (`?removeFromFiles=1` strips the condition off every Long-Term loan), so what
     matters is that NO statement reaches a template by bare id. */
  const studioSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/routes/admin-conditions.js'), 'utf8');
  const byId = [...studioSrc.matchAll(/`([^`]*checklist_templates[^`]*)`/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    // Only statements whose PRIMARY target is checklist_templates. A query that
    // merely mentions the table inside a count() subquery (the custom-fields door
    // does) is not a template door and must not be demanded to carry the scope.
    // The id predicate must be the TEMPLATE's own — unqualified, or on the `t`
    // alias this file uses for checklist_templates. The custom-fields door filters
    // `cf.id=$1` and merely MENTIONS checklist_templates inside count() subqueries;
    // it is not a template door and must not be asked to carry the scope.
    .filter((q) => /(?<![\w.])(?:t\.)?id\s*=\s*\$1\b/.test(q));
  assert(byId.length >= 4, `J3 the Studio really does have doors that reach a template by id (${byId.length})`);
  const unscoped = byId.filter((q) => !/scope\s*=\s*ANY\(/.test(q));
  assert(unscoped.length === 0,
    `J3a every one of them names the scope too — unscoped: ${JSON.stringify(unscoped)}`);
  // And the LIST door is scoped as well, though it takes no id.
  assert(/FROM checklist_templates t[\s\S]{0,400}?WHERE t\.scope = ANY\(\$1\)/.test(studioSrc),
    'J3b the list door is scoped');

  // AND IT STILL SHOWS WHAT IT ALWAYS SHOWED — this must not narrow to
  // 'application' and quietly drop the borrower-profile and per-entity rows.
  const kept = (await db.query(
    `SELECT count(*) c FROM checklist_templates WHERE scope = ANY($1)`, [studioScopes])).rows[0].c;
  const historical = (await db.query(
    `SELECT count(*) c FROM checklist_templates WHERE scope IN ('application','borrower_profile','llc')`)).rows[0].c;
  assert(kept === historical, `J4 …and every historically-visible template is still listed (${kept})`);

  /* ═══════════════════════════════ done ════════════════════════════════════ */

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll assertions passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
