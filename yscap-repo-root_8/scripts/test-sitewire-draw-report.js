/* PILOT-branded draw report builder (Draw Management phase 2b, 2026-07-20).
 *
 * buildDrawReport is a PURE renderer over already-loaded data — no DB, no storage, no network — so it tests
 * in isolation. jsPDF writes text uncompressed, so field values are greppable in the raw bytes. Covers:
 *  1. staff per-draw report → %PDF-, shows property/loan/economics/inspector note + embeds a JPEG photo
 *  2. borrower per-draw report → NO capital-partner name (scrubbed), NO lender fee/net labels
 *  3. whole-project report → cumulative "Construction Progress Report"
 *  4. image embedding tolerates a bad buffer (never throws) + imageFormat magic-byte sniff
 *  5. reportFilename determinism / version sensitivity
 * Run: node scripts/test-sitewire-draw-report.js
 */
const R = require('../src/sitewire/draw-report');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { const g = JSON.stringify(got), e = JSON.stringify(exp); if (g === e) pass++; else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); } };

// A minimal VALID 1x1 JPEG (from a real encoder) — jsPDF embeds JPEG as DCTDecode without decoding.
const JPEG_1x1 = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8AH//Z', 'base64');
const BAD_IMG = Buffer.from('this is definitely not an image at all', 'utf8');

const rollup = {
  project: { budget: 12000000, drawn: 3000000, approved_pending: 0, requested_open: 0, remaining: 9000000, pct_complete: 25 },
  lines: [
    { sow_line_key: 'cat:0', kind: 'line', label: 'Kitchen', budgeted: 8000000, drawn: 2000000, remaining: 6000000, pct_complete: 25, units: [] },
    { sow_line_key: 'cat:1', kind: 'line', label: 'Roof', budgeted: 4000000, drawn: 1000000, remaining: 3000000, pct_complete: 25, units: [] },
    { sow_line_key: '__contingency__', kind: 'contingency', label: 'Contingency', budgeted: 0, drawn: 0, remaining: 0, pct_complete: 0, units: [] },
  ],
  draws: [],
};

// A draw section with a capital-partner name deliberately planted in an inspector note (defense-in-depth
// scrub target for the borrower copy) + one good photo and one broken photo.
function section(withNote) {
  return {
    number: 1, status: 'approved', requested_cents: 2500000, approved_cents: 2000000, not_approved_cents: 500000,
    fee_cents: 29900, net_release_cents: 1970100, released: true, release_date: '2026-07-18',
    lines: [
      {
        name: 'Kitchen — cabinets', inspector_comments: withNote ? 'Fidelis approved the scope; work looks complete.' : 'Work looks complete.',
        requested_cents: 1500000, approved_cents: 1200000, not_approved_cents: 300000,
        photos: [
          { buf: JPEG_1x1, format: 'JPEG', caption: '2026-07-18 · 41.30, -72.90' },
          { buf: BAD_IMG, caption: 'broken' },   // no format → sniffed → skipped (not embedded)
        ],
      },
      { name: 'Roof', inspector_comments: 'Shingles installed.', requested_cents: 1000000, approved_cents: 800000, not_approved_cents: 200000, photos: [] },
    ],
  };
}
const app = { loanNo: 'YSCAP258134761', address: '109 Chapel St', csz: 'New Haven, CT 06511', borrowerName: 'Moshe Spitzer', program: 'Gold Standard' };

// ---- 1. staff per-draw report ----
{
  let threw = null, buf = null;
  try { buf = R.buildDrawReport({ app, rollup, sections: [section(true)], scope: 'draw', mode: 'staff' }); } catch (e) { threw = e; }
  ok('staff build does not throw', !threw);
  ok('staff report is a Buffer', Buffer.isBuffer(buf));
  eq('staff report starts with %PDF-', buf && buf.slice(0, 5).toString('latin1'), '%PDF-');
  const text = buf.toString('latin1');
  ok('staff shows property', text.includes('109 Chapel St'));
  ok('staff shows loan number', text.includes('YSCAP258134761'));
  ok('staff shows borrower name', text.includes('Moshe Spitzer'));
  ok('staff shows Net release label', text.includes('Net release'));
  ok('staff shows Draw fee label', text.includes('Draw fee'));
  ok('staff shows Schedule of values', /Schedule of values/i.test(text));
  ok('staff shows an inspector note', text.includes('Work looks complete') || text.includes('Fidelis approved'));
  ok('staff KEEPS the capital-partner name (staff surface)', text.includes('Fidelis'));
  ok('staff report embedded the JPEG (DCTDecode stream present)', /DCTDecode/.test(text));
}

// ---- 2. borrower per-draw report (borrower-safe) ----
{
  const buf = R.buildDrawReport({ app, rollup, sections: [section(true)], scope: 'draw', mode: 'borrower' });
  const text = buf.toString('latin1');
  eq('borrower report starts with %PDF-', buf.slice(0, 5).toString('latin1'), '%PDF-');
  ok('borrower report SCRUBS the capital-partner name', !text.includes('Fidelis'));
  ok('borrower report has NO "Net release" label', !text.includes('Net release'));
  ok('borrower report has NO "Draw fee" label', !text.includes('Draw fee'));
  ok('borrower report shows the program as Gold Standard program', text.includes('Gold Standard program'));
  ok('borrower report still shows Approved', text.includes('Approved'));
}

// ---- 2b. borrower copy NEVER reveals the capital-partner relationship (status neutralized) ----
{
  const s = section(false); s.status = 'pending_capital_partner';
  const staff = R.buildDrawReport({ app, rollup, sections: [s], scope: 'draw', mode: 'staff' }).toString('latin1');
  ok('staff status shows "With capital partner"', /With capital partner/.test(staff));
  const bor = R.buildDrawReport({ app, rollup, sections: [s], scope: 'draw', mode: 'borrower' }).toString('latin1');
  ok('borrower status NEVER says "capital partner"', !/capital partner/i.test(bor));
  ok('borrower status neutralized to "Under review"', /Under review/.test(bor));
}

// ---- 3. whole-project report ----
{
  const buf = R.buildDrawReport({ app, rollup, sections: [section(false)], scope: 'project', mode: 'staff' });
  const text = buf.toString('latin1');
  ok('project report titled Construction Progress Report', text.includes('Construction Progress Report'));
  ok('project report shows a Draw # section', /Draw #1/i.test(text));
}

// ---- 4. image embedding tolerance + magic-byte sniff ----
{
  // a section whose only photo is a bad buffer with NO declared format → sniffed as non-image → skipped
  const s = section(false);
  s.lines[0].photos = [{ buf: BAD_IMG, caption: 'garbage' }];
  let threw = null, buf = null;
  try { buf = R.buildDrawReport({ app, rollup, sections: [s], scope: 'draw', mode: 'staff' }); } catch (e) { threw = e; }
  ok('bad-only-photo build does not throw', !threw && Buffer.isBuffer(buf));

  // a bad buffer DECLARED as JPEG (format forced) → addImage try/catch draws a placeholder, still no throw
  const s2 = section(false);
  s2.lines[0].photos = [{ buf: BAD_IMG, format: 'JPEG', caption: 'forced-bad' }];
  let threw2 = null;
  try { R.buildDrawReport({ app, rollup, sections: [s2], scope: 'draw', mode: 'staff' }); } catch (e) { threw2 = e; }
  ok('forced-bad-format photo does not throw', !threw2);

  eq('imageFormat: JPEG magic', R.imageFormat(JPEG_1x1), 'JPEG');
  ok('imageFormat: PNG magic', R.imageFormat(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])) === 'PNG');
  ok('imageFormat: garbage → null', R.imageFormat(BAD_IMG) === null);
  ok('imageFormat: empty → null', R.imageFormat(Buffer.alloc(0)) === null);
}

// ---- 5. reportFilename determinism ----
{
  const a = R.reportFilename({ scope: 'draw', mode: 'staff', drawNumber: 1, version: 'abc123', loanNo: 'YSCAP258134761' });
  const b = R.reportFilename({ scope: 'draw', mode: 'staff', drawNumber: 1, version: 'abc123', loanNo: 'YSCAP258134761' });
  eq('reportFilename is deterministic', a, b);
  ok('reportFilename encodes scope+mode+version', a.includes('draw-1') && a.includes('staff') && a.includes('abc123') && a.endsWith('.pdf'));
  const c = R.reportFilename({ scope: 'draw', mode: 'staff', drawNumber: 1, version: 'zzz999', loanNo: 'YSCAP258134761' });
  ok('a version change changes the filename', a !== c);
  const bor = R.reportFilename({ scope: 'project', mode: 'borrower', drawNumber: null, version: 'abc123', loanNo: 'YSCAP258134761' });
  ok('project/borrower filename', bor.includes('project') && bor.includes('borrower'));
}

console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} draw-report assertions ${fail === 0 ? 'passed' : ''}`);
process.exit(fail === 0 ? 0 : 1);
