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
      // EVERY FOLDER IS OPENED, NOT ONLY THE ONES WITH SUB-FOLDERS.
      //
      // The first run gated this on `hasSubFolders === true` and reported
      // `complete: true` — while never looking inside "DO NOT USE", whose
      // `hasSubFolders` is false. That flag says the folder has no child FOLDERS.
      // It says nothing about whether it holds TEMPLATES, which is the thing being
      // counted. So the walk announced a complete tree having skipped a branch that
      // could contain rows: a report that measured less than it claimed, which is
      // the exact defect being hunted everywhere else this week.
      //
      // The bound that keeps this safe is the call cap and the depth cap, both of
      // which are reported. A folder is opened because it is a folder.
      if (c.entityPath && depth + 1 <= MAX_DEPTH && String(c.entityType || '').toLowerCase().includes('folder')) {
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

/**
 * WEBHOOK CHECK — does this tenant actually have webhooks, and has Encompass ever
 * tried to deliver one? READ ONLY.
 *
 * WHY (owner, 2026-08-25, on a status changed half an hour earlier and still not
 * showing): *"We need to make this shit happen immediately because we have the
 * webhooks. Maybe your system is not reading webhooks correctly."*
 *
 * OUR SIDE IS ALREADY ANSWERED, from this deployment's own logs: seven days contain
 * exactly two `[lt-encompass-hook]` lines and both are test pings sent by hand from
 * a session. The endpoint is alive and correctly refuses an unauthenticated POST
 * with 403. Nothing arrives to be read wrongly.
 *
 * SO THE QUESTION IS ENCOMPASS'S SIDE, and Encompass keeps its own record of it.
 * `/webhook/v1/subscriptions` says whether any subscription exists at all;
 * `/webhook/v1/events` is Event History — every delivery ATTEMPT, with statuses up
 * to `DeliveryFailedExhaustedRetries`. Between them, "nobody ever subscribed" and
 * "we subscribed and every delivery failed" stop looking identical, which from the
 * outside they do.
 *
 * AND THERE IS A THIRD ANSWER THE VENDOR HAS ALREADY WRITTEN DOWN, recorded in
 * `docs/ENCOMPASS-API-ATLAS.md` §6.3: the Loan `milestone` event — along with
 * `create`, `condition` and `fieldchange` — fires for **API-originated actions
 * ONLY**. Staff working in the Encompass desktop emit none of them. A milestone
 * completed by a human at a desk therefore CANNOT produce a milestone webhook,
 * however perfectly the subscription is configured. `change` (with filters),
 * `update`, `move` and `delete` are the events a desktop action does emit, and this
 * route reports which of those the tenant actually offers so the question can be
 * settled with the vendor's own list rather than an assumption.
 *
 * READ ONLY, and pointedly so: creating or repairing a subscription is a WRITE
 * against the tenant's configuration and is not this route's business.
 */
router.get('/webhook-check', async (_req, res) => {
  if (!encompass.configured()) {
    return res.status(503).json({ ok: false, error: 'Encompass is not connected on this deployment.' });
  }
  const out = {};
  /**
   * NOTHING SECRET LEAVES THIS ROUTE.
   *
   * A subscription carries its `signingkey` — the HMAC secret Encompass signs every
   * delivery with — and its `endpoint` carries a per-integration token in the path.
   * The first run of this route handed both back in clear text. It is token-gated,
   * so the exposure was narrow, but this file's own header says it out loud: *"a
   * diagnostic that hands out more than its job needs is a diagnostic somebody will
   * regret."* Reading a secret is not this route's job.
   *
   * What the job DOES need is the endpoint's HOST — "these deliveries go somewhere
   * that is not PILOT" is the entire finding — so the host is kept and the path is
   * replaced by its length. The key is replaced by whether one is set at all, which
   * is the only fact about it anybody here needs.
   */
  const REDACT = /^(signingkey|signingKey|secret|token|password|clientSecret)$/i;
  const scrub = (v) => {
    if (Array.isArray(v)) return v.map(scrub);
    if (!v || typeof v !== 'object') return v;
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (REDACT.test(k)) { o[k] = val ? `(set — ${String(val).length} chars, not shown)` : null; continue; }
      if (k === 'endpoint' && typeof val === 'string') {
        try {
          const u = new URL(val);
          o[k] = `${u.protocol}//${u.host}${u.pathname === '/' ? '' : `/…(${u.pathname.length} chars)`}`;
        } catch (_) { o[k] = '(unreadable endpoint)'; }
        continue;
      }
      o[k] = scrub(val);
    }
    return o;
  };

  const ask = async (key, path) => {
    try {
      const body = await encompass.apiGet(path);
      const rows = Array.isArray(body) ? body : (body && (body.items || body.events || body.subscriptions)) || null;
      out[key] = { ok: true, path, count: Array.isArray(rows) ? rows.length : null, body: scrub(rows || body) };
    } catch (e) {
      const msg = String((e && e.message) || e);
      const m = msg.match(/Encompass\s+(\d{3})/);
      out[key] = { ok: false, path, status: m ? Number(m[1]) : null, error: msg.slice(0, 220) };
    }
  };

  await ask('subscriptions', '/webhook/v1/subscriptions');
  await ask('resources', '/webhook/v1/resources');
  await ask('loanEvents', '/webhook/v1/resources/loan/events');
  // Event History — Encompass's OWN record of every delivery attempt. This is the
  // one that tells "never subscribed" apart from "subscribed and every send failed".
  await ask('deliveryHistory', '/webhook/v1/events?limit=25');

  const subs = out.subscriptions;
  const subCount = subs && subs.ok ? (subs.count == null ? null : subs.count) : null;
  const hist = out.deliveryHistory;
  const histCount = hist && hist.ok ? (hist.count == null ? null : hist.count) : null;

  // The answer in words, so nobody has to read the JSON to get it.
  let verdict;
  if (subs && !subs.ok && !subs.status) {
    // NO HTTP STATUS MEANS THE CALL NEVER LANDED — a connection that dropped, a
    // timeout, a DNS blip. Observed on the very first live run of this route, so it
    // is not rare. The earlier wording sent that case to ICE ("PILOT cannot see
    // them"), which is a confident wrong answer about somebody else's system and
    // would have somebody chasing a vendor over a network hiccup. Say what actually
    // happened and say to ask again.
    verdict = `The request for this tenant's webhook subscriptions did not complete — ${subs.error || 'the connection failed'}. That is a network failure on the way out, not an answer from Encompass. Run this again.`;
  } else if (subs && !subs.ok) {
    verdict = `Encompass refused to say what this tenant's webhook subscriptions are (HTTP ${subs.status}). That is a permissions question for ICE — PILOT is asking correctly and being turned down.`;
  } else if (subCount === 0) {
    verdict = 'Encompass has NO webhook subscriptions at all. Nothing was ever going to arrive, and no change on PILOT\'s side could have made it. The five-minute sweep is doing the whole job.';
  } else if (histCount === 0) {
    verdict = `Encompass has ${subCount} subscription(s) but its own delivery history is EMPTY — it has never attempted a send. Note that a milestone completed in the Encompass desktop emits no milestone event at all (atlas §6.3), so this is expected if the subscription is for 'milestone'.`;
  } else {
    verdict = `Encompass has ${subCount} subscription(s) and ${histCount} delivery record(s) — read deliveryHistory.body for the statuses; DeliveryFailedExhaustedRetries means it tried and gave up.`;
  }

  res.json({
    ok: true,
    verdict,
    // Stated every time, because it is the fact that most often explains the report
    // and it is nobody's fault on either side of the integration.
    // NAMED BY POINTING AT THE VENDOR'S OWN LIST, NOT BY TRANSCRIBING IT — which is
    // both more accurate and the only version this file may carry. `book-diag` is
    // guarded to contain no write keyword ANYWHERE after comments are stripped, and
    // a string is not a comment: spelling the desktop-visible event names out here
    // put two of them into the file as bare words and tripped that guard. The guard
    // is right — it is what keeps a read-only diagnostic honest — so the sentence
    // changed rather than the rule, and `loanEvents` below is the tenant's own
    // answer rather than my memory of the documentation.
    desktopCaveat: 'Encompass Loan events create/milestone/condition/fieldchange fire for API-originated actions ONLY — a milestone completed by a person in the Encompass desktop emits none of them, however the subscription is configured. The events a desktop action DOES emit are the others in loanEvents below; compare that list against what subscriptions is subscribed to.',
    ...out,
  });
});

/**
 * WHY IS THIS CARD'S STATUS NOT MOVING? — the whole chain for ONE loan, in order,
 * with the link that broke named. READ ONLY.
 *
 * WHY (owner-reported 2026-08-25, YSCAP258134720): *"This file was updated on pilot
 * for clear to close, but I don't see that ClickUp was updated... don't fix the
 * issue. Just dig in deeper. Go to the deep root cause and fix the bug in the back
 * so it should work every time, everywhere."*
 *
 * A STATUS REACHING CLICKUP DEPENDS ON FOUR THINGS IN SERIES, and until now a break
 * in any one of them looked exactly like a break in any other — from the outside, a
 * card that simply did not move:
 *
 *   1. THE MOVE IS WITNESSED. `readLoan` sees the milestone change and
 *      `milestones.writeMilestone` records an `observed_entered` row. A first
 *      sighting records `observed_baseline` INSTEAD, which deliberately pushes
 *      nothing — and a `redefinition` (the first successful ladder read of a loan
 *      that already had a milestone) records NOTHING AT ALL.
 *   2. THE LOAN IS PICKED UP. `pushPass` takes linked, confirmed, non-trash loans
 *      where `clickup_pushed_at IS NULL OR encompass_synced_at > clickup_pushed_at`.
 *   3. THE DECISION SAYS PUSH. `status-push` writes only for an `observed_entered`
 *      NEWER than the loan's watermark, and only forwards unless the status is one
 *      of the backward-allowed ones. This is the owner's own rule from 2026-08-24 —
 *      *"Only when Encompass is changing a milestone should ClickUp be changing
 *      milestones"* — so a card is NEVER re-asserted to reconcile it, and any
 *      question is raised for a person instead.
 *   4. THE STATUS EXISTS ON THE CARD'S LIST. PILOT never invents one.
 *
 * So this route reports all four, side by side, plus the card's ACTUAL live status
 * read from ClickUp, and names the first link that explains the outcome. Guessing
 * which of four silent links broke is what makes a bug like this take a day.
 *
 * READ ONLY: `lt_*` reads, one ClickUp GET for the card, and no write path. It does
 * not push, does not stamp a watermark, and does not repair anything — deciding to
 * write a status is the sync's job and is governed by rules this route only reports.
 */
router.get('/why-no-status', async (req, res) => {
  const loanNumber = String(req.query.loan || '').trim();
  if (!loanNumber) return res.status(400).json({ ok: false, error: 'pass ?loan=<loan number>' });
  try {
    const { rows } = await db.query(
      `SELECT id, loan_number, milestone_name, stage_key, milestone_since,
              milestone_since_is_baseline, ladder_synced_at, encompass_synced_at,
              encompass_sync_error, clickup_task_id, clickup_custom_id,
              clickup_link_confidence, clickup_pushed_at, clickup_push_error,
              clickup_status_event_at, loan_folder, created_at
         FROM lt_loans WHERE loan_number = $1`, [loanNumber]);
    const loan = rows[0];
    if (!loan) return res.status(404).json({ ok: false, error: `no loan in the book carries the number ${loanNumber}` });

    // ── 1. what PILOT witnessed ──────────────────────────────────────────────
    const { rows: events } = await db.query(
      `SELECT event_type, from_milestone, to_milestone, observed_at
         FROM lt_milestone_events WHERE loan_id = $1::uuid
        ORDER BY observed_at DESC LIMIT 12`, [loan.id]);
    const lastEntered = events.find((e) => e.event_type === 'observed_entered') || null;

    // ── 2. would the push pass even pick it up? ──────────────────────────────
    const pushed = loan.clickup_pushed_at ? new Date(loan.clickup_pushed_at).getTime() : null;
    const synced = loan.encompass_synced_at ? new Date(loan.encompass_synced_at).getTime() : null;
    const dueForPush = !!loan.clickup_task_id
      && String(loan.clickup_link_confidence || 'confirmed') === 'confirmed'
      && (pushed === null || (synced !== null && synced > pushed));

    // ── 3. what the decision would say, run through the REAL rule ────────────
    let card = null; let cardError = null;
    if (loan.clickup_task_id) {
      try { card = await clickup.getTask(loan.clickup_task_id); }
      catch (e) { cardError = String((e && e.message) || e).slice(0, 200); }
    }
    const cardStatus = card && card.status ? String(card.status.status || '').trim() : null;

    // THE REAL RULE, RUN — not a paraphrase of it. `desiredStatus` reads the
    // mirrored LADDER (not the loan's milestone name) plus the folder, exactly as
    // `push.js:desiredStatusFor` does; a diagnostic that approximated the call
    // would answer confidently about a decision the sync never makes.
    let decision = null;
    let ladderRows = [];
    try {
      const lr = await db.query(
        `SELECT milestone_name, position, done FROM lt_loan_milestones
          WHERE loan_id = $1::uuid ORDER BY position`, [loan.id]);
      ladderRows = lr.rows;
      const statusPush = require('../clickup/status-push');
      const engine = require('../clickup/status-engine');
      // `f1393` and the funding channel ride the per-loan field bag the push
      // builds; this route does not read Encompass, so they are left out and the
      // answer is the LADDER's, which is the case that matters here. Said out loud
      // rather than implied, because a cancelled or on-hold file would outrank it.
      const desired = engine.desiredStatus({ ladder: ladderRows, folder: loan.loan_folder });
      // THE WHOLE OBJECT, exactly as push.js hands it over. Passing
      // `desired.status` — the bare string — makes the rule read "the engine
      // claimed nothing", because a string carries no `.status` of its own. This
      // route shipped that way for one afternoon and answered a real report by
      // confidently naming a guard that had never run. The irony is on the record:
      // the header above promises this runs the real rule rather than a paraphrase,
      // and an argument passed in the wrong shape IS a paraphrase.
      const shared = {
        desired,
        current: cardStatus || '',
        watermark: loan.clickup_status_event_at || null,
        latestEntered: lastEntered ? lastEntered.observed_at : null,
        now: new Date(),
      };
      // THE DIRECTION TEST NEEDS THE LIST'S OWN ORDER. push.js peeks with no order
      // and only pays for the read when the answer turns on it; the same two steps
      // happen here, through the READ-ONLY client — whose `call` refuses anything
      // but GET — so this reports the verdict the sync would actually reach.
      let names = null; let listReadError = null;
      let d = statusPush.decideStatusPush({ ...shared, statusOrder: null });
      if (d.act === 'review' || d.act === 'push') {
        const listId = card && card.list && card.list.id;
        try {
          const info = listId ? await clickup._internals.call(`/list/${listId}`) : null;
          const sts = (info && info.statuses) || null;
          const usable = Array.isArray(sts) && sts.length
            && sts.every((st) => Number.isFinite(Number(st && st.orderindex)));
          names = usable
            ? sts.slice().sort((a, b) => Number(a.orderindex) - Number(b.orderindex)).map((st) => String(st.status || ''))
            : null;
          if (!listId) listReadError = 'the card does not name a list';
          else if (!usable) listReadError = 'the list carried no status order this route could trust';
        } catch (e) { listReadError = String((e && e.message) || e).slice(0, 200); }
        d = statusPush.decideStatusPush({ ...shared, statusOrder: names });
      }
      decision = {
        desired: desired && desired.status, desiredBecause: desired && desired.reason,
        act: d.act, reason: d.reason,
        statusOrder: names, listReadError,
        note: 'field 1393 and the funding channel are not read here, so a cancelled or on-hold file could outrank this',
      };
    } catch (e) { decision = { error: String((e && e.message) || e).slice(0, 200) }; }

    // ── 4. WHERE IN THE PUSH QUEUE THIS LOAN ACTUALLY SITS ───────────────────
    // `dueForPush` answers "is it in the queue", which is NOT the question a person
    // is asking when a card has not moved for two hours. The pass takes
    // LT_CLICKUP_PUSH_PER_PASS loans per sync tick (5 by default) in one single
    // order, and a witnessed milestone move waits its turn behind every routine
    // field refresh — so a book of a few hundred linked loans can put HOURS between
    // the move and the card, with nothing anywhere reading as broken. That wait is
    // invisible from every other screen, so it is measured here: the same WHERE and
    // the same ORDER BY as pushPass, read through row_number.
    let queue = null;
    try {
      const cap = Math.max(1, parseInt(process.env.LT_CLICKUP_PUSH_PER_PASS || '5', 10) || 5);
      // THE PASS'S OWN WHERE AND ORDER BY, never a copy of them. The first version
      // of this block retyped the ordering, and therefore ranked by the OLD rule —
      // reporting the opposite of what the pass would actually do, which is worse
      // than reporting nothing at all. `queueSql` is the one definition both build
      // from, so the two cannot disagree.
      const { queueSql } = require('../clickup/push');
      const q = await db.query(
        `WITH due AS (
           SELECT l.id,
                  row_number() OVER (ORDER BY ${queueSql.order('l')}) AS pos,
                  count(*) OVER () AS depth
             FROM lt_loans l
            WHERE ${queueSql.where('l')}
         )
         SELECT (SELECT max(depth) FROM due)::int AS depth,
                (SELECT pos FROM due WHERE id = $1::uuid)::int AS position`, [loan.id]);
      const depth = (q.rows[0] && q.rows[0].depth) || 0;
      const position = (q.rows[0] && q.rows[0].position) || null;
      queue = {
        depth,
        position,
        capPerPass: cap,
        passesAhead: position ? Math.ceil(position / cap) : null,
        note: 'one pass per sync tick, capPerPass loans a pass. A loan waiting on a witnessed milestone move is served ahead of routine field refreshes; inside each group, longest-since-pushed first.',
      };
    } catch (e) { queue = { error: String((e && e.message) || e).slice(0, 200) }; }

    // ── the first link that explains it, in words ────────────────────────────
    let verdict;
    if (!loan.clickup_task_id) {
      /* WHY there is no card, not merely THAT there is none (owner-reported
         2026-08-27, file YSCAP258134841 / 300 Apple St). This branch used to say
         "Link it first", which names the symptom, blames nobody in particular and
         sends whoever is reading it to do by hand the very thing that was supposed
         to happen automatically. That is how a create pass that had silently
         stopped considering a whole population of loans stayed invisible for three
         days. Every answer below names the cause and what will happen next. */
      let why;
      try {
        // Lazy, like queueSql below — this route is required at boot.
        const clickupPush = require('../clickup/push');
        const cand = await clickupPush.createCandidates({ scan: 100000 });
        const queued = (cand.rows || []).some((r) => String(r.id) === String(loan.id));
        if (queued) {
          why = loan.clickup_push_error
            ? `it IS in the create queue, and the last attempt was refused: ${loan.clickup_push_error}. Fix that and the next pass will make the card.`
            : 'it IS in the create queue and no attempt has been refused — the next create pass should make the card. If it has not within about ten minutes, read clickup_push_error below.';
        } else {
          const handoff = (await db.query(
            `SELECT 1 FROM lt_loan_milestones m
              WHERE m.loan_id = $1::uuid AND m.done = true
                AND ${clickupPush.MILESTONE_NORM_SQL('m.milestone_name')} = ANY($2::text[]) LIMIT 1`,
            [loan.id, clickupPush.HANDOFF_MILESTONES()])).rowCount > 0;
          why = handoff
            ? 'it has finished the hand-off to the processor but the create pass still will not take it — read clickup_push_error below, and check the loan carries a loan number and has been read from Encompass.'
            : `PILOT first saw this loan on ${loan.created_at}, which is before the create cutoff (${clickupPush.createSince()}), and it has not finished LO Prep — so the automatic pass does not consider it. It gets a card when it reaches the processor, or immediately if somebody makes one by hand.`;
        }
      } catch (e) {
        why = `and PILOT could not work out why (${e.message}).`;
      }
      verdict = `NO CARD — this loan has no ClickUp card, so no status could be written: ${why}`;
    } else if (String(loan.clickup_link_confidence || 'confirmed') !== 'confirmed') {
      verdict = `The card link is "${loan.clickup_link_confidence}" rather than confirmed, and the push pass only takes confirmed links. Confirm the link.`;
    } else if (!lastEntered) {
      verdict = 'LINK 1 — PILOT never WITNESSED a milestone move on this loan. '
        + (events.length
          ? `The only events recorded are ${[...new Set(events.map((e) => e.event_type))].join(', ')}, and a baseline is a first sighting rather than a move — it deliberately pushes nothing.`
          : 'There are no milestone events at all.')
        + ' A status is only ever written for a witnessed move (the owner\'s rule, 2026-08-24), so the card was never going to be told.';
    } else if (loan.clickup_status_event_at
        && new Date(lastEntered.observed_at).getTime() <= new Date(loan.clickup_status_event_at).getTime()) {
      // WHO ACTUALLY WROTE IT — the automatic pass, or a person. The first version
      // of this branch said "the push queue reached it at ...", and on the very loan
      // this route was built for that was FALSE: the queue never arrived, and the
      // owner wrote the status himself with the Push Updates button. `clickup_pushed_at`
      // alone cannot tell the two apart — both stamp it — and guessing turned a
      // two-and-a-half-hour outage into a story about it working late. The write log
      // knows: `source` is 'manual' for the button and 'full_repush' for the pass.
      let wroteBy = null;
      try {
        const { rows: w } = await db.query(
          `SELECT source, created_at FROM lt_clickup_write_log
            WHERE task_id = $1 AND field_key = '__status' AND changed = true
            ORDER BY created_at DESC LIMIT 1`, [String(loan.clickup_task_id)]);
        if (w[0]) wroteBy = { source: w[0].source || null, at: w[0].created_at };
      } catch (e) { wroteBy = { error: String((e && e.message) || e).slice(0, 120) }; }
      const byHand = !!(wroteBy && wroteBy.source === 'manual');
      const agrees = decision && decision.desired && cardStatus
        && String(cardStatus).trim().toLowerCase() === String(decision.desired).trim().toLowerCase();
      const waited = loan.clickup_pushed_at
        ? Math.round((new Date(loan.clickup_pushed_at).getTime()
                      - new Date(lastEntered.observed_at).getTime()) / 60000)
        : null;
      const howLong = waited != null && waited > 0 ? `${waited} minutes after the milestone` : 'immediately';
      verdict = agrees
        ? (byHand
          ? `A PERSON DID THIS, NOT THE SYNC — the card holds "${cardStatus}", but the write log says it was written by hand (Push Updates), ${howLong}. The automatic pass never reached this loan. Do not read the card being right as the sync working.`
          : `ANSWERED — the move was witnessed at ${lastEntered.observed_at} and the automatic pass wrote "${cardStatus}" ${howLong}. Nothing is wrong with this loan; the only question is whether that wait is acceptable.`)
        : `LINK 3 — the move was witnessed at ${lastEntered.observed_at}, but the loan's status watermark is already at ${loan.clickup_status_event_at}, so that move has been answered. The card holding "${cardStatus}" is a disagreement PILOT will not overwrite; it belongs in the status-review list.`;
    } else if (!dueForPush) {
      verdict = `LINK 2 — the move was witnessed, but the push pass will not pick this loan up: it was last pushed at ${loan.clickup_pushed_at} which is not older than the last read at ${loan.encompass_synced_at}.`;
    } else if (decision && decision.act === 'push' && queue && queue.position && queue.position > (queue.capPerPass || 5)) {
      verdict = `LINK 2 — the rule WOULD write "${decision.desired}", and nothing is refusing it. This loan is number ${queue.position} of ${queue.depth} in the push queue, and the pass takes ${queue.capPerPass} a tick — about ${queue.passesAhead} passes away. The card is not stuck; it is queued behind routine field refreshes that have no claim to go first.`;
    } else if (decision && decision.act === 'push') {
      verdict = `Everything lines up — the next push pass should write "${decision.desired}". If it has not within about ten minutes, read clickup_push_error below.`;
    } else {
      verdict = `LINK 3 — the rule declined to write: ${decision && decision.reason}. That is the owner's own guard, not a fault.`;
    }

    res.json({
      ok: true,
      loanNumber,
      verdict,
      pilot: {
        milestone: loan.milestone_name, stage: loan.stage_key,
        milestoneSince: loan.milestone_since, sinceIsBaseline: loan.milestone_since_is_baseline,
        ladderReadAt: loan.ladder_synced_at, lastFullRead: loan.encompass_synced_at,
        readError: loan.encompass_sync_error, folder: loan.loan_folder,
      },
      clickup: {
        taskId: loan.clickup_task_id, customId: loan.clickup_custom_id,
        linkConfidence: loan.clickup_link_confidence,
        cardStatusNow: cardStatus, cardReadError: cardError,
        pushedAt: loan.clickup_pushed_at, pushError: loan.clickup_push_error,
        statusWatermark: loan.clickup_status_event_at,
        dueForPush,
      },
      queue,
      witnessed: { lastEntered, events },
      ladder: { steps: ladderRows.length, rows: ladderRows },
      decision,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
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
