'use strict';
/**
 * src/lib/elementix/crm-tools.js — the CRM plane's door to Elementix.
 *
 * ── WHY THIS IS NOT IN lookups.js ──────────────────────────────────────────
 * `lookups.js` is the UNDERWRITING plane: it proves a borrower's track record
 * from recorded deeds and mortgages, and its whole design assumes the answer
 * may end up in a lending decision. `docs/research/elementix/04-connector-verification.md`
 * draws the line in as many words — "a contact detail may not appear in an
 * underwriting decision, which is the FCRA plane separation the blueprint
 * already draws" — and `submit_contact_enrichment` is permanently absent from
 * that module because of it.
 *
 * The CRM plane is the other side of that line: an officer looking somebody up
 * to telephone them about a loan. That is marketing, and buying a phone number
 * for it is legitimate. Rather than widen the underwriting module's allowlist
 * (which would put the paid tool one typo away from a verification sweep), this
 * is a SECOND door with its own closed set. `lookups.js` is not modified by the
 * CRM work at all, so the separation is structural rather than a convention
 * somebody has to remember.
 *
 * WHAT IS SHARED: the transport (`elementix/client.js`, which owns the rate
 * bucket, the money cap, the ledger and the never-throws contract) and the
 * request PREFLIGHT (`lookups._internals.contractProblem`, which reads the same
 * transcribed schemas). Sharing the preflight is deliberate — a malformed
 * request is answered with a raw -32602 AND still spends a slot of the office's
 * shared 1,000/hour, so both planes must refuse the same malformed call.
 */

const client = require('../../elementix/client');
const lookups = require('./lookups');
const fields = require('../fields');

const { contractProblem, isUuid, stateCode } = lookups._internals;

/**
 * THE CRM PLANE'S CLOSED SET. A tool not named here cannot be called from the
 * CRM. Adding one is a reviewed act: confirm whether it is free first, and if it
 * is not, add it to PAID below as well.
 *
 * Every name here is from the account's own published catalogue of 40 tools.
 */
const TOOLS = new Set([
  // Identity of the connected login — how an officer's own Elementix seat is
  // recognised. See identity.js.
  'welcome',

  // Finding a person at all.
  'search', 'match_person',

  // The person profile, tab by tab. These are the Elementix person page's own
  // sections, which is what the profile screen reproduces.
  'get_person',
  'get_person_entities',
  'get_person_properties',
  'get_person_mortgages',
  'get_person_deeds',
  'get_person_associated_people',
  'get_person_cross_state',
  'get_person_lender_network',

  // Drill-ins from a profile row.
  'get_address', 'get_address_ownership', 'get_address_transactions',
  'get_entity_deeds', 'get_entity_mortgages', 'get_entity_related_addresses',

  // Foreclosures and the wider transaction feed.
  'list_transactions',

  // Filter vocabularies, so a filter offers real values instead of guesses.
  'get_filter_options',

  // Contact. `get_contact_status` is the FREE gate; `get_contact_info` is FREE
  // for somebody already unlocked; `submit_contact_enrichment` SPENDS A CREDIT
  // and is the only paid tool in PILOT.
  'get_contact_status', 'get_contact_info', 'submit_contact_enrichment',

  // WHO UNLOCKED WHAT. `list_people` with unlockStatus:'unlocked' is the only
  // way to enumerate the contacts this organisation has paid for, and every row
  // names the person who did it. FREE. It is the whole historical backfill, and
  // the reason the CRM does not need a separate OAuth seat per officer.
  'list_people',
]);

/** Tools that cost money. Mirrors client.PAID_TOOLS; kept here so this module
 *  can refuse before the wire rather than relying on the transport to do it. */
const PAID = new Set(['submit_contact_enrichment']);

/**
 * Tools whose RESPONSE shape has never been observed.
 *
 * Their REQUEST shape is no longer in question: every tool this plane can call
 * was transcribed from the live connector's own schema on 2026-08-18, so a
 * request our code shapes wrongly is refused here for free. What can still be
 * wrong is how we read what comes BACK — which envelope the rows sit in — and
 * that is not a theoretical worry: `get_person_lender_network` returns its rows
 * under `lenderConnections`, a key `rowsOf` does not know, so before its
 * response was captured this plane would have read seventy lenders as zero.
 *
 * So a result from one of these carries `unverified: true`, whether it
 * succeeded or not, and a screen must never render one as a confident zero: a
 * shape we have not seen, answering nothing, is not evidence that the person
 * has nothing. The four person tools left this set on 2026-08-18 when their
 * real responses were captured into scripts/fixtures/elementix-shapes.json —
 * which is the way out of it: call the tool, record the response, remove it.
 */
const UNVERIFIED_SHAPE = new Set(['welcome', 'list_transactions', 'get_filter_options']);

/**
 * PARAMETERS THIS PLANE MAY NEVER SEND — a compliance refusal, not a preference.
 *
 * `list_people` (and its lender/entity siblings) offer filters the vendor
 * describes as "inferred gender based on first name" and "surname is likely
 * Hispanic/Spanish". Narrowing a marketing list by an inferred protected
 * characteristic is exactly the conduct ECOA and the Fair Housing Act exist to
 * prohibit, and PILOT is a lender: the fact that a vendor offers a filter is not
 * a reason for us to have a code path that can send it.
 *
 * Refused HERE rather than merely "not used", because "we don't use it" is a
 * property of today's callers and this is a property of the door. It fails the
 * request outright rather than dropping the argument silently — a filter
 * quietly removed would make a screen show results that do not match what it
 * asked for, which is its own kind of wrong.
 */
const FORBIDDEN_ARGS = new Set(['gender', 'hasHispanicName']);

/**
 * A VENDOR PAYLOAD ON ITS WAY INTO A `jsonb` COLUMN. Everything this plane
 * stores from Elementix goes through here.
 *
 * TWO THINGS GO WRONG WITHOUT IT, and both fail AFTER the money is spent:
 *
 *  · A NUL BYTE. Postgres refuses U+0000 anywhere in jsonb (22P05). The
 *    `nul-strip` middleware scrubs REQUEST bodies, and it never sees this — a
 *    vendor response arrives over `fetch`, not through express.json. So the
 *    strip is `fields.jsonbText`, which removes NULs from the OBJECT (keys and
 *    values, at any depth) and never from the serialized string: the obvious
 *    `JSON.stringify(x).replace(/\u0000/g,'')` eats a backslash out of text that
 *    merely SPELLS the escape and produces malformed JSON.
 *
 *  · SIZE. A lender-network row carries an 8–12 KB base64 logo, and a big
 *    profile section can run to megabytes. Capping by SLICING THE SERIALIZED
 *    STRING — which is what this code used to do — produces a truncated
 *    document Postgres rejects outright (22P02), so an over-large payload took
 *    the whole write down instead of being trimmed. A payload over the ceiling
 *    is therefore REPLACED by a shaped marker that says so in the row itself,
 *    rather than half-written or silently dropped.
 *
 * Never throws: a payload that cannot be serialized at all (a cycle) becomes the
 * same marker. Returns a STRING ready to bind to a `$n::jsonb` placeholder.
 *
 * NOTE for a future caller: a null/undefined value serializes to `{}`, which is
 * right for the OBJECT payloads this stores today (a vendor response, a profile
 * section) and wrong for a column somebody reads with `jsonb_array_length`.
 * Pass `[]` rather than nothing for an array column — `normalizeContact`
 * guarantees its three arrays, which is why storeContact can bind them directly.
 */
const JSONB_MAX = 400000;
function vendorJsonb(v, max = JSONB_MAX) {
  let out;
  try { out = fields.jsonbText(v == null ? {} : v); }
  catch (_) { return JSON.stringify({ _dropped: 'unserializable', _note: 'Elementix sent something PILOT could not store.' }); }
  if (out.length <= max) return out;
  return JSON.stringify({
    _dropped: 'too_large', _bytes: out.length, _limit: max,
    _note: 'Elementix sent more than PILOT stores for one record. The counts and the rows on screen are unaffected; only this raw copy was left out.',
  });
}

const str = (v) => String(v == null ? '' : v).trim();

/**
 * Call a CRM-plane tool. NEVER THROWS — the transport already guarantees that,
 * and every refusal added here is a shaped object too, so a CRM screen degrades
 * to a sentence instead of a 500.
 *
 * `opts.staffId` is REQUIRED and is not decoration: Elementix sees one account
 * per connected login, so without it the call ledger cannot answer "who used the
 * allowance", and — for a per-officer connection — `client` cannot pick the
 * right token. A call with no officer behind it has no business on this plane.
 */
async function call(tool, args = {}, opts = {}) {
  const name = str(tool);
  if (!TOOLS.has(name)) {
    return { ok: false, reason: 'not_allowed',
      detail: `${name || 'that lookup'} is not available to the CRM.` };
  }
  if (!opts.staffId) {
    return { ok: false, reason: 'no_actor',
      detail: 'An Elementix lookup has to be made by a signed-in member of staff.' };
  }
  if (PAID.has(name) && !opts.paidActor) {
    return { ok: false, reason: 'paid_tool_refused',
      detail: 'Looking up somebody\'s contact details spends a credit, so it only runs from a deliberate click.' };
  }

  for (const k of Object.keys(args || {})) {
    if (FORBIDDEN_ARGS.has(k)) {
      return { ok: false, reason: 'not_allowed',
        detail: `PILOT never filters people by ${k === 'gender' ? 'gender' : 'the likely origin of a surname'} — that is a protected characteristic and a lender may not select on it.` };
    }
  }

  // Preflight against the transcribed schema where we have one. A refusal here
  // spends nothing; the vendor's own validation error would spend a slot.
  const problem = contractProblem(name, args);
  if (problem) return { ok: false, reason: 'bad_args', detail: problem };

  const out = await client.callTool(name, args || {}, opts);

  /* A DRY RUN IS NOT AN ANSWER — the same rule lookups.js adopted after the
     owner was told "the county does not publish online" about a search that
     never left the building. The client answers a dry run `{ok:true,
     data:null}`, and on THIS plane that is worse than a wrong county: `rowsOf`
     reads it as "nobody by that name", a profile section caches as a confident
     empty for a day, and — because `crm.skipTrace` treats an ok from the paid
     tool as proof the unlock happened — an officer is told their contact is on
     its way while nothing was sent. A dry run is a refusal with a reason. */
  if (out && out.dryRun) {   // the transport already refuses; this keeps the door's own wording
    return { ok: false, reason: 'dry_run',
      detail: 'Dry-run mode is ON, so this was logged but never sent to Elementix. Turn dry-run off on the API Health page.' };
  }

  // Marked on SUCCESS too, not only on failure. A refusal is already legible
  // (`ok:false` plus a reason); the subtler danger is a success we PARSE to
  // zero rows because the vendor wrapped them in an envelope we have never
  // seen. Both are "we cannot vouch for this section", and only the screen
  // knows whether that is worth saying out loud.
  if (out && UNVERIFIED_SHAPE.has(name)) return { ...out, unverified: true };
  return out;
}

/**
 * Rows out of whatever envelope the vendor used. Delegates to `lookups.rowsOf`
 * — that function already carries the hard-won cases (the singular `match`
 * object, the envelope-inside-an-envelope `{x:{data}}` shape), and a second
 * copy here is exactly how two readers of one vendor drift apart.
 */
const rowsOf = (d) => lookups.rowsOf(d);

/**
 * The total the vendor reports for a paged list, when it reports one. Used to
 * tell "showing the first 50 of 349" from "there are 50". Returns null rather
 * than guessing, so a screen with no total says nothing instead of implying the
 * page IS the total.
 */
function totalOf(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  for (const k of ['total', 'totalCount', 'total_count', 'count', 'totalResults']) {
    const n = Number(d[k]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const meta = d.meta || d.pagination || d.page;
  if (meta && typeof meta === 'object') {
    for (const k of ['total', 'totalCount', 'total_count', 'count']) {
      const n = Number(meta[k]);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

module.exports = { call, rowsOf, totalOf, vendorJsonb, TOOLS, PAID, UNVERIFIED_SHAPE, FORBIDDEN_ARGS,
  _internals: { isUuid, stateCode, JSONB_MAX } };
