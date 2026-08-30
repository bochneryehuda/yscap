'use strict';
/**
 * LONG-TERM TERM SHEETS — HTTP.
 *
 * Mounted at /api/lt/dscr/term-sheet on the STAFF router only, and — like
 * `pricer-groups.js` — deliberately NOT inside `dscr-pricer`'s `makeRouter`,
 * which is ALSO mounted on the secret-gated diagnostics seam where there is no
 * signed-in person. A term sheet is issued BY somebody, its comp plan is resolved
 * from THEIR settings, and the cart is THEIR arrangement, so every door here
 * needs an actor and the diagnostics surface stays exactly what it was.
 *
 * ⛔ THE SERVER RE-DERIVES EVERY DOLLAR. The client posts the vendor's raw price
 * and the officer's choices; nothing it says about money is believed. The comp
 * plan comes from the SERVER's own resolver, the figures from `snapshot.js`, and
 * a monthly payment the board disagrees with REFUSES the export rather than
 * issuing a document that contradicts the screen the officer was reading.
 *
 * ⛔ RAW PRICING CANNOT BE ISSUED, at three layers: `snapshot.buildMember`
 * refuses it by name, db/642's CHECK refuses it on the sheet AND on every
 * member, and `overlay.ISSUABLE_MODES` — which both read — does not contain it.
 */

const express = require('express');

const router = express.Router();

const snapshot = require('../termsheet/snapshot');
const layout = require('../termsheet/layout');
const pdf = require('../termsheet/pdf');
const store = require('../termsheet/store');
const code = require('../termsheet/code');
const comparison = require('../termsheet/comparison');
const settingsStore = require('../settings/store');
const { resolveCompPlan } = require('../comp-plan');

router.use(express.json({ limit: '512kb' }));

const staffId = (req) => (req.actor && req.actor.id != null ? String(req.actor.id) : null);

/** A term sheet setting, with our shipped default when nothing is stored. */
function setting(company, key, fallback) {
  const v = company && company.settings ? company.settings[key] : undefined;
  return v === undefined || v === null || v === '' ? fallback : v;
}

/**
 * THE OFFICER'S OWN COMPENSATION, resolved by the server.
 *
 * Same shape as the pricer's `/comp-plan` door and for the same reason: person →
 * company → declared default, with the company figure as a FLOOR. A plan that
 * cannot be read yields NO plan, and `snapshot.js` then refuses the export with a
 * sentence the officer can act on — never a document priced at zero comp.
 */
async function officerPlan(req) {
  const id = staffId(req);
  const [company, user] = await Promise.all([
    settingsStore.load(),
    id ? settingsStore.load(`user:${id}`) : Promise.resolve({ settings: {}, stored: new Set(), degraded: false }),
  ]);
  const { plan, source } = resolveCompPlan({
    defaults: settingsStore.defaults(),
    company: company.settings,
    user: user.settings,
    userStored: user.stored,
  });
  return { plan, source, company, degraded: !!(company.degraded || user.degraded) };
}

/** Who the sheet says it is from. Read from the roster, never from the client. */
function preparedFrom(req, company, body) {
  const a = req.actor || {};
  const b = body && typeof body.prepared === 'object' ? body.prepared : {};
  return {
    // The BORROWER's details are the officer's to state — this is a quote, and a
    // borrower may not have a profile yet.
    borrowerName: b.borrowerName,
    propertyAddress: b.propertyAddress,
    // OURS are not. A term sheet naming somebody else as the officer, or naming
    // a company we are not, is a document we cannot stand behind.
    officerName: a.full_name || a.fullName || a.name || null,
    officerEmail: a.email || null,
    officerPhone: a.phone || a.cell_phone || null,
    officerNmls: a.nmls || null,
    companyName: setting(company, 'termSheet.companyName', 'YS Capital Group'),
    companyNmls: setting(company, 'termSheet.companyNmls', '2609746'),
    preparedAt: new Date().toISOString().slice(0, 10),
    expiresAt: null,   // filled after the sheet is issued and its clock starts
  };
}

/** Build a snapshot from a request, or answer the refusal. Never throws. */
async function snapshotFor(req, res) {
  const body = req.body || {};
  const { plan, company } = await officerPlan(req);
  const maxMembers = Number(setting(company, 'termSheet.cartMax', 8)) || 8;
  const built = snapshot.buildSnapshot({
    selections: Array.isArray(body.selections) ? body.selections : [],
    plan,
    anchorIndex: Number.isFinite(Number(body.anchorIndex)) ? Number(body.anchorIndex) : 0,
    prepared: preparedFrom(req, company, body),
    maxMembers,
  });
  if (!built.ok) {
    res.status(422).json({
      ok: false, error: built.error, message: built.message,
      memberIndex: built.memberIndex === undefined ? null : built.memberIndex,
    });
    return null;
  }
  return { snapshot: built.snapshot, plan, company };
}

// ── PREVIEW ─────────────────────────────────────────────────────────────────
// Everything the sheet will say, with NO code minted and nothing stored. A term
// sheet ID is a promise that the document exists and can be pulled up again, so
// it is never spent on a look.
router.post('/preview', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ ok: false, error: 'Sign in to build a term sheet.' });
    const built = await snapshotFor(req, res);
    if (!built) return undefined;
    const lay = layout.buildLayout(built.snapshot, {
      pricedApartMinutes: Number(setting(built.company, 'termSheet.pricedApartMinutes', 60)) || 60,
    });
    return res.json({
      ok: true, snapshot: built.snapshot, blocks: lay.blocks,
      hash: snapshot.hashSnapshot(built.snapshot),
    });
  } catch (e) {
    console.error('[lt] term sheet preview failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not build that term sheet.' });
  }
});

// ── ISSUE ───────────────────────────────────────────────────────────────────
// Mints the code and writes the sheet. This is the moment the document becomes a
// thing that exists, so from here nothing about it is ever edited.
router.post('/', async (req, res) => {
  try {
    const id = staffId(req);
    if (!id) return res.status(401).json({ ok: false, error: 'Sign in to issue a term sheet.' });
    const body = req.body || {};
    const built = await snapshotFor(req, res);
    if (!built) return undefined;

    const issued = await store.issueSheet({
      snapshot: built.snapshot,
      snapshotHash: snapshot.hashSnapshot(built.snapshot),
      compPlan: built.plan,
      staffId: id,
      borrowerId: body.borrowerId || null,
      borrowerName: (built.snapshot.prepared || {}).borrowerName,
      createdBy: 'officer',
      supersedes: body.supersedes || null,
      expiryDays: Number(setting(built.company, 'termSheet.expiryDays', 2)) || 2,
      cartId: body.cartId || null,
    });
    return res.json({ ok: true, ...issued });
  } catch (e) {
    console.error('[lt] term sheet issue failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not issue that term sheet.' });
  }
});

// ── LIST ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const id = staffId(req);
    if (!id) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    return res.json({ ok: true, sheets: await store.listForStaff(id, req.query || {}) });
  } catch (e) {
    console.error('[lt] term sheet list failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not load your term sheets.' });
  }
});

// ── THE CART ────────────────────────────────────────────────────────────────
// Registered BEFORE /:codeParam, or "cart" is read as a term sheet ID.

router.get('/cart', async (req, res) => {
  try {
    const id = staffId(req);
    if (!id) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    const [{ cart, members }, company] = await Promise.all([store.readCart(id), settingsStore.load()]);
    // THE SWITCH RIDES THE CART, deliberately. The board asks "is this on?" and
    // "what have I collected?" at the same moment and on every load, so one call
    // answers both — and there is only ever ONE reading of whether term sheets
    // are switched on, which is what stops a screen offering a control the
    // server would refuse.
    return res.json({
      ok: true,
      enabled: setting(company, 'termSheet.officerEnabled', false) === true,
      cartMax: Number(setting(company, 'termSheet.cartMax', 8)) || 8,
      cart,
      members,
    });
  } catch (e) {
    console.error('[lt] term sheet cart read failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not load your comparison.' });
  }
});

router.post('/cart', async (req, res) => {
  try {
    const id = staffId(req);
    if (!id) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    const { plan, company } = await officerPlan(req);
    // ⛔ THE MEMBER IS RE-DERIVED BEFORE IT IS STORED, through the SAME
    // `buildMember` an issue runs. A quote that could never be issued must be
    // refused at the moment it is added, with the reason — an officer who
    // collects four options and learns at the end that one of them cannot go on
    // a document has been let down by the screen, not by the rule.
    const r = snapshot.buildMember(req.body && req.body.selection, plan);
    if (!r.ok) return res.status(422).json({ ok: false, error: r.error, message: r.message });
    const out = await store.addToCart({
      staffId: id,
      member: {
        label: r.member.label, mode: r.member.mode, waiveLenderFees: r.member.waiveLenderFees,
        scenario: r.member.scenario, charges: r.member.charges, closing: r.member.closing,
        pricedAt: r.member.pricedAt,
        program: {
          consumerLabel: r.member.consumerLabel, product: r.member.product,
          ratePct: r.member.ratePct, monthlyPI: r.member.monthlyPI,
          prepayLabel: r.member.prepayLabel, rawPrice: (req.body.selection || {}).rawPrice,
        },
      },
      max: Number(setting(company, 'termSheet.cartMax', 8)) || 8,
    });
    if (!out.ok) return res.status(409).json({ ok: false, error: out.reason, message: out.message || 'Could not add that option.' });
    return res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[lt] term sheet cart add failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not add that option.' });
  }
});

router.patch('/cart', async (req, res) => {
  try {
    const id = staffId(req);
    if (!id) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    const out = await store.setAnchor(id, (req.body || {}).anchorPosition);
    if (!out.ok) return res.status(404).json({ ok: false, error: 'That option is not in your comparison.' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[lt] term sheet anchor failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not set the comparison.' });
  }
});

router.delete('/cart', async (req, res) => {
  try {
    const id = staffId(req);
    if (!id) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    await store.clearCart(id);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[lt] term sheet cart clear failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not clear your comparison.' });
  }
});

router.delete('/cart/:memberId', async (req, res) => {
  try {
    const id = staffId(req);
    if (!id) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    const out = await store.removeFromCart(id, req.params.memberId);
    if (!out.ok) return res.status(404).json({ ok: false, error: 'That option is not yours to remove.' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[lt] term sheet cart remove failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not remove that option.' });
  }
});

// ── REPLAY ──────────────────────────────────────────────────────────────────

/** Load a sheet by the typed code, or answer the 404 / 400. */
async function loadByCode(req, res) {
  const normalized = code.normalizeCode(req.params.code);
  if (!normalized) {
    res.status(400).json({
      ok: false, error: 'bad_code',
      message: 'A term sheet ID looks like TS-4K7P2M — six letters and numbers after TS.',
    });
    return null;
  }
  const row = await store.findByCode(normalized);
  if (!row) {
    res.status(404).json({
      ok: false, error: 'not_found',
      message: `No term sheet was issued under ${normalized}.`,
    });
    return null;
  }
  return row;
}

/**
 * Pull up a term sheet by its ID — the owner's *"put in the term sheet ID and
 * pull up the exact scenario that was searched."*
 *
 * ANY officer may replay ANY sheet, deliberately: the owner's case is somebody
 * ringing about a document a colleague sent, and scoping it to the issuer would
 * make the ID useless for exactly that. It is a read of a document we ourselves
 * sent out; nothing here can change one.
 */
router.get('/:code', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    const row = await loadByCode(req, res);
    if (!row) return undefined;
    const integrity = store.verifyIntegrity(row);
    return res.json({
      ok: true,
      code: row.code,
      issued: {
        at: row.created_at, pricedAt: row.priced_at, expiresAt: row.expires_at,
        by: row.created_by, borrowerName: row.borrower_name, kind: row.kind,
        supersedes: row.supersedes,
      },
      expired: new Date(row.expires_at).getTime() < Date.now(),
      snapshot: row.snapshot,
      // ⛔ SAID, NEVER SWALLOWED. The replay still renders — an officer on the
      // telephone needs to see something — but a document whose stored bytes no
      // longer hash to what we recorded is NOT the document we sent, and the
      // screen must say so rather than present it as authoritative.
      integrity,
    });
  } catch (e) {
    console.error('[lt] term sheet replay failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not pull up that term sheet.' });
  }
});

/** The PDF, rebuilt from the stored snapshot — never re-priced. */
router.get('/:code/pdf', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    const row = await loadByCode(req, res);
    if (!row) return undefined;
    const company = await settingsStore.load();
    const lay = layout.buildLayout(row.snapshot, {
      code: row.code,
      pricedApartMinutes: Number(setting(company, 'termSheet.pricedApartMinutes', 60)) || 60,
    });
    const bytes = await pdf.renderTermSheet(lay, { title: `Term Sheet ${row.code}` });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="term-sheet-${row.code}.pdf"`);
    res.setHeader('Content-Length', String(bytes.length));
    // A term sheet is a moment. Caching one would serve a stale copy after a
    // correction supersedes it.
    res.setHeader('Cache-Control', 'no-store');
    return res.end(Buffer.from(bytes));
  } catch (e) {
    console.error('[lt] term sheet pdf failed:', (e && e.message) || e);
    if (res.headersSent) return res.end();
    return res.status(500).json({ ok: false, error: 'Could not draw that term sheet.' });
  }
});

/**
 * THE THREE-WAY REPLAY — as issued, as it prices today, and the difference.
 *
 * The caller re-prices the SAME scenario against today's board and posts the
 * result; this compares it to what was issued and says plainly what moved.
 * Nothing is stored: re-pricing a quote does not change the document that was
 * sent, and it must never look as though it did.
 */
router.post('/:code/replay', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    const row = await loadByCode(req, res);
    if (!row) return undefined;
    const { plan } = await officerPlan(req);
    const today = snapshot.buildSnapshot({
      selections: Array.isArray((req.body || {}).selections) ? req.body.selections : [],
      plan,
      prepared: row.snapshot.prepared || {},
    });
    if (!today.ok) return res.status(422).json({ ok: false, error: today.error, message: today.message });
    return res.json({
      ok: true,
      code: row.code,
      asIssued: row.snapshot,
      asItPricesToday: today.snapshot,
      delta: comparison.compareSnapshots(row.snapshot, today.snapshot),
    });
  } catch (e) {
    console.error('[lt] term sheet re-price failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not re-price that term sheet.' });
  }
});

module.exports = router;
