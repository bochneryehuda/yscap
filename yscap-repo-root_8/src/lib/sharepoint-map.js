/**
 * Folder resolution for the Pipeline Drive mirror — the "linking logic"
 * (owner-directed, 2026-07-13).
 *
 * Resolves (creating only what's missing, never renaming/moving what exists):
 *   Pipeline Drive / <Officer> / <Borrower> / <Address> / YS portal syncing
 *
 * Fuzzy matching rules (owner-approved):
 *  • Borrower: an existing folder matches on the exact normalized full name OR
 *    when its first and last tokens equal the borrower's first/last name
 *    (middle names/initials ignored, on either side). Never substring matches —
 *    "Moshe Katz" must not link to "Moshe Katzman".
 *  • Address: an existing folder matches when the HOUSE NUMBER is identical and
 *    the street tokens agree after suffix/directional normalization
 *    ("St"≡"Street", "Pl"≡"Place", "N"≡"North"…), tolerating a missing/extra
 *    city+state+zip+"USA" tail on either side. The house-number requirement
 *    guarantees a stage folder ("Open loan", "closed") can never match.
 *  • Anything that can't be matched confidently → CREATE a new exact-named
 *    folder (never guess into someone else's), and record the decision in the
 *    cache `details` for manual review.
 *
 * Reads only folder NAMES from SharePoint (matching); documents flow one-way
 * portal → SharePoint. Resolution results are cached in sharepoint_folder_cache.
 */
const cfg = require('../config');
const db = require('../db');
const sp = require('./sharepoint');

// ---------------------------------------------------------------- normalizers
const SUFFIX = {
  st: 'street', str: 'street', street: 'street',
  ave: 'avenue', av: 'avenue', avenue: 'avenue',
  rd: 'road', road: 'road',
  pl: 'place', place: 'place',
  dr: 'drive', drv: 'drive', drive: 'drive',
  ln: 'lane', lane: 'lane',
  ct: 'court', court: 'court',
  blvd: 'boulevard', boulevard: 'boulevard',
  ter: 'terrace', terr: 'terrace', terrace: 'terrace',
  cir: 'circle', circle: 'circle',
  hwy: 'highway', highway: 'highway',
  pkwy: 'parkway', parkway: 'parkway',
  sq: 'square', square: 'square',
  trl: 'trail', trail: 'trail',
  way: 'way', wy: 'way',
};
const DIRECTION = { n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest' };
const STATE_ABBR = new Set(['al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc']);
const NOISE_TAIL = new Set(['usa', 'us', 'unitedstates', 'america']);
const UNIT_MARKERS = new Set(['apt', 'apartment', 'unit', 'ste', 'suite', 'fl', 'floor', 'rm', 'room', 'bsmt', 'basement']);

// Auto-created folders carry this marker (owner-directed 2026-07-13): every
// folder the AUTOMATION creates at the officer/borrower/address level is named
// "<name>, YS portal sync" so staff can always tell API-created folders from
// human-created ones. Matched (pre-existing) folders are never renamed. The
// marker is stripped during matching so a previously-created folder still
// matches its borrower/address next time.
// PILOT branding (owner-directed 2026-07-14): auto-created folders are now
// marked "…, Synced by Pilot". The matcher MUST keep recognizing the LEGACY
// "YS portal sync[ing]" names forever — existing folders are never renamed
// (hard no-rename policy) and must still match so we never duplicate/strand
// them. norm() therefore strips BOTH the new and the legacy phrasing.
const AUTO_MARKER = ', Synced by Pilot';

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/\bys portal sync(ing)?\b/g, ' ')     // LEGACY marker/leaf — keep forever
  .replace(/\bsynced by pilot\b/g, ' ')          // new marker
  .replace(/\bpilot sync(ing)?\b/g, ' ')         // new leaf / short alt
  .replace(/[.,'’"()‘’“”]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const nameTokens = (s) => norm(s).split(' ').filter(Boolean);

// Address → { num, street[], unit } core, computed from the PRE-COMMA segment
// only (the street portion — everything after the first comma is city/state/
// zip tail and is ignorable; the auto-created ", YS portal sync" marker lands
// after a comma too, so it is structurally ignorable). Returns null when there
// is no leading house number (which is what keeps stage/category folders out
// of address matching). `unit` captures the first token after an apt/unit/
// #-marker so two different units never collapse into one folder.
function addressCore(s) {
  const streetPart = String(s || '').split(',')[0];   // comma captured BEFORE norm strips it
  let toks = norm(streetPart).replace(/#/g, ' # ').split(' ').filter(Boolean);
  if (!toks.length || !/^\d+[a-z]?$/.test(toks[0])) return null;
  const num = toks[0];
  toks = toks.slice(1);
  const street = [];
  let unit = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '#' || UNIT_MARKERS.has(t)) { unit = toks[i + 1] || null; break; }  // unit/apt tail
    const mapped = SUFFIX[t] || DIRECTION[t] || t;
    street.push(mapped);
  }
  // Comma-less strings may still carry a state/zip/USA tail — strip that noise.
  while (street.length) {
    const last = street[street.length - 1];
    if (/^\d{5}(-\d{4})?$/.test(last) || STATE_ABBR.has(last) || NOISE_TAIL.has(last)) street.pop();
    else break;
  }
  return street.length ? { num, street, unit } : null;
}

// Does candidate address folder match the target address? House number must be
// identical and the (suffix/directional-normalized) pre-comma street tokens
// must be EXACTLY equal — "654 Hamilton st" ≡ "654 Hamilton Street, Newark NJ",
// but "45 Oak Street Extension" never matches "45 Oak St" (different street),
// and a comma-less folder that embeds an unknown city falls through to the
// safe create-new-folder path rather than guessing. When BOTH sides carry a
// unit/apt number, the units must be identical too.
function addressMatches(candidate, target) {
  const c = addressCore(candidate), t = addressCore(target);
  if (!c || !t || c.num !== t.num) return false;
  if (c.unit && t.unit && c.unit !== t.unit) return false;
  if (!c.street.length || c.street.length !== t.street.length) return false;
  for (let i = 0; i < c.street.length; i++) if (c.street[i] !== t.street[i]) return false;
  return true;
}

// Does candidate folder name match borrower "<first> <last>"? Exact normalized
// match, or first/last token equality with middle tokens ignored on both sides.
function borrowerMatches(candidate, first, last) {
  const cand = nameTokens(candidate);
  const f = norm(first), l = norm(last);
  if (!cand.length || !f || !l) return false;
  const full = nameTokens(`${first} ${last}`);
  if (cand.join(' ') === full.join(' ')) return true;
  // First and last token agreement (middle names ignored either side). The
  // borrower's own first_name may carry a middle ("Moshe C") — use its first
  // token; last_name's last token likewise.
  const fTok = f.split(' ')[0];
  const lParts = l.split(' ');
  const lTok = lParts[lParts.length - 1];
  return cand.length >= 2 && cand[0] === fTok && cand[cand.length - 1] === lTok;
}

// Officer folders are person names; match exact, else first+last agreement.
function officerMatches(candidate, officerName) {
  const cand = nameTokens(candidate);
  const want = nameTokens(officerName);
  if (!cand.length || !want.length) return false;
  if (cand.join(' ') === want.join(' ')) return true;
  return cand.length >= 2 && want.length >= 2 && cand[0] === want[0] && cand[cand.length - 1] === want[want.length - 1];
}

// Pick the single best match; exact normalized equality wins ties. On a
// genuinely AMBIGUOUS fuzzy match (2+ hits, none exact) we return no hit —
// the caller then CREATES an exact-named folder rather than guessing into
// possibly the wrong person's/property's folder (owner rule: can't link
// confidently => new folder + manual review).
function pickMatch(candidates, matchFn, exactName) {
  const hits = candidates.filter((c) => c.isFolder && matchFn(c.name));
  if (!hits.length) return { hit: null, ambiguous: false };
  if (hits.length === 1) return { hit: hits[0], ambiguous: false };
  const exact = hits.find((h) => norm(h.name) === norm(exactName));
  return { hit: exact || null, ambiguous: !exact };
}

// ------------------------------------------------------------------ resolution
let _pipelineRoot = null;   // { driveId, rootId }
const _memCache = new Map(); // scope_key -> resolved target
const _conditionFolderCache = new Map(); // `${syncId}:${name}` -> {id, webUrl}

async function pipelineRoot() {
  if (_pipelineRoot) return _pipelineRoot;
  const { driveId } = await sp.resolveDrive();
  const root = await sp.itemByPath(driveId, cfg.sharepointPipelineRoot);
  _pipelineRoot = { driveId, rootId: root.id };
  return _pipelineRoot;
}

/**
 * Resolve (find-or-create) the `YS portal syncing` folder for a document scope.
 * ctx: { scopeKey, officerName, borrowerFirst, borrowerLast, addressOneLine,
 *        ysLoanNumber, hasApplication }
 * Returns { driveId, syncFolderId, webUrl, fullPath, details }.
 */
async function resolveSyncFolder(ctx) {
  if (_memCache.has(ctx.scopeKey)) return _memCache.get(ctx.scopeKey);
  const cached = (await db.query(
    'SELECT sync_folder_id, web_url, full_path, details FROM sharepoint_folder_cache WHERE scope_key=$1',
    [ctx.scopeKey])).rows[0];
  const { driveId, rootId } = await pipelineRoot();
  // Upgrade path: a scope that resolved to the Unfiled area while no officer
  // existed re-resolves once an officer is known — new docs then file into the
  // real officer tree (the old Unfiled copies stay put; we never move them).
  const wasUnfiled = cached && Array.isArray(cached.details && cached.details.flags)
    && cached.details.flags.includes('no-officer:unfiled');
  if (cached && !(wasUnfiled && ctx.officerName)) {
    const out = { driveId, syncFolderId: cached.sync_folder_id, webUrl: cached.web_url, fullPath: cached.full_path, details: cached.details };
    _memCache.set(ctx.scopeKey, out);
    return out;
  }

  const details = { matches: {}, created: [], flags: [] };
  const pathParts = [cfg.sharepointPipelineRoot];
  let parentId = rootId;

  const borrowerName = [ctx.borrowerFirst, ctx.borrowerLast].filter(Boolean).join(' ').trim() || 'Unknown Borrower';

  // Every folder the automation CREATES is named "<name>, Synced by Pilot"
  // (AUTO_MARKER) so humans can tell it apart; matched folders keep their name.
  const createMarked = async (pid, name) => sp.ensureChildFolder(driveId, pid, `${name}${AUTO_MARKER}`);

  // Alias-aware create for the fixed leaf/unfiled folders (owner-directed
  // 2026-07-14): reuse a LEGACY-named folder if one already exists under this
  // parent (so we never duplicate/strand the 15 existing "YS portal syncing"
  // leaves), and only create under the NEW Pilot name when none is present.
  // Never renames — matched legacy folders keep their old name.
  const ensureAliased = async (pid, name, legacyNames) => {
    const wanted = [name, ...(legacyNames || [])].map((n) => n.toLowerCase());
    const kids = await sp.listChildren(driveId, pid);
    const hit = kids.find((k) => k.isFolder && wanted.includes(String(k.name).toLowerCase()));
    if (hit) return { id: hit.id, name: hit.name, webUrl: hit.webUrl, created: false };
    return sp.ensureChildFolder(driveId, pid, name);
  };

  if (!ctx.officerName) {
    // No officer at all → clearly-labeled unfiled area, never guessing.
    const unfiled = await ensureAliased(parentId, cfg.sharepointUnfiledRoot, cfg.sharepointUnfiledLegacy);
    parentId = unfiled.id; pathParts.push(unfiled.name);
    details.flags.push('no-officer:unfiled');
    const bf = await createMarked(parentId, borrowerName);
    parentId = bf.id; pathParts.push(bf.name);
    if (bf.created) details.created.push('borrower');
    // Keep the address level for application scopes here too — without it, a
    // lead-capture borrower's multiple loans would commingle in one folder.
    if (ctx.hasApplication) {
      const addressName = ctx.addressOneLine || (ctx.ysLoanNumber ? `Loan ${ctx.ysLoanNumber}` : 'Property');
      const af = await createMarked(parentId, addressName);
      parentId = af.id; pathParts.push(af.name);
      if (af.created) details.created.push('address');
    }
  } else {
    // 1) Officer folder (fuzzy; created — with the marker — if genuinely missing).
    const officers = await sp.listChildren(driveId, parentId);
    const om = pickMatch(officers, (n) => officerMatches(n, ctx.officerName), ctx.officerName);
    let officerFolder = om.hit;
    if (om.ambiguous) details.flags.push('officer-ambiguous');
    if (!officerFolder) {
      officerFolder = await createMarked(parentId, ctx.officerName);
      details.created.push('officer');
    }
    details.matches.officer = officerFolder.name;
    parentId = officerFolder.id; pathParts.push(officerFolder.name);

    // 2) Borrower folder (fuzzy on first/last, middle-name tolerant).
    const borrowers = await sp.listChildren(driveId, parentId);
    const bm = pickMatch(borrowers, (n) => borrowerMatches(n, ctx.borrowerFirst, ctx.borrowerLast), borrowerName);
    let borrowerFolder = bm.hit;
    if (bm.ambiguous) details.flags.push('borrower-ambiguous');
    if (!borrowerFolder) {
      borrowerFolder = await createMarked(parentId, borrowerName);
      details.created.push('borrower');
    }
    details.matches.borrower = borrowerFolder.name;
    parentId = borrowerFolder.id; pathParts.push(borrowerFolder.name);

    // 3) Address folder — application scopes only (borrower-profile documents
    //    live directly under the borrower folder).
    if (ctx.hasApplication) {
      const addressName = ctx.addressOneLine || (ctx.ysLoanNumber ? `Loan ${ctx.ysLoanNumber}` : 'Property');
      const kids = await sp.listChildren(driveId, parentId);
      const am = ctx.addressOneLine
        ? pickMatch(kids, (n) => addressMatches(n, ctx.addressOneLine), ctx.addressOneLine)
        : { hit: null, ambiguous: false };
      let addressFolder = am.hit;
      if (am.ambiguous) details.flags.push('address-ambiguous');
      if (!addressFolder) {
        addressFolder = await createMarked(parentId, addressName);
        details.created.push('address');
      }
      details.matches.address = addressFolder.name;
      parentId = addressFolder.id; pathParts.push(addressFolder.name);
    }
  }

  // 4) The portal-owned sync folder. Everything the mirror writes lives inside
  //    here — the only place it ever writes files. Alias-aware so an existing
  //    "YS portal syncing" leaf is reused (never duplicated) while new scopes
  //    get "Synced by Pilot".
  const sync = await ensureAliased(parentId, cfg.sharepointSyncFolderName, cfg.sharepointSyncFolderLegacy);
  pathParts.push(sync.name);
  const fullPath = pathParts.join('/');

  await db.query(
    `INSERT INTO sharepoint_folder_cache (scope_key, sync_folder_id, web_url, full_path, details)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (scope_key) DO UPDATE SET sync_folder_id=EXCLUDED.sync_folder_id,
       web_url=EXCLUDED.web_url, full_path=EXCLUDED.full_path, details=EXCLUDED.details, resolved_at=now()`,
    [ctx.scopeKey, sync.id, sync.webUrl || null, fullPath, JSON.stringify(details)]);

  const out = { driveId, syncFolderId: sync.id, webUrl: sync.webUrl, fullPath, details };
  // An officer-less (Unfiled) resolution is NOT memory-cached: the in-memory
  // hit would short-circuit the Unfiled→officer upgrade above for the whole
  // process lifetime, stranding every later document in "Pilot — Unfiled"
  // after an officer is assigned. The DB-cache read (which knows how to
  // upgrade) is cheap.
  if (!details.flags.includes('no-officer:unfiled')) _memCache.set(ctx.scopeKey, out);
  // SHAREPOINT UNCERTAINTY → SYNC REVIEW (owner-directed 2026-07-15 night:
  // "when it finds something it's not sure is the correct one, it should come
  // up for manual review with options"). The resolver never guesses — an
  // ambiguous fuzzy match creates a fresh marked folder and an officer-less
  // scope files into Unfiled — but those SAFE choices were silent. Now they
  // queue a review row (deduped per scope via the synthetic sp:<scope> key,
  // dismiss sticks) telling the officer exactly where documents are filing
  // and how to fix it: merge/rename the folders IN SharePoint (the mirror
  // never moves or renames anything) and use Re-match, or dismiss to keep
  // the new folder. Auto-closes when a later resolve is fully confident.
  try {
    const uncertain = (details.flags || []).filter((f) => /ambiguous|unfiled/.test(f));
    const review = require('./sync-review');
    if (uncertain.length) {
      await review.queueReview({
        applicationId: ctx.applicationId || null, borrowerId: ctx.borrowerId || null,
        taskId: `sp:${ctx.scopeKey}`, direction: 'outbound', fieldKey: 'sharepoint_folder',
        reason: 'sharepoint_match_uncertain', suppressIfRejected: true,
        clickupValue: null, portalValue: String(fullPath).slice(0, 200),
        rawValue: JSON.stringify({ scopeKey: ctx.scopeKey, flags: uncertain, created: details.created }).slice(0, 500) });
    } else {
      await review.closeStaleReviews({ taskId: `sp:${ctx.scopeKey}`, fieldKey: 'sharepoint_folder',
        note: `auto-closed — the folder match is now confident (${String(fullPath).slice(0, 120)})` });
    }
  } catch (_) { /* visibility is best-effort — never blocks the mirror */ }
  return out;
}

// Find-or-create a condition/category folder inside a sync folder. `nameOrPath`
// may be a single name or an ARRAY of nested segments (e.g. an LLC's name with
// a document-type subfolder, or Term Sheet/Unsigned) — each level is
// find-or-create, never renamed.
async function resolveConditionFolder(driveId, syncFolderId, nameOrPath) {
  const segments = Array.isArray(nameOrPath) ? nameOrPath : [nameOrPath];
  const key = `${syncFolderId}:${segments.map(norm).join('/')}`;
  if (_conditionFolderCache.has(key)) return _conditionFolderCache.get(key);
  let parentId = syncFolderId;
  let folder = null;
  for (const seg of segments) {
    folder = await sp.ensureChildFolder(driveId, parentId, seg);
    parentId = folder.id;
  }
  const out = { id: folder.id, webUrl: folder.webUrl, name: segments.join('/') };
  _conditionFolderCache.set(key, out);
  return out;
}

// A cached folder id can go stale if a human deletes/moves the folder in
// SharePoint (their prerogative — we never re-create over their choices
// silently; we just re-resolve from scratch, which recreates only what's
// genuinely missing). Drops the scope from the DB + memory caches.
async function invalidateScope(scopeKey) {
  _memCache.delete(scopeKey);
  _conditionFolderCache.clear();          // keyed by sync folder id — cheap to rebuild
  _pipelineRoot = null;                   // heal a stale Pipeline Drive root id too
  try { await db.query('DELETE FROM sharepoint_folder_cache WHERE scope_key=$1', [scopeKey]); }
  catch (_) { /* best-effort */ }
}

// Testing/maintenance: clear in-memory caches (DB cache remains).
function _resetMemory() { _pipelineRoot = null; _memCache.clear(); _conditionFolderCache.clear(); }

module.exports = {
  resolveSyncFolder,
  resolveConditionFolder,
  pipelineRoot,
  invalidateScope,
  // exported for unit tests
  addressCore, addressMatches, borrowerMatches, officerMatches, norm,
  _resetMemory,
};
