'use strict';
/**
 * GUEST CONDITION LINKS — the login-free way for a borrower to work their
 * conditions (owner-directed 2026-08-28: "another way for borrowers to manage
 * their conditions if they're not so technical. A more simple condition center
 * for them, with an email directly with links to upload and enter the
 * information over there … without him being able to set up an account or
 * portal … Every condition should have an upload button that takes them
 * directly to upload to that condition directly … when he fills it out and he
 * click saves it saves directly into the file without him needing to log in").
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS — the `borrower_assistants` dual-identity model, deliberately
 * ────────────────────────────────────────────────────────────────────────────
 * The emailed link carries an unguessable token (24 random bytes; stored only
 * as a sha256 in `condition_links`, db/637). Opening the guest page exchanges
 * it for a REAL `kind:'borrower'` access token whose `sub` is the borrower the
 * link was minted for, PLUS a guest envelope:
 *
 *     { sub:<borrowerId>, kind:'borrower', role:'borrower',
 *       gcl: 1, gclId: <condition_links.id>, gclApp: <application id> }
 *
 * Because the session IS a borrower session, every existing borrower endpoint —
 * the scrubbed checklist, the info-condition answer with its freeze/sandbox
 * governance, the tool submit, the document upload with its dedupe and review
 * pipeline, the appraisal-card capture — works with NO second implementation.
 * That is the whole point: a parallel "guest API" would be a second copy of a
 * dozen safety rules, and the copy is what drifts.
 *
 * What makes it SAFE to hand that much power to an emailed link:
 *   1. `authenticate()` re-validates the LINK ROW on every request (live, not
 *      revoked, not expired, still pointing at this borrower) — revoking a link
 *      kills its sessions immediately, exactly like disabling a helper.
 *   2. THE PATH JAIL (`allowedRequest`, below): a guest session may reach ONLY
 *      the handful of endpoints the simple condition center needs, and ONLY for
 *      the one linked application. Everything else — other files, the profile,
 *      draws, chat, e-sign, credentials — answers 403 before any route runs.
 *      Default-deny: an endpoint added next year is closed until listed here.
 *   3. PII IS STRIPPED from every response through the SAME chokepoint a
 *      helper's session uses (borrower-assistant.scrubPii — one definition):
 *      an emailed link can be forwarded, so what it can READ is kept to what
 *      the condition list itself needs.
 *   4. The link EXPIRES ({@link LINK_TTL_DAYS} days). Every fresh send mints a
 *      fresh link; staff can revoke any of them.
 *
 * THE EMAIL is the "simple version of outstanding conditions": a numbered list
 * of what is still needed — the same borrower-safe wording every other surface
 * uses — with ONE button into the guest condition center and per-item deep
 * links. Its Reply-To is the file's own address (file+<id>@…), so a borrower
 * who just hits Reply lands in the file's email chain, where the team already
 * works.
 */
const db = require('../db');
const C = require('./crypto');
const cfg = require('../config');

const LINK_TTL_DAYS = 30;

// ---------------------------------------------------------------------------
// Minting + validation
// ---------------------------------------------------------------------------

/** Mint a link for one recipient. Returns { link, token } — the clear token
    exists only here and in the email built from it. */
async function mintLink({ applicationId, borrowerId, email, createdBy }, client = db) {
  const token = C.randomToken(24);
  const r = await client.query(
    `INSERT INTO condition_links (application_id, borrower_id, sent_to_email, token_hash, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)
     RETURNING *`,
    [applicationId, borrowerId, String(email || '').trim().toLowerCase(), C.sha256(token), createdBy || null, String(LINK_TTL_DAYS)]);
  return { link: r.rows[0], token };
}

/** The LIVE link a clear token names, or null. Never throws. */
async function linkByToken(token, client = db) {
  try {
    if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return null;
    const r = await client.query(
      `SELECT cl.*, a.deleted_at AS app_deleted
         FROM condition_links cl JOIN applications a ON a.id = cl.application_id
        WHERE cl.token_hash=$1 AND cl.revoked_at IS NULL AND cl.expires_at > now()`,
      [C.sha256(String(token))]);
    const row = r.rows[0];
    if (!row || row.app_deleted) return null;
    return row;
  } catch (_) { return null; }
}

/** The LIVE link row by id — what `authenticate()` re-checks per request. */
async function linkById(id, client = db) {
  try {
    const r = await client.query(
      `SELECT cl.*, a.deleted_at AS app_deleted
         FROM condition_links cl JOIN applications a ON a.id = cl.application_id
        WHERE cl.id=$1 AND cl.revoked_at IS NULL AND cl.expires_at > now()`, [id]);
    const row = r.rows[0];
    if (!row || row.app_deleted) return null;
    return row;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// The guest session token
// ---------------------------------------------------------------------------

/** A real borrower-kind access token carrying the guest envelope. Sliding like
    any session token; the durable capability is the LINK, not this JWT. */
function mintGuestToken({ borrowerId, linkId, applicationId, ltLoanId }) {
  /* ONE OWNER, NEVER TWO. A link opens a SHORT-TERM file (`gclApp`) or a
     LONG-TERM loan (`gclLt`) and the path jail below reads exactly one of them
     to decide which doors exist and which id they must name. A token carrying
     both would be a session with two jails, and the first rule that matched
     would decide — so the claim is simply not written unless it is the one this
     link is for. `readGuest` refuses both-or-neither on the way back in, which
     is where it actually matters: a forged claim never reaches the jail. */
  const claims = {
    sub: borrowerId, kind: 'borrower', role: 'borrower', tv: 0,
    gcl: 1, gclId: linkId,
  };
  if (ltLoanId) claims.gclLt = ltLoanId;
  else claims.gclApp = applicationId;
  return C.signJwt(claims, cfg.accessTtlSec);
}

/** The guest envelope off verified claims, or null. */
function readGuest(claims) {
  if (!claims || claims.gcl !== 1 || claims.kind !== 'borrower') return null;
  if (!claims.gclId) return null;
  const app = claims.gclApp || null;
  const lt = claims.gclLt || null;
  /* EXACTLY ONE OWNER — fail closed both ways. Neither means the jail has no
     id to pin a path to and would have nothing to compare against; BOTH means
     two jails at once, and whichever rule list ran first would win. Either is a
     token nothing in this system mints, so the honest answer to both is "not a
     guest session", which costs a forged token everything and a real one
     nothing. */
  if ((app && lt) || (!app && !lt)) return null;
  return { linkId: claims.gclId, applicationId: app, ltLoanId: lt };
}

// ---------------------------------------------------------------------------
// THE PATH JAIL — everything a guest session may do, and nothing else
// ---------------------------------------------------------------------------
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/* Each rule: method + a regex over the FULL path (baseUrl + path) whose first
   capture, when present, must be the linked application id. The documents doors
   carry the application in the body / metadata header instead — checked below. */
const RULES = [
  { m: 'GET',  re: new RegExp(`^/api/borrower/applications/(${UUID})$`) },
  { m: 'GET',  re: new RegExp(`^/api/borrower/applications/(${UUID})/checklist$`) },
  { m: 'POST', re: new RegExp(`^/api/borrower/applications/(${UUID})/checklist/${UUID}/info$`) },
  { m: 'POST', re: new RegExp(`^/api/borrower/applications/(${UUID})/checklist/${UUID}/tool$`) },
  { m: 'POST', re: new RegExp(`^/api/borrower/applications/(${UUID})/appraisal-card$`) },
  { m: 'POST', re: /^\/api\/borrower\/documents$/, docBody: true },
  { m: 'POST', re: /^\/api\/borrower\/documents\/binary$/, docMeta: true },
];

/* A SECOND PRODUCT'S DOORS ARE REGISTERED, NOT WRITTEN HERE.
   The obvious shape — a `LT_RULES` list beside the one above — puts the string
   "/api/lt" into shared back-end code, and `check-product-separation` refuses
   that for a good reason: only `src/server.js` may name the Long-Term mount
   path, or the two products start naming each other's routes and the boundary
   stops meaning anything. So the shared module owns the MECHANISM (one jail per
   owner kind, default-deny, the id in the path must be this link's) and each
   product declares its OWN doors in its own code.

   FAIL-CLOSED BY CONSTRUCTION: with nothing registered — Long-Term not mounted,
   or a boot that never loaded it — a long-term guest matches no rule at all and
   gets a 403 rather than the short-term doors. */
const EXTRA_JAILS = new Map();

/**
 * Declare the doors a guest link on `ownerKind` may reach.
 * Called once at boot by the product that owns those paths.
 *
 * @param {string} ownerKind  today only 'lt_loan'
 * @param {Array}  rules      [{ m, re, noEntity? }] — `re`'s first capture, when
 *                            present, must be the id the link was minted for.
 */
function registerJail(ownerKind, rules) {
  if (!ownerKind || !Array.isArray(rules) || !rules.length) return false;
  EXTRA_JAILS.set(String(ownerKind), rules);
  return true;
}

/**
 * The guest shape a stored link row describes — the owner it was minted for.
 *
 * WHY THIS IS A FUNCTION AND NOT TWO LINES AT THE CALL SITE. `authenticate()`
 * uses the answer THREE times per request: to check the token still describes
 * the link it was minted from, to build the jail, and to re-mint on a sliding
 * refresh. Three hand-written readings of "which owner is this?" is three
 * chances for one of them to look at `application_id` on a long-term link and
 * silently compare null to null — which would pass. One function, read once.
 *
 * PURE, and it never throws: a row with neither owner (or both, which the
 * database's own CHECK forbids) answers null, and null gets no doors.
 */
function guestFromLink(row) {
  if (!row) return null;
  const app = row.application_id || null;
  const lt = row.lt_loan_id || null;
  if ((app && lt) || (!app && !lt)) return null;
  return { linkId: row.id, applicationId: app, ltLoanId: lt };
}

/**
 * Does the envelope the caller presented still describe this link row?
 *
 * NULL-SAFE ON PURPOSE. Comparing `String(row.application_id)` to
 * `String(claim)` reads `"null" === "null"` as agreement, so one borrower's
 * long-term token would match a DIFFERENT long-term link — both rows carry a
 * null application_id. Both sides are resolved to a single owner first and the
 * OWNER KIND has to agree before the ids are compared at all.
 */
function linkMatchesGuest(row, guest) {
  const a = guestFromLink(row);
  if (!a || !guest) return false;
  if (!!a.applicationId !== !!guest.applicationId) return false;
  if (!!a.ltLoanId !== !!guest.ltLoanId) return false;
  const mine = a.applicationId || a.ltLoanId;
  const theirs = guest.applicationId || guest.ltLoanId;
  return String(mine).toLowerCase() === String(theirs).toLowerCase();
}

/** Which doors exist for this guest, and which id every path must name.
    Exactly one owner is guaranteed by `readGuest`; this re-reads it rather
    than trusting a caller to have gone through that door. */
function rulesFor(guest) {
  if (!guest) return null;
  if (guest.ltLoanId && !guest.applicationId) {
    const rules = EXTRA_JAILS.get('lt_loan');
    // Nothing registered means no doors — never a fall-through to RTL's.
    return rules ? { rules, id: guest.ltLoanId } : null;
  }
  if (guest.applicationId && !guest.ltLoanId) return { rules: RULES, id: guest.applicationId };
  return null;                       // both or neither — no jail, so no doors
}

/**
 * May THIS request run under THIS guest envelope? Pure over (method, fullPath,
 * body, headers). Returns true/false — the caller answers 403 on false.
 */
function allowedRequest({ method, fullPath, body, headers }, guest) {
  const jail = rulesFor(guest);
  if (!jail) return false;
  for (const rule of jail.rules) {
    if (rule.m !== method) continue;
    const m = rule.re.exec(String(fullPath || ''));
    if (!m) continue;
    // A path that names a file must name THE file this link was minted for —
    // the application on a short-term link, the loan on a long-term one.
    if (m[1] && m[1].toLowerCase() !== String(jail.id).toLowerCase()) return false;
    if (rule.noEntity) {
      /* THE LONG-TERM UPLOAD DOORS. The loan and the condition are already
         pinned by the path above, so all that is left is the entity door: the
         shared upload module files onto a COMPANY when it is handed an
         `llcId`, and an emailed link must never be able to put a document on
         the borrower's company record. Refused from the body and from the
         streaming door's metadata header alike, mirroring the short-term
         rules — a guest uploads into a condition on this loan, full stop. */
      if (body && body.llcId) return false;
      const raw = (headers || {})['x-upload-meta'];
      if (raw) {
        try { if (JSON.parse(String(raw)).llcId) return false; } catch (_) { return false; }
      }
      return true;
    }
    if (rule.docBody) {
      // The JSON upload door: the body must target the linked application (and
      // through it, a condition on that application — the route re-verifies the
      // item belongs to the file). An upload aimed anywhere else is refused.
      const appId = body && body.applicationId;
      if (String(appId || '').toLowerCase() !== String(guest.applicationId).toLowerCase()) return false;
      // No LLC-scoped or free-floating uploads through the guest door — the
      // simple condition center uploads into conditions on this file only.
      if (body && body.llcId) return false;
      return true;
    }
    if (rule.docMeta) {
      // The streaming door: metadata rides the x-upload-meta header (the body IS
      // the file). Same application check, off that header.
      try {
        const meta = JSON.parse(String((headers || {})['x-upload-meta'] || '{}'));
        if (String(meta.applicationId || '').toLowerCase() !== String(guest.applicationId).toLowerCase()) return false;
        if (meta.llcId) return false;
        return true;
      } catch (_) { return false; }
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// THE EMAIL — the simple outstanding-conditions list with direct links
// ---------------------------------------------------------------------------

/** The guest condition center URL for a clear token (+ optional item focus).
    Emitted as the tracking-proof /link/r bounce (server.js): click-trackers
    rewrite every emailed link and DROP the #fragment, and the portal is
    hash-routed — a naked /#/guest/… link would arrive with no route and no
    token. The item focus rides as a QUERY param for the same reason. */
function guestUrl(token, itemId) {
  const base = String(cfg.appUrl || '').replace(/\/+$/, '');
  const route = `/guest/conditions?t=${encodeURIComponent(token)}${itemId ? `&item=${encodeURIComponent(itemId)}` : ''}`;
  return `${base}/link/r?to=${encodeURIComponent(route)}`;
}

/**
 * Build the outstanding-conditions email for ONE recipient (their own token).
 * `items` come from the caller (the same borrower-facing outstanding read every
 * other surface uses — see routes/staff.js sendOutstanding); this renders them
 * as the simple numbered list the owner asked for, each with its direct link.
 */
function buildOutstandingEmail({ items, token, data, note }) {
  const tpl = require('./email/template');
  const quote = require('./email/quote');
  const lines = [];
  items.slice(0, 40).forEach((it, i) => {
    lines.push(`${i + 1}) ${it.label}${it.detail ? ` — ${it.detail}` : ''}`);
    /* EVERY condition gets its own DIRECT link (owner-directed: "Every condition
       should have an upload button that takes them directly to upload to that
       condition directly") — the same page, opened ON that item. Only checklist
       items have a card to land on; a plain condition row rides the main button. */
    if (it.kind === 'checklist' && it.id) {
      lines.push(`   → Upload / fill this one in: ${guestUrl(token, it.id)}`);
    }
    /* The Scope of Work rides the Investor Suite line the owner's own sample email
       carries — the public tool builds the budget; the link above imports it. */
    if (it.toolKey === 'rehab_budget') {
      lines.push('   Please visit our investor suite to make the rehab budget (scope of work) at https://www.yscapgroup.com/suite');
    }
    lines.push('');
  });
  const built = tpl.render({
    title: 'What your loan still needs',
    subjectTag: data.loanNumber || undefined,
    kicker: 'Outstanding items',
    preheader: `The items still needed on ${data.propertyLine || 'your loan file'}`,
    greeting: data.firstName ? `Hi ${data.firstName},` : 'Hi,',
    intro: (note && String(note).trim())
      || 'Here is everything still needed on your loan file. The button below opens your items — each one has its own Upload or Fill-in button, and whatever you save lands straight on your file. No account or password needed.',
    lines: [...lines, '', 'Open your items with the button below — upload or type each one in right there.'],
    meta: [
      data.propertyLine ? { label: 'Property', value: data.propertyLine } : null,
      data.loanNumber ? { label: 'Loan Number', value: data.loanNumber } : null,
    ].filter(Boolean),
    cta: { label: 'Open your outstanding items', url: guestUrl(token) },
    officer: data.officer || undefined,
    note: 'Reply to this email and it reaches your loan team directly.',
    replyable: true,
    replyMarker: quote.replyMarker('and it reaches your loan team'),
    audience: 'borrower',
  });
  return built;
}

module.exports = {
  LINK_TTL_DAYS,
  mintLink, linkByToken, linkById,
  mintGuestToken, readGuest, allowedRequest,
  registerJail, rulesFor, guestFromLink, linkMatchesGuest,
  guestUrl, buildOutstandingEmail,
  _internals: { RULES },
};
