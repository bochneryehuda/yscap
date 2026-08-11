'use strict';
/**
 * DRAW DISPUTE -> SITEWIRE REFRESH (owner-directed 2026-08-11: "after a dispute is
 * accepted we update Sitewire with the new figures; Sitewire generates a new
 * report, and that report is NEVER pulled back into our system. When we click
 * Deliver to Investor it should refresh from Sitewire first and deliver the NEW
 * PDF").
 *
 * `draw-report.refreshDrawFromSitewire` is the missing Sitewire -> PILOT pull. This
 * pins its CONTRACT with the vendor client + DB stubbed (no network, no database):
 *   - it is GATED on SITEWIRE_ENABLED (off -> a no-op that touches nothing);
 *   - when on it COMPOSES reconcileOne -> archiveDrawMedia -> rebuild reports;
 *   - every step is best-effort (a failing report build never throws);
 * plus source guards that the three call sites are actually wired.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const dr = require('../src/sitewire/draw-report');
const reconcile = require('../src/sitewire/reconcile');
const media = require('../src/sitewire/media-archive');
const switches = require('../src/lib/integrations/switches');

ok(typeof dr.refreshDrawFromSitewire === 'function', 'refreshDrawFromSitewire is exported');

const origOn = switches.on;
const origReconcile = reconcile.reconcileOne;
const origArchive = media.archiveDrawMedia;

(async () => {
  // ---- 1) OFF: a no-op that never touches Sitewire ---------------------------
  let reconcileCalls = 0, archiveCalls = 0;
  reconcile.reconcileOne = async () => { reconcileCalls++; return {}; };
  media.archiveDrawMedia = async () => { archiveCalls++; return { archived: 0 }; };
  switches.on = (n) => (n === 'SITEWIRE_ENABLED' ? false : origOn(n));

  let out = await dr.refreshDrawFromSitewire('app-1', 42);
  ok(reconcileCalls === 0 && archiveCalls === 0, 'SITEWIRE_ENABLED off → nothing is pulled (no reconcile, no archive)');
  ok(out && out.reconciled === false && out.archived === 0 && Array.isArray(out.reports) && out.reports.length === 0,
    'off → returns the empty result shape');

  // ---- 2) ON: composes reconcile -> archive -> reports, best-effort ----------
  reconcileCalls = 0; archiveCalls = 0;
  const seen = [];
  reconcile.reconcileOne = async (appId) => { reconcileCalls++; seen.push('reconcile:' + appId); return { ok: true }; };
  media.archiveDrawMedia = async (appId, drawId) => { archiveCalls++; seen.push('archive:' + appId + ':' + drawId); return { archived: 3 }; };
  switches.on = (n) => (n === 'SITEWIRE_ENABLED' ? true : origOn(n));

  out = await dr.refreshDrawFromSitewire('app-9', 77);
  ok(reconcileCalls === 1, 'on → reconcileOne is called exactly once');
  ok(archiveCalls === 1, 'on → archiveDrawMedia is called exactly once');
  ok(seen[0] === 'reconcile:app-9' && seen[1] === 'archive:app-9:77', 'the ORDER is reconcile → archive (figures before the PDF)');
  ok(out.reconciled === true && out.archived === 3, 'on → reports the reconcile success and the archived count');
  // buildOrGetReportDoc runs with no DB and fails per-mode — caught, so reports stays [] and nothing throws.
  ok(Array.isArray(out.reports), 'a report-build failure is swallowed (best-effort) — refresh never throws');

  // ---- 3) a reconcile that reports "not linked" is not counted a success -----
  reconcile.reconcileOne = async () => ({ skipped: 'not linked' });
  out = await dr.refreshDrawFromSitewire('app-x', 1);
  ok(out.reconciled === false, 'a skipped/errored reconcile is not reported as reconciled');

  // ---- 4) the call sites are wired -------------------------------------------
  const decideSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sitewire.js'), 'utf8');
  ok(/if \(pushed\)[\s\S]{0,220}refreshDrawFromSitewire/.test(decideSrc),
    'the dispute-decide handler refreshes only when the Sitewire push confirmed (pushed)');
  const deliverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'sitewire', 'investor-delivery-send.js'), 'utf8');
  ok(deliverSrc.indexOf('refreshDrawFromSitewire') < deliverSrc.indexOf('const pre = await deliveryPreview'),
    'Deliver-to-Investor refreshes from Sitewire BEFORE it reads the preview / gathers attachments');
  ok(/kind='draw_pdf'[\s\S]{0,120}ORDER BY archived_at DESC LIMIT 1/.test(deliverSrc),
    'only the NEWEST Sitewire PDF is delivered (LIMIT 1, not the stale pre-dispute copy)');

  switches.on = origOn; reconcile.reconcileOne = origReconcile; media.archiveDrawMedia = origArchive;
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  switches.on = origOn; reconcile.reconcileOne = origReconcile; media.archiveDrawMedia = origArchive;
  console.error(e); process.exit(1);
});
