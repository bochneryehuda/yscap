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

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[.,'’"()‘’“”]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const nameTokens = (s) => norm(s).split(' ').filter(Boolean);

// Address → { num, street[] } core. Returns null when there is no leading house
// number (which is what keeps stage/category folders out of address matching).
function addressCore(s) {
  let toks = norm(s).replace(/#/g, ' # ').split(' ').filter(Boolean);
  if (!toks.length || !/^\d+[a-z]?$/.test(toks[0])) return null;
  const num = toks[0];
  toks = toks.slice(1);
  const street = [];
  for (const t of toks) {
    if (t === '#' || UNIT_MARKERS.has(t)) break;           // unit/apt tail starts
    const mapped = SUFFIX[t] || DIRECTION[t] || t;
    street.push(mapped);
  }
  // Drop pure-noise trailing tokens: zip, state abbrev, USA.
  while (street.length) {
    const last = street[street.length - 1];
    if (/^\d{5}(-\d{4})?$/.test(last) || STATE_ABBR.has(last) || NOISE_TAIL.has(last)) street.pop();
    else break;
  }
  return street.length ? { num, street } : null;
}

// Does candidate address folder match the target address? House number must be
// identical; then the shorter street-token list must be a prefix of the longer
// (tolerates a city/state tail on either side after noise-stripping).
function addressMatches(candidate, target) {
  const c = addressCore(candidate), t = addressCore(target);
  if (!c || !t || c.num !== t.num) return false;
  const [short, long] = c.street.length <= t.street.length ? [c.street, t.street] : [t.street, c.street];
  if (!short.length) return false;
  for (let i = 0; i < short.length; i++) if (short[i] !== long[i]) return false;
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

// Pick the single best match; exact normalized equality wins ties. Returns
// { hit, ambiguous } — ambiguity is recorded for manual review, first hit used.
function pickMatch(candidates, matchFn, exactName) {
  const hits = candidates.filter((c) => c.isFolder && matchFn(c.name));
  if (!hits.length) return { hit: null, ambiguous: false };
  if (hits.length === 1) return { hit: hits[0], ambiguous: false };
  const exact = hits.find((h) => norm(h.name) === norm(exactName));
  return { hit: exact || hits[0], ambiguous: !exact };
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
  if (cached) {
    const out = { driveId, syncFolderId: cached.sync_folder_id, webUrl: cached.web_url, fullPath: cached.full_path, details: cached.details };
    _memCache.set(ctx.scopeKey, out);
    return out;
  }

  const details = { matches: {}, created: [], flags: [] };
  const pathParts = [cfg.sharepointPipelineRoot];
  let parentId = rootId;

  const borrowerName = [ctx.borrowerFirst, ctx.borrowerLast].filter(Boolean).join(' ').trim() || 'Unknown Borrower';

  if (!ctx.officerName) {
    // No officer at all → clearly-labeled unfiled area, never guessing.
    const unfiled = await sp.ensureChildFolder(driveId, parentId, cfg.sharepointUnfiledRoot);
    parentId = unfiled.id; pathParts.push(cfg.sharepointUnfiledRoot);
    details.flags.push('no-officer:unfiled');
    const bf = await sp.ensureChildFolder(driveId, parentId, borrowerName);
    parentId = bf.id; pathParts.push(borrowerName);
    if (bf.created) details.created.push('borrower');
  } else {
    // 1) Officer folder (fuzzy; created if genuinely missing).
    const officers = await sp.listChildren(driveId, parentId);
    const om = pickMatch(officers, (n) => officerMatches(n, ctx.officerName), ctx.officerName);
    let officerFolder = om.hit;
    if (om.ambiguous) details.flags.push('officer-ambiguous');
    if (!officerFolder) {
      officerFolder = await sp.ensureChildFolder(driveId, parentId, ctx.officerName);
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
      borrowerFolder = await sp.ensureChildFolder(driveId, parentId, borrowerName);
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
        addressFolder = await sp.ensureChildFolder(driveId, parentId, addressName);
        details.created.push('address');
      }
      details.matches.address = addressFolder.name;
      parentId = addressFolder.id; pathParts.push(addressFolder.name);
    }
  }

  // 4) The portal-owned sync folder. Everything the mirror writes lives inside
  //    here — the only place it ever writes files.
  const sync = await sp.ensureChildFolder(driveId, parentId, cfg.sharepointSyncFolderName);
  pathParts.push(cfg.sharepointSyncFolderName);
  const fullPath = pathParts.join('/');

  await db.query(
    `INSERT INTO sharepoint_folder_cache (scope_key, sync_folder_id, web_url, full_path, details)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (scope_key) DO UPDATE SET sync_folder_id=EXCLUDED.sync_folder_id,
       web_url=EXCLUDED.web_url, full_path=EXCLUDED.full_path, details=EXCLUDED.details, resolved_at=now()`,
    [ctx.scopeKey, sync.id, sync.webUrl || null, fullPath, JSON.stringify(details)]);

  const out = { driveId, syncFolderId: sync.id, webUrl: sync.webUrl, fullPath, details };
  _memCache.set(ctx.scopeKey, out);
  return out;
}

// Find-or-create a condition/category folder inside a sync folder.
async function resolveConditionFolder(driveId, syncFolderId, name) {
  const key = `${syncFolderId}:${norm(name)}`;
  if (_conditionFolderCache.has(key)) return _conditionFolderCache.get(key);
  const folder = await sp.ensureChildFolder(driveId, syncFolderId, name);
  const out = { id: folder.id, webUrl: folder.webUrl, name: folder.name };
  _conditionFolderCache.set(key, out);
  return out;
}

// Testing/maintenance: clear in-memory caches (DB cache remains).
function _resetMemory() { _pipelineRoot = null; _memCache.clear(); _conditionFolderCache.clear(); }

module.exports = {
  resolveSyncFolder,
  resolveConditionFolder,
  pipelineRoot,
  // exported for unit tests
  addressCore, addressMatches, borrowerMatches, officerMatches, norm,
  _resetMemory,
};
