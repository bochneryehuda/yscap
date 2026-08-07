'use strict';
/**
 * Class Valuation — the staff order desk. STAFF ONLY, file-scoped.
 *
 * Read-shaped except one route. `POST /files/:id/order` is the only thing that
 * can reach Class in a way that costs money, and it is gated four deep: the
 * master switch, the outbound switch, `canPlace` (nothing missing), and an
 * explicit `confirm:true` from the screen. A GET can never place an order.
 *
 * NOTHING HERE DECIDES BETWEEN VENDORS. The owner has not picked a default and
 * said to leave it until one is actually ready, so this desk answers only for
 * Class; the AMC desk answers only for the AMC. Whichever surface eventually
 * chooses between them is a separate, deliberate piece of work — do not quietly
 * grow a default in here.
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requireStaff } = require('../auth');
const { assigneeExistsSql } = require('../lib/permissions');
const { can } = require('../lib/permissions');
const client = require('../class/client');
const orderService = require('../class/order-service');

router.use(requireAuth, requireStaff);

// The same per-file scope every staff surface uses — never a hand-written one.
async function canSeeFile(req, appId) {
  if (can(req.actor, 'see_all_files')) {
    const r = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId]);
    return r.rowCount > 0;
  }
  const r = await db.query(
    `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${assigneeExistsSql('a', '$2')}`,
    [appId, req.actor.id]);
  return r.rowCount > 0;
}

// Only the keys the preview is allowed to override, so a crafted request cannot
// smuggle an arbitrary field into the vendor body.
const OVERRIDE_KEYS = new Set([
  'productId', 'propertyTypeEnum', 'purpose', 'loanType', 'occupancy',
  'referenceNumber', 'street', 'city', 'state', 'zip', 'dueDate', 'instructions',
]);
function readOverrides(src) {
  const out = {};
  for (const [k, v] of Object.entries(src || {})) if (OVERRIDE_KEYS.has(k) && v != null && v !== '') out[k] = v;
  return out;
}

// Whether the integration is configured / switched on. Booleans only — never a
// credential, never a masked one either; there is nothing here worth leaking.
router.get('/config', async (_req, res) => {
  res.json({ class: client.configured(), hosts: client.hosts() });
});

// The auto-filled order preview: every field that would be sent, each labelled
// with where its value came from. Read-only, and safe with ordering switched off.
router.get('/files/:id/preview', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const preview = await orderService.buildPreview(db, appId, { overrides: readOverrides(req.query) });
  if (!preview) return res.status(404).json({ error: 'file not found' });
  res.json(preview);
});

// Their product catalogue, for the form picker. A read — master switch only.
router.get('/products', async (req, res) => {
  if (!client.configured().enabled) return res.json({ available: false, products: [] });
  try {
    const r = await client.products({ limit: req.query.limit || 200 });
    res.json({ available: true, products: (r && r.products) || [] });
  } catch (e) {
    // Never relay the vendor's status — a 401 from Class would sign the STAFFER
    // out of PILOT (the repo's session chokepoint documents this class).
    res.status(502).json({ available: false, error: e.code || 'lookup_failed', detail: e.message });
  }
});

// PLACE THE ORDER. The only route here that costs money.
router.post('/files/:id/order', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });

  const body = req.body || {};
  // The screen must say so explicitly. A missing confirm is a refusal, not a
  // default — nobody places a real appraisal order by accident.
  if (body.confirm !== true) {
    return res.status(400).json({ error: 'confirm_required', message: 'Ordering needs an explicit confirmation from the screen.' });
  }

  const preview = await orderService.buildPreview(db, appId, { overrides: readOverrides(body.overrides) });
  if (!preview) return res.status(404).json({ error: 'file not found' });

  // Re-checked HERE, at send time — never trusted from whatever the screen
  // fetched earlier, which may be minutes stale.
  if (!preview.canPlace) {
    return res.status(422).json({ error: 'incomplete', missing: preview.missing,
      message: 'Some details Class requires are still missing.' });
  }

  const cfgd = client.configured();
  if (!cfgd.enabled) return res.status(409).json({ error: 'CLASS_DISABLED', message: 'The Class Valuation connection is switched off.' });
  if (!cfgd.ready) return res.status(409).json({ error: 'CLASS_NOT_CONFIGURED', message: 'The Class Valuation credentials are not all set.' });

  try {
    const out = await client.createOrder(preview.body, {
      OrgId: (require('../config').class || {}).orgId || undefined,
      LenderOrgId: (require('../config').class || {}).lenderOrgId || undefined,
    });
    if (out && out.__dryrun) {
      return res.json({ ok: true, dryrun: true, message: 'TEST MODE — the order was built and logged, nothing was sent.', body: preview.body });
    }
    res.json({ ok: true, orderId: out && out.orderId, transactionId: out && out.transactionId, body: preview.body });
  } catch (e) {
    if (e.code === 'CLASS_OUTBOUND_DISABLED') {
      return res.status(409).json({ error: e.code, message: 'Placing orders with Class Valuation is switched off.' });
    }
    res.status(502).json({ error: e.code || 'order_failed', detail: e.message, vendor: e.body || null });
  }
});

module.exports = router;
