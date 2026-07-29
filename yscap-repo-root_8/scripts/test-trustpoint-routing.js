/* Physical-draw routing (phase 1, 2026-07-24 blueprint): sitewire_inspection_rules.draw_platform
 * routes a file's draw administration — 'sitewire' (default), 'trustpoint' (full Sitewire setup as
 * intake+mirror; approvals in TrustPoint), 'external' (legacy handled_externally: no push at all).
 *
 * PURE section (always runs): routing.platformOf fallbacks, risk.assessDraw physical-method
 * no_inspection suppression, reconcile's method/platform-aware inbound copy.
 * DB section (needs DATABASE_URL with migrations applied; skips cleanly otherwise):
 * the widened constraints + orchestrator.pushFile routing (external skips, trustpoint proceeds).
 * Run: [DATABASE_URL=...] node scripts/test-trustpoint-routing.js
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const routing = require('../src/sitewire/routing');
const risk = require('../src/sitewire/risk');
const reconcile = require('../src/sitewire/reconcile');

// ============ PURE 1: platformOf ============
ok('platformOf: null rule → sitewire', routing.platformOf(null) === 'sitewire');
ok('platformOf: empty rule → sitewire', routing.platformOf({}) === 'sitewire');
ok('platformOf: explicit trustpoint', routing.platformOf({ draw_platform: 'trustpoint' }) === 'trustpoint');
ok('platformOf: explicit external', routing.platformOf({ draw_platform: 'external' }) === 'external');
ok('platformOf: pre-migration fallback handled_externally → external', routing.platformOf({ handled_externally: true }) === 'external');
ok('platformOf: bogus value falls back to handled_externally', routing.platformOf({ draw_platform: 'bogus', handled_externally: true }) === 'external');
ok('platformOf: bogus value + not external → sitewire', routing.platformOf({ draw_platform: 'bogus' }) === 'sitewire');
ok('platformOf: column value wins over stale flag', routing.platformOf({ draw_platform: 'trustpoint', handled_externally: true }) === 'trustpoint');
ok('isExternal/isTrustpoint helpers', routing.isExternal({ draw_platform: 'external' }) && routing.isTrustpoint({ draw_platform: 'trustpoint' }) && !routing.isExternal(null));

// ============ PURE 2: risk no_inspection is method-aware ============
const riskFixture = (method) => risk.assessDraw({
  draw: { sitewire_draw_id: 1, number: 1, status: 'pending', total_requested_cents: 50000 },
  requests: [{ sitewire_job_item_id: 11, requested_cents: 50000, approved_cents: null, inspection_count: 0 }],
  links: [{ sitewire_job_item_id: 11, sow_line_key: 'k1', name: 'Kitchen', budgeted_cents: 100000, is_media_item: false }],
  rollup: { lines: [{ sow_line_key: 'k1', label: 'Kitchen', budgeted: 100000, drawn: 0, remaining: 100000, requested_open: 50000 }], project: null },
  opts: { inspectionMethod: method },
});
ok('risk: mobile file keeps no_inspection', riskFixture('mobile').flags.some((f) => f.code === 'no_inspection'));
ok('risk: unknown method keeps no_inspection', riskFixture(null).flags.some((f) => f.code === 'no_inspection'));
ok('risk: traditional (physical) suppresses no_inspection', !riskFixture('traditional').flags.some((f) => f.code === 'no_inspection'));
ok('risk: traditional keeps OTHER flags (over-budget still fires)', (() => {
  const a = risk.assessDraw({
    draw: { number: 1, status: 'pending' },
    requests: [{ sitewire_job_item_id: 11, requested_cents: 200000, approved_cents: null, inspection_count: 0 }],
    links: [{ sitewire_job_item_id: 11, sow_line_key: 'k1', name: 'Kitchen', budgeted_cents: 100000 }],
    rollup: { lines: [{ sow_line_key: 'k1', label: 'Kitchen', budgeted: 100000, drawn: 0, remaining: 100000, requested_open: 200000 }], project: null },
    opts: { inspectionMethod: 'traditional' },
  });
  return a.flags.some((f) => f.code === 'exceeds_remaining') && !a.flags.some((f) => f.code === 'no_inspection');
})());

// ============ PURE 3: inbound copy is platform/method-aware ============
const rf = reconcile._reactFor;
ok('reactFor: mobile pending keeps the inspected copy', /was inspected/.test(rf('pending', 1, 'addr', { platform: 'sitewire', method: 'mobile' }).title));
ok('reactFor: physical pending says arrange the inspection', /on-site inspection/.test(rf('pending', 1, 'addr', { platform: 'sitewire', method: 'traditional' }).title));
ok('reactFor: trustpoint pending says enter into TrustPoint', /TrustPoint/.test(rf('pending', 1, 'addr', { platform: 'trustpoint', method: 'traditional' }).title)
  && /task was opened/.test(rf('pending', 1, 'addr', { platform: 'trustpoint', method: 'traditional' }).body));
ok('reactFor: approved copy unchanged by platform', /approved in Sitewire/.test(rf('approved', 1, 'addr', { platform: 'trustpoint' }).title));
ok('reactFor: unmapped status → null', rf('drafting', 1, 'addr', { platform: 'trustpoint' }) === null);
ok('reactFor: no ctx behaves like before', /was inspected/.test(rf('pending', 1, 'addr', null).title));

// ============ DB section ============
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log(`test-trustpoint-routing: ${pass} passed, ${fail} failed (DB section SKIPPED — no DATABASE_URL)`);
    process.exit(fail ? 1 : 0);
  }
  const cfg = require('../src/config');
  const db = require('../src/db');
  const orch = require('../src/sitewire/orchestrator');
  const crypto = require('crypto');
  const tag = crypto.randomBytes(4).toString('hex');

  // constraint: draw_platform enum enforced
  let rejected = false;
  try { await db.query(`INSERT INTO sitewire_inspection_rules (partner_label, draw_platform) VALUES ($1,'bogus')`, ['TPX ' + tag]); }
  catch (_) { rejected = true; }
  ok('db: CHECK rejects a bogus draw_platform', rejected);

  // seed two partner rules: one external, one trustpoint (both physical)
  await db.query(
    `INSERT INTO sitewire_inspection_rules (partner_label, inspection_method, fee_cents_virtual, fee_cents_physical, allow_virtual, allow_physical, handled_externally, draw_platform)
     VALUES ($1,'traditional',29900,25000,false,true,true,'external'), ($2,'traditional',29900,25000,false,true,false,'trustpoint')`,
    ['ExtPartner ' + tag, 'TpPartner ' + tag]);

  const mkApp = async (lender) => {
    const email = 'tr' + crypto.randomBytes(5).toString('hex') + '@example.com';
    const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('T','R',$1) RETURNING id`, [email])).rows[0].id;
    const app = (await db.query(`INSERT INTO applications(borrower_id,status,lender) VALUES($1,'funded',$2) RETURNING id`, [bor, lender])).rows[0].id;
    return { app, bor };
  };
  const cleanup = async (app, bor) => { await db.query(`DELETE FROM applications WHERE id=$1`, [app]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]); };

  // resolveFilePlatform reads the rule through the real resolver chain
  {
    const { app, bor } = await mkApp('TpPartner ' + tag);
    const rp = await routing.resolveFilePlatform(app);
    ok('db: resolveFilePlatform → trustpoint + traditional', rp.platform === 'trustpoint' && rp.method === 'traditional');
    await cleanup(app, bor);
  }

  // pushFile routing: external skips before any park; trustpoint proceeds past the gate
  // (dryrun satisfies the outbound gate; force bypasses the master switch; the next gate —
  // no YS loan number — parks, which for an unmanaged file records setup_status, proving
  // the platform gate was PASSED, not skipped).
  cfg.sitewireDryrun = true;
  {
    const { app, bor } = await mkApp('ExtPartner ' + tag);
    const r = await orch.pushFile(app, { force: true });
    ok('db: pushFile external → skipped handled_externally', r && r.skipped === 'handled_externally');
    await cleanup(app, bor);
  }
  {
    const { app, bor } = await mkApp('TpPartner ' + tag);
    const r = await orch.pushFile(app, { force: true });
    ok('db: pushFile trustpoint → NOT skipped (proceeds to the loan-number gate)', r && r.skipped !== 'handled_externally' && r.parked === 'missing_loan_number');
    await cleanup(app, bor);
  }
  cfg.sitewireDryrun = false;

  await db.query(`DELETE FROM sitewire_inspection_rules WHERE partner_label LIKE '%' || $1`, [tag]);
  console.log(`test-trustpoint-routing: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-trustpoint-routing crashed:', e); process.exit(1); });
