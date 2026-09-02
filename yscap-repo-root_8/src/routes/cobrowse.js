'use strict';
/**
 * HTTP for CO-BROWSING — request / answer / status / end / history, and (Phase B)
 * the SECOND consent: ask for control / answer / release. Mounted at /api/cobrowse OUTSIDE the staff router because the WATCHED
 * person may be a borrower: they answer the consent prompt and press Stop while
 * holding a borrower-kind token.
 *
 * The rule lives in src/lib/cobrowse/sessions.js; this file only maps it to
 * doors and refusals. Two refusals are made at the door itself: nobody inside a
 * view-as (borrower / TPO / staff view) may ask OR answer — a person acting as
 * somebody else can neither consent for them nor be watched as themselves.
 */
const router = require('../lib/safe-router')();
const { requireAuth, requireStaff } = require('../auth');
const S = require('../lib/cobrowse/sessions');
const hub = require('../lib/cobrowse/hub');

router.use(requireAuth);

/** A borrower's HELPER token and a condition guest link carry the borrower's id
 *  and are not the borrower: they may not ask, answer, end, or even see a
 *  co-browse (pre-merge audit 2026-09-02, blocker — a helper could have accepted
 *  on the borrower's behalf and the borrower's screen would have streamed). */
function notAProxy(req, res, next) {
  if (req.actor && (req.actor.assistant || req.actor.guestConditions)) {
    return res.status(403).json({ error: 'Co-browsing is between the person themselves and the team — a helper or guest link cannot answer for them.', code: 'proxy_actor' });
  }
  next();
}
router.use(notAProxy);

function notInsideAView(req, res, next) {
  if (req.impersonation || req.staffImpersonation) {
    return res.status(403).json({ error: 'Co-browsing is not available inside a “view as” session — leave it first.', code: 'inside_view' });
  }
  next();
}

const refuse = (res, out) => {
  const status = out.code === 'no_such_target' || out.code === 'not_yours' ? 403
    : out.code === 'not_found' ? 404
      : out.code === 'busy' || out.code === 'no_login' || out.code === 'not_open' || out.code === 'control_not_open' ? 409
        : out.code === 'bad_target' || out.code === 'self' ? 400 : 403;
  return res.status(status).json({ error: out.message || 'Not allowed.', code: out.code, status: out.status });
};

/** Ask to watch. { kind:'staff'|'borrower', id, applicationId? } */
router.post('/request', requireStaff, notInsideAView, async (req, res) => {
  const b = req.body || {};
  const out = await S.request({ actor: req.actor, kind: String(b.kind || ''), id: String(b.id || '').trim(), applicationId: b.applicationId || null, req });
  if (!out.ok) return refuse(res, out);
  res.json({ ok: true, session: out.session });
});

/** The watched person answers. { accept: true|false } */
router.post('/:id/respond', notInsideAView, async (req, res) => {
  const out = await S.respond({ actor: req.actor, sessionId: req.params.id, accept: !!(req.body && req.body.accept === true), req });
  if (!out.ok) return refuse(res, out);
  res.json({ ok: true, session: out.session });
});

/** Either party ends it. */
router.post('/:id/end', notInsideAView, async (req, res) => {
  const out = await S.end({ actor: req.actor, sessionId: req.params.id, req });
  if (!out.ok) return refuse(res, out);
  res.json({ ok: true, session: out.session });
});

/* ── Phase B: TAKE CONTROL — the second consent ───────────────────────────── */
/** The viewer asks to drive the watched person's page. */
router.post('/:id/control/request', requireStaff, notInsideAView, async (req, res) => {
  const out = await S.requestControl({ actor: req.actor, sessionId: req.params.id, req });
  if (!out.ok) return refuse(res, out);
  res.json({ ok: true, session: out.session, already: !!out.already });
});
/** The watched person answers. { accept: true|false } */
router.post('/:id/control/respond', notInsideAView, async (req, res) => {
  const out = await S.respondControl({ actor: req.actor, sessionId: req.params.id, accept: !!(req.body && req.body.accept === true), req });
  if (!out.ok) return refuse(res, out);
  res.json({ ok: true, session: out.session });
});
/** Either party takes control back. { reason?: 'guest_moved' | 'guest_stop' | 'viewer_release' } */
router.post('/:id/control/release', async (req, res) => {
  const out = await S.releaseControl({ actor: req.actor, sessionId: req.params.id, reason: req.body && req.body.reason, req });
  if (!out.ok) return refuse(res, out);
  res.json({ ok: true, session: out.session, already: !!out.already });
});

/** Open requests aimed at ME, and my live session if any (the guest re-reads on load). */
router.get('/mine', notInsideAView, async (req, res) => {
  const [pending, active] = await Promise.all([S.pendingFor(req.actor), S.activeFor(req.actor)]);
  res.json({ pending, active, wsPath: hub.PATH });
});

/** The register. */
router.get('/history', requireStaff, async (req, res) => {
  res.json({ sessions: await S.history(req.actor, { limit: req.query.limit }) });
});

/** One session, for either party. */
router.get('/:id', notInsideAView, async (req, res) => {
  const row = await S.loadRaw(req.params.id);
  if (!row) return res.status(404).json({ error: 'That session does not exist.' });
  if (!S.isViewer(row, req.actor) && !S.isWatched(row, req.actor)) return res.status(403).json({ error: 'This is not your session.' });
  const v = await S.view(row, req.actor);
  res.json({ session: v, wsPath: hub.PATH });
});

module.exports = router;
