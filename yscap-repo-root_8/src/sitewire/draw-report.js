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
const lazy = { get db() { return require('../db'); }, get storage() { return require('../lib/storage'); }, get rollup() { return require('./rollup'); } };

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
const MAX_PHOTOS_PER_LINE = 4;
const MAX_PHOTOS_TOTAL = 32;
const EMBED_BYTE_BUDGET = 18 * 1024 * 1024; // ~18 MB of image bytes per report

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

  header();
  y = 96;

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
    band('Schedule of values — construction progress');
    const p = rollup.project;
    // headline tiles row
    brk(52);
    const tiles = [
      ['Budget', usd(p.budget)],
      ['Drawn to date', usd(p.drawn)],
      ['Remaining', usd(p.remaining)],
      ['Complete', pctStr(p.pct_complete)],
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
    // line table
    const cols = [
      { t: 'Line item', w: 0.34, a: 'left' },
      { t: 'Budget', w: 0.16, a: 'right' },
      { t: 'Drawn', w: 0.16, a: 'right' },
      { t: 'Remaining', w: 0.18, a: 'right' },
      { t: '% done', w: 0.16, a: 'right' },
    ];
    const iw = W - 2 * M;
    function rowCells(cells, isHead) {
      brk(15);
      if (isHead) { doc.setFont('helvetica', 'bold'); doc.setFontSize(7.6); doc.setTextColor.apply(doc, GRAY); }
      else { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor.apply(doc, DARK); }
      let x = M + 3;
      cols.forEach((c, i) => {
        const cw = c.w * iw;
        const tx = c.a === 'right' ? x + cw - 6 : x;
        doc.text(pdfSafe(fit(String(cells[i] == null ? '' : cells[i]), c.a === 'left' ? 46 : 16)), tx, y + 9, { align: c.a });
        x += cw;
      });
      y += 14; doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.4); doc.line(M + 3, y - 3, W - M - 3, y - 3);
    }
    rowCells(cols.map((c) => c.t), true);
    const shown = rollup.lines.filter((l) => l.kind === 'line');
    for (const l of shown) rowCells([clean(l.label), usd(l.budgeted), usd(l.drawn), usd(l.remaining), pctStr(l.pct_complete)]);
    for (const l of rollup.lines.filter((l) => l.kind === 'contingency' || l.kind === 'gc')) {
      rowCells([l.kind === 'gc' ? 'General conditions' : 'Contingency', usd(l.budgeted), usd(l.drawn), usd(l.remaining), pctStr(l.pct_complete)]);
    }
    // totals
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor.apply(doc, TEAL);
    rowCells(['Total', usd(p.budget), usd(p.drawn), usd(p.remaining), pctStr(p.pct_complete)]);
  }

  // ---- Per-draw inspection sections ----
  let embeddedBytes = 0, embeddedCount = 0, skippedPhotos = 0;
  for (const s of sections) {
    band((scope === 'project' ? 'Draw #' + (s.number != null ? s.number : '—') : 'This draw') + ' — inspection findings');
    // money summary line
    if (borrower) {
      kv('Requested', usd(s.requested_cents));
      kv('Approved', usd(s.approved_cents), { accent: true });
      if (Number(s.not_approved_cents) > 0) kv('Not approved (this inspection)', usd(s.not_approved_cents));
      kv('Status', STATUS_LABEL(s.status, true));
    } else {
      kv('Requested', usd(s.requested_cents));
      kv('Approved', usd(s.approved_cents), { accent: true });
      if (Number(s.not_approved_cents) > 0) kv('Not approved', usd(s.not_approved_cents));
      if (s.fee_cents != null) kv('Draw fee', usd(s.fee_cents));
      if (s.net_release_cents != null) kv('Net release', usd(s.net_release_cents), { accent: true });
      kv('Release date', s.release_date ? String(s.release_date).slice(0, 10) : (s.released ? '(released)' : ''));
      kv('Status', STATUS_LABEL(s.status, false));
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
        para('Photos for this line are saved in PILOT but not shown here (report photo limit reached).', 7.6, GRAY);
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
    borrowerName: [a.first_name, a.last_name].filter(Boolean).join(' '),
    program: /gold/i.test(String(a.program || '')) ? 'Gold Standard program' : (a.program ? 'Standard Program' : ''),
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
        `SELECT id, sitewire_request_id, sitewire_job_item_id, name, requested_cents, approved_cents, not_approved_cents, inspector_comments
           FROM draw_finding_lines WHERE finding_id=$1 ORDER BY id`, [f.id])).rows;
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
      approved_cents: d.approved_cents || 0,
      not_approved_cents: d.not_approved_cents || 0,
      fee_cents: d.fee_cents != null ? d.fee_cents : null,
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
          const buf = await lazy.storage.read(ph.storage_ref);
          if (!buf || !buf.length || buf.length > EMBED_BYTE_BUDGET) continue;
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

/** The deterministic, version-hashed filename for a report. */
function reportFilename({ scope, mode, drawNumber, version, loanNo }) {
  const label = scope === 'project' ? 'project' : ('draw-' + (drawNumber != null ? drawNumber : 'x'));
  const who = mode === 'borrower' ? 'borrower' : 'staff';
  const ln = String(loanNo || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'file';
  return `pilot-${label}-report-${who}-${ln}-${version}.pdf`;
}

module.exports = {
  buildDrawReport, loadReportMeta, attachPhotoBytes, storeDrawReport, reportVersion, reportFilename,
  imageFormat, getJsPDF, MAX_PHOTOS_TOTAL, MAX_PHOTOS_PER_LINE, EMBED_BYTE_BUDGET,
};
