/* Super-admin Scope-of-Work line-item editor (owner-directed 2026-07-21).
 *
 * sow-line-edit.editLine updates a line's wording (label) + description (desc) in the REAL Scope of Work
 * (checklist_items.tool_payload.state), regenerates the SOW Excel as a superseding documents row, and pushes
 * the new WORDING to Sitewire (skipped/for-unmanaged here). The DESCRIPTION never goes to Sitewire (read-only).
 * DB-gated: needs DATABASE_URL with migrations; skips otherwise. Sitewire client is not exercised (unmanaged).
 * Run: DATABASE_URL=... node scripts/test-sitewire-sow-line-edit.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sitewire-sow-line-edit (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const M = require('../src/sitewire/mapper');
const sle = require('../src/sitewire/sow-line-edit');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

function baseState() {
  return {
    propType: 'single',
    items: {
      'kitchen:0': { on: true, each: '25000', label: 'Kitchen remodel', desc: 'old kitchen desc' },
      'baths:0': { on: true, each: '15000' },
      'x:c1': { on: true, each: '5000' },
    },
    custom: [{ id: 'c1', name: 'Special item', desc: 'custom desc' }],
    cont: { mode: 'usd', value: '0' }, gcFee: { mode: 'usd', value: '0' },
  };
}

async function seed() {
  const email = 'sle' + crypto.randomBytes(5).toString('hex') + '@e.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('S','L',$1) RETURNING id`, [email])).rows[0].id;
  const app = (await db.query(`INSERT INTO applications(borrower_id,status,ys_loan_number,rehab_budget) VALUES($1,'funded',$2,45000) RETURNING id`, [bor, 'SLE' + crypto.randomBytes(3).toString('hex')])).rows[0].id;
  const payload = { state: baseState(), total: 4500000 };
  await db.query(
    `INSERT INTO checklist_items (scope, application_id, label, tool_key, tool_payload, status)
     VALUES ('application',$1,'Scope of Work','rehab_budget',$2,'received')`,
    [app, JSON.stringify(payload)]);
  return { app, bor };
}
const cleanup = async (app, bor) => { await db.query(`DELETE FROM applications WHERE id=$1`, [app]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]); };
const stateOf = async (app) => (await db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget'`, [app])).rows[0].tool_payload.state;

(async () => {
  // ---- pure: applyEdit ----
  {
    const st = baseState();
    const r = sle.applyEdit(st, 'kitchen:0', { label: 'New Kitchen', desc: 'shiny new' });
    ok('applyEdit taxonomy: found', r.found === true && r.oldLabel === 'Kitchen remodel');
    ok('applyEdit taxonomy: label+desc set', st.items['kitchen:0'].label === 'New Kitchen' && st.items['kitchen:0'].desc === 'shiny new');
    const rc = sle.applyEdit(st, 'x:c1', { label: 'Renamed Special', desc: 'd2' });
    ok('applyEdit custom: found', rc.found === true);
    ok('applyEdit custom: name+desc set on custom entry', st.custom[0].name === 'Renamed Special' && st.custom[0].desc === 'd2');
    const rm = sle.applyEdit(st, 'zzz:9', { label: 'x' });
    ok('applyEdit missing line: not found (never invents a line)', rm.found === false);
    // desc-only edit leaves label untouched
    const rd = sle.applyEdit(st, 'baths:0', { desc: 'bath note' });
    ok('applyEdit desc-only: leaves label, sets desc', rd.found === true && st.items['baths:0'].desc === 'bath note' && (st.items['baths:0'].label == null || st.items['baths:0'].label === ''));
  }

  // ---- mapper.sowLineSummary ----
  {
    const rows = M.sowLineSummary(baseState());
    ok('sowLineSummary: one entry per ON line (3)', rows.length === 3);
    ok('sowLineSummary: reads label + desc', rows.find((r) => r.name === 'Kitchen remodel' && r.desc === 'old kitchen desc'));
    ok('sowLineSummary: custom line name from custom[]', rows.find((r) => r.name === 'Special item' && r.desc === 'custom desc'));
    ok('sowLineSummary: cents summed', rows.find((r) => r.name === 'Kitchen remodel').cents === 2500000);
  }

  // ---- buildSowExcel returns a real .xlsx (PK zip) with the wording + description ----
  {
    const buf = sle.buildSowExcel(baseState(), 4500000);
    ok('buildSowExcel: returns a Buffer', Buffer.isBuffer(buf) && buf.length > 0);
    ok('buildSowExcel: is a zip (xlsx magic PK)', buf[0] === 0x50 && buf[1] === 0x4b);
  }

  // ---- editLine end-to-end (unmanaged file): updates SOW + regenerates Excel doc ----
  {
    const { app, bor } = await seed();
    const r = await sle.editLine(app, { sow_line_key: 'kitchen:0', label: 'Gourmet Kitchen', desc: 'high-end finishes' }, null);
    ok('editLine: ok', r.ok === true && r.label_changed === true && r.desc_changed === true);
    const st = await stateOf(app);
    ok('editLine: REAL SOW wording updated', st.items['kitchen:0'].label === 'Gourmet Kitchen');
    ok('editLine: REAL SOW description updated', st.items['kitchen:0'].desc === 'high-end finishes');
    const doc = await db.query(`SELECT COUNT(*)::int c FROM documents WHERE application_id=$1 AND doc_kind='rehab_budget_export' AND is_current=true`, [app]);
    ok('editLine: regenerated SOW Excel document created', doc.rows[0].c >= 1);
    ok('editLine: unmanaged file → wording not pushed to Sitewire (not_managed)', r.sitewire === 'not_managed' || r.sitewire === 'not_pushed');
    // a second edit supersedes the prior Excel (still exactly one current)
    await sle.editLine(app, { sow_line_key: 'baths:0', desc: 'tile + fixtures' }, null);
    const cur = await db.query(`SELECT COUNT(*)::int c FROM documents WHERE application_id=$1 AND doc_kind='rehab_budget_export' AND is_current=true`, [app]);
    ok('editLine: re-edit supersedes → exactly one current Excel', cur.rows[0].c === 1);
    await cleanup(app, bor);
  }

  // ---- listLines: lines + drawn_locked flags (unmanaged → all false) ----
  {
    const { app, bor } = await seed();
    const r = await sle.listLines(app);
    ok('listLines: available with lines', r.available === true && r.lines.length === 3);
    ok('listLines: unmanaged → no line drawn-locked', r.lines.every((l) => l.drawn_locked === false));
    ok('listLines: carries amount + desc', r.lines.every((l) => typeof l.amount === 'string') && r.lines.some((l) => l.desc === 'old kitchen desc'));
    await cleanup(app, bor);
  }

  // ---- guards ----
  {
    const { app, bor } = await seed();
    ok('editLine: nothing_to_change', (await sle.editLine(app, { sow_line_key: 'kitchen:0' }, null)).error === 'nothing_to_change');
    ok('editLine: line_not_found', (await sle.editLine(app, { sow_line_key: 'nope:0', label: 'x' }, null)).error === 'line_not_found');
    ok('editLine: missing_key', (await sle.editLine(app, { label: 'x' }, null)).error === 'missing_key');
    await cleanup(app, bor);
  }

  console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} SOW line-edit assertions ${fail === 0 ? 'passed' : ''}`);
  try { await db.pool.end(); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
