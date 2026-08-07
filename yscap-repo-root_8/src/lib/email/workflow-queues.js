'use strict';
/**
 * ONE OVERDUE EMAIL, ONE CARD PER WORKFLOW — the grouping rule for the Workflow-overdue nudge.
 *
 * Owner-directed 2026-08-07: *"emails like this should have a list of the files and the status of
 * each and every file and whose loan officer in every single file, nicely designed … if it's in the
 * draw coordinator workflow, the draw coordinator workflows should only be stuff that they need to
 * do now. It means stuff that has open draws, and the same thing for the closer work loan for the
 * purchasing workflow. Nicely design every workflow separately."*
 *
 * The nudge used to be one merged list with a "Waiting for" column, which reads as ONE job that was
 * arbitrarily split. It is not: setting a file up for the processor, sending a closing package, and
 * ordering a draw inspection are three different desks that happen to route to the same person. So
 * each workflow family gets its OWN card, with its own title and its own subtitle saying what that
 * queue is for — which is what makes two lists in one email read as two different jobs.
 *
 * PURE — no DB, no network, no I/O. It is handed the rows `workflow.overdueItemsFor` already
 * returns and decides only how they are grouped, ordered and worded.
 */

/**
 * The families, in the order a file actually travels: set up → clear → close → fund the draws →
 * sell it. An email that lists them in that order reads like the pipeline the recipient knows.
 *
 * `roles` matches `workflow.typeConfig(t).role`; `types` pins a hand-off whose role is null (those
 * are routed to a person by hand, so the role cannot place them). A type matching NEITHER lands in
 * `other` rather than being dropped — an unrecognised hand-off is still overdue work.
 */
const FAMILIES = [
  {
    key: 'processing',
    roles: ['processor'],
    title: 'Processing',
    subtitle: 'Files handed to you to set up, work, or clear conditions on.',
  },
  {
    key: 'closing',
    roles: ['closer'],
    title: 'Closing',
    subtitle: 'Files with a closing date on them, waiting on the closing steps.',
  },
  {
    key: 'draws',
    roles: ['draw_coordinator'],
    title: 'Construction draws',
    subtitle: 'Funded files where a borrower is waiting on draw money right now.',
    /* The one family where being routed the file is NOT the same as having something to do — see
       `has_open_draw` in workflow.overdueItemsFor. */
    onlyWhenOpenDraw: true,
    parkedNote: 'set up and waiting — nobody has asked for a draw on them yet, so there is nothing to do until they do.',
  },
  {
    key: 'purchasing',
    types: ['post_closing'],
    title: 'Purchasing / investor delivery',
    subtitle: 'Funded files waiting on post-closing conditions and delivery to the investor.',
  },
  {
    key: 'exceptions',
    roles: ['super_admin'],
    types: ['exception'],
    title: 'Exceptions and escalations',
    subtitle: 'Files somebody sent you personally to review or clear.',
  },
  {
    key: 'other',
    title: 'Everything else',
    subtitle: 'Hand-offs that do not belong to one of the queues above.',
  },
];

/** Which family a row belongs to. Falls through to `other` — never dropped. */
function familyFor(submissionType, cfg) {
  const t = String(submissionType || '');
  const role = cfg && cfg.role ? String(cfg.role) : null;
  for (const f of FAMILIES) {
    if (f.types && f.types.indexOf(t) !== -1) return f;
    if (f.roles && role && f.roles.indexOf(role) !== -1) return f;
  }
  return FAMILIES[FAMILIES.length - 1];
}

/** "3d" / "9h" — how far past target, at the resolution a person actually thinks in. */
function overBy(hoursOver) {
  const h = Math.max(0, Math.round(Number(hoursOver) || 0));
  return h >= 48 ? `${Math.floor(h / 24)}d` : `${h}h`;
}

/** The property, else the loan number, else something honest. */
function addressOf(row) {
  const a = (row && row.property_address) || {};
  const line = typeof a === 'string'
    ? a
    : (a.oneLine || [a.street || a.line1, a.city, a.state].filter(Boolean).join(', '));
  if (line) return line;
  if (row && row.ys_loan_number) return String(row.ys_loan_number).toUpperCase();
  return 'a file';
}

function words(s) { return String(s || '').replace(/_/g, ' '); }

/**
 * Group overdue hand-offs into one table per workflow.
 *
 * @param {Array} items   rows from `workflow.overdueItemsFor`
 * @param {Function} typeConfig  `workflow.typeConfig` (injected so this file stays pure)
 * @param {Object} [opts]
 * @param {number} [opts.perTable=8]  cap per card
 * @param {number} [opts.total]       the recipient's real overdue count, when it exceeds `items`
 * @returns {{tables: Array, shown: number, parked: number}}
 */
function buildQueueTables(items, typeConfig, opts) {
  const o = opts || {};
  const perTable = Number(o.perTable) > 0 ? Number(o.perTable) : 8;
  const rows = Array.isArray(items) ? items : [];

  const buckets = new Map();
  let parked = 0;
  for (const it of rows) {
    const cfg = typeof typeConfig === 'function' ? typeConfig(it.submission_type) : null;
    const fam = familyFor(it.submission_type, cfg);
    /* The owner's rule, applied HERE rather than in the query: a draw hand-off on a file where
       nobody has asked for money is real, it is simply not today's work. It is COUNTED and named
       in the card's note — never silently dropped. */
    if (fam.onlyWhenOpenDraw && !it.has_open_draw) { parked++; continue; }
    if (!buckets.has(fam.key)) buckets.set(fam.key, { fam, rows: [] });
    buckets.get(fam.key).rows.push({ it, cfg });
  }

  const tables = [];
  let shown = 0;
  for (const fam of FAMILIES) {
    const b = buckets.get(fam.key);
    if (!b || !b.rows.length) continue;
    const take = b.rows.slice(0, perTable);
    shown += take.length;
    const notes = [];
    if (b.rows.length > take.length) {
      notes.push(`…and ${b.rows.length - take.length} more in this queue.`);
    }
    if (fam.parkedNote && parked) {
      notes.push(`${parked} other file${parked === 1 ? ' is' : 's are'} ${fam.parkedNote}`);
    }
    tables.push({
      title: `${fam.title} — ${b.rows.length} past target`,
      subtitle: fam.subtitle,
      head: ['Property / file', 'Waiting for', 'File status', 'Loan officer', 'Over by'],
      align: ['left', 'left', 'left', 'left', 'right'],
      rows: take.map(({ it, cfg }) => [
        addressOf(it),
        (cfg && cfg.label) || words(it.submission_type),
        words(it.file_status) || '—',
        it.lo_name || 'unassigned',
        overBy(it.hours_over),
      ]),
      note: notes.length ? notes.join(' ') : null,
    });
  }

  /* A draw queue that is ENTIRELY parked has no card of its own, so the fact would vanish. Say it
     once at the end instead — the recipient still learns their draw files are accounted for. */
  const drawFam = FAMILIES.find((f) => f.key === 'draws');
  if (parked && !buckets.has('draws')) {
    tables.push({
      title: 'Construction draws',
      subtitle: drawFam.subtitle,
      head: ['Status'],
      align: ['left'],
      rows: [[`${parked} file${parked === 1 ? ' is' : 's are'} ${drawFam.parkedNote}`]],
      note: null,
    });
  }

  return { tables, shown, parked };
}

module.exports = { buildQueueTables, familyFor, overBy, addressOf, FAMILIES };
