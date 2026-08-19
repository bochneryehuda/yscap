import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { askConfirm } from '../lib/dialog.js';

/**
 * THE ELEMENTIX PROFILE — one person, every state, on a lead or a borrower.
 *
 * The owner asked for "a mega profile, even better than Elementix": the
 * overview, the entities, the properties, the mortgages, the deeds, the
 * foreclosures, all states merged, searchable and filterable, with a Run a
 * search button when nobody is linked yet and a Refresh data button when
 * somebody is.
 *
 * ── TWO RULES THIS SCREEN EXISTS TO KEEP ────────────────────────────────────
 *
 * 1. AN EMPTY TAB MUST SAY WHY IT IS EMPTY. The server answers each section
 *    with a status — read / refused / never asked for — because those are three
 *    different facts and only one of them means "this person has none". A screen
 *    that draws the same blank table for all three teaches people to trust a
 *    number that was never fetched.
 *
 * 2. THE VENDOR'S FIELD NAMES ARE NOT CONSISTENT, so `addressOf` reads several
 *    spellings. That is not defensive padding — it is measured: on 2026-08-18 a
 *    PERSON deed row carried `addresses` as plain STRINGS while an ENTITY deed
 *    row used the same key for {addressFull} OBJECTS, and a person MORTGAGE row
 *    had no `addresses` key at all, spelling it `propertyAddresses`. Reading one
 *    spelling renders a blank column or the words "[object Object]".
 *
 * ── COLOURS ─────────────────────────────────────────────────────────────────
 * Every text colour here is an explicit dark hex. The `--ink*` tokens in this
 * palette are LIGHT (paper), so `color: var(--ink)` renders white on white — the
 * bug that made a whole card invisible once already.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E4DECF';

/* The tabs, in the order the owner listed them. `key` matches the server's own
   section key, so a section added there appears here by adding one row. */
const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'entities', label: 'Entities' },
  { key: 'properties', label: 'Properties' },
  { key: 'mortgages', label: 'Mortgages' },
  { key: 'deeds', label: 'Deeds' },
  { key: 'foreclosures', label: 'Foreclosures' },
  { key: 'associated_people', label: 'Associated people' },
  { key: 'lender_network', label: 'Lenders' },
  { key: 'cross_state', label: 'Other states' },
  { key: 'transactions', label: 'All transactions' },
];

// ---------------------------------------------------------------------------
// Readers — tolerant on purpose, and never inventive
// ---------------------------------------------------------------------------

const txt = (v) => (v === null || v === undefined ? '' : String(v));

/** A number from a number OR a decimal string (the vendor sends both). */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v) {
  const n = num(v);
  if (n === null) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function count(v) {
  const n = num(v);
  // "—" NOT "0". A count we never read is not a count of none.
  return n === null ? '—' : n.toLocaleString('en-US');
}

function day(v) {
  const s = txt(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : (s || '—');
}

/** One address out of a row, whichever way this particular tool spelled it. */
function addressOf(row) {
  if (!row || typeof row !== 'object') return '';
  const buckets = [row.addresses, row.propertyAddresses, row.property_addresses];
  for (const b of buckets) {
    if (!Array.isArray(b) || !b.length) continue;
    const first = b[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object') {
      const s = txt(first.addressFull || first.address_full || first.address || first.full);
      if (s) return s;
    }
  }
  for (const k of ['addressFull', 'address_full', 'address', 'granteeAddress', 'borrowerAddress']) {
    const s = txt(row[k]);
    if (s) return s;
  }
  // Nothing spelled as an address — build one from the parts the row does carry
  // rather than showing a dash next to a row that plainly knows where it is.
  const parts = [txt(row.city), txt(row.countyState || row.state), txt(row.zipCode)].filter(Boolean);
  return parts.join(', ');
}

const names = (v) => (Array.isArray(v) ? v.filter(Boolean).map(txt).join(', ') : txt(v));

/* Every column is a function of the row, so an absent field is a dash rather
   than a crash, and a tool that renames a field degrades one cell. */
const COLUMNS = {
  entities: [
    { h: 'Entity', w: '34%', get: (r) => txt(r.name), strong: true },
    { h: 'State', get: (r) => txt(r.state) },
    { h: 'Type', get: (r) => txt(r.entityType || r.type) },
    { h: 'Mortgages', get: (r) => count(r.mortgageCount), n: true },
    { h: 'Deeds', get: (r) => count(r.deedCount), n: true },
    { h: 'Owns now', get: (r) => count(r.currentOwnershipsCount), n: true },
    { h: 'Last seen', get: (r) => day(r.latestTransactionDate) },
  ],
  properties: [
    { h: 'Property', w: '44%', get: (r) => addressOf(r), strong: true },
    { h: 'Bought', get: (r) => day(r.startDate || r.purchaseDate) },
    { h: 'Sold', get: (r) => day(r.endDate || r.saleDate) },
    { h: 'Paid', get: (r) => money(r.purchasePrice ?? r.totalConsideration), n: true },
    { h: 'Sold for', get: (r) => money(r.salePrice), n: true },
  ],
  mortgages: [
    { h: 'Property', w: '32%', get: (r) => addressOf(r), strong: true },
    { h: 'Recorded', get: (r) => day(r.recordingDate) },
    { h: 'Amount', get: (r) => money(r.mortgageAmount), n: true },
    { h: 'Lender', get: (r) => txt(r.lenderName || r.lenderAliasName) },
    { h: 'Kind', get: (r) => txt(r.lenderType) },
    { h: 'Term', get: (r) => (num(r.loanTermMonths) === null ? '—' : `${r.loanTermMonths} mo`) },
    { h: 'Matures', get: (r) => day(r.maturityDate) },
    { h: 'Paid off', get: (r) => (r.satisfactionDate ? day(r.satisfactionDate) : 'Open') },
  ],
  deeds: [
    { h: 'Property', w: '32%', get: (r) => addressOf(r), strong: true },
    { h: 'Recorded', get: (r) => day(r.recordingDate) },
    { h: 'Price', get: (r) => money(r.totalConsideration), n: true },
    { h: 'From', get: (r) => names(r.grantors) },
    { h: 'To', get: (r) => names(r.grantees) },
    { h: 'Cash', get: (r) => (r.isCashPurchase === true ? 'Cash' : r.isCashPurchase === false ? 'Financed' : '—') },
  ],
  associated_people: [
    { h: 'Person', w: '40%', get: (r) => txt(r.name), strong: true },
    { h: 'Shared mortgages', get: (r) => count(r.sharedMortgageCount), n: true },
    { h: 'Shared deeds', get: (r) => count(r.sharedDeedCount), n: true },
    { h: 'Together on', get: (r) => count(r.sharedTotalCount), n: true },
  ],
  lender_network: [
    { h: 'Lender', w: '38%', get: (r) => txt(r.name), strong: true },
    { h: 'Kind', get: (r) => txt(r.lenderType) },
    { h: 'Loans', get: (r) => count(r.mortgageCount), n: true },
    { h: 'Total lent', get: (r) => money(r.totalVolume), n: true },
  ],
  cross_state: [
    { h: 'Name', w: '38%', get: (r) => txt(r.name), strong: true },
    { h: 'State', get: (r) => txt(r.state) },
    { h: 'Mortgages', get: (r) => count(r.mortgageCount), n: true },
    { h: 'Deeds', get: (r) => count(r.deedCount), n: true },
    { h: 'Records', get: (r) => count(r.transactionCount), n: true },
  ],
};
COLUMNS.foreclosures = COLUMNS.mortgages;

/** A last resort for a shape we have no columns for: the row's own scalars. */
function fallbackColumns(rows) {
  const first = rows.find((r) => r && typeof r === 'object') || {};
  const keys = Object.keys(first)
    .filter((k) => !k.startsWith('_') && ['string', 'number', 'boolean'].includes(typeof first[k]))
    .slice(0, 6);
  return keys.map((k) => ({ h: k, get: (r) => txt(r[k]) }));
}

/** Everything on the row, flattened, so the search box searches what is shown
 *  AND what is not — a person hunting for a street name should find it even
 *  when the column showing it is off to the right. */
function haystack(row) {
  try { return JSON.stringify(row).toLowerCase(); } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Tile({ label, value, wide }) {
  return (
    <div style={{
      border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px',
      background: '#FFFFFF', minWidth: wide ? 170 : 104, flex: wide ? '1 1 190px' : '0 0 auto',
    }}>
      <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: MUTED, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: wide ? 19 : 17, fontWeight: 650, color: INK, marginTop: 2 }}>{value}</div>
    </div>
  );
}

/** The one place a section's state becomes a sentence. */
function SectionNotice({ section, onRefresh }) {
  if (!section) return null;
  const box = (tone, text, cta) => (
    <div style={{
      border: `1px solid ${tone === 'warn' ? '#D9A441' : LINE}`,
      background: tone === 'warn' ? '#FDF6E7' : '#FAF8F3',
      borderRadius: 10, padding: '10px 12px', color: INK, fontSize: 14, marginBottom: 10,
    }}>
      {text}{cta}
    </div>
  );
  if (section.status === 'unavailable') return box('plain', section.detail);
  if (section.status === 'not_loaded') {
    return box('plain', 'This part has not been read from Elementix yet. ',
      onRefresh ? <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} onClick={onRefresh}>Read it now</button> : null);
  }
  if (section.status === 'error') {
    return box('warn', `We could not read this from Elementix — ${section.detail || 'no reason was given'}. This is NOT the same as this person having none. `,
      onRefresh ? <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} onClick={onRefresh}>Try again</button> : null);
  }
  if (section.status === 'partial') {
    return box('warn', 'One of this person’s state records could not be read, so what follows is incomplete.');
  }
  if (section.truncated) {
    return box('warn', `Showing the first ${section.rowCount.toLocaleString('en-US')} — there are more in Elementix than we pulled.`);
  }
  if (section.unverified && !section.rowCount) {
    return box('warn', 'Elementix answered, but we have not confirmed how this part comes back — so an empty list here is not proof there is nothing.');
  }
  return null;
}

function OverviewTab({ profile, onRefresh, busy }) {
  const byState = (profile.summary && profile.summary.byState) || [];
  if (!byState.length) return null;
  /* WHAT IS READ AND WHAT IS NOT, SAID PLAINLY. Opening a lead reads the
     overview only — one call per state — so the deep tabs are genuinely empty
     until somebody asks. Leaving that unsaid is the confident-zero problem one
     level up: the figures here would look like the whole picture. */
  const deep = Object.entries(profile.sections || {})
    .filter(([k, v]) => k !== 'overview' && v && v.status !== 'unavailable');
  const unread = deep.filter(([, v]) => v.status === 'not_loaded').length;
  return (
    <div>
      {unread > 0 && deep.length > 0 && (
        <div style={{
          border: `1px solid ${LINE}`, borderRadius: 12, padding: '10px 12px', marginBottom: 12,
          background: '#FCF8F1', color: INK, fontSize: 14, display: 'flex', gap: 10,
          alignItems: 'center', flexWrap: 'wrap',
        }}>
          <span style={{ flex: '1 1 260px' }}>
            These are the headline figures. Their {unread === deep.length ? '' : 'remaining '}
            properties, loans, deeds and companies have not been pulled in yet.
          </span>
          {onRefresh && (
            <button className="btn primary btn-sm" disabled={!!busy} onClick={onRefresh}>
              {busy === 'refresh' ? 'Reading…' : 'Pull in everything'}
            </button>
          )}
        </div>
      )}
      {byState.map((b) => {
        const f = b.facts;
        return (
          <div key={b.personId} style={{ border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, marginBottom: 12, background: '#FFFFFF' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <strong style={{ color: INK, fontSize: 16 }}>{b.name || 'Unnamed record'}</strong>
              <span style={{ color: MUTED, fontSize: 13 }}>{b.state || 'state unknown'}</span>
            </div>
            {!f ? (
              <div style={{ color: MUTED, fontSize: 14, marginTop: 8 }}>This state’s record has not been read yet.</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  <Tile label="Mortgages" value={count(f.mortgages)} />
                  <Tile label="Deeds" value={count(f.deeds)} />
                  <Tile label="Properties" value={count(f.properties)} />
                  <Tile label="Owns now" value={count(f.propertiesCurrent)} />
                  <Tile label="Foreclosures" value={count(f.foreclosures)} />
                  <Tile label="Owed today" value={money(f.exposure)} wide />
                </div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12, fontSize: 13, color: MUTED }}>
                  <span>New loans — last 3 months: <strong style={{ color: INK }}>{count(f.recentMortgages.m3)}</strong></span>
                  <span>6 months: <strong style={{ color: INK }}>{count(f.recentMortgages.m6)}</strong></span>
                  <span>12 months: <strong style={{ color: INK }}>{count(f.recentMortgages.m12)}</strong></span>
                  {f.firstLenderDates.any && <span>Borrowing since <strong style={{ color: INK }}>{day(f.firstLenderDates.any)}</strong></span>}
                  {f.yearsActive != null && <span>Active <strong style={{ color: INK }}>{count(f.yearsActive)}</strong> years</span>}
                  {f.previousExits3y != null && <span>Finished projects, last 3 years: <strong style={{ color: INK }}>{count(f.previousExits3y)}</strong></span>}
                  {f.averageLoanSize != null && <span>Typical loan <strong style={{ color: INK }}>{money(f.averageLoanSize)}</strong></span>}
                  {f.mostFrequentCounty && <span>Mostly in <strong style={{ color: INK }}>{f.mostFrequentCounty}</strong></span>}
                </div>
                {f.mailingAddress && (
                  <div style={{ marginTop: 10, fontSize: 13.5, color: INK }}>
                    <span style={{ color: MUTED }}>Where they get their post: </span>{f.mailingAddress}
                  </div>
                )}
                {f.unlockedBy && (
                  <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
                    Contact details unlocked by <strong style={{ color: INK }}>{f.unlockedBy}</strong>
                    {f.unlockedAt ? ` on ${day(f.unlockedAt)}` : ''}
                  </div>
                )}
                {(f.likelyAttorneyOrTitle || f.likelySupportStaff) && (
                  /* The vendor's own warning. Worth showing BEFORE somebody
                     telephones them about a loan: a closing attorney appears on
                     hundreds of files and is not a borrower. */
                  <div style={{ marginTop: 8, border: '1px solid #D9A441', background: '#FDF6E7', borderRadius: 10, padding: '8px 11px', color: INK, fontSize: 13.5 }}>
                    Elementix thinks this may be {f.likelyAttorneyOrTitle ? 'a closing attorney or title agent' : 'support staff'} rather than an investor —
                    they turn up on a lot of files. Worth checking before you call.
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RowTable({ section, filter }) {
  const rows = section.rows || [];
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => (q ? rows.filter((r) => haystack(r).includes(q)) : rows), [rows, q]);
  const cols = COLUMNS[section.key] || fallbackColumns(rows);
  if (!rows.length) return null;
  return (
    <>
      {q && (
        <div style={{ fontSize: 13, color: MUTED, marginBottom: 6 }}>
          {shown.length.toLocaleString('en-US')} of {rows.length.toLocaleString('en-US')} match “{filter.trim()}”
        </div>
      )}
      <div style={{ overflowX: 'auto', border: `1px solid ${LINE}`, borderRadius: 10, background: '#FFFFFF' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.h} style={{
                  textAlign: c.n ? 'right' : 'left', padding: '9px 11px', color: MUTED,
                  fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', fontWeight: 700,
                  borderBottom: `1px solid ${LINE}`, whiteSpace: 'nowrap', width: c.w || undefined,
                }}>{c.h}</th>
              ))}
              <th style={{ borderBottom: `1px solid ${LINE}` }} />
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={(r && r.id) || i} style={{ borderBottom: `1px solid ${LINE}` }}>
                {cols.map((c) => {
                  const v = c.get(r) || '—';
                  return (
                    <td key={c.h} style={{
                      padding: '9px 11px', color: INK, textAlign: c.n ? 'right' : 'left',
                      fontWeight: c.strong ? 600 : 400, whiteSpace: c.strong ? 'normal' : 'nowrap',
                    }}>{v}</td>
                  );
                })}
                <td style={{ padding: '9px 11px', whiteSpace: 'nowrap' }}>
                  {r && r._source && r._source.state
                    ? <span style={{ fontSize: 11, color: MUTED, border: `1px solid ${LINE}`, borderRadius: 20, padding: '1px 7px' }}>{r._source.state}</span>
                    : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!shown.length && q && <div style={{ color: MUTED, fontSize: 14, marginTop: 10 }}>Nothing here matches “{filter.trim()}”.</div>}
    </>
  );
}

/**
 * EVERY WAY TO REACH THEM — the owner's "all the contact information, all the
 * phone numbers and their names, all details".
 *
 * The LEAD row carries two numbers (`phone`, `phone_alt`), because that is what
 * a lead has always had. A skip trace routinely buys five, and the other three
 * sat in the database with no screen to show them. They are all here, with the
 * vendor's OWN words kept rather than translated: the label it gave the line
 * ("Mobile", "Fixed"), the carrier, where it is, whether it thinks the address
 * is deliverable, and how sure it is.
 *
 * ORDER IS THE VENDOR'S, which puts its best guess first — an officer ringing
 * three numbers should start at the top — and the confidence score is printed
 * so a weak one is visibly weak rather than just lower down.
 */
function ContactCard({ contact }) {
  if (!contact) return null;
  const phones = Array.isArray(contact.phones) ? contact.phones : [];
  const emails = Array.isArray(contact.emails) ? contact.emails : [];
  const addrs = Array.isArray(contact.addresses) ? contact.addresses : [];
  const prof = contact.profile || {};
  if (!phones.length && !emails.length && !addrs.length) return null;

  const pct = (c) => (typeof c === 'number' && c > 0 && c <= 1 ? `${Math.round(c * 100)}%` : null);
  const bits = (a) => a.filter(Boolean).join(' · ');

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, marginBottom: 12, background: '#FFFFFF' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 8 }}>
        <strong style={{ color: INK, fontSize: 15 }}>How to reach them</strong>
        <span style={{ color: MUTED, fontSize: 12.5 }}>
          {phones.length} number{phones.length === 1 ? '' : 's'}
          {emails.length ? ` · ${emails.length} email${emails.length === 1 ? '' : 's'}` : ''}
          {contact.unlockedByEmail ? ` · looked up by ${contact.unlockedByEmail}` : ''}
          {contact.unlockedAt ? ` · ${day(contact.unlockedAt)}` : ''}
        </span>
      </div>

      {phones.map((p, i) => (
        <div key={`${p.value}-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', padding: '5px 0', borderTop: i ? `1px solid ${LINE}` : 'none' }}>
          <a href={`tel:${String(p.value).replace(/[^\d+]/g, '')}`} style={{ color: '#256168', fontWeight: 650, fontSize: 15, textDecoration: 'none' }}>{p.value}</a>
          <span style={{ color: MUTED, fontSize: 13, flex: '1 1 160px' }}>
            {bits([p.label, p.carrier, p.location, p.status])}
          </span>
          {pct(p.confidence) && (
            <span style={{ color: MUTED, fontSize: 12.5 }}>{pct(p.confidence)} sure</span>
          )}
        </div>
      ))}

      {emails.map((e, i) => (
        <div key={`${e.value}-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', padding: '5px 0', borderTop: `1px solid ${LINE}` }}>
          <a href={`mailto:${e.value}`} style={{ color: '#256168', fontWeight: 600, fontSize: 14, textDecoration: 'none', wordBreak: 'break-all' }}>{e.value}</a>
          <span style={{ color: MUTED, fontSize: 13 }}>{bits([e.label, e.status])}</span>
        </div>
      ))}

      {addrs.map((a, i) => (
        <div key={`${a.value}-${i}`} style={{ color: INK, fontSize: 14, padding: '5px 0', borderTop: `1px solid ${LINE}` }}>
          {a.value}{a.label ? <span style={{ color: MUTED }}> · {a.label}</span> : null}
        </div>
      ))}

      {(prof.summary || prof.company || prof.linkedin) && (
        <div style={{ borderTop: `1px solid ${LINE}`, marginTop: 6, paddingTop: 8, color: MUTED, fontSize: 13.5 }}>
          {prof.company ? <div style={{ color: INK }}>{prof.company}{prof.companyDomain ? ` · ${prof.companyDomain}` : ''}</div> : null}
          {prof.summary ? <div style={{ marginTop: 4 }}>{prof.summary}</div> : null}
          {prof.linkedin ? <div style={{ marginTop: 4 }}><a href={prof.linkedin} target="_blank" rel="noreferrer" style={{ color: '#256168' }}>LinkedIn</a></div> : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export default function ElementixProfile({ kind, recordId, personName, personState }) {
  const [state, setState] = useState({ loading: true, linked: false, personId: null, profile: null, contact: null });
  const [tab, setTab] = useState('overview');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [query, setQuery] = useState(personName || '');
  const [qState, setQState] = useState(personState || '');
  const [hits, setHits] = useState(null);
  const [hitsCut, setHitsCut] = useState(false);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 3200); };

  /* OPENING A LEAD SHOWS THE PROFILE, NOT AN EMPTY ONE.
     A skip trace attaches the person and stores their contact — it does not read
     their records — so the first time anybody opened that lead this section drew
     every tab blank and waited to be told to fetch. The owner asked for the
     profile to BE there.
     So a person nobody has read yet is read on open, and deliberately only the
     OVERVIEW: that is ONE call per state and it carries every headline figure —
     the mortgages, the deeds, the properties, the exposure. The deep tabs are up
     to forty calls across eight paged sections, out of an allowance the whole
     organisation shares, and browsing a list of leads must not spend that. They
     fill on "Refresh data", which is the deliberate press.
     It cannot loop: the server stamps the person as read whether the build
     succeeded or failed, so a second open never re-triggers it. */
  const load = () => api.elxFor(kind, recordId)
    .then((r) => {
      setState({ loading: false, linked: !!r.linked, personId: r.personId, profile: r.profile, contact: r.contact || null });
      if (r.linked && r.personId && r.profile && r.profile.loaded === false) {
        return api.elxProfileBuild(r.personId, { sections: ['overview'] })
          .then((built) => setState((s) => ({ ...s, profile: built.profile })))
          .catch(() => { /* the lead still opens; Refresh data is right there */ });
      }
      return null;
    })
    .catch((e) => { setErr(e.message); setState((s) => ({ ...s, loading: false })); });

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [kind, recordId]);
  useEffect(() => { setQuery(personName || ''); }, [personName]);

  const search = async () => {
    setErr(''); setHits(null);
    if (query.trim().length < 3) { setErr('Type at least three letters of the name.'); return; }
    setBusy('search');
    try {
      const r = await api.elxSearch(query.trim(), qState.trim().toUpperCase());
      setHits(r.results || []);
      setHitsCut(!!r.truncated);
      if (!r.results || !r.results.length) flash('Elementix has nobody by that name.');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const linkTo = async (hit) => {
    setErr(''); setBusy('link');
    /* TWO STEPS, AND THE FIRST ONE STICKS. Attaching the person is one request
       and reading their profile is another, so Elementix being slow or the
       hourly allowance running out fails the SECOND while the FIRST has already
       landed on the server. Reporting only the error left this screen still
       showing "nobody is attached yet" over a record that WAS attached — so the
       next thing anybody does is search and attach again. */
    let attached = false;
    try {
      await api.elxLink({ kind, recordId, personId: hit.personId, name: hit.name, state: hit.state, replace: true });
      attached = true;
      const built = await api.elxProfileBuild(hit.personId, {});
      /* MERGE, NEVER REPLACE. The state shape carries `contact` — the phone
         numbers and emails — and writing a fresh object dropped it, so the
         "How to reach them" panel vanished the instant somebody pressed
         "This is them" and did not come back until the page was reloaded. */
      setState((s) => ({ ...s, loading: false, linked: true, personId: hit.personId, profile: built.profile }));
      setHits(null);
      flash(`Linked to ${hit.name || 'that record'} and read their profile.`);
    } catch (e) {
      setErr(e.message);
      if (attached) {
        setState((s) => ({ ...s, loading: false, linked: true, personId: hit.personId, profile: null }));
        setHits(null);
      }
    } finally { setBusy(''); }
  };

  const refresh = async (force) => {
    if (!state.personId) return;
    setErr(''); setBusy('refresh');
    try {
      const built = await api.elxProfileBuild(state.personId, { force: !!force });
      setState((s) => ({ ...s, profile: built.profile }));
      const failed = (built.sections || []).filter((x) => x.status === 'error');
      const short = (built.sections || []).filter((x) => x.status === 'skipped');
      if (failed.length) flash(`Read what we could — ${failed.length} part(s) Elementix would not answer.`);
      else if (short.length) flash('Read part of it — the hourly allowance ran out. Press Refresh again to carry on.');
      else flash(`Refreshed. ${built.callsSpent} lookup(s) used.`);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const unlink = async () => {
    const yes = await askConfirm('Take this Elementix record off this file? Nothing is deleted from Elementix — it just stops showing here.', { confirmLabel: 'Unlink' });
    if (!yes) return;
    setBusy('unlink');
    try {
      await api.elxLink({ kind, recordId, personId: null });
      setState({ loading: false, linked: false, personId: null, profile: null });
      flash('Unlinked.');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const decideAlias = async (aliasId, confirm, label) => {
    if (confirm) {
      const yes = await askConfirm(
        `Treat ${label || 'that record'} as the SAME person? Their properties, loans and deeds will be added into this profile. Only say yes if you are sure — Elementix matched on the name alone.`,
        { confirmLabel: 'Yes, same person' });
      if (!yes) return;
    }
    setBusy('alias');
    try {
      await api.elxDecideAlias(state.personId, aliasId, confirm);
      const built = await api.elxProfileBuild(state.personId, { force: false });
      setState((s) => ({ ...s, profile: built.profile }));
      flash(confirm ? 'Merged — this is now one profile.' : 'Noted — kept separate.');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  if (state.loading) return <div className="panel pad" style={{ color: MUTED }}>Loading the Elementix profile…</div>;

  // ---- Not linked: the "Run a search on this client" state --------------
  if (!state.linked) {
    return (
      <div className="panel">
        <div className="panel-h"><h3>Elementix</h3></div>
        <div className="panel-b">
          {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
          {msg && <div className="notice ok" style={{ marginBottom: 10 }}>{msg}</div>}
          <p style={{ color: MUTED, fontSize: 14, marginTop: 0 }}>
            Nobody from Elementix is attached yet. Search their name to pull in everything on record —
            the companies they own, every property, every loan, every deed.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 240px' }}>
              <label className="lbl" style={{ color: MUTED }}>Name</label>
              <input className="input" style={{ fontSize: 16 }} value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') search(); }} placeholder="e.g. Moty Brisk" />
            </div>
            <div style={{ flex: '0 0 110px' }}>
              <label className="lbl" style={{ color: MUTED }}>State</label>
              <input className="input" style={{ fontSize: 16 }} value={qState} maxLength={2}
                onChange={(e) => setQState(e.target.value.toUpperCase())} placeholder="NJ" />
            </div>
            <button className="btn primary" disabled={busy === 'search'} onClick={search}>
              {busy === 'search' ? 'Searching…' : 'Run a search on this client'}
            </button>
          </div>

          {hits && hits.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 13, color: MUTED, marginBottom: 6 }}>
                Pick the right person. Elementix keeps one record per state, so the same person can appear more than once —
                link one, and you can join the others afterwards.
                {/* NEVER A SILENT CAP: Elementix answers a search with as many as it
                    will send and states its own limit, so a full page means there may
                    be more — and the right person can be the one just off the end. */}
                {hitsCut ? ' Elementix sent back as many as it will in one go, so there may be more — add the state, or type more of the name.' : ''}
              </div>
              {hits.map((h) => (
                <div key={h.personId} style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px', marginBottom: 8, background: '#FFFFFF',
                }}>
                  <div style={{ flex: '1 1 200px' }}>
                    <div style={{ color: INK, fontWeight: 600 }}>{h.name || 'Unnamed'}</div>
                    <div style={{ color: MUTED, fontSize: 13 }}>
                      {h.state || 'state unknown'}
                      {h.hasContact ? ' · we already hold their contact details' : ''}
                      {h.leadCount ? ` · ${h.leadCount} lead(s) already` : ''}
                    </div>
                  </div>
                  <button className="btn primary btn-sm" disabled={busy === 'link'} onClick={() => linkTo(h)}>
                    {busy === 'link' ? 'Linking…' : 'This is them'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- Linked: the profile ----------------------------------------------
  const p = state.profile;
  /* ATTACHED, NOT READ YET. A bare sentence here was a dead end: it did not say
     what went wrong and offered no way forward, on the one screen where the
     record IS attached and one press would fix it. */
  if (!p) {
    return (
      <div className="panel">
        <div className="panel-h" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h3>Elementix</h3>
          <span style={{ flex: 1 }} />
          <button className="btn primary btn-sm" disabled={!!busy} onClick={() => refresh(true)}>
            {busy === 'refresh' ? 'Reading…' : 'Read their profile'}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={unlink}>Unlink</button>
        </div>
        <div className="panel-b">
          {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
          {msg && <div className="notice ok" style={{ marginBottom: 10 }}>{msg}</div>}
          <ContactCard contact={state.contact} />
          <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>
            This person is attached to the file, but their Elementix record has not been read yet.
            Press <strong>Read their profile</strong> to pull it in.
          </p>
        </div>
      </div>
    );
  }
  const s = p.summary || {};
  const c = s.counts || {};
  const sections = p.sections || {};
  const current = sections[tab];
  const candidates = p.aliasCandidates || [];

  return (
    <div className="panel">
      <div className="panel-h" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h3>Elementix</h3>
        <span style={{ color: MUTED, fontSize: 13 }}>
          {(p.person && p.person.name) || 'Linked record'}
          {s.states && s.states.length ? ` · ${s.states.join(', ')}` : ''}
          {p.person && p.person.refreshedAt ? ` · read ${day(p.person.refreshedAt)}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => refresh(true)}>
          {busy === 'refresh' ? 'Refreshing…' : 'Refresh data'}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={unlink}>Unlink</button>
      </div>
      <div className="panel-b">
        {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
        {msg && <div className="notice ok" style={{ marginBottom: 10 }}>{msg}</div>}

        {p.person && p.person.lastError && (
          <div style={{ border: '1px solid #D9A441', background: '#FDF6E7', borderRadius: 10, padding: '10px 12px', color: INK, fontSize: 14, marginBottom: 12 }}>
            The last read did not finish cleanly — {p.person.lastError}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <Tile label="Companies" value={count(c.entities)} />
          <Tile label="Properties" value={count(c.properties)} />
          <Tile label="Mortgages" value={count(c.mortgages)} />
          <Tile label="Deeds" value={count(c.deeds)} />
          <Tile label="Foreclosures" value={count(c.foreclosures)} />
          <Tile label="Owed today" value={money(s.exposure)} wide />
        </div>
        {s.complete === false && (
          <div style={{ color: MUTED, fontSize: 12.5, marginBottom: 10 }}>
            Some of these totals are missing because part of this person’s record has not been read yet.
          </div>
        )}

        {candidates.length > 0 && (
          <div style={{ border: `1px solid ${LINE}`, background: '#FAF8F3', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
            <div style={{ color: INK, fontWeight: 600, fontSize: 14 }}>Found in other states — is this the same person?</div>
            <div style={{ color: MUTED, fontSize: 13, margin: '2px 0 8px' }}>
              Elementix matched on the name only, so this is a question, not an answer. Say yes and their records join this profile.
            </div>
            {candidates.map((a) => (
              <div key={a.personId} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                <span style={{ color: INK, fontWeight: 600 }}>{a.name || 'Unnamed'}</span>
                <span style={{ color: MUTED, fontSize: 13 }}>{a.state || '—'}</span>
                <span style={{ flex: 1 }} />
                <button className="btn primary btn-sm" disabled={!!busy} onClick={() => decideAlias(a.personId, true, `${a.name || 'that record'} (${a.state || 'unknown state'})`)}>Same person</button>
                <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => decideAlias(a.personId, false)}>Different person</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: `1px solid ${LINE}`, paddingBottom: 8, marginBottom: 12 }}>
          {TABS.map((t) => {
            const sec = sections[t.key];
            /* A NUMBER ON A TAB IS A CLAIM, SO IT IS ONLY MADE ABOUT A SECTION WE
               ACTUALLY READ. `rowCount` is 0 for a section that was never asked
               for and for one whose call failed, so badging it prints a confident
               "0" — "Elementix has nothing on this person" — about a question
               nobody put. Those get a quiet dot instead, and the notice under the
               tabs says which it was. */
            const read = !!sec && (sec.status === 'ok' || sec.status === 'partial');
            const n = read ? (sec.total != null ? sec.total : sec.rowCount) : null;
            const unread = !!sec && !read && sec.status !== 'unavailable';
            const on = tab === t.key;
            return (
              <button key={t.key} onClick={() => { setTab(t.key); setFilter(''); }}
                style={{
                  // GOLD AS A BACKGROUND FOR WHITE TEXT is #AE8746 at 3.31:1 — the single
                  // worst pair the repo's own contrast guard names. --gold-ink (#856529)
                  // reads 5.40:1 and is the same brand gold, darkened just enough.
                  border: `1px solid ${on ? '#856529' : LINE}`, background: on ? '#856529' : '#FFFFFF',
                  color: on ? '#FFFFFF' : INK, borderRadius: 20, padding: '5px 12px',
                  fontSize: 13.5, fontWeight: on ? 650 : 500, cursor: 'pointer',
                }}>
                {t.label}
                {t.key !== 'overview' && n != null
                  ? <span style={{ opacity: 0.75, marginLeft: 6 }}>{n.toLocaleString('en-US')}</span>
                  : t.key !== 'overview' && unread
                    ? <span style={{ opacity: 0.55, marginLeft: 6 }}
                        title={sec.status === 'error' ? 'This part did not come back — open it to try again'
                          : sec.status === 'skipped' ? 'This part was left for the next refresh'
                            : 'Not read yet'}>·</span>
                    : null}
              </button>
            );
          })}
        </div>

        {tab !== 'overview' && current && (current.rows || []).length > 3 && (
          <input className="input" style={{ marginBottom: 10, fontSize: 16 }} value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Search these ${TABS.find((t) => t.key === tab).label.toLowerCase()} — an address, a company, a lender…`} />
        )}

        <SectionNotice section={current} onRefresh={busy ? null : () => refresh(true)} />

        {tab === 'overview'
          ? <><ContactCard contact={state.contact} />
              <OverviewTab profile={p} busy={busy} onRefresh={busy ? null : () => refresh(true)} /></>
          : current && current.status !== 'unavailable' && (current.rows || []).length
            ? <RowTable section={current} filter={filter} />
            : current && (current.status === 'ok' || current.status === 'partial')
              ? <div style={{ color: MUTED, fontSize: 14 }}>Elementix has nothing on record here.</div>
              : null}
      </div>
    </div>
  );
}

export { addressOf, money, count, day, COLUMNS, TABS, fallbackColumns };
