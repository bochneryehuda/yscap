'use strict';

/**
 * /api/dashboards — the Dashboards section.
 *
 * Staff-only, whole-router gated (the `src/routes/research.js` model). Every card answers
 * under the CALLER's file scope, applied in the compiler, so this router never has to
 * remember to scope anything — and a shared dashboard cannot leak, because what travels
 * between people is the question, not the answer.
 *
 * Every card is answered INDEPENDENTLY and a failure is shaped, not thrown: a dashboard
 * with one broken card renders eleven good ones and one "couldn't load this". A dashboard
 * that 500s because a single card is stale is how a reporting surface loses its audience.
 *
 * Nothing here is a 401. Past the auth chokepoint the SPA reads any 401 as "your session
 * died" and signs the user out of every tab on the device (src/auth/index.js) — so a
 * refusal in here is a 403, and a broken card is a shaped body with `ok:false`.
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requireStaff } = require('../auth');
const registry = require('../lib/dashboards/registry');
const store = require('../lib/dashboards/store');
const answer = require('../lib/dashboards/answer');

router.use(requireAuth, requireStaff);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The house audit helper. Best-effort — a logging failure never fails the action. */
async function audit(req, action, entityId, detail) {
  let d = detail;
  if (d != null && typeof d !== 'object') d = { note: String(d) };
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
       VALUES ('staff',$1,$2,'dashboard',$3,$4,$5,$6)`,
      [req.actor.id, action, entityId || null, req.ip, req.get('user-agent') || null, d || null]);
  } catch (e) {
    console.warn(`[dashboards] could not log ${action}:`, (e && e.message) || e);
  }
}

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------------------------------------------------------------------------
// The catalogue that drives the whole builder UI
// ---------------------------------------------------------------------------
router.get('/meta', async (req, res) => {
  const meta = registry.meta({ staff: true });
  // The officer list is data, not catalogue, so it is fetched here rather than hard-coded
  // into the registry — a new hire appears in the filter dropdown with no deploy.
  try {
    const r = await db.query(
      `SELECT id::text AS v, NULLIF(full_name,'') AS label FROM staff_users
        WHERE is_active AND full_name IS NOT NULL ORDER BY full_name`);
    meta.lookups = { staff: r.rows.filter((x) => x.label) };
  } catch (_) { meta.lookups = { staff: [] }; }
  meta.vizKinds = store.VIZ;
  res.json(meta);
});

// ---------------------------------------------------------------------------
// Reading dashboards
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  res.json({ dashboards: await store.list(req.actor) });
});

router.get('/home', async (req, res) => {
  const d = await store.homeFor(req.actor);
  if (!d) return res.json({ dashboard: null, cards: [] });
  res.json({ dashboard: d, canEdit: await store.canEdit(req.actor, d.id) });
});

router.get('/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return bad(res, 'not a dashboard id');
  if (!await store.canSee(req.actor, req.params.id)) return bad(res, 'that dashboard is not shared with you', 403);
  const d = await store.get(req.params.id);
  if (!d) return bad(res, 'that dashboard is gone', 404);
  res.json({ dashboard: d, canEdit: await store.canEdit(req.actor, d.id) });
});

/**
 * Answer every card on a dashboard. Cards run with a small concurrency so one dashboard
 * load cannot occupy the whole (deliberately small) dashboard connection pool — the
 * client asking for twelve at once is exactly the stampede this guards against.
 */
router.get('/:id/answers', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return bad(res, 'not a dashboard id');
  if (!await store.canSee(req.actor, req.params.id)) return bad(res, 'that dashboard is not shared with you', 403);
  const d = await store.get(req.params.id);
  if (!d) return bad(res, 'that dashboard is gone', 404);
  const showSql = ['admin', 'super_admin'].includes(req.actor.role);
  const out = [];
  const queue = [...d.cards];
  const worker = async () => {
    for (;;) {
      const card = queue.shift();
      if (!card) return;
      out.push(await answer.answerCard(card, req.actor, { includeSql: showSql }));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const order = new Map(d.cards.map((c, i) => [c.id, i]));
  out.sort((a, b) => order.get(a.id) - order.get(b.id));
  res.json({ answers: out });
});

router.get('/cards/:cardId/answer', async (req, res) => {
  if (!UUID_RE.test(req.params.cardId)) return bad(res, 'not a card id');
  const c = await db.query(`SELECT * FROM dashboard_cards WHERE id=$1`, [req.params.cardId]);
  if (!c.rows[0]) return bad(res, 'that card is gone', 404);
  if (!await store.canSee(req.actor, c.rows[0].dashboard_id)) return bad(res, 'not yours to see', 403);
  const showSql = ['admin', 'super_admin'].includes(req.actor.role);
  res.json(await answer.answerCard(c.rows[0], req.actor, { includeSql: showSql }));
});

/** The files behind a number — the same predicate, enumerated. */
router.get('/cards/:cardId/files', async (req, res) => {
  if (!UUID_RE.test(req.params.cardId)) return bad(res, 'not a card id');
  const c = await db.query(`SELECT * FROM dashboard_cards WHERE id=$1`, [req.params.cardId]);
  if (!c.rows[0]) return bad(res, 'that card is gone', 404);
  if (!await store.canSee(req.actor, c.rows[0].dashboard_id)) return bad(res, 'not yours to see', 403);
  const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 200));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  try {
    res.json({ files: await answer.drillCard(c.rows[0], req.actor, { limit, offset }) });
  } catch (e) {
    res.status(e.status && e.status !== 401 ? e.status : 400).json({ error: e.message || 'could not list those files' });
  }
});

/** Try a card before saving it — the same path a saved card takes. */
router.post('/preview', async (req, res) => {
  const card = req.body && req.body.card;
  if (!card) return bad(res, 'send a card to preview');
  const problems = store.validateCard(card);
  if (problems.length) return bad(res, problems.join('; '));
  const showSql = ['admin', 'super_admin'].includes(req.actor.role);
  res.json(await answer.answerCard({ id: null, ...card }, req.actor, { includeSql: showSql }));
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
async function mustEdit(req, res, id) {
  if (!UUID_RE.test(id)) { bad(res, 'not a dashboard id'); return false; }
  if (!await store.canEdit(req.actor, id)) {
    bad(res, 'this is a company dashboard — use "Make it mine" to get your own copy you can change', 403);
    return false;
  }
  return true;
}

router.post('/', async (req, res) => {
  const d = await store.create(req.actor, req.body || {});
  await audit(req, 'dashboard_created', d.id, { name: d.name });
  res.status(201).json({ dashboard: d });
});

router.post('/:id/fork', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return bad(res, 'not a dashboard id');
  if (!await store.canSee(req.actor, req.params.id)) return bad(res, 'not yours to copy', 403);
  const d = await store.fork(req.actor, req.params.id, req.body || {});
  await audit(req, 'dashboard_forked', d.id, { from: req.params.id });
  res.status(201).json({ dashboard: d });
});

router.patch('/:id', async (req, res) => {
  if (!await mustEdit(req, res, req.params.id)) return;
  const d = await store.rename(req.params.id, req.body || {});
  await audit(req, 'dashboard_renamed', req.params.id, { name: d && d.name });
  res.json({ dashboard: d });
});

router.delete('/:id', async (req, res) => {
  if (!await mustEdit(req, res, req.params.id)) return;
  await store.archive(req.params.id);
  await audit(req, 'dashboard_archived', req.params.id, null);
  res.json({ ok: true });
});

router.post('/:id/cards', async (req, res) => {
  if (!await mustEdit(req, res, req.params.id)) return;
  try {
    const card = await store.addCard(req.params.id, req.body || {});
    await audit(req, 'dashboard_card_added', req.params.id, { card: card.id, title: card.title });
    res.status(201).json({ card });
  } catch (e) {
    res.status(e.status === 400 ? 400 : 500).json({ error: e.message || 'could not add that card' });
  }
});

router.patch('/:id/cards/:cardId', async (req, res) => {
  if (!await mustEdit(req, res, req.params.id)) return;
  if (!UUID_RE.test(req.params.cardId)) return bad(res, 'not a card id');
  try {
    const card = await store.updateCard(req.params.cardId, req.body || {});
    await audit(req, 'dashboard_card_updated', req.params.id, { card: card.id, title: card.title });
    res.json({ card });
  } catch (e) {
    res.status(e.status === 404 ? 404 : 400).json({ error: e.message || 'could not save that card' });
  }
});

router.delete('/:id/cards/:cardId', async (req, res) => {
  if (!await mustEdit(req, res, req.params.id)) return;
  if (!UUID_RE.test(req.params.cardId)) return bad(res, 'not a card id');
  await store.removeCard(req.params.cardId);
  await audit(req, 'dashboard_card_removed', req.params.id, { card: req.params.cardId });
  res.json({ ok: true });
});

router.post('/:id/reorder', async (req, res) => {
  if (!await mustEdit(req, res, req.params.id)) return;
  await store.reorder(req.params.id, (req.body && req.body.order) || []);
  res.json({ ok: true });
});

router.get('/:id/shares', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return bad(res, 'not a dashboard id');
  if (!await store.canSee(req.actor, req.params.id)) return bad(res, 'not yours', 403);
  res.json({ shares: await store.shares(req.params.id) });
});

router.post('/:id/shares', async (req, res) => {
  if (!await mustEdit(req, res, req.params.id)) return;
  const b = req.body || {};
  if (b.shareKind === 'staff' && !UUID_RE.test(String(b.staffId || ''))) return bad(res, 'pick a person');
  try {
    await store.share(req.params.id, req.actor, b);
    await audit(req, 'dashboard_shared', req.params.id, { kind: b.shareKind, role: b.role || null });
    res.json({ shares: await store.shares(req.params.id) });
  } catch (e) {
    res.status(e.status === 400 ? 400 : 500).json({ error: e.message || 'could not share that' });
  }
});

router.delete('/:id/shares/:shareId', async (req, res) => {
  if (!await mustEdit(req, res, req.params.id)) return;
  await store.unshare(req.params.id, req.params.shareId);
  res.json({ shares: await store.shares(req.params.id) });
});

module.exports = router;
