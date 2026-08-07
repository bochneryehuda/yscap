/* WHO IS DRIVING THIS TOOL — the ONE way the portal tells an embedded static tool
 * which staff member it is working for.
 *
 * Owner-reported 2026-08-07: "I generated a term sheet and sent it to the lead
 * through Pilot and lead got it with Shia Kaff's name on it. One of our staff members
 * generated the term sheet in their staff portal from this 'Generate Term Sheet', and
 * they delivered it to a borrower by email. It looks like it used the automatic queue
 * system and was assigned to another officer. Maybe because the term sheet generator
 * within the officer's portals is not using anything unique to the loan officer…
 * We need to make sure that if somebody is doing something from his login, it should
 * always stay with his information, his name."
 *
 * ROOT CAUSE. The tools inside PILOT are the SAME static pages the marketing site
 * serves (`/tools/*.html`), and every one of them reads the officer it is working for
 * from `window.YSBRAND` — which `web/v2/brand.js` fills from the `?lo=` link
 * parameter, because on the marketing site the branded link IS the only signal there
 * is. The portal mounted them with no officer at all, so:
 *   · `window.YSBRAND` was null,
 *   · every lead the tool posted carried NO `officerCode`, and
 *   · `POST /api/leads` did exactly what it is built to do with an unowned marketing
 *     lead — handed it to the next loan officer in the round-robin rotation (db/468).
 * Nothing errored. The staffer's own work simply arrived in a stranger's book, and
 * the term sheet they delivered carried that stranger's name.
 *
 * THE CLASS: a tool that identifies its operator from a URL parameter is UNIDENTIFIED
 * anywhere that parameter is not set — and every consumer downstream reads that
 * absence as "anonymous", never as "nobody told me".
 *
 * WHY NOT JUST APPEND `?lo=<code>`. That is how the marketing site does it, and it
 * would look like the smaller change — but `brand.js` resolves a code against a
 * HAND-MAINTAINED roster baked into that file, so a staff member who is not in that
 * list (a new hire, anyone outside the sales grid) would resolve to null and land
 * straight back in the rotation. This reads the person's REAL `staff_users` row
 * instead, through `/api/roster`, so it is right for every active staff member and
 * stays right when somebody joins.
 *
 * NEVER GUESSES. If the identity cannot be established the tool is left exactly as it
 * was — no `window.YSBRAND` — so it behaves as it does today rather than being stamped
 * with a wrong name. The server-side half of the rule (src/routes/leads.js) is what
 * makes that safe: a submission declaring a staff-portal origin is never
 * round-robined, so an unresolved identity falls to the sales desk, which a human
 * works, never to an officer who had nothing to do with it.
 */
import { api } from './api.js';

/* One in-flight fetch shared by every caller, and the answer cached for the session.
   The Investor Suite and a file's Products & Pricing panel both stamp their frames,
   and a staffer opens several tools in a session — the roster must not be re-fetched
   each time. Cached on the module, so it resets on a real page load (which is also
   when a sign-out happens). */
let _pending = null;
let _cached;   // undefined = not looked up yet; null = looked up and unknown

/**
 * The signed-in staff member in the shape the static tools expect on
 * `window.YSBRAND` — `{code, name, role, title, email, phone, cell, direct, ext, nmls}`.
 * `code` is the email local-part, which is the key `POST /api/leads` resolves an
 * officer by, so it must be present for the attribution to work.
 *
 * @returns {Promise<object|null>} null when it cannot be established — the caller
 *          must then leave the tool alone rather than stamp a guess.
 */
export function currentToolOfficer() {
  if (_cached !== undefined) return Promise.resolve(_cached);
  if (_pending) return _pending;
  _pending = (async () => {
    try {
      const me = await api.me();
      // A BORROWER (or a staffer inside a borrower view, whose session IS the
      // borrower) is not an officer and must never be stamped as one.
      if (!me || me.kind !== 'staff' || !me.email) return null;
      const wanted = String(me.email).trim().toLowerCase();
      const code = wanted.split('@')[0];
      // The roster carries the contact details the term sheet actually prints —
      // title, direct line, cell, extension and the individual NMLS for a licensed
      // MLO. Best-effort: without it we still have a name, an email and a code,
      // which is everything the ATTRIBUTION needs.
      let row = null;
      try {
        const r = await api.roster();
        const people = (r && (Array.isArray(r.people) ? r.people : [])) || [];
        row = people.find((p) => p && String(p.email || '').trim().toLowerCase() === wanted) || null;
      } catch (_) { /* the roster is a nicety; identity is not */ }
      return {
        code,
        name: (row && row.name) || me.full_name || null,
        role: (row && row.role) || me.role || null,
        title: (row && row.title) || null,
        email: me.email,
        phone: (row && row.phone) || null,
        // `direct` is what the tools' contact block reads; the roster calls it `phone`.
        direct: (row && row.phone) || null,
        cell: (row && row.cell) || null,
        ext: (row && row.ext) || null,
        nmls: (row && row.nmls) || null,
      };
    } catch (_) {
      return null;
    }
  })().then((v) => { _cached = v; _pending = null; return v; });
  return _pending;
}

/**
 * Stamp the signed-in staff member onto an embedded tool's window.
 *
 * `window.YSBRAND` is read at CLICK time by every tool that posts a lead or prints a
 * contact block, so stamping it after the frame has booted is in time — the frame's
 * own `brand.js` has by then set it to null, and this replaces that null.
 *
 * `YS_FROM_STAFF_PORTAL` is the companion flag the tools send as `fromStaffPortal`,
 * which is what tells the server "this is somebody's own work" so it is never
 * round-robined. It is set even when the officer could not be resolved — that case is
 * PRECISELY when the rotation must stay out of the way.
 *
 * Never throws: a cross-origin or torn-down frame is a no-op, and a failure here must
 * never stop a tool from loading.
 *
 * `keepExisting` is for a surface that has ALREADY stamped a more specific officer —
 * a file's Products & Pricing panel stamps the FILE'S ASSIGNED loan officer, and that
 * must win: the term sheet belongs to the file, not to whoever happened to open it.
 * The origin flag is still declared, because the work is still being done from a staff
 * login. Only the identity is left alone.
 *
 * @param {Window} win the embedded tool's window
 * @param {{keepExisting?: boolean}} [opts]
 * @returns {Promise<object|null>} the officer that was stamped, or null
 */
export async function stampToolOfficer(win, opts) {
  try { if (!win) return null; } catch (_) { return null; }
  // Declare the origin FIRST and unconditionally — it is the safety half, and it must
  // hold even if the identity lookup below fails, is slow, or is deliberately skipped.
  try { win.YS_FROM_STAFF_PORTAL = true; } catch (_) { return null; }
  if (opts && opts.keepExisting) return null;
  const officer = await currentToolOfficer();
  if (!officer) return null;
  // A late resolve must not overwrite an officer the host stamped in the meantime.
  try { if (win.YSBRAND && win.YSBRAND.name) return null; } catch (_) { return null; }
  try {
    win.YSBRAND = officer;
    // The tools' own helper object exposes `current()`; keep the two in step so a
    // tool reading either one sees the same person.
    if (win.YSBrand && typeof win.YSBrand === 'object') {
      win.YSBrand.current = () => officer;
    }
  } catch (_) { /* frame gone — nothing to stamp */ }
  return officer;
}

/** Test seam: forget the cached identity (a sign-out inside one page load). */
export function _resetToolOfficerCache() { _cached = undefined; _pending = null; }
