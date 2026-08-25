'use strict';
/**
 * THE LONG-TERM BOOK, FOR RECONCILIATION — secret-gated, read-only, match keys only.
 *
 * WHY IT EXISTS. Long-Term is about to become Encompass-first: an office opens the
 * file in Encompass and PILOT opens its ClickUp card. Before that can be switched on,
 * every loan already in the book has to be told which card is already its own, or the
 * first pass opens a second card for every deal the office has ever worked (the
 * owner, 2026-08-23: *"we're going to find ourselves with duplicate ClickUps"*). That
 * one-time match is made off PILOT, by hand and with judgement, against the two
 * sides' loan numbers, addresses and amounts — which means the two sides have to be
 * readable from outside a browser session, once.
 *
 * IT IS THE SIBLING OF `lenderprice-diag.js`, deliberately, and copies its shape
 * rather than inventing one: mounted before the staff-gated `/api/lt` mount, 404 on
 * every path unless a token this deployment's owner set is present, constant-time
 * compare, and no write path anywhere inside it.
 *
 * WHAT IT WILL NOT ANSWER WITH. Match keys only — loan number, Encompass id, the
 * borrower's NAME, the program, the amount, where the file has got to, the officer's
 * folder, the property address, and the dates the two sides were opened and last
 * touched — a date is a match key here, because a card that pre-dates its file is
 * history rather than a link waiting to be made. Deliberately NOT: the borrower's email, phone or
 * Social, the rate, the DSCR, the fees, any document, anything about a condition.
 * None of that helps decide which ClickUp card a loan belongs to, and a diagnostic
 * that hands out more than its job needs is a diagnostic somebody will regret.
 *
 * IT IS OFF UNLESS SOMEBODY TURNS IT ON, AND IT IS REVOCABLE IN ONE MOVE. With
 * `LT_BOOK_DIAG_TOKEN` unset the router does not exist as far as a caller is
 * concerned — every path 404s, which is the honest answer for a feature that is not
 * switched on and gives a prober nothing to work with. Removing the variable turns it
 * off again with no deploy and no code change.
 *
 * PRODUCT SEPARATION: `lt_*` tables and `staff_users` (the shared identity zone,
 * read-only) only. No RTL table is read, and there is no write path of any kind.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const clickup = require('../clickup/client');
const encompass = require('../encompass/client');
const program = require('../clickup/program');
const { PIPELINE, SYNC } = require('../../clickup/fields');

const router = express.Router();

// The gate. Off unless the token is set; then a matching header, compared in
// constant time so a wrong guess tells the caller nothing about how wrong it was.
router.use((req, res, next) => {
  const token = process.env.LT_BOOK_DIAG_TOKEN || '';
  if (!token) return res.status(404).json({ error: 'not_found' });
  const got = String(req.get('x-lt-diag-token') || '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

/**
 * ONE READ. The join is the loan, its property and its officer's name — the three
 * places a match key can live — and nothing else.
 */
const BOOK_SQL = `
  SELECT l.loan_number,
         l.encompass_loan_guid,
         l.borrower_name,
         l.program_name,
         l.product_kind::text        AS product_kind,
         l.loan_purpose::text        AS loan_purpose,
         l.loan_amount,
         l.milestone_name,
         l.stage_key,
         l.loan_folder,
         s.full_name                 AS officer_name,
         p.street, p.city, p.state, p.zip, p.county,
         l.clickup_task_id,
         l.clickup_custom_id,
         l.clickup_link_confidence,
         l.encompass_synced_at,
         l.created_at,
         l.encompass_last_modified,
         l.milestone_since
    FROM lt_loans l
    LEFT JOIN lt_properties p ON p.loan_id  = l.id
    LEFT JOIN staff_users   s ON s.id       = l.loan_officer_id
   ORDER BY l.loan_number NULLS LAST, l.created_at
`;

router.get('/', async (_req, res) => {
  try {
    const { rows } = await db.query(BOOK_SQL);
    const linked = rows.filter((r) => r.clickup_task_id).length;
    res.json({
      ok: true,
      count: rows.length,
      linkedToClickup: linked,
      unlinked: rows.length - linked,
      loans: rows,
    });
  } catch (e) {
    // Say what failed. A diagnostic that answers "server error" is not one.
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

/** The one-line answer, for checking the door works before pulling the whole book. */
router.get('/count', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS loans,
              count(*) FILTER (WHERE loan_number IS NOT NULL)::int AS with_loan_number,
              count(*) FILTER (WHERE clickup_task_id IS NOT NULL)::int AS linked,
              max(encompass_synced_at) AS last_encompass_read
         FROM lt_loans`);
    res.json({ ok: true, ...rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

/**
 * WHEN THE BOOK WAS LAST SWEPT — and why the count endpoint cannot answer it.
 *
 * `/count` reports `max(encompass_synced_at)`, which is the newest SINGLE loan read.
 * That is not the same question as "has the whole book been refreshed", and reading
 * it as if it were is actively misleading: two loans read a minute ago make a book
 * last swept this morning look current. Measured on the live book — a `/count` of
 * 18:02 over a set whose folder data came from the 07:00 sweep.
 *
 * The difference decides whether "the owner's change is not here yet" means "PILOT
 * has not looked" or "Encompass does not have it either", and those send you to two
 * different places. `lt_sync_runs` (db/616) already records every pass with what it
 * discovered and what it read; this hands the last few of them over the same gated
 * door so the question is answered from the record instead of from an inference.
 */
router.get('/runs', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
  try {
    const { rows } = await db.query(
      `SELECT kind, trigger, started_at, finished_at, ok, reason,
              discovered, read_count, failed, skipped, remaining, passes
         FROM lt_sync_runs
        ORDER BY started_at DESC
        LIMIT $1`, [limit]);
    // The newest pass that actually SWEPT the book, as opposed to one that read a
    // couple of due loans. A sweep is what makes the folder on every row current.
    const swept = rows.find((r) => r.kind === 'loans' && Number(r.discovered) > 0) || null;
    res.json({ ok: true, runs: rows, lastSweep: swept });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

/**
 * ASK ENCOMPASS ABOUT ONE LOAN, BOTH WAYS, AND PRINT THE DIFFERENCE.
 *
 * WHY THIS EXISTS. An officer moved files into the Withdrawn folder; PILOT went on
 * showing them as working. Three explanations fit that equally well from the outside
 * — the save did not happen, the pipeline view lags, or the sweep cannot see the
 * folder at all — and they need three different fixes. Nothing we had could tell
 * them apart, so the argument was unwinnable in either direction.
 *
 * The one question that separates them: what does Encompass say about this loan RIGHT
 * NOW, and does the answer change when we ask for archived loans? So it asks twice —
 * once exactly as discovery used to, once with `includeArchivedLoans` — and hands
 * back both, beside what PILOT currently has stored. A difference between the two
 * columns IS the diagnosis.
 *
 * Read-only: two pipeline searches for ONE loan number and one row from our own
 * table. No write path, and it cannot touch a loan.
 */
router.get('/probe', async (req, res) => {
  const loanNumber = String(req.query.loan || '').trim();
  if (!loanNumber) return res.status(400).json({ ok: false, error: 'pass ?loan=<loan number>' });
  if (!encompass.configured()) {
    return res.status(503).json({ ok: false, error: 'Encompass is not connected on this deployment.' });
  }
  const fields = ['Loan.LoanNumber', 'Loan.LoanFolder', 'Loan.LastModified',
                  'Loan.CurrentMilestoneName', 'Loan.LoanAmount'];
  const ask = async (withArchived) => {
    const request = {
      fields,
      filter: { terms: [{ canonicalName: 'Loan.LoanNumber', matchType: 'exact', value: loanNumber }] },
      sortOrder: [{ canonicalName: 'Loan.LastModified', order: 'Descending' }],
    };
    if (withArchived) request.includeArchivedLoans = true;
    try {
      const body = await encompass.pipelineSearch(request, { limit: 10, start: 0 });
      const rows = Array.isArray(body) ? body : ((body && body.loans) || []);
      return {
        found: rows.length,
        loans: rows.map((r) => {
          const f = (r && r.fields) || r || {};
          return { folder: f['Loan.LoanFolder'] || null, lastModified: f['Loan.LastModified'] || null,
                   milestone: f['Loan.CurrentMilestoneName'] || null, amount: f['Loan.LoanAmount'] || null };
        }),
      };
    } catch (e) { return { error: (e && e.message) || String(e) }; }
  };
  try {
    const [asDiscoveryUsedTo, withArchived] = await Promise.all([ask(false), ask(true)]);
    const { rows } = await db.query(
      `SELECT loan_number, loan_folder, milestone_name, encompass_last_modified, encompass_synced_at
         FROM lt_loans WHERE loan_number = $1`, [loanNumber]);
    res.json({ ok: true, loanNumber, asDiscoveryUsedTo, withArchived, pilotHas: rows[0] || null });
  } catch (e) {
    res.status(502).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

/**
 * THE OTHER HALF OF THE SAME QUESTION — the long-term cards, read with PILOT'S OWN
 * ClickUp credentials.
 *
 * WHY IT LIVES HERE rather than being pulled separately: the reconciliation compares
 * two lists, and whoever is making the match needs both. Pulling ClickUp from
 * somewhere else would mean a second copy of the workspace token in a second place —
 * the exact thing the credentials rule exists to prevent — and a card list that is a
 * day older than the book it is being compared against. PILOT already holds the token
 * and already has a read-only client for it; this hands the answer over the same
 * gated door, so ONE setting opens both sides and no token moves anywhere.
 *
 * MATCH KEYS ONLY, on this side too: what the card is called, its status and folder,
 * the YS loan number, the program, the amount, the address, and whether it already
 * carries a portal stamp. Not the description, not the comments, not the assignees.
 *
 * The classification is `program.js` — the owner's own rule, the inverse of the
 * obvious one: the five RTL products are listed and everything else is long-term, so
 * a product added to the ClickUp dropdown tomorrow is long-term from the moment it
 * exists instead of falling silently out of the count.
 */
const fieldValue = (task, id) => {
  const list = (task && Array.isArray(task.custom_fields)) ? task.custom_fields : [];
  const f = list.find((x) => x && x.id === id);
  if (!f) return null;
  let v = f.value;
  if (v == null) return null;

  // A DROP-DOWN READS BACK AS A NUMBER, NOT ITS LABEL — and the number is the
  // option's `orderindex`, not anything a person would recognise. The labels sit
  // beside it in `type_config.options`. Skipping this step is not a cosmetic bug:
  // *Program is a drop-down, so "Fix & Flip With Construction" arrives as 0 and
  // "Non-QM - DSCR Ratio" as 3, and the product rule — which decides a file is
  // long-term unless it is one of the five RTL programs by NAME — then reads every
  // number as a program it has never heard of and calls the whole workspace
  // long-term. Measured before this was fixed: 216 Fix & Flip files classified as
  // long-term, silently.
  const opts = (f.type_config && Array.isArray(f.type_config.options)) ? f.type_config.options : null;
  if (opts) {
    // Match the orderindex the way the rest of the system does; fall back to the
    // option's id, because some fields hand back the uuid instead.
    const byIdx = opts.find((o) => o && Number(o.orderindex) === Number(v));
    const byId = opts.find((o) => o && o.id === v);
    const hit = byIdx || byId;
    // NEVER GUESS: an option the field does not list is reported as-is rather than
    // dropped, so an unknown value is visible instead of reading as "not set".
    v = hit ? (hit.name != null ? hit.name : hit.label) : v;
  }

  const out = (typeof v === 'object') ? v : String(v).trim();
  return (out === '' ? null : out);
};

router.get('/cards', async (req, res) => {
  if (!clickup.configured()) {
    return res.status(503).json({ ok: false, error: 'ClickUp is not connected on this deployment.' });
  }
  const wanted = String(req.query.product || 'long').toLowerCase();
  try {
    const cards = [];
    let pages = 0;
    // The team-task read returns 100 at a time and answers `last_page` when done.
    // Bounded so a paging bug can never walk forever.
    for (let page = 0; page < 30; page += 1) {
      const out = await clickup.pipelineTasksPage(page, { includeClosed: true });
      const tasks = (out && out.tasks) || [];
      pages += 1;
      for (const t of tasks) {
        const prog = fieldValue(t, PIPELINE.program);
        const kind = program.classifyProgram(prog).product;
        if (wanted !== 'all' && kind !== program.PRODUCT[wanted.toUpperCase()]) continue;
        cards.push({
          id: t.id,
          custom_id: t.custom_id || null,
          name: t.name || null,
          status: (t.status && t.status.status) || null,
          folder: (t.folder && t.folder.name) || null,
          list: (t.list && t.list.name) || null,
          product: kind,
          program: prog,
          ys: fieldValue(t, PIPELINE.ysLoanNumber),
          amount: fieldValue(t, PIPELINE.loanAmount),
          addr: fieldValue(t, PIPELINE.subjectAddress),
          portal: fieldValue(t, SYNC.portalFileId),
          // WHEN, on both sides — the signal that separates history from work. A card
          // opened long before its Encompass file existed is pre-Encompass history and
          // nobody needs to review it; a card opened within days of the file is almost
          // certainly that file's own card even when the loan number was never typed in.
          // ClickUp answers with millisecond strings and they are passed through
          // untouched: formatting here would bake this server's timezone into a date
          // the reader has to reason about in theirs.
          created: t.date_created || null,
          touched: t.date_updated || null,
          closed_on: t.date_closed || null,
          // WHAT KIND OF THING THE CARD IS. ClickUp's task types arrive as a numeric
          // `custom_item_id` (absent or 0 meaning the default task), and a workspace
          // that uses them for something other than a loan needs that visible — a
          // category told apart by its own id rather than guessed from its name.
          type_id: (t.custom_item_id == null ? null : t.custom_item_id),
          url: t.url || null,
        });
      }
      if (!tasks.length || (out && out.last_page)) break;
    }
    res.json({ ok: true, pages, count: cards.length, product: wanted, cards });
  } catch (e) {
    res.status(502).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

/**
 * THE PEOPLE MAP, AS IT STANDS — for diagnosing "my name is not in the officer
 * picker" from outside a browser session. Match keys only: the Encompass login,
 * the two display names, the LINK state, and whether the two sides' emails AGREE
 * (computed here — the addresses themselves are not handed out). No token, no
 * phone, no write path.
 */
/**
 * FIELD PROBE — what does Encompass actually hold for ONE loan, beside what PILOT
 * stored for it. READ ONLY.
 *
 * WHY (owner-reported 2026-08-25): *"Everything was already filled in Encompass.
 * Just didn't read. The ratios and everything was already filled."* A file screen
 * showing a dash cannot tell you whether the far system is empty or whether OUR read
 * dropped it — and those are opposite problems with opposite fixes. Reasoning about
 * it from the milestone (as I did, wrongly) is exactly the guess this endpoint
 * exists to replace.
 *
 * It reads the SAME field numbers the loan sync reads, by number, through the same
 * read-only `fieldReader` the sync uses — so what comes back here is what the sync
 * would have seen. Beside each one it prints what PILOT has stored, so a field that
 * Encompass fills and PILOT left blank is visible at a glance.
 *
 * The ids are the ones the 490-loan census recorded (src/longterm/encompass/
 * loan-anatomy.js), with the census's own fill rate quoted, so "Encompass usually
 * fills this" is a measurement rather than an impression.
 */
const FIELD_PROBE = [
  // The COLUMN names are the real ones, taken from the schema rather than from the
  // screen's labels — the file screen says "LTV" and "Note rate" while the columns
  // are `lt_properties.ltv_pct` and `lt_loans.note_rate_pct`, and several of these
  // live on the PROPERTY row rather than the loan. A probe that reported "(no such
  // column)" for half of them would be a broken instrument telling a confident story.
  { id: '353',  what: 'LTV',                census: 'filled on 90.2% of DSCR files', on: 'property', column: 'ltv_pct' },
  { id: '3',    what: 'Note rate',          census: 'filled on 86.9%',               on: 'loan',     column: 'note_rate_pct' },
  { id: '1005', what: 'Gross monthly rent', census: 'filled on 65.9%',               on: 'property', column: 'gross_monthly_rent' },
  { id: '912',  what: 'Housing expense',    census: 'filled on 92.2%',               on: 'loan',     column: 'housing_expense_total' },
  { id: '4',    what: 'Term (months)',      census: 'filled on 100%',                on: 'loan',     column: 'term_months' },
  { id: '2',    what: 'Loan amount',        census: 'filled ~92%',                   on: 'loan',     column: 'loan_amount' },
  { id: '356',  what: 'Appraised value',    census: 'filled on 74.5%',               on: 'property', column: 'appraised_value' },
  { id: '1821', what: 'Estimated value',    census: 'filled on 69.6%',               on: 'property', column: 'estimated_value' },
  { id: '4008', what: 'Vesting type',       census: 'the vesting line',              on: 'loan',     column: 'vesting_type' },
  { id: '1859', what: 'Vesting entity',     census: 'the entity name',               on: 'loan',     column: 'vesting_entity_name' },
];

router.get('/fields', async (req, res) => {
  const loanNumber = String(req.query.loan || '').trim();
  if (!loanNumber) return res.status(400).json({ ok: false, error: 'pass ?loan=<loan number>' });
  if (!encompass.configured()) {
    return res.status(503).json({ ok: false, error: 'Encompass is not connected on this deployment.' });
  }
  try {
    const { rows } = await db.query(
      `SELECT id, loan_number, encompass_loan_guid, encompass_synced_at, milestone_name
         FROM lt_loans WHERE loan_number = $1`, [loanNumber]);
    const loan = rows[0];
    if (!loan) return res.status(404).json({ ok: false, error: 'PILOT does not hold that loan number.' });
    if (!loan.encompass_loan_guid) {
      return res.json({ ok: true, loanNumber, note: 'PILOT holds no Encompass id for this loan, so it can only be found by a pipeline search — nothing can be read by field number.' });
    }

    // ONE fieldReader call, exactly as the sync makes it.
    let values = null; let readError = null;
    try {
      values = await encompass.fieldReader(loan.encompass_loan_guid, FIELD_PROBE.map((f) => f.id));
    } catch (e) { readError = String((e && e.message) || e).slice(0, 300); }

    const storedLoan = (await db.query('SELECT * FROM lt_loans WHERE id = $1', [loan.id])).rows[0] || {};
    const storedProp = (await db.query('SELECT * FROM lt_properties WHERE loan_id = $1 LIMIT 1', [loan.id])).rows[0] || {};
    const compare = FIELD_PROBE.map((f) => {
      const row = f.on === 'property' ? storedProp : storedLoan;
      return {
        field: f.id,
        what: f.what,
        census: f.census,
        encompass: values ? (values[f.id] === undefined ? '(not returned)' : values[f.id]) : null,
        pilot: f.column in row ? row[f.column] : '(no such column)',
        storedOn: f.on,
      };
    });
    res.json({ ok: true, loanNumber, milestone: loan.milestone_name,
      lastRead: loan.encompass_synced_at, readError, fields: compare });
  } catch (e) {
    res.status(502).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

/**
 * CATALOG PROBE — ask Encompass, from the server that holds the credentials, which
 * catalog addresses actually answer. READ ONLY.
 *
 * WHY THIS EXISTS (owner-directed 2026-08-25, after the nightly refresh reported
 * five of six catalog reads refused with 403). "Which address works?" is a question
 * about the VENDOR, and the only honest way to answer it is to ask the vendor — from
 * the machine whose environment already holds the login, so nobody has to move a
 * credential anywhere to find out. A path that is guessed and happens to answer is
 * far worse than a 403 that says so, and this is what makes guessing unnecessary.
 *
 * IT IS NOT AN OPEN PROXY. The list below is FIXED in code; nothing is taken from the
 * query string. So this can ask Encompass exactly these questions and no others, and
 * every one of them is a GET through the read-only client, which refuses any method
 * but GET and refuses the OAuth namespace outright.
 *
 * Each entry pairs a `kind` with the address the code uses today and any CANDIDATE
 * worth asking about. Reporting a candidate's status is research; ADOPTING one is a
 * separate, deliberate code change that only ever follows a 200 seen here.
 */
const CATALOG_PROBES = [
  // The control. This one is known to work (857 fields in production), so a run
  // where even this fails is telling us about the connection, not about the paths.
  { kind: 'customField', role: 'in use', path: '/encompass/v3/settings/loan/customFields' },

  { kind: 'standardField', role: 'was in use', path: '/encompass/v3/settings/loan/standardFields' },
  { kind: 'standardField', role: 'probed 2026-08-14', path: '/encompass/v3/schemas/loan/standardFields?start=0&limit=5' },

  { kind: 'milestone', role: 'was in use', path: '/encompass/v3/settings/loan/milestones' },
  { kind: 'milestone', role: 'probed 2026-08-14', path: '/encompass/v3/settings/milestones?start=0&limit=5' },

  // The three nobody has ever probed. Their current addresses are asked FIRST so the
  // answer is recorded either way, then the shapes the two corrections above turned
  // out to take — a settings path that dropped `/loan`, and a schemas path.
  // ENUMS. The research pass found NO enum endpoint anywhere in ICE's own 800-request
  // Developer Connect collection, and `encompass/dropdowns.js` explains why: a custom
  // dropdown does not publish its options at all. The candidate below is the one place
  // the tenant was measured to carry option lists (790 of 3,159 definitions).
  { kind: 'enum', role: 'in use', path: '/encompass/v3/settings/loan/enums' },
  { kind: 'enum', role: 'candidate', path: '/encompass/v1/loanPipeline/fieldDefinitions' },

  // FOLDERS. Live-probed 2026-08-14 and transcribed with all 22 folder names, so this
  // candidate is expected to answer; asking anyway is the point of the exercise.
  { kind: 'folder', role: 'in use', path: '/encompass/v3/settings/loan/folders' },
  { kind: 'folder', role: 'probed 2026-08-14', path: '/encompass/v1/loanFolders' },

  // TEMPLATES. Measured 2026-08-25: the address in use is 403, and the candidate
  // answers 400 with an instruction rather than a refusal —
  //   "Folder path is empty. Default parent directory should start with public or
  //    personal."
  // That is the vendor telling us the shape of the question, so both shapes are
  // asked. A 400 that explains itself is a better lead than a 403 that does not.
  { kind: 'loanTemplate', role: 'in use', path: '/encompass/v3/settings/loan/loanTemplates' },
  { kind: 'loanTemplate', role: 'candidate', path: '/encompass/v3/settings/templates/loanTemplateSet/folders' },
  { kind: 'loanTemplate', role: 'per the 400', path: '/encompass/v3/settings/templates/loanTemplateSet/folders?path=public' },
  { kind: 'loanTemplate', role: 'per the 400', path: '/encompass/v3/settings/templates/loanTemplateSet/folders?path=personal' },

  // THE PAGING QUESTION, asked rather than assumed. ICE's own reference says there is
  // no fixed upper limit, only a max payload size — if a single call answers with
  // 10,000, the catalog is one request rather than fifty.
  //
  // TWO sizes, on purpose. `apiGet` gives up after 15 seconds, so a big page that
  // comes back empty-handed is ambiguous: it could be the vendor refusing the size
  // or it could be OUR clock. The 1,000 asked first settles that — if 1,000 answers
  // and 10,000 aborts, the limit is the timeout and the fix is paging, not the path.
  { kind: 'standardField', role: 'paging check', path: '/encompass/v3/schemas/loan/standardFields?start=0&limit=1000' },
  { kind: 'standardField', role: 'paging check', path: '/encompass/v3/schemas/loan/standardFields?start=0&limit=10000' },
];

router.get('/catalog-probe', async (_req, res) => {
  if (!encompass.configured()) {
    return res.status(503).json({ ok: false, error: 'Encompass is not connected on this deployment.' });
  }
  const results = [];
  for (const probe of CATALOG_PROBES) {
    try {
      const body = await encompass.apiGet(probe.path);
      const rows = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : null);
      // AN OBJECT IS AN ANSWER TOO. The first run reported the enum candidate as
      // `shape: object, sampleKeys: null` — a probe that saw a 200 and then threw
      // away the one thing that would have told us how to read it. `refreshFieldCatalog`
      // only understands an array or `{items:[…]}`, so an object under any OTHER key
      // is silently zero rows, and that is exactly what has to be visible here.
      const objKeys = (!rows && body && typeof body === 'object') ? Object.keys(body) : null;
      const listUnder = objKeys ? objKeys.filter((k) => Array.isArray(body[k])) : null;
      results.push({
        ...probe,
        ok: true,
        // The COUNT is what tells a working address from one that answers politely
        // with nothing, and the first row's keys are what tells us the shape our
        // reader would have to read.
        count: rows ? rows.length : null,
        sampleKeys: rows && rows[0] ? Object.keys(rows[0]).slice(0, 8) : null,
        shape: rows ? 'list' : typeof body,
        objectKeys: objKeys ? objKeys.slice(0, 20) : null,
        // Which of those keys actually holds a list, and how long — this is the one
        // fact that turns "200 but we read nothing" into a one-line reader change.
        listsUnder: listUnder && listUnder.length
          ? listUnder.slice(0, 8).map((k) => ({ key: k, len: body[k].length,
              firstKeys: body[k][0] && typeof body[k][0] === 'object' ? Object.keys(body[k][0]).slice(0, 8) : null }))
          : null,
      });
    } catch (e) {
      // The client's own error text is `Encompass <status>: <body>` — the status is
      // the whole answer here, so it is kept rather than flattened to "failed".
      results.push({ ...probe, ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  res.json({ ok: true, probed: results.length, results });
});

/**
 * REQUEST AUDIT — every request PILOT makes to Encompass, fired at the live tenant,
 * with the status it answered written down. READ ONLY.
 *
 * WHY (owner-directed, 2026-08-25, asked three times): *"I want you to double-check
 * and triple-check every single request that you're going to encompass to make sure
 * every request works... make sure all the tests and all the requests are correct,
 * everything works, and nothing returns an error."*
 *
 * `/catalog-probe` above answers that for the CATALOG. This answers it for the whole
 * surface: the token, the pipeline search, the loan, the milestone ladder, the
 * milestone logs, the field reader, the company users, and every settings address —
 * eighteen distinct requests, which is all of them. The list was taken by grepping
 * every `apiGet(`, `_fetchGuarded(` and path constant in all THREE Encompass clients,
 * so a request that exists in code and not here is a gap this file is wrong about,
 * not a request that went unaudited.
 *
 * IT IS NOT AN OPEN PROXY, for the same reason `/catalog-probe` is not: the list is
 * FIXED in code and nothing is taken from the query string except which loan to use
 * as the subject — and that is looked up in our OWN book, never passed through to
 * Encompass as a path. Every entry is a GET through the read-only client, or one of
 * the two read-shaped POSTs (`loanPipeline`, `fieldReader`) that the client's own
 * allowlist already permits and that mutate nothing.
 *
 * WHERE THE TWO PRODUCTS DISAGREE, BOTH ARE ASKED. RTL reads the milestone log at
 * `/logs/milestoneLogs` and Long-Term reads it at `/milestoneLogs`. Both cannot be
 * right, and neither has ever been measured — so both are in the list, side by side,
 * and the answer decides it rather than whichever file somebody opens first.
 */
router.get('/request-audit', async (req, res) => {
  if (!encompass.configured()) {
    return res.status(503).json({ ok: false, error: 'Encompass is not connected on this deployment.' });
  }

  // THE SUBJECT LOAN comes from our own book, not from the caller. A caller may name
  // a loan NUMBER to audit a specific file; the GUID is looked up here, so nothing a
  // caller types ever reaches Encompass as a path.
  const wanted = String(req.query.loan || '').trim();
  let subject = null;
  try {
    const { rows } = await db.query(
      wanted
        ? `SELECT loan_number, encompass_loan_guid FROM lt_loans
            WHERE loan_number = $1 AND encompass_loan_guid IS NOT NULL LIMIT 1`
        : `SELECT loan_number, encompass_loan_guid FROM lt_loans
            WHERE encompass_loan_guid IS NOT NULL
            ORDER BY encompass_synced_at DESC NULLS LAST LIMIT 1`,
      wanted ? [wanted] : [],
    );
    subject = rows[0] || null;
  } catch (e) {
    return res.status(500).json({ ok: false, error: `could not choose a subject loan: ${(e && e.message) || e}` });
  }
  if (!subject) {
    return res.status(404).json({ ok: false, error: 'no loan in the book carries an Encompass id, so the per-loan requests cannot be audited' });
  }
  const guid = subject.encompass_loan_guid;

  const results = [];
  const record = async (group, what, how, run) => {
    const t0 = Date.now();
    try {
      const body = await run();
      const rows = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : null);
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
      // WHERE THE LIST IS, WHEN THE ANSWER IS AN OBJECT. `refreshFieldCatalog`
      // understands an array or `{items:[…]}` and nothing else, so a list under any
      // other key is silently zero rows — the enum endpoint hides its rows under
      // `pipelineLoanReportFieldDefs`, and the template endpoint under `contents`.
      // Reporting the nested key AND the shape of its first row is what turns
      // "200 but we stored nothing" into a one-line reader change.
      const listsUnder = keys
        ? keys.filter((k) => Array.isArray(body[k])).slice(0, 6).map((k) => ({
          key: k,
          len: body[k].length,
          firstKeys: body[k][0] && typeof body[k][0] === 'object' ? Object.keys(body[k][0]).slice(0, 10) : null,
        }))
        : null;
      results.push({
        group, what, how, ok: true, status: 200, ms: Date.now() - t0,
        count: rows ? rows.length : (keys ? keys.length : null),
        shape: rows ? 'list' : (body === null || body === undefined ? 'empty' : typeof body),
        sampleKeys: rows && rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 8)
          : (keys ? keys.slice(0, 10) : null),
        listsUnder: listsUnder && listsUnder.length ? listsUnder : null,
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      const m = msg.match(/(?:Encompass|fieldReader)\s+(\d{3})/);
      results.push({ group, what, how, ok: false, status: m ? Number(m[1]) : null,
        ms: Date.now() - t0, error: msg.slice(0, 240) });
    }
  };

  // ── 1. THE TOKEN. Nothing else can pass if this does not. ──────────────────
  await record('auth', 'mint an access token', 'POST /oauth2/v1/token', async () => {
    const p = await encompass.ping();
    if (!p.ok) throw new Error(`LT Encompass 000: ${p.reason}`);
    return { ok: true };
  });

  // ── 2. THE SEARCH. How every loan is discovered in the first place. ────────
  await record('search', 'find loans by field', 'POST /encompass/v3/loanPipeline', () =>
    encompass.pipelineSearch({
      fields: ['Loan.LoanNumber', 'Loan.LastModified'],
      filter: { operator: 'and', terms: [{ canonicalName: 'Loan.LastModified', matchType: 'greaterThanOrEquals', value: '2000-01-01' }] },
    }, { limit: 5, start: 0 }));

  // ── 3. THE PER-LOAN READS. The four calls a full read makes. ──────────────
  await record('loan', 'the loan itself', 'GET /encompass/v3/loans/{guid}', () => encompass.getLoan(guid));
  await record('loan', 'the milestone ladder', 'GET /encompass/v3/loans/{guid}/milestones', () => encompass.getLoanMilestones(guid));

  // BOTH spellings of the milestone log, because the two products disagree.
  await record('loan', 'milestone log — the Long-Term spelling', 'GET /encompass/v3/loans/{guid}/milestoneLogs',
    () => encompass.apiGet(`/encompass/v3/loans/${encodeURIComponent(guid)}/milestoneLogs`));
  await record('loan', 'milestone log — the RTL spelling', 'GET /encompass/v3/loans/{guid}/logs/milestoneLogs',
    () => encompass.apiGet(`/encompass/v3/loans/${encodeURIComponent(guid)}/logs/milestoneLogs`));

  // THE FIELD READER — the call that fills the rate, the DSCR and the address.
  await record('loan', 'fields by number', 'POST /encompass/v3/loans/{guid}/fieldReader',
    () => encompass.fieldReader(guid, ['4002', '3', '1109', '4008', 'MS.STATUS']));

  // ── 4. THE CATALOG. Both the address in use and the measured candidate. ────
  const cat = (what, path) => record('catalog', what, `GET ${path}`, () => encompass.apiGet(path));
  await cat('custom fields', '/encompass/v3/settings/loan/customFields');
  await cat('standard fields — in use', '/encompass/v3/settings/loan/standardFields');
  await cat('standard fields — candidate', '/encompass/v3/schemas/loan/standardFields?start=0&limit=5');
  await cat('standard fields by id', '/encompass/v3/schemas/loan/standardFields?ids=4002&start=0&limit=5');
  await cat('milestones — in use', '/encompass/v3/settings/loan/milestones');
  await cat('milestones — candidate', '/encompass/v3/settings/milestones?start=0&limit=5');
  await cat('dropdown options — in use', '/encompass/v3/settings/loan/enums');
  await cat('dropdown options — candidate', '/encompass/v1/loanPipeline/fieldDefinitions');
  await cat('folders — in use', '/encompass/v3/settings/loan/folders');
  await cat('folders — candidate', '/encompass/v1/loanFolders');
  await cat('loan templates — in use', '/encompass/v3/settings/loan/loanTemplates');
  // THE FOUR SHAPES ICE ITSELF SHIPS, verbatim from its Developer Connect collection
  // (requests 649 and 657) and from the tutorial "Retrieve Loan Template Folder
  // Locations and Settings". The tenant's own 400 said the path must "start with
  // public or personal", so the bare forms are asked; ICE's literal example goes a
  // level deeper (`public\Companywide`), and its V1 spelling puts the folder in the
  // PATH rather than the query string, which is a different request altogether.
  // All four are asked because the difference between them is exactly what is unknown.
  await cat('loan templates — v3, path=public', '/encompass/v3/settings/templates/loanTemplateSet/folders?path=public');
  await cat('loan templates — v3, path=personal', '/encompass/v3/settings/templates/loanTemplateSet/folders?path=personal');
  await cat("loan templates — v3, ICE's literal example", '/encompass/v3/settings/templates/loanTemplateSet/folders?path=public%5cCompanywide');
  await cat('loan templates — v1, folder in the path', '/encompass/v1/settings/templates/loanTemplateSet/folders/public');
  await cat('the people in the company', '/encompass/v1/company/users?limit=5&start=0');

  // ── 5. THE TWO THE COVERAGE CHECK CAUGHT. Neither has ever been measured. ──
  // `getMilestoneSetting(id)` — one milestone by id. The id comes from the catalog
  // call above, so this is only asked when that answered; asking it with a made-up
  // id would audit our guess rather than the endpoint.
  let msId = null;
  try {
    const list = await encompass.apiGet('/encompass/v3/settings/milestones?start=0&limit=1');
    const rows = Array.isArray(list) ? list : (list && list.items) || [];
    msId = rows[0] && (rows[0].id || rows[0].milestoneId);
  } catch (_) { /* the catalog entry above already recorded why */ }
  if (msId) {
    await cat('one milestone by id', `/encompass/v3/settings/milestones/${encodeURIComponent(String(msId))}`);
  } else {
    results.push({ group: 'catalog', what: 'one milestone by id', how: 'GET /encompass/v3/settings/milestones/{id}',
      ok: false, status: null, error: 'not asked: the milestone list did not answer, so there was no real id to ask with' });
  }

  // RTL's `getLoan` takes an `entities=` filter that Long-Term's never uses. Same
  // endpoint, different question, and only one of the two has ever been exercised.
  await record('loan', 'the loan, asking for named entities only',
    'GET /encompass/v3/loans/{guid}?entities=…', () =>
    encompass.apiGet(`/encompass/v3/loans/${encodeURIComponent(guid)}?entities=${encodeURIComponent('LoanProductData,Property')}`));

  const failed = results.filter((r) => !r.ok);
  res.json({
    ok: failed.length === 0,
    subject: { loanNumber: subject.loan_number },
    audited: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    // The headline, so a human does not have to read the table to get the answer.
    summary: failed.length
      ? `${failed.length} of ${results.length} requests did NOT work: ${failed.map((f) => `${f.what} (${f.status || 'no status'})`).join(', ')}`
      : `all ${results.length} requests answered`,
    results,
  });
});

/**
 * TEMPLATE WALK — the loan-template tree, read for real before any code is written
 * against it. READ ONLY.
 *
 * WHY A THIRD DIAGNOSTIC (2026-08-25). The request audit settled that
 * `/v3/settings/loan/loanTemplates` is 403 and that
 * `/v3/settings/templates/loanTemplateSet/folders?path=…` answers 200. It also
 * showed the rows are nested under `contents` as
 * `{ entityName, entityType, entityPath, hasSubFolders }` — and that
 * `refreshFieldCatalog`'s key chain for this kind, `r.path || r.name || r.id`,
 * matches NONE of those four names. Handed straight through, every row would key to
 * undefined, hit `if (!key) continue`, and the catalog would report a clean refresh
 * holding zero templates. That is the third endpoint this week with exactly that
 * shape, so it is measured rather than assumed.
 *
 * WHAT IS STILL UNKNOWN AND WHY IT NEEDS A WALK. The roots answer with ONE entry
 * each; ICE's own literal example one level down answers with eleven. So the
 * templates are not at the root — they are somewhere in a TREE, and the only honest
 * way to learn its shape, its depth, and which `entityType` values mark a leaf is to
 * walk it and look. Writing a recursive reader against a tree nobody has seen is
 * precisely the guess this whole exercise exists to stop.
 *
 * BOUNDED BY CONSTRUCTION. At most MAX_CALLS requests and MAX_DEPTH levels, breadth
 * first, and every path it follows comes from an `entityPath` the vendor itself
 * returned — never from the caller, and never assembled by us. It reports what it
 * stopped for, so a truncated walk can never read as a complete one.
 */
router.get('/template-walk', async (_req, res) => {
  if (!encompass.configured()) {
    return res.status(503).json({ ok: false, error: 'Encompass is not connected on this deployment.' });
  }
  const MAX_CALLS = 40;
  const MAX_DEPTH = 4;
  const BASE = '/encompass/v3/settings/templates/loanTemplateSet/folders?path=';

  const seen = new Set();
  const rows = [];
  const errors = [];
  let calls = 0;
  let stoppedFor = null;

  const queue = [{ path: 'public', depth: 0 }, { path: 'personal', depth: 0 }];
  while (queue.length) {
    if (calls >= MAX_CALLS) { stoppedFor = `the ${MAX_CALLS}-call bound`; break; }
    const { path: p, depth } = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    calls += 1;
    let body;
    try {
      body = await encompass.apiGet(BASE + encodeURIComponent(p));
    } catch (e) {
      errors.push({ path: p, error: String((e && e.message) || e).slice(0, 160) });
      continue;
    }
    const contents = body && Array.isArray(body.contents) ? body.contents : [];
    for (const c of contents) {
      if (!c || typeof c !== 'object') continue;
      rows.push({
        askedAt: p,
        depth,
        entityName: c.entityName || null,
        entityType: c.entityType || null,
        entityPath: c.entityPath || null,
        hasSubFolders: c.hasSubFolders === true,
      });
      // Follow only what the VENDOR handed back, and only while inside the bound.
      if (c.entityPath && depth + 1 <= MAX_DEPTH && c.hasSubFolders === true) {
        queue.push({ path: c.entityPath, depth: depth + 1 });
      }
    }
  }
  if (!stoppedFor && queue.length) stoppedFor = `the ${MAX_DEPTH}-level depth bound`;

  // WHICH entityType VALUES EXIST, counted — this is what decides whether a row is a
  // folder to walk into or a template to record, and it is the one fact a reader
  // cannot be written without.
  const byType = {};
  for (const r of rows) byType[r.entityType || '(none)'] = (byType[r.entityType || '(none)'] || 0) + 1;

  res.json({
    ok: errors.length === 0,
    calls,
    found: rows.length,
    // NO SILENT TRUNCATION. A walk that stopped early says so, in words.
    complete: !stoppedFor && queue.length === 0,
    stoppedFor,
    entityTypes: byType,
    errors: errors.length ? errors : null,
    rows,
  });
});

router.get('/people', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.login_id,
              u.full_name AS encompass_name,
              l.status AS link_status,
              l.match_method,
              s.full_name AS staff_name,
              s.role AS staff_role,
              (lower(btrim(COALESCE(u.email,''))) <> ''
               AND EXISTS (SELECT 1 FROM staff_users sx
                            WHERE sx.is_active = true AND sx.is_external = false
                              AND lower(btrim(COALESCE(sx.email,''))) = lower(btrim(COALESCE(u.email,''))))) AS email_matches_some_staff,
              (SELECT count(*)::int FROM lt_loan_contacts c
                 JOIN lt_loans ll ON ll.id = c.loan_id
                WHERE c.encompass_login_id = u.login_id AND c.role = 'loan_officer'
                  AND lower(btrim(regexp_replace(COALESCE(ll.loan_folder, ''), '\\s+', ' ', 'g'))) <> '(trash)') AS officer_on_loans
         FROM lt_encompass_users u
         LEFT JOIN lt_staff_links l ON l.encompass_login_id = u.login_id
         LEFT JOIN staff_users s ON s.id = l.staff_id
        ORDER BY u.full_name NULLS LAST`);
    res.json({ ok: true, count: rows.length, people: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

module.exports = router;
