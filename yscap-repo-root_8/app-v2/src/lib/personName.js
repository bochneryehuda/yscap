/**
 * PERSON NAME — the browser half of src/lib/person-name.js.
 *
 * THE ONE BIG NAME FIELD (owner-directed 2026-07-27). A borrower's name is stored
 * as four columns — first / middle / last / suffix (db/343) — but every screen,
 * email, term sheet and ClickUp card shows THE WHOLE NAME, and `borrowers.full_name`
 * (db/344, a Postgres generated column) is that whole name. So:
 *
 *   • `fullNameOf(row)` is what a screen renders. It prefers `full_name` and falls
 *     back to joining the parts, which means a response that has not (yet) been
 *     updated to select `full_name` renders exactly as it did before — nothing
 *     breaks anywhere while the columns roll out.
 *   • `splitName(text)` turns a name typed into the ONE big box into the parts, so
 *     the two stay in step as you type.
 *   • `rejoin(form)` does the reverse — typing in a part rebuilds the big box.
 *
 * The SPLIT RULES are a deliberately small mirror of the server's splitter (which
 * is the authority — the server re-splits whatever it is sent). This copy exists
 * only so the boxes update live while someone types; it never decides what is
 * stored. Keep the two in the same spirit: two words split in half, a suffix comes
 * out of the last name, a lowercase particle ("van", "de la") belongs to the
 * surname, and a courtesy title is dropped.
 */

const SUFFIXES = {
  jr: 'Jr.', jnr: 'Jr.', sr: 'Sr.', snr: 'Sr.',
  ii: 'II', iii: 'III', iv: 'IV', vi: 'VI', vii: 'VII', viii: 'VIII', ix: 'IX',
  '2nd': 'II', '3rd': 'III', '4th': 'IV',
  esq: 'Esq.', md: 'MD', phd: 'PhD', dds: 'DDS', dvm: 'DVM', cpa: 'CPA', jd: 'JD', rn: 'RN', do: 'DO',
};
const TITLES = new Set(['mr', 'mrs', 'ms', 'mx', 'miss', 'dr', 'doctor', 'prof', 'professor',
  'rabbi', 'rav', 'rebbetzin', 'rev', 'reverend', 'father', 'pastor', 'sir', 'dame', 'hon', 'honorable', 'judge', 'atty']);
const STRONG_PARTICLES = new Set(['van', 'von', 'vander', 'vanden', 'della', 'delle', 'dello',
  'degli', 'dos', 'das', 'du', 'ter', 'ten', 'zu', 'af', 'op']);
const WEAK_PARTICLES = new Set(['de', 'del', 'di', 'da', 'la', 'le', 'el', 'al', 'bin', 'ibn', 'ben',
  'abu', 'san', 'santa', 'st', 'ste', 'y', 'e']);
const PLACEHOLDERS = new Set(['', 'unknown', 'co-borrower', 'coborrower', 'n/a', 'na', 'tbd', 'none', '-', '--', 'unknown unknown']);

const squish = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const key = (v) => squish(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const isPlaceholder = (v) => PLACEHOLDERS.has(squish(v).toLowerCase());
const isParticle = (t) => STRONG_PARTICLES.has(key(t)) || (WEAK_PARTICLES.has(key(t)) && squish(t) === squish(t).toLowerCase());

/** Join four parts into the one line a screen shows. */
export function joinName(p) {
  if (!p) return '';
  const core = [p.firstName ?? p.first_name, p.middleName ?? p.middle_name, p.lastName ?? p.last_name]
    .map(squish).filter((x) => x && !isPlaceholder(x)).join(' ');
  const sfx = squish(p.nameSuffix ?? p.name_suffix);
  if (!core) return '';
  return sfx && !isPlaceholder(sfx) ? `${core} ${sfx}` : core;
}

/**
 * THE display name for any row we hold — a borrower row, a file row, a lead.
 * `prefix` reads a co-borrower off a file row: fullNameOf(app, 'co_').
 */
export function fullNameOf(row, prefix) {
  if (!row || typeof row !== 'object') return '';
  const p = prefix || '';
  const get = (snake) => {
    const v = row[p + snake];
    return v == null ? '' : String(v);
  };
  const full = get('full_name');
  if (squish(full) && !isPlaceholder(full)) return squish(full);
  return joinName({
    first_name: get('first_name'), middle_name: get('middle_name'),
    last_name: get('last_name'), name_suffix: get('name_suffix'),
  });
}

/** Split a name typed into the ONE big box into the four form fields. */
export function splitName(text) {
  const s = squish(text);
  const blank = { firstName: '', middleName: '', lastName: '', nameSuffix: '' };
  if (!s || isPlaceholder(s)) return blank;

  let tokens = s.split(' ');
  let suffix = '';
  while (tokens.length > 1 && TITLES.has(key(tokens[0]))) tokens.shift();
  const tail = [];
  while (tokens.length > 2 && SUFFIXES[key(tokens[tokens.length - 1])]) tail.unshift(SUFFIXES[key(tokens.pop())]);
  if (tail.length) suffix = tail.join(' ');

  if (!tokens.length) return { ...blank, nameSuffix: suffix };
  if (tokens.length === 1) return { firstName: tokens[0], middleName: '', lastName: '', nameSuffix: suffix };
  if (tokens.length === 2) return { firstName: tokens[0], middleName: '', lastName: tokens[1], nameSuffix: suffix };

  let start = tokens.length - 1;
  while (start - 1 >= 1 && isParticle(tokens[start - 1])) start -= 1;
  return {
    firstName: tokens[0],
    middleName: tokens.slice(1, start).join(' '),
    lastName: tokens.slice(start).join(' '),
    nameSuffix: suffix,
  };
}

/** Typing in a PART rebuilds the one big box, so the two never disagree. */
export function rejoin(form) {
  return { ...form, fullName: joinName(form) };
}

/** Did the name actually change? Used to avoid a pointless write + ClickUp push. */
export function nameChanged(form, row) {
  if (!form || !row) return false;
  return squish(form.firstName) !== squish(row.first_name || '')
    || squish(form.middleName) !== squish(row.middle_name || '')
    || squish(form.lastName) !== squish(row.last_name || '')
    || squish(form.nameSuffix) !== squish(row.name_suffix || '');
}

export default { fullNameOf, joinName, splitName, rejoin, nameChanged };
