/* PILOT-branded construction-draw inspection reports (Draw Management phase 2b, owner-directed 2026-07-20).
 *
 * Turns a draw's inspector findings + the DURABLE photos we archived (phase 2a `draw_media`) into a
 * polished, PILOT-branded PDF the coordinator can file and the borrower can see:
 *   • per-draw report  — one draw: schedule of values, per-line approved/not-approved, inspector notes,
 *                        and the inspector's photos embedded (never expiring — read from PILOT storage);
 *   • whole-project    — cumulative construction progress across every draw + all inspections;
 *   • borrower-safe    — the same, with every capital-partner name scrubbed, lender fee/net stripped, and
 *                        photo GPS removed (a borrower must never see our margin or a note-buyer name).
 *
 * The builder (`buildDrawReport`) is a PURE renderer over already-loaded data (app header, rollup,
 * draw sections with photo BYTES) so it unit-tests with no DB and no network. The DB/storage side
 * (`loadReportMeta` + `attachPhotoBytes` + `storeDrawReport` + `reportVersion`) lives here too but is only
 * touched by the routes. Reuses pdfSafe/fit + the PILOT palette from the esign application PDF; it does NOT
 * refactor that live signing path (per the build spec — avoid regressions on e-sign).
 *
 * jsPDF runs in Node dependency-free (the same UMD the browser tools + the esign PDF use); text is written
 * uncompressed so field values are greppable in the raw bytes (the tests assert on that). Photos embed via
 * doc.addImage: JPEG + well-formed PNG only, format chosen from the file's MAGIC BYTES (content_type is not
 * trusted); anything else — or a byte buffer that won't decode — is skipped, never thrown.
 */
const path = require('path');
const crypto = require('crypto');
const { pdfSafe, fit } = require('../lib/esign/application-pdf');
const { scrubText } = require('../lib/borrower-safe');
// DB / storage / rollup are required lazily inside the DB-side functions only, so the PURE builder path
// (and its unit test) never touches the database or trips the "DATABASE_URL not set" boot log.
const lazy = { get db() { return require('../db'); }, get storage() { return require('../lib/storage'); }, get rollup() { return require('./rollup'); }, get media() { return require('./media-archive'); } };
const { stripLocationExif } = require('../lib/image-exif');

// ---- jsPDF lazy loader (own cache; deliberately NOT sharing esign's, so a report can render even if the
// esign module never loaded). Same UMD bundle. ----
let _jsPDF = null;
function getJsPDF() {
  if (_jsPDF) return _jsPDF;
  const abs = path.join(__dirname, '..', '..', 'web', 'tools', 'vendor', 'jspdf.umd.min.js');
  const mod = require(abs);
  _jsPDF = (mod && typeof mod.jsPDF === 'function') ? mod.jsPDF : (global.jspdf && global.jspdf.jsPDF);
  if (typeof _jsPDF !== 'function') { const e = new Error('PDF engine not loaded'); e.retryable = false; throw e; }
  return _jsPDF;
}

const LENDER = { name: 'YS Capital Group', nmls: '2609746', addr: '5 New Montrose Avenue, Brooklyn, NY 11211', phone: '(718) 635-0277' };

// Embedding budgets — keep the PDF a sane size without a native image resizer (jsPDF embeds JPEG bytes
// as-is). Bound by count AND total embedded bytes; anything past the budget is summarized, not dropped.
// EVERY photo goes in the report (owner-directed 2026-07-27: "all pictures"). A single draw's
// inspection carries ~100 photos (99 on the 105-107 N 10th St draw #2), so the old 4-per-line /
// 32-per-report caps silently dropped roughly two thirds of them. These are now SAFETY ceilings,
// not editorial limits — high enough that a real inspection never reaches them, low enough that a
// runaway archive can't build a PDF nobody can open. Anything beyond is REPORTED at the end of the
// report, never silently missing.
const MAX_PHOTOS_PER_LINE = 250;
const MAX_PHOTOS_TOTAL = 400;
const EMBED_BYTE_BUDGET = 60 * 1024 * 1024;

const usd = (cents) => '$' + (Math.round(Number(cents) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const pctStr = (n) => (Number.isFinite(n) ? (Math.round(Number(n) * 10) / 10) + '%' : '0%');

// Detect JPEG / PNG from the leading bytes (content_type is set at upload and not trusted). Returns the
// jsPDF format string, or null for anything we won't embed (webp/gif/heic/garbage) — skipped, not thrown.
function imageFormat(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'JPEG';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'PNG';
  return null;
}

/**
 * Build a PILOT-branded draw report. PURE — no DB, no storage, no network.
 * @param {object} args
 * @param {object} args.app     { loanNo, address, csz, borrowerName, program }
 * @param {object} args.rollup  rollupMod.computeRollup / loadRollup output (project + lines)
 * @param {Array}  args.sections one entry per draw:
 *     { number, status, requested_cents, approved_cents, not_approved_cents, fee_cents, net_release_cents,
 *       released, release_date, submitted_at, approved_at,
 *       lines: [{ name, inspector_comments, requested_cents, approved_cents, not_approved_cents,
 *                 photos: [{ buf, format?, caption }] }] }
 * @param {'draw'|'project'} args.scope
 * @param {'staff'|'borrower'} args.mode
 * @returns {Buffer} PDF bytes
 */
function buildDrawReport({ app = {}, rollup = null, sections = [], scope = 'draw', mode = 'staff' } = {}) {
  const jsPDF = getJsPDF();
  const borrower = mode === 'borrower';
  // borrower copy: scrub any capital-partner name out of every free-text value that lands in the PDF.
  const clean = (s) => (borrower ? scrubText(String(s == null ? '' : s)) : String(s == null ? '' : s));

  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
  const INK = [11, 16, 20], TEAL = [31, 58, 64], GOLD = [150, 123, 68], GRAY = [91, 103, 112], DARK = [19, 32, 28], LINE = [228, 224, 214];
  const BAD = [176, 74, 63];
  const title = scope === 'project' ? 'Construction Progress Report' : 'Draw Inspection Report';
  const subtitle = scope === 'project'
    ? (borrower ? 'Construction progress across all draws' : 'Cumulative draw + inspection summary')
    : (sections[0] ? 'Draw #' + (sections[0].number != null ? sections[0].number : '—') : 'Draw inspection');
  const loanNo = app.loanNo || '';
  let y = 0;

  function header() {
    doc.setFillColor.apply(doc, INK); doc.rect(0, 0, W, 76, 'F');
    doc.setFillColor.apply(doc, GOLD); doc.rect(0, 76, W, 2.2, 'F');
    doc.setTextColor(243, 239, 230); doc.setFont('times', 'bold'); doc.setFontSize(20); doc.text('PILOT', M, 40);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(201, 168, 106); doc.text('by YS Capital', M + 62, 40);
    doc.setTextColor(243, 239, 230); doc.setFont('times', 'bold'); doc.setFontSize(15); doc.text(pdfSafe(title), W - M, 34, { align: 'right' });
    doc.setFont('times', 'italic'); doc.setFontSize(9); doc.setTextColor(201, 168, 106); doc.text(pdfSafe(subtitle), W - M, 50, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(170, 178, 182);
    doc.text(pdfSafe(LENDER.name + ' · NMLS ' + LENDER.nmls + (loanNo ? ' · Loan #' + clean(loanNo) : '')), W - M, 65, { align: 'right' });
  }
  function footer(pageNum) {
    doc.setFontSize(7); doc.setTextColor(150, 158, 162); doc.setFont('helvetica', 'normal');
    doc.text(pdfSafe(LENDER.name + ' · NMLS ' + LENDER.nmls + ' · ' + LENDER.addr + ' · ' + LENDER.phone), M, H - 34, { maxWidth: W - 2 * M });
    const note = borrower
      ? 'Construction-progress summary prepared for the borrower. Inspection findings are subject to lender review.'
      : 'Internal draw inspection report. Figures are integer cents rolled up from the Sitewire draw record + the PILOT ledger.';
    doc.text(pdfSafe(note), M, H - 22, { maxWidth: W - 2 * M });
    if (pageNum) doc.text(pdfSafe('Page ' + pageNum), W - M, H - 22, { align: 'right' });
  }
  let page = 1;
  function brk(need) { if (y + need > H - 56) { footer(page); doc.addPage(); page++; header(); y = 92; } }
  function band(t) {
    brk(30); doc.setFillColor.apply(doc, TEAL); doc.roundedRect(M, y, W - 2 * M, 17, 2.5, 2.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.2); doc.setTextColor(255, 255, 255);
    doc.text(pdfSafe(String(t).toUpperCase()), M + 7, y + 11.5); y += 23;
  }
  function kv(k, val, opts) {
    opts = opts || {}; const sv = pdfSafe(fit(String(val == null ? '' : val), 70));
    if (val == null || val === '' || !/\S/.test(sv)) return;
    brk(16); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.4); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe(k), M + 3, y + 8);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.6); doc.setTextColor.apply(doc, opts.accent ? GOLD : DARK);
    doc.text(sv, W - M - 3, y + 8, { align: 'right' });
    y += 15; doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.4); doc.line(M + 3, y - 3.5, W - M - 3, y - 3.5);
  }
  function para(t, size, color) {
    const ls = doc.splitTextToSize(pdfSafe(t), W - 2 * M - 6); brk(ls.length * 10.5 + 6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(size || 8); doc.setTextColor.apply(doc, color || [70, 78, 82]);
    doc.text(ls, M + 3, y + 8); y += ls.length * 10.5 + 8;
  }

  /**
   * THE MONEY ANSWER, FIRST (owner-directed 2026-07-27). The report used to open with the
   * property/loan header and bury "how much was approved" partway down the second band — so the
   * one question the borrower opens this PDF to answer was the hardest thing on the page to find.
   * A per-draw report now leads with a single panel: what was approved, of what was requested,
   * how much was not, and what it means. Everything else follows underneath, unchanged.
   */
  function moneyHero(s) {
    const req = Number(s.requested_cents || 0);
    const appr = Number(s.approved_cents || 0);
    const notAppr = s.not_approved_cents != null ? Number(s.not_approved_cents) : Math.max(0, req - appr);
    const full = notAppr <= 0 && req > 0;
    // WHOSE approval is this number? Until we press Final approve it is the INSPECTOR'S — the
    // proposal the borrower is being asked to accept — and the report must say so rather than
    // print a confident $0 (owner-directed 2026-08-03: "the report should show what the inspector
    // approved… even though he didn't click on final approve yet").
    const finalDone = !!s.final_approved_cents || s.approval_stage === 'final_approved' || s.approval_stage === 'released';
    const heroLabel = finalDone
      ? (s.released ? 'RELEASED' : 'FINAL APPROVED FOR RELEASE')
      : 'APPROVED BY THE INSPECTOR';
    const H0 = 96;
    brk(H0 + 10);
    doc.setFillColor(246, 243, 236); doc.roundedRect(M, y, W - 2 * M, H0, 4, 4, 'F');
    doc.setFillColor.apply(doc, full ? TEAL : GOLD); doc.roundedRect(M, y, 4.5, H0, 2, 2, 'F');

    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.4); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe(heroLabel), M + 18, y + 20);
    // the headline number, as large as the panel allows
    doc.setFont('times', 'bold'); doc.setFontSize(34); doc.setTextColor.apply(doc, full ? TEAL : DARK);
    doc.text(pdfSafe(usd(appr)), M + 18, y + 52);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe('of ' + usd(req) + ' requested'), M + 18, y + 70);

    // the right-hand rail: what was held back, and the plain-language meaning
    const rx = W - M - 18;
    if (notAppr > 0) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.4); doc.setTextColor.apply(doc, GRAY);
      doc.text(pdfSafe('NOT APPROVED THIS INSPECTION'), rx, y + 20, { align: 'right' });
      doc.setFont('times', 'bold'); doc.setFontSize(18); doc.setTextColor.apply(doc, BAD);
      doc.text(pdfSafe(usd(notAppr)), rx, y + 42, { align: 'right' });
    } else if (full) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor.apply(doc, TEAL);
      doc.text(pdfSafe('Everything requested was approved'), rx, y + 30, { align: 'right' });
    }
    // The plain-language meaning under the headline. It states (a) whose approval this is and what
    // happens next, and (b) exactly what is netted out of it — the owner's ask that the report say
    // clearly why money is being netted and what.
    const stageLine = finalDone
      ? (s.released ? 'This draw has been released.' : 'Final approved — ready to release.')
      : (borrower
        ? 'This is what the inspector approved. Accept it and your loan team releases the draw.'
        : 'This is the INSPECTOR\u2019S approval. It still needs the borrower\u2019s acceptance, the capital partner\u2019s review and our final approval before the money is released.');
    const netLine = borrower ? '' : (s.net_release_cents != null
      ? ' Net release ' + usd(s.net_release_cents) + ' = ' + usd(appr) + ' approved, less the ' + usd(s.fee_cents || 0) + ' draw fee'
        + (Number(s.retainage_held_cents) > 0 ? ' and ' + usd(s.retainage_held_cents) + ' retainage' : '')
        + (s.fee_projected ? ' (standard fee for this file \u2014 final once the release is recorded).' : '.')
      : '');
    const meaning = borrower
      ? (notAppr > 0
        ? stageLine + '\nAnything not approved stays in your budget for a future draw once that work is complete.'
        : stageLine)
      : (stageLine + netLine + ' Status: ' + (s.approval_label || STATUS_LABEL(s.status, false)) + '.');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8); doc.setTextColor.apply(doc, [70, 78, 82]);
    doc.text(pdfSafe(meaning), M + 18, y + 84, { maxWidth: W - 2 * M - 36 });
    y += H0 + 14;
  }

  header();
  y = 96;

  // The money answer leads a PER-DRAW report; a whole-project report leads with the schedule of
  // values instead (there is no single draw for a headline to be about).
  if (scope !== 'project' && sections[0]) moneyHero(sections[0]);

  // ---- File header ----
  band('Property & loan');
  kv('Property', clean(app.address));
  kv('City / State / ZIP', clean(app.csz));
  kv('Loan number', clean(loanNo), { accent: true });
  kv('Borrower', clean(app.borrowerName));
  if (!borrower && app.program) kv('Program', app.program);
  else if (borrower) kv('Program', 'Gold Standard program');

  // ---- Schedule of values (project-wide progress) ----
  if (rollup && rollup.project) {
    // The heading keeps "Schedule of values" in both shapes — it is the term the desk and the
    // existing report contract use — and only says what the extra columns add.
    band(scope !== 'project' && sections[0] && Array.isArray(sections[0].lines) && sections[0].lines.length
      ? 'Schedule of values — full budget, with this draw on every line'
      : 'Schedule of values — construction progress');
    const p = rollup.project;
    // headline tiles row
    brk(52);
    // "Remaining" used to be budget − RELEASED, so a $25,000 draw sitting at inspector-approved left
    // the whole $220,000 showing as still available. The tiles now show what is genuinely free.
    const committed = p.committed != null ? p.committed : p.drawn;
    const available = p.available != null ? p.available : p.remaining;
    const tiles = [
      ['Budget', usd(p.budget)],
      ['Released', usd(p.drawn)],
      ['Approved, not yet released', usd(Math.max(0, committed - p.drawn))],
      ['Still available', usd(available)],
    ];
    const tw = (W - 2 * M - 3 * 8) / 4;
    tiles.forEach((t, i) => {
      const x = M + i * (tw + 8);
      doc.setFillColor(246, 243, 236); doc.roundedRect(x, y, tw, 44, 3, 3, 'F');
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor.apply(doc, GRAY);
      doc.text(pdfSafe(t[0].toUpperCase()), x + 8, y + 15);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor.apply(doc, i === 3 ? TEAL : DARK);
      doc.text(pdfSafe(fit(t[1], 14)), x + 8, y + 34);
    });
    y += 54;
    // ---- THE WHOLE BUDGET, WITH THIS DRAW'S ACTIVITY ON EVERY LINE (owner-directed 2026-07-27:
    // "include the entire budget with all the details — how much was budgeted, how much requested
    // and how much was approved from that line at this time"). When we hold per-line inspection
    // detail for the draw, two extra columns are folded into the SAME schedule of values, so one
    // table answers both questions: where the whole project stands, and what this draw did to it.
    // Every budget line is listed either way — a line with no activity this draw shows "—", so a
    // reader can see what was NOT drawn against just as clearly as what was.
    const drawLines = (scope !== 'project' && sections[0] && Array.isArray(sections[0].lines)) ? sections[0].lines : [];
    // Match an inspected line to its BUDGET line by the CROSSWALK KEY, with the name as a fallback.
    // Our Scope of Work keeps ONE "Roof" line; Sitewire keeps one job item per unit ("Unit 1 - Roof"),
    // so a name match could never join the two — which is why the budget row read "—" for requested
    // and approved while four unbudgeted "Unit N - Roof" rows hung underneath it (owner-reported
    // 2026-08-03). `sow_line_key` is the same key the rollup and the Excel packet already join on.
    const activity = new Map();
    const nameKey = (v) => 'n:' + String(v || '').trim().toLowerCase();
    const lineKey = (v) => 'k:' + String(v || '');
    for (const l of drawLines) {
      const key = l.sow_line_key ? lineKey(l.sow_line_key) : (l.name ? nameKey(l.name) : null);
      if (!key) continue;
      const prev = activity.get(key) || { req: 0, appr: 0 };
      activity.set(key, { req: prev.req + (Number(l.requested_cents) || 0), appr: prev.appr + (Number(l.approved_cents) || 0) });
    }
    const withDraw = activity.size > 0;
    const cols = withDraw ? [
      { t: 'Line item', w: 0.24, a: 'left' },
      { t: 'Budget', w: 0.12, a: 'right' },
      { t: 'Released', w: 0.12, a: 'right' },
      { t: 'Requested', w: 0.128, a: 'right' },
      { t: 'Approved', w: 0.128, a: 'right' },
      { t: 'Available', w: 0.13, a: 'right' },
      { t: '% used', w: 0.134, a: 'right' },
    ] : [
      { t: 'Line item', w: 0.34, a: 'left' },
      { t: 'Budget', w: 0.16, a: 'right' },
      { t: 'Released', w: 0.16, a: 'right' },
      { t: 'Available', w: 0.18, a: 'right' },
      { t: '% used', w: 0.16, a: 'right' },
    ];
    // one row builder for both shapes — the draw columns slot in only when we have them.
    // AVAILABLE / % USED count a draw that is inspector-approved but not yet FINALLY approved as
    // spent (the rollup's `available` / `pct_committed`) — owner-directed 2026-08-03: "we should
    // treat a draw that is not fully approved, even if it's halfway approved, as if it is approved…
    // we can still decline it, and everything goes back to fully available."
    const actFor = (line) => activity.get(lineKey(line && line.sow_line_key)) || activity.get(nameKey(line && line.label)) || null;
    const row = (label, budgeted, drawn, available, pct, act) => (withDraw
      ? [label, usd(budgeted), usd(drawn), act ? usd(act.req) : '—', act ? usd(act.appr) : '—', usd(available), pctStr(pct)]
      : [label, usd(budgeted), usd(drawn), usd(available), pctStr(pct)]);
    const iw = W - 2 * M;
    function rowCells(cells, isHead) {
      brk(15);
      // The 7-column (with-draw) shape is tighter, so it steps the type down and clips the line
      // NAME harder — the money columns must never be the thing that gets truncated.
      const wide = cols.length > 5;
      if (isHead) { doc.setFont('helvetica', 'bold'); doc.setFontSize(wide ? 6.9 : 7.6); doc.setTextColor.apply(doc, GRAY); }
      else { doc.setFont('helvetica', 'normal'); doc.setFontSize(wide ? 7.4 : 8); doc.setTextColor.apply(doc, DARK); }
      let x = M + 3;
      cols.forEach((c, i) => {
        const cw = c.w * iw;
        const tx = c.a === 'right' ? x + cw - 6 : x;
        const cap = c.a === 'left' ? (wide ? 34 : 46) : 16;
        doc.text(pdfSafe(fit(String(cells[i] == null ? '' : cells[i]), cap)), tx, y + 9, { align: c.a });
        x += cw;
      });
      y += 14; doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.4); doc.line(M + 3, y - 3, W - M - 3, y - 3);
    }
    rowCells(cols.map((c) => c.t), true);
    const seen = new Set();
    // `available` / `pct_committed` are only on a rollup built by the current code — fall back to the
    // released-only figures rather than printing a blank on an older cached shape.
    const avail = (l) => (l.available != null ? l.available : l.remaining);
    const usedPct = (l) => (l.pct_committed != null ? l.pct_committed : l.pct_complete);
    const shown = rollup.lines.filter((l) => l.kind === 'line');
    for (const l of shown) {
      const act = actFor(l);
      if (act) { seen.add(lineKey(l.sow_line_key)); seen.add(nameKey(l.label)); }
      rowCells(row(clean(l.label), l.budgeted, l.drawn, avail(l), usedPct(l), act));
    }
    for (const l of rollup.lines.filter((l) => l.kind === 'contingency' || l.kind === 'gc')) {
      const label = l.kind === 'gc' ? 'General conditions' : 'Contingency';
      const act = actFor(l) || activity.get(nameKey(label)) || null;
      if (act) { seen.add(lineKey(l.sow_line_key)); seen.add(nameKey(l.label)); seen.add(nameKey(label)); }
      rowCells(row(label, l.budgeted, l.drawn, avail(l), usedPct(l), act));
    }
    // An inspected line that is not on the budget rollup must never vanish from the table — it is
    // exactly the case a reader would ask about (work drawn against something not budgeted).
    for (const l of drawLines) {
      const key = l.sow_line_key ? lineKey(l.sow_line_key) : (l.name ? nameKey(l.name) : null);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const act = activity.get(key);
      rowCells(withDraw
        ? [clean(l.name), '—', '—', usd(act.req), usd(act.appr), '—', '—']
        : [clean(l.name), '—', '—', '—', '—']);
    }
    // totals
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor.apply(doc, TEAL);
    // The DRAW's own stated totals win over the sum of its lines. Per-line detail can legitimately
    // fall short of the draw total (an unallocated amount, a rounding difference, a line the
    // administrator did not itemize), and if the total row disagreed with the headline panel the
    // report would show two different "approved" numbers on one page — the fastest way to lose a
    // borrower's trust in the whole document. The line sum is used only when the draw is silent.
    const sum = (k) => [...activity.values()].reduce((s, a) => s + a[k], 0);
    const s0 = sections[0] || {};
    const totReq = s0.requested_cents != null ? Number(s0.requested_cents) : sum('req');
    // The draw's `approved_cents` is now the INSPECTOR-approved total (approval.drawMoney), so the
    // Total row can no longer disagree with the per-line "Approved" column above it — the old total
    // read Sitewire's final-approval field and printed $0 under a column of real approvals.
    const totAppr = s0.approved_cents != null ? Number(s0.approved_cents) : sum('appr');
    rowCells(row('Total', p.budget, p.drawn,
      p.available != null ? p.available : p.remaining,
      p.pct_committed != null ? p.pct_committed : p.pct_complete,
      withDraw ? { req: totReq, appr: totAppr } : null));
  }

  // ---- OUR FEES ON THIS PROJECT, kept separately from the borrower's money ----
  // Owner-directed 2026-08-03: "it should keep track separately of our fees for this project."
  // Staff copy only — a borrower report never shows our fee income (frozen borrower-safe rule).
  if (!borrower && rollup && rollup.fees && Number(rollup.fees.total_cents) > 0) {
    band('Our draw fees on this project');
    if (rollup.fees.per_draw_cents != null) {
      kv('Fee per draw', usd(rollup.fees.per_draw_cents)
        + (rollup.fees.fee_kind ? ' (' + rollup.fees.fee_kind + ' inspection)' : '')
        + (rollup.fees.overridden ? ' — custom fee set for this file' : ''));
    }
    kv('Charged so far (on recorded releases)', usd(rollup.fees.charged_cents), { accent: true });
    if (Number(rollup.fees.projected_cents) > 0) kv('Expected on draws not yet released', usd(rollup.fees.projected_cents));
    kv('Total for this project', usd(rollup.fees.total_cents));
    para('These fees are netted out of each draw before the borrower is paid — they are our income on this file, not part of the construction budget.', 7.6, GRAY);
  }

  // ---- Per-draw inspection sections ----
  let embeddedBytes = 0, embeddedCount = 0, skippedPhotos = 0;
  for (const s of sections) {
    band((scope === 'project' ? 'Draw #' + (s.number != null ? s.number : '—') : 'This draw') + ' — inspection findings');
    // money summary line — the requested/approved pair is the HERO on a per-draw report, so it is
    // not repeated here; a whole-project report has no hero and still needs it per draw.
    const heroShown = scope !== 'project' && sections[0] === s;
    if (borrower) {
      if (!heroShown) {
        kv('Requested', usd(s.requested_cents));
        kv('Approved', usd(s.approved_cents), { accent: true });
        if (Number(s.not_approved_cents) > 0) kv('Not approved (this inspection)', usd(s.not_approved_cents));
      }
      kv('Status', STATUS_LABEL(s.status, true));
    } else {
      if (!heroShown) {
        kv('Requested', usd(s.requested_cents));
        kv('Approved by the inspector', usd(s.approved_cents), { accent: true });
        if (Number(s.not_approved_cents) > 0) kv('Not approved', usd(s.not_approved_cents));
      }
      // THE RELEASE BREAKDOWN, spelled out (owner-directed 2026-08-03: "clearly on the report, why
      // it's being netted and what exactly is being netted"). Every deduction gets its own line and
      // the arithmetic is shown, so the release amount can never look like the whole approval again.
      kv('Final approved (by us)', Number(s.final_approved_cents) > 0 ? usd(s.final_approved_cents) : 'not yet — awaiting final approval');
      if (Number(s.fee_cents) > 0) kv('Less: draw processing fee' + (s.fee_projected ? ' (standard for this file)' : ''), '-' + usd(s.fee_cents));
      if (Number(s.retainage_held_cents) > 0) kv('Less: retainage held', '-' + usd(s.retainage_held_cents));
      if (s.net_release_cents != null) kv('Net release to the borrower', usd(s.net_release_cents), { accent: true });
      if (Number(s.fee_cents) > 0) {
        para('Our draw processing fee is deducted from the approved amount — the borrower receives the net. '
          + (s.fee_projected
            ? 'This is this file\u2019s standard draw fee; it becomes the final charged fee when the release is recorded.'
            : 'This is the fee recorded on the release.'), 7.4, GRAY);
      }
      kv('Release date', s.release_date ? String(s.release_date).slice(0, 10) : (s.released ? '(released)' : ''));
      kv('Status', s.approval_label || STATUS_LABEL(s.status, false));
    }

    const lines = Array.isArray(s.lines) ? s.lines : [];
    if (!lines.length) { para('No inspection line items on this draw yet.', 8, GRAY); continue; }

    for (const l of lines) {
      brk(24);
      // line title + economics
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor.apply(doc, DARK);
      doc.text(pdfSafe(fit(clean(l.name) || 'Line item', 58)), M + 3, y + 9);
      const notAppr = l.not_approved_cents != null ? Number(l.not_approved_cents) : Math.max(0, Number(l.requested_cents || 0) - Number(l.approved_cents || 0));
      const econ = borrower
        ? 'Requested ' + usd(l.requested_cents) + ' · Approved ' + usd(l.approved_cents)
        : 'Req ' + usd(l.requested_cents) + ' · Appr ' + usd(l.approved_cents);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor.apply(doc, GRAY);
      doc.text(pdfSafe(econ), W - M - 3, y + 9, { align: 'right' });
      y += 14;
      if (notAppr > 0) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7.8); doc.setTextColor.apply(doc, BAD);
        doc.text(pdfSafe('Not approved: ' + usd(notAppr)), W - M - 3, y + 6, { align: 'right' }); y += 11;
      }
      if (l.inspector_comments) para('Inspector: "' + clean(l.inspector_comments) + '"', 8, [70, 78, 82]);

      // photos grid — durable bytes only
      const photos = Array.isArray(l.photos) ? l.photos : [];
      const usable = [];
      for (const ph of photos) {
        if (usable.length >= MAX_PHOTOS_PER_LINE) { skippedPhotos++; continue; }
        if (embeddedCount >= MAX_PHOTOS_TOTAL || embeddedBytes >= EMBED_BYTE_BUDGET) { skippedPhotos++; continue; }
        const buf = ph && ph.buf;
        const fmt = ph && (ph.format || imageFormat(buf));
        if (!buf || !fmt) { skippedPhotos++; continue; }
        usable.push({ buf, fmt, caption: ph.caption });
        embeddedBytes += buf.length; embeddedCount++;
      }
      if (usable.length) {
        const cellW = 118, cellH = 90, gap = 8, perRow = Math.max(1, Math.floor((W - 2 * M) / (cellW + gap)));
        for (let i = 0; i < usable.length; i += perRow) {
          const rowItems = usable.slice(i, i + perRow);
          brk(cellH + 16);
          rowItems.forEach((ph, j) => {
            const x = M + 3 + j * (cellW + gap);
            try {
              doc.addImage(ph.buf, ph.fmt, x, y, cellW, cellH);
              doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.5); doc.rect(x, y, cellW, cellH);
            } catch (_) {
              // a byte buffer that won't decode — draw a placeholder, never throw
              doc.setFillColor(240, 238, 232); doc.rect(x, y, cellW, cellH, 'F');
              doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor.apply(doc, GRAY);
              doc.text('photo unavailable', x + 6, y + cellH / 2);
            }
            if (ph.caption) {
              doc.setFont('helvetica', 'normal'); doc.setFontSize(6.4); doc.setTextColor.apply(doc, GRAY);
              doc.text(pdfSafe(fit(clean(ph.caption), 30)), x, y + cellH + 8);
            }
          });
          y += cellH + 16;
        }
      } else if (photos.length) {
        para('Photos for this line are saved in PILOT but could not be embedded here.', 7.6, GRAY);
      }
      y += 4;
    }
  }

  if (skippedPhotos > 0) {
    para(skippedPhotos + ' additional photo(s) are saved in PILOT beyond this report’s photo limit.', 7.4, GRAY);
  }

  footer(page);
  return Buffer.from(doc.output('arraybuffer'));
}

function STATUS_LABEL(s, borrower) {
  // Borrower copy must NEVER reveal the capital-partner / note-buyer relationship (frozen borrower-safe
  // rule) — collapse the review + capital-partner stages to a neutral "Under review" for the borrower.
  if (borrower) {
    return { drafting: 'Drafting', pending_borrower: 'Awaiting your submission', inspecting: 'Inspection in progress',
      pending: 'Under review', pending_capital_partner: 'Under review', approved: 'Approved' }[s] || 'In progress';
  }
  return { drafting: 'Drafting', pending_borrower: 'With borrower', inspecting: 'Inspecting', pending: 'Under review',
    pending_capital_partner: 'With capital partner', approved: 'Approved' }[s] || (s || 'In progress');
}

// ============================================================================
// DB / storage side — only the routes call these; the builder above stays pure.
// ============================================================================

/**
 * Load everything needed to render (except the photo BYTES, which are read lazily by attachPhotoBytes only
 * on a cache miss). Returns { app, rollup, sections, version, hasScope }.
 *  - sitewireDrawId null  → whole-project report (all draws)
 *  - sitewireDrawId set   → per-draw report (that draw only)
 * `sections[].lines[].photos` here carry METADATA ONLY: { storage_ref, content_type, caption }.
 */
async function loadReportMeta(appId, { sitewireDrawId = null, mode = 'staff' } = {}) {
  const drawId = sitewireDrawId != null ? Number(sitewireDrawId) : null;
  const a = (await lazy.db.query(
    `SELECT a.ys_loan_number,
            a.property_address->>'oneLine' AS address_one,
            a.property_address->>'city'  AS city,
            a.property_address->>'state' AS state,
            a.property_address->>'zip'   AS zip,
            b.first_name, b.last_name,
            pr.program AS program
       FROM applications a
       LEFT JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN product_registrations pr ON pr.application_id = a.id AND pr.is_current
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId])).rows[0];
  if (!a) return null;
  const csz = [a.city, a.state].filter(Boolean).join(', ') + (a.zip ? ' ' + a.zip : '');
  const app = {
    loanNo: a.ys_loan_number || '',
    address: a.address_one || '',
    csz: csz.trim(),
    borrowerName: require('../lib/person-name').displayName(a),
    program: /gold/i.test(String(a.program || '')) ? 'Gold Standard program' : /silver/i.test(String(a.program || '')) ? 'Silver Program' : (a.program ? 'Standard Program' : ''),
  };

  // SOW labels for the rollup (never required)
  let sowState = null;
  try { const s = (await lazy.db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appId])).rows[0]; sowState = s && s.tool_payload && s.tool_payload.state ? s.tool_payload.state : null; } catch (_) {}
  const rollup = await lazy.rollup.loadRollup(lazy.db, appId, { sowState });

  // draws in scope + their rolled-up money (from the same rollup so fee/net line up with the desk)
  const drawById = new Map((rollup.draws || []).map((d) => [Number(d.sitewire_draw_id), d]));
  const findings = (drawId != null
    ? await lazy.db.query(`SELECT id, sitewire_draw_id, status FROM draw_findings WHERE application_id=$1 AND sitewire_draw_id=$2 ORDER BY delivered_at DESC`, [appId, drawId])
    : await lazy.db.query(`SELECT id, sitewire_draw_id, status FROM draw_findings WHERE application_id=$1 ORDER BY sitewire_draw_id`, [appId])).rows;
  // one finding per draw (latest); build the section list from the rollup draws in scope
  const findingByDraw = new Map();
  for (const f of findings) if (!findingByDraw.has(Number(f.sitewire_draw_id))) findingByDraw.set(Number(f.sitewire_draw_id), f);

  const drawIds = drawId != null ? [drawId] : (rollup.draws || []).map((d) => Number(d.sitewire_draw_id));
  const sections = [];
  for (const did of drawIds) {
    const d = drawById.get(did) || {};
    const f = findingByDraw.get(did);
    let lines = [];
    if (f) {
      const rows = (await lazy.db.query(
        `SELECT id, sitewire_request_id, sitewire_job_item_id, sow_line_key, unit_index, name, requested_cents, approved_cents, not_approved_cents, inspector_comments
           FROM draw_finding_lines WHERE finding_id=$1 AND retired_at IS NULL ORDER BY id`, [f.id])).rows;
      // durable archived photos for this draw, grouped by request id (kind='image' only)
      const media = (await lazy.db.query(
        `SELECT sitewire_request_id, storage_ref, content_type, note, lat, lng, captured_at
           FROM draw_media WHERE application_id=$1 AND sitewire_draw_id=$2 AND kind='image' ORDER BY id`, [appId, did])).rows;
      const mediaByReq = new Map();
      for (const m of media) {
        const k = m.sitewire_request_id != null ? Number(m.sitewire_request_id) : null;
        const arr = mediaByReq.get(k) || []; arr.push(m); mediaByReq.set(k, arr);
      }
      lines = rows.map((r) => ({
        name: r.name,
        // The crosswalk key is how an inspected line finds its BUDGET line. Our Scope of Work keeps
        // one line ("Roof") while Sitewire keeps one job item per unit ("Unit 1 - Roof"), so matching
        // the two by NAME — as this report used to — could never line them up: the budget row showed
        // "—" for requested and approved while four "Unit N - Roof" rows dangled underneath it as
        // work drawn against nothing budgeted (owner-reported 2026-08-03). The name stays as the
        // fallback for a line that predates the crosswalk.
        sow_line_key: r.sow_line_key || null,
        unit_index: r.unit_index,
        inspector_comments: r.inspector_comments,
        requested_cents: r.requested_cents,
        approved_cents: r.approved_cents,
        not_approved_cents: r.not_approved_cents,
        photos: (mediaByReq.get(r.sitewire_request_id != null ? Number(r.sitewire_request_id) : null) || []).map((m) => ({
          storage_ref: m.storage_ref,
          content_type: m.content_type,
          // staff caption keeps GPS + time; borrower caption is time-only (no location leak)
          caption: mode === 'borrower'
            ? (m.captured_at ? isoDay(m.captured_at) : '')
            : [m.captured_at ? isoDay(m.captured_at) : '', (m.lat != null && m.lng != null) ? (round5(m.lat) + ', ' + round5(m.lng)) : ''].filter(Boolean).join(' · '),
        })),
      }));
    }
    sections.push({
      number: d.number != null ? d.number : null,
      status: d.status || (f && f.status) || null,
      requested_cents: d.requested_cents || 0,
      // `approved_cents` is the INSPECTOR-approved amount (the approval ladder's answer) — the number
      // the borrower is being asked to accept. `final_approved_cents` is 0 until we press Final
      // approve. Printing the final figure as "approved" is what put "$0 APPROVED FOR RELEASE" at the
      // top of a report whose every line said "Appr $6,250" (owner-reported 2026-08-03).
      approved_cents: d.approved_cents || 0,
      final_approved_cents: d.final_approved_cents || 0,
      not_approved_cents: d.not_approved_cents || 0,
      approval_stage: d.approval_stage || null,
      approval_label: d.approval_label || null,
      fee_cents: d.fee_cents != null ? d.fee_cents : null,
      fee_projected: !!d.fee_projected,
      retainage_held_cents: d.retainage_held_cents || 0,
      net_release_cents: d.net_release_cents != null ? d.net_release_cents : null,
      released: !!d.released,
      release_date: d.release_date || null,
      lines,
    });
  }
  // The version also folds in the FILE HEADER fields (address/borrower/program/loan) so a correction to
  // any of them mints a fresh report instead of serving the cached one with a stale header.
  const baseVersion = await reportVersion(appId, drawId);
  const version = crypto.createHash('sha256')
    .update(baseVersion + '|' + [app.address, app.csz, app.borrowerName, app.program, app.loanNo].join('|'))
    .digest('hex').slice(0, 12);
  return { app, rollup, sections, version, hasScope: drawIds.length > 0 };
}

function isoDay(v) { return v ? String(new Date(v).toISOString()).slice(0, 10) : ''; }
function round5(n) { const x = Number(n); return Number.isFinite(x) ? Math.round(x * 1e5) / 1e5 : ''; }

// Read the photo bytes for each section's lines from PILOT storage (cache-miss path only). Bounded by the
// same budget the builder enforces; a missing/oversized/unreadable blob is skipped (photo dropped), never
// thrown. Mutates `sections` in place, replacing each photo's { storage_ref } with { buf, caption }.
async function attachPhotoBytes(sections) {
  let bytes = 0, count = 0;
  for (const s of sections) {
    for (const l of (s.lines || [])) {
      const out = [];
      for (const ph of (l.photos || [])) {
        if (count >= MAX_PHOTOS_TOTAL || bytes >= EMBED_BYTE_BUDGET) break;
        if (!ph.storage_ref) continue;
        try {
          const raw = await lazy.storage.read(ph.storage_ref);
          if (!raw || !raw.length || raw.length > EMBED_BYTE_BUDGET) continue;
          // Belt-and-suspenders GPS scrub on the embed path too: go-forward the archived bytes are already
          // clean (media-archive strips before storing), but a photo archived BEFORE the F-3 fix still carries
          // its EXIF GPS — strip it here so no report (staff or borrower) ever embeds the capture location.
          const buf = stripLocationExif(raw);
          const fmt = imageFormat(buf);
          if (!fmt) continue; // not JPEG/PNG → can't embed
          bytes += buf.length; count++;
          out.push({ buf, format: fmt, caption: ph.caption });
        } catch (_) { /* blob gone / unreadable — skip this photo */ }
      }
      l.photos = out;
    }
  }
  return { photoCount: count, photoBytes: bytes };
}

/** A short content hash so an unchanged draw reuses its stored report (and a change mints a fresh one). */
async function reportVersion(appId, drawId) {
  const dq = drawId != null
    ? await lazy.db.query(`SELECT sitewire_draw_id, status, total_requested_cents, total_approved_cents, updated_at FROM sitewire_draws WHERE application_id=$1 AND sitewire_draw_id=$2`, [appId, drawId])
    : await lazy.db.query(`SELECT sitewire_draw_id, status, total_requested_cents, total_approved_cents, updated_at FROM sitewire_draws WHERE application_id=$1 ORDER BY sitewire_draw_id`, [appId]);
  const fq = drawId != null
    ? await lazy.db.query(`SELECT COALESCE(max(fl.updated_at), max(f.updated_at)) m, count(fl.*) c FROM draw_findings f LEFT JOIN draw_finding_lines fl ON fl.finding_id=f.id WHERE f.application_id=$1 AND f.sitewire_draw_id=$2`, [appId, drawId])
    : await lazy.db.query(`SELECT COALESCE(max(fl.updated_at), max(f.updated_at)) m, count(fl.*) c FROM draw_findings f LEFT JOIN draw_finding_lines fl ON fl.finding_id=f.id WHERE f.application_id=$1`, [appId]);
  const mq = drawId != null
    ? await lazy.db.query(`SELECT count(*) c, max(archived_at) m FROM draw_media WHERE application_id=$1 AND sitewire_draw_id=$2 AND kind='image'`, [appId, drawId])
    : await lazy.db.query(`SELECT count(*) c, max(archived_at) m FROM draw_media WHERE application_id=$1 AND kind='image'`, [appId]);
  const lq = drawId != null
    ? await lazy.db.query(`SELECT COALESCE(sum(fee_cents),0) fee, COALESCE(sum(net_release_cents),0) net, max(created_at) m FROM draw_disbursements WHERE application_id=$1 AND sitewire_draw_id=$2`, [appId, drawId])
    : await lazy.db.query(`SELECT COALESCE(sum(fee_cents),0) fee, COALESCE(sum(net_release_cents),0) net, max(created_at) m FROM draw_disbursements WHERE application_id=$1`, [appId]);
  // The "Schedule of values" is ALWAYS project-wide (loadRollup reads every job-item link + request for the
  // file, not just this draw), so a net-zero reallocation that moves budget BETWEEN lines changes none of the
  // tables above. Hash the two rollup-source tables (app-wide) so such a change refreshes the cached report.
  const jq = await lazy.db.query(`SELECT COALESCE(max(updated_at)::text,'') m, count(*) c, COALESCE(sum(budgeted_cents),0) b, COALESCE(sum(CASE WHEN state='deleted' THEN 1 ELSE 0 END),0) del FROM sitewire_job_item_links WHERE application_id=$1`, [appId]);
  const rq = await lazy.db.query(`SELECT COALESCE(max(r.updated_at)::text,'') m, count(*) c, COALESCE(sum(r.requested_cents),0) rq, COALESCE(sum(r.approved_cents),0) ap FROM sitewire_draw_requests r JOIN sitewire_draws d ON d.sitewire_draw_id=r.sitewire_draw_id WHERE d.application_id=$1`, [appId]);
  const sig = JSON.stringify({ d: dq.rows, f: fq.rows, m: mq.rows, l: lq.rows, j: jq.rows, r: rq.rows });
  return crypto.createHash('sha256').update(sig).digest('hex').slice(0, 12);
}

/**
 * Store a generated report as a `documents` row (idempotent by the version-hashed filename). Mirrors the
 * esign storeSignedDocument pattern: check-then-insert with a 23505 backstop (db/171), supersede the prior
 * current report of the same scope/mode, and (for a borrower copy) stamp visibility='borrower' so it can
 * surface to the borrower + mirror to SharePoint. Returns the documents row id.
 */
async function storeDrawReport({ appId, borrowerId, filename, bytes, mode }) {
  const docKind = 'draw_inspection_report';
  const visibility = mode === 'borrower' ? 'borrower' : 'staff_only';
  const existing = await lazy.db.query(
    `SELECT id FROM documents WHERE application_id=$1 AND doc_kind=$2 AND filename=$3 LIMIT 1`, [appId, docKind, filename]);
  if (existing.rows.length) return existing.rows[0].id;
  const { ref, provider } = await lazy.storage.save(Buffer.from(bytes), { filename });
  try {
    const ins = await lazy.db.query(
      `INSERT INTO documents
         (application_id, borrower_id, filename, content_type, size_bytes,
          storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind,
          source_type, visibility, is_current, review_status)
       VALUES ($1,$2,$3,'application/pdf',$4,$5,$6,'staff',NULL,$7,'system',$8,true,'pending')
       RETURNING id`,
      [appId, borrowerId || null, filename, Buffer.from(bytes).length, provider, ref, docKind, visibility]);
    // Supersede ONLY prior versions of the SAME report identity (same scope + mode + draw + loan) — never
    // an UNRELATED report. The version-hashed filename is `...-<12hex>.pdf`; stripping the version yields the
    // stable identity prefix (which encodes scope/who/loan), so generating draw #2's report can't mark
    // draw #1's — or the project, or the borrower — report stale (that over-scoping would re-introduce the
    // SharePoint Version-N churn class). The prefix contains only [A-Za-z0-9-] (no LIKE wildcards).
    const identityPrefix = filename.replace(/-[0-9a-f]{12}\.pdf$/i, '-');
    await lazy.db.query(
      `UPDATE documents SET is_current=false,
          review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
        WHERE application_id=$1 AND doc_kind=$2 AND filename LIKE $3 || '%' AND id<>$4 AND is_current=true`,
      [appId, docKind, identityPrefix, ins.rows[0].id]);
    return ins.rows[0].id;
  } catch (e) {
    if (e && e.code === '23505') {
      const again = await lazy.db.query(
        `SELECT id FROM documents WHERE application_id=$1 AND doc_kind=$2 AND filename=$3 LIMIT 1`, [appId, docKind, filename]);
      if (again.rows.length) return again.rows[0].id;
    }
    throw e;
  }
}

/* Build (or reuse the cached) branded report `documents` row for a draw/project + mode. Returns
   { doc, built } — or null when there is no draw data to report on yet. This is the ONE place the
   load -> attach photos -> build PDF -> store+supersede -> cache-by-version sequence lives, shared by the
   on-demand report route and the auto-deliver-on-findings path so both cache identically by version hash
   (an unchanged draw reuses the stored row; a change mints a fresh one and supersedes the old). */
async function buildOrGetReportDoc(appId, { sitewireDrawId = null, scope, mode = 'staff' } = {}) {
  const meta = await loadReportMeta(appId, { sitewireDrawId, mode });
  if (!meta || !meta.hasScope || !Array.isArray(meta.sections) || !meta.sections.length) return null;
  const drawNumber = scope === 'draw' && meta.sections[0] ? meta.sections[0].number : null;
  const filename = reportFilename({ scope, mode, drawNumber, version: meta.version, loanNo: meta.app.loanNo });
  const borrowerRow = (await lazy.db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId])).rows[0] || {};
  let doc = (await lazy.db.query(
    `SELECT * FROM documents WHERE application_id=$1 AND doc_kind='draw_inspection_report' AND filename=$2 LIMIT 1`,
    [appId, filename])).rows[0];
  if (doc) return { doc, built: false };
  await attachPhotoBytes(meta.sections);                                 // read the durable photo bytes (bounded)
  const bytes = buildDrawReport({ app: meta.app, rollup: meta.rollup, sections: meta.sections, scope, mode });
  const docId = await storeDrawReport({ appId, borrowerId: borrowerRow.borrower_id, filename, bytes, mode });
  doc = (await lazy.db.query(`SELECT * FROM documents WHERE id=$1`, [docId])).rows[0];
  return { doc, built: true };
}

/* On findings delivery: durably capture the inspector's (pre-signed, EXPIRING) media NOW, then pre-build
   the branded PILOT (staff) + borrower-safe reports — so the durable copy and both reports exist the moment
   findings are delivered, never dependent on someone clicking "archive" later (before this, a report built
   pre-archive silently had ZERO photos). Media is archived FIRST so the reports embed it and the version
   hash reflects it. Every step is best-effort and independently caught: a failure here can never block,
   reverse, or un-notify the delivery the borrower was just told about. Off-switch: DRAW_AUTODELIVER_ENABLED=0. */
async function autoDeliverArtifacts(appId, sitewireDrawId) {
  const out = { archived: 0, reports: [] };
  if (process.env.DRAW_AUTODELIVER_ENABLED === '0') return out;
  try {
    const r = await lazy.media.archiveDrawMedia(appId, sitewireDrawId);
    out.archived = (r && r.archived) || 0;
  } catch (e) { console.warn(`[sitewire] auto-archive on deliver failed (draw=${sitewireDrawId}): ${e && e.message}`); }
  for (const mode of ['staff', 'borrower']) {
    try {
      const r = await buildOrGetReportDoc(appId, { sitewireDrawId, scope: 'draw', mode });
      if (r && r.doc) out.reports.push(mode);
    } catch (e) { console.warn(`[sitewire] auto-report on deliver failed (draw=${sitewireDrawId}, ${mode}): ${e && e.message}`); }
  }
  return out;
}

/** The deterministic, version-hashed filename for a report. */
function reportFilename({ scope, mode, drawNumber, version, loanNo }) {
  const label = scope === 'project' ? 'project' : ('draw-' + (drawNumber != null ? drawNumber : 'x'));
  const who = mode === 'borrower' ? 'borrower' : 'staff';
  const ln = String(loanNo || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'file';
  return `pilot-${label}-report-${who}-${ln}-${version}.pdf`;
}

module.exports = {
  buildDrawReport, loadReportMeta, attachPhotoBytes, storeDrawReport, reportVersion, reportFilename,
  buildOrGetReportDoc, autoDeliverArtifacts,
  imageFormat, getJsPDF, MAX_PHOTOS_TOTAL, MAX_PHOTOS_PER_LINE, EMBED_BYTE_BUDGET,
};
