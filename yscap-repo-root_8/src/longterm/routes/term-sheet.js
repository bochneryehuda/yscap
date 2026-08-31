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
 * refuses it by name, db/649's CHECK refuses it on the sheet AND on every
 * member, and `overlay.ISSUABLE_MODES` — which both read — does not contain it.
 */

const express = require('express');

const router = express.Router();

const snapshot = require('../termsheet/snapshot');
const layout = require('../termsheet/layout');
const store = require('../termsheet/store');
const internalRecord = require('../termsheet/internal');
const code = require('../termsheet/code');
const comparison = require('../termsheet/comparison');
const deliver = require('../termsheet/deliver');
const settingsStore = require('../settings/store');
const db = require('../db');
const { resolveCompPlan } = require('../comp-plan');

router.use(express.json({ limit: '512kb' }));

const staffId = (req) => (req.actor && req.actor.id != null ? String(req.actor.id) : null);

/* ⛔ ONE READER, NOT TWO. This used to be its own three-line copy of "read a key
   off the loaded scope, fall back to ours when nothing is stored" — and
   `termsheet/deliver.js` needs the SAME answer about the SAME keys, because the
   emailed copy of a sheet and the downloaded copy must be the same document down
   to the expiry line. Two copies of that reader is how one of them starts treating
   a stored blank as a value. It lives in the settings store, where it belongs, and
   the local name is kept so the twelve call sites below are unchanged. */
const setting = settingsStore.pick;

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

/* ⛔ THE OFFICER IS READ FROM THE ROSTER, AND UNTIL NOW NOBODY WAS READING IT
   (owner-directed 2026-08-31: *"We need to add loan officer branding on the term
   sheets ... their contact information, their name, their phone numbers, their
   emails, and their own branding on all the term sheets that they issue and all
   the comparison PDFs that they issue."*).

   THE WHOLE CHAIN WAS ALREADY BUILT and produced nothing. `snapshot.buildSnapshot`
   has accepted `officerName / officerTitle / officerEmail / officerPhone /
   officerNmls` since it shipped, `layout.recipientBlock` assembles them into an
   officer column, and `pdf.js` draws that column. What was missing is at the very
   start: `preparedFrom` read them off `req.actor`, and `authenticate` puts only
   `{ id, kind, role, sid }` on the actor. So every field resolved to null, the
   column filtered to an empty array, and EVERY long-term sheet ever issued carried
   no officer at all — silently, because an empty column draws nothing and looks
   like a design choice.

   The line above it already said "read from the roster"; this makes that true.

   ⛔ IT IS THE ROSTER, NEVER THE CLIENT. A term sheet naming somebody else as the
   officer is a document we cannot stand behind, so the body is not consulted for
   any of these — that part of the original contract is unchanged and is why the
   read has to happen server-side rather than being passed in by the screen.

   `staff_users` is the shared identity zone, which Long-Term has been authorized
   to READ since 2026-08-03 (`sql-read staff_users`); nothing here writes it. */
async function loadOfficer(req) {
  const id = staffId(req);
  if (!id) return {};
  try {
    const { rows } = await db.query(
      'SELECT full_name, title, email, phone, nmls FROM staff_users WHERE id = $1::uuid',
      [id],
    );
    return rows[0] || {};
  } catch (_) {
    /* ⛔ A SHEET IS NEVER REFUSED OVER THE LETTERHEAD. The officer block is
       decoration on a document whose numbers are the point, so an unreadable
       roster costs the branding and nothing else — exactly what happens today,
       every time. Never rethrown. */
    return {};
  }
}

/** Who the sheet says it is from. Read from the roster, never from the client. */
function preparedFrom(req, company, body, expiresAt, officer = {}) {
  const a = req.actor || {};
  const b = body && typeof body.prepared === 'object' ? body.prepared : {};
  return {
    // The BORROWER's details are the officer's to state — this is a quote, and a
    // borrower may not have a profile yet.
    borrowerName: b.borrowerName,
    propertyAddress: b.propertyAddress,
    // OURS are not. A term sheet naming somebody else as the officer, or naming
    // a company we are not, is a document we cannot stand behind.
    officerName: officer.full_name || a.full_name || a.fullName || a.name || null,
    officerTitle: officer.title || a.title || a.role_label || null,
    officerEmail: officer.email || a.email || null,
    officerPhone: officer.phone || a.phone || a.cell_phone || null,
    officerNmls: officer.nmls || a.nmls || null,
    companyName: setting(company, 'termSheet.companyName', 'YS Capital Group'),
    companyNmls: setting(company, 'termSheet.companyNmls', '2609746'),
    preparedAt: stamp(new Date()),
    expiresAt: expiresAt ? stamp(new Date(expiresAt)) : null,
  };
}

/** A date a borrower reads, not an ISO string. One definition, so the band, the
 *  expiry panel and the footer all date the document identically. */
function stamp(d) {
  try {
    return d.toLocaleString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York',
    });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * HOW LONG THIS DOCUMENT IS GOOD FOR, by what kind of document it is.
 *
 * ⛔ A TERM SHEET RUNS ON A 24-HOUR CLOCK. Owner-directed 2026-08-30: *"it should
 * also say that it's expiring in 24 hours."* A comparison is a working document
 * rather than an offer, so it keeps the longer company window — the same
 * `termSheet.expiryDays` it has always used. Both are settings, so neither
 * number is written into the page as a literal that could go on saying 24 after
 * somebody changed it.
 */
function expiryHoursFor(docKind, company) {
  if (docKind === snapshot.DOC_KINDS.TERM_SHEET) {
    const h = Number(setting(company, 'termSheet.expiryHours', 24));
    return Number.isFinite(h) && h > 0 ? h : 24;
  }
  const d = Number(setting(company, 'termSheet.expiryDays', 2));
  return (Number.isFinite(d) && d > 0 ? d : 2) * 24;
}

/**
 * Build a snapshot from a request, or answer the refusal. Never throws.
 *
 * ⛔ IT IS BUILT TWICE, AND THAT IS THE POINT. How long the document is good for
 * depends on WHICH of the three documents it is, and which one it is depends on
 * the members — so the first pass learns the kind, and the second stamps the
 * expiry the kind earns. Two passes rather than reaching into a built snapshot
 * afterwards: `buildSnapshot` sanitizes every string a document prints, and a
 * value written in behind it would be the one field on the page that never went
 * through that. The build is pure arithmetic, so the second pass can differ from
 * the first only in the one string it was given.
 */
async function snapshotFor(req, res) {
  const body = req.body || {};
  const [{ plan, company }, officer] = await Promise.all([officerPlan(req), loadOfficer(req)]);
  const maxMembers = Number(setting(company, 'termSheet.cartMax', 8)) || 8;
  const build = (expiresAt) => snapshot.buildSnapshot({
    selections: Array.isArray(body.selections) ? body.selections : [],
    plan,
    anchorIndex: Number.isFinite(Number(body.anchorIndex)) ? Number(body.anchorIndex) : 0,
    prepared: preparedFrom(req, company, body, expiresAt, officer),
    maxMembers,
  });

  const first = build(null);
  if (!first.ok) {
    res.status(422).json({
      ok: false, error: first.error, message: first.message,
      memberIndex: first.memberIndex === undefined ? null : first.memberIndex,
    });
    return null;
  }
  const expiryHours = expiryHoursFor(first.snapshot.docKind, company);
  const expiresAt = new Date(Date.now() + expiryHours * 3600000);
  const built = build(expiresAt.toISOString());
  if (!built.ok) {
    // Unreachable in practice — the same inputs plus one string — but a silent
    // fall-through to a snapshot with no expiry would print a term sheet that
    // never expires, so it is answered rather than assumed.
    res.status(422).json({ ok: false, error: built.error, message: built.message });
    return null;
  }
  // `internal` rides BESIDE the snapshot, never inside it (db/651): it is the
  // staff-only note about who funds each option, and the snapshot is the
  // client's own document. Only the ISSUE door passes it on; the preview
  // deliberately drops it, because a preview is a look at the document.
  return { snapshot: built.snapshot, internal: built.internal, plan, company, expiryHours, expiresAt };
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
      expiryHours: built.expiryHours,
    });
    // ⛔ THE PREVIEW REPORTS THE GATE, IT DOES NOT ENFORCE IT. An officer looking
    // at what a sheet WILL say is exactly who needs to be told what is still
    // missing; refusing to draw it would hide the very page that shows them.
    return res.json({
      ok: true, snapshot: built.snapshot, blocks: lay.blocks,
      docKind: built.snapshot.docKind,
      gate: snapshot.exportGate(built.snapshot),
      expiryHours: built.expiryHours,
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

    // ⛔ A TERM SHEET IS ONLY ISSUED COMPLETE. Owner-directed 2026-08-30: *"Term
    // sheet should only be able to be exported if they enter the full scenario
    // and calculate the ratio … If you didn't do that, then you can just export
    // comparisons."* The refusal names every missing field at once, and each one
    // is a box on the screen the officer is already looking at.
    const gate = snapshot.exportGate(built.snapshot);
    if (!gate.ok) {
      return res.status(422).json({
        ok: false, error: gate.error, message: gate.message, missing: gate.missing, docKind: gate.kind,
      });
    }

    const issued = await store.issueSheet({
      snapshot: built.snapshot,
      snapshotHash: snapshot.hashSnapshot(built.snapshot),
      compPlan: built.plan,
      staffId: id,
      borrowerId: body.borrowerId || null,
      borrowerName: (built.snapshot.prepared || {}).borrowerName,
      createdBy: 'officer',
      supersedes: body.supersedes || null,
      // The instant the DOCUMENT prints, so the column and the page agree.
      expiresAt: built.expiresAt.toISOString(),
      cartId: body.cartId || null,
      internal: built.internal,
    });
    return res.json({ ok: true, docKind: built.snapshot.docKind, ...issued });
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
        // db/651 — the STAFF-ONLY record of who funds this option, kept on the
        // cart member so it survives to the sheet. `addToCart` projects it
        // through the same whitelist the issue does, so the two paths can never
        // record different fields for one quote.
        internal: (req.body.selection || {}).internal,
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
    /* ⛔ THE PROVENANCE IS FETCHED SEPARATELY AND RETURNED AS ITS OWN KEY (db/651).
       The owner's ask was *"see exactly what the input was and what exactly they
       priced in the real program and the real investors behind everything"*, and
       the input half already replayed — every figure the officer typed is on each
       member's `scenario`. The investor half never could, because the snapshot is
       the borrower's document and an investor's name may never be on one.

       So it is loaded from the STAFF-side member rows and answered as a sibling
       of `snapshot`, never merged into it: this door is staff-gated, but the
       snapshot object it returns is the same one the PDF is drawn from, and the
       moment an investor becomes a key on it, one careless projection puts it on
       a client's page. A read that fails is REPORTED as unavailable rather than
       silently returning an empty list, which would read as "nobody funds this". */
    let internal = null;
    let internalError = null;
    try {
      internal = await store.readInternal(row.id);
    } catch (e) {
      internalError = 'Could not read who was behind these prices.';
      console.error('[lt] term sheet provenance read failed:', (e && e.message) || e);
    }
    return res.json({
      ok: true,
      code: row.code,
      internal,
      internalError,
      internalNotRecorded: internalRecord.NOT_RECORDED,
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

/**
 * The PDF, rebuilt from the stored snapshot — never re-priced.
 *
 * ⛔ THE DOCUMENT IS DRAWN IN ONE PLACE (`termsheet/deliver.renderSheet`), and this
 * route and the email door below both go through it. The layout it is built from
 * takes options — the priced-apart window, and an expiry read off the DOCUMENT
 * rather than off today's settings — and this route used to assemble those options
 * itself. Two callers assembling them separately is precisely how the copy a
 * borrower is emailed comes to state a different expiry from the copy the officer
 * downloaded and filed, on the same sheet, with nothing anywhere saying why.
 */
router.get('/:code/pdf', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    const row = await loadByCode(req, res);
    if (!row) return undefined;
    const company = await settingsStore.load();
    const doc = await deliver.renderSheet(row, company);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.setHeader('Content-Length', String(doc.bytes.length));
    // A term sheet is a moment. Caching one would serve a stale copy after a
    // correction supersedes it.
    res.setHeader('Cache-Control', 'no-store');
    return res.end(doc.bytes);
  } catch (e) {
    console.error('[lt] term sheet pdf failed:', (e && e.message) || e);
    if (res.headersSent) return res.end();
    return res.status(500).json({ ok: false, error: 'Could not draw that term sheet.' });
  }
});

/**
 * EMAIL IT TO THE BORROWER — the PDF, the branded letter, from the officer.
 *
 * The owner (2026-08-31): *"we should be able to put in an email address from a
 * borrower, which should deliver them the PDF and the nice email ... It should
 * deliver it from the loan officer's email address and from the loan officer's
 * name, and, of course, with the branding, same style emails that we have on the
 * short-term side."*
 *
 * ⛔ THE FROM LINE IS THE ROSTER'S, NEVER THE CLIENT'S. Who this comes from is read
 * from `staff_users` for the person signed in, the same read that put the officer
 * on the paper. A screen that could name the sender could send a borrower's pricing
 * under a colleague's address.
 *
 * ⛔ IT IS RECORDED, whatever happens next. The row in `lt_term_sheet_delivery` is
 * the only answer to "what did we actually send this person, and when" — the email
 * itself lands in a mailbox we cannot read, and rule 4 keeps a long-term send out
 * of the short-term Email Center. Recording is best-effort AFTER the send, in that
 * order and never the reverse: a bookkeeping failure must not turn a delivered
 * email into an error the officer answers by sending it again.
 */
router.post('/:code/email', async (req, res) => {
  try {
    const id = staffId(req);
    if (!id) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    const row = await loadByCode(req, res);
    if (!row) return undefined;

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const [company, officer] = await Promise.all([settingsStore.load(), loadOfficer(req)]);

    const out = await deliver.sendSheet({
      row,
      company,
      to: body.to,
      note: body.note,
      /* The sender is the person signed in, off the roster. `send-as.js` decides
         whether their address may go in the From line at all — that is a DKIM
         question, not a preference — and says so in `sentAs.why`. */
      from: {
        name: officer.full_name || null,
        email: officer.email || null,
      },
    });

    if (!out.ok) {
      // A refusal here is something a person fixes and tries again — a mistyped
      // address, a note naming the investor — so it answers 422 with the sentence,
      // never a bare 500 that tells them nothing.
      const status = out.error === 'render_failed' ? 500 : 422;
      return res.status(status).json({ ok: false, error: out.error, message: out.message, ambiguous: !!out.ambiguous });
    }

    try {
      await db.query(
        `INSERT INTO lt_term_sheet_delivery
           (sheet_id, code, to_email, to_name, note, doc_kind, filename, doc_sha256,
            sent_by_staff, from_email, sent_as_mode, message_id)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11, $12)`,
        [row.id, row.code, out.to, out.toName, out.note, out.docKind, out.filename, out.sha256,
          id, (out.sentAs && out.sentAs.from) || null, (out.sentAs && out.sentAs.mode) || null, out.messageId],
      );
    } catch (e) {
      /* ⛔ SAID, NEVER SWALLOWED. The borrower HAS the document — reversing that is
         not possible and pretending it failed would get it sent twice — so the send
         stands and the gap in the record is logged loudly for a human to find. */
      console.error('[lt] term sheet delivery recorded nowhere:', (e && e.message) || e);
    }

    return res.json({
      ok: true,
      sent: {
        to: out.to,
        subject: out.subject,
        filename: out.filename,
        sentAs: out.sentAs,
      },
    });
  } catch (e) {
    console.error('[lt] term sheet email failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not send that document.' });
  }
});

/**
 * EVERY SEND OF ONE SHEET, newest first.
 *
 * A screen offering "email this to the borrower" has to be able to say whether it
 * has already been sent, and to whom — otherwise the honest answer to "did she get
 * it?" is another copy in the borrower's inbox.
 */
router.get('/:code/deliveries', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    const row = await loadByCode(req, res);
    if (!row) return undefined;
    const { rows } = await db.query(
      `SELECT to_email, to_name, note, filename, sent_as_mode, from_email, created_at
         FROM lt_term_sheet_delivery
        WHERE sheet_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 50`,
      [row.id],
    );
    return res.json({ ok: true, code: row.code, deliveries: rows });
  } catch (e) {
    console.error('[lt] term sheet deliveries failed:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'Could not pull up who this was sent to.' });
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

/* Exported for the test that proves the officer actually reaches the paper. The
   router is still the default export and the only thing `src/longterm/index.js`
   mounts; these two are the pair the 2026-08-31 defect lived between, and a test
   that cannot reach them can only assert the layout — which was never the broken
   half. */
module.exports = router;
module.exports._internals = { loadOfficer, preparedFrom };
