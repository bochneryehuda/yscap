import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { askConfirm } from '../lib/dialog.js';
import {
  addressOf, money, count, day, haystack,
  COLUMNS, fallbackColumns,
  NO_FILTERS, UNKNOWN_STATE, PAYOFF_LABELS,
  facetsFor, applyRowView, viewSummary, nextSort, sortLabel,
} from '../lib/elementixRows.js';

/**
 * THE ELEMENTIX PROFILE — one person, every state, on a lead or a borrower.
 *
 * The owner asked for "a mega profile, even better than Elementix": the
 * overview, the entities, the properties, the mortgages, the deeds, the
 * foreclosures, all states merged, searchable and filterable, with a Run a
 * search button when nobody is linked yet and a Refresh data button when
 * somebody is.
 *
 * ── FOUR RULES THIS SCREEN EXISTS TO KEEP ───────────────────────────────────
 *
 * 1. AN EMPTY TAB MUST SAY WHY IT IS EMPTY. The server answers each section
 *    with a status — read / refused / never asked for — because those are three
 *    different facts and only one of them means "this person has none". A screen
 *    that draws the same blank table for all three teaches people to trust a
 *    number that was never fetched. The FILTERS inherit that rule: a filter that
 *    matches nothing says so in words, and never leaves a blank table behind
 *    that reads as "Elementix has none".
 *
 * 2. THE VENDOR'S FIELD NAMES ARE NOT CONSISTENT, so `addressOf` reads several
 *    spellings. That is not defensive padding — it is measured: on 2026-08-18 a
 *    PERSON deed row carried `addresses` as plain STRINGS while an ENTITY deed
 *    row used the same key for {addressFull} OBJECTS, and a person MORTGAGE row
 *    had no `addresses` key at all, spelling it `propertyAddresses`. Reading one
 *    spelling renders a blank column or the words "[object Object]".
 *
 * 3. FILTERING A PARTIAL SET IS A DIFFERENT CLAIM FROM FILTERING A COMPLETE
 *    ONE. Every tab states how many rows it is showing out of how many it HOLDS,
 *    and a `truncated` section says beside its filters that what it holds is not
 *    all Elementix has. "17 of 829 loans over $1m" is an answer; "17 of the
 *    first 829 loans of an unknown number" is not, and they look identical
 *    unless it is written down.
 *
 * 4. MONEY IS NEVER SPENT WITHOUT A TYPED REASON AND A CONFIRM. "Look them up"
 *    asks the FREE cost check first (counts only — that route deliberately no
 *    longer carries phone numbers), says in plain words which of the two things
 *    is about to happen, and only then offers the paid one. Nothing here spends
 *    on render, on a tab change, or on Refresh.
 *
 * ── COLOURS ─────────────────────────────────────────────────────────────────
 * Every text colour here is an explicit dark hex. The `--ink*` tokens in this
 * palette are LIGHT (paper), so `color: var(--ink)` renders white on white — the
 * bug that made a whole card invisible once already. Gold as TEXT on a light
 * surface is #856529, never the brand #AE8746 (3.3:1).
 *
 * ── WHERE THE ROWS LIVE ─────────────────────────────────────────────────────
 * The readers, the COLUMNS and the whole filter/sort decision are in
 * `../lib/elementixRows.js` — pure, no React — so `scripts/test-elementix-
 * profile-filters-pure.js` can walk their truth table (the unknown third state,
 * an empty result, both sort directions, a filter narrowing a truncated set).
 * A rule that only exists inside a component is a rule nothing can test.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E4DECF';
const GOLD_INK = '#856529';

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

/* EVERY CONTROL AT 16px. Anything smaller and iOS Safari zooms the whole page
   on focus, which on a 390px phone leaves the table scrolled sideways under the
   user's thumb with no way back. */
const CTRL = {
  width: '100%', boxSizing: 'border-box', minWidth: 0,
  fontSize: 16, color: INK, background: '#FFFFFF',
};

/**
 * THE FREE COST CHECK — counts only, never the numbers.
 *
 * `/people/:id/contact` answers one question ("will the next click cost money")
 * and deliberately carries `stored.phoneCount` / `stored.emailCount` INSTEAD of
 * the phone numbers, because it is unscoped: it has to be askable about somebody
 * nobody has attached to anything yet. The DETAIL comes back through the scoped
 * door — `api.elxFor(kind, recordId)` — which is exactly what `afterLookup`
 * re-reads when a lookup lands.
 *
 * The wrapper is named `elxContactStatus` where that rename has landed and
 * `elxContact` where it has not; this component may not edit `lib/api.js`, so it
 * asks for whichever exists and REFUSES LOUDLY if neither does rather than
 * silently doing nothing on a button somebody pressed.
 */
function costCheck(personId) {
  const fn = api.elxContactStatus || api.elxContact;
  if (typeof fn !== 'function') {
    return Promise.reject(new Error('This build has no Elementix cost check wired up, so PILOT cannot tell you whether this would spend a credit.'));
  }
  return fn(personId);
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

/** One labelled control in the filter row. It WRAPS — never a sideways scroll. */
function FilterField({ label, basis, children }) {
  return (
    <label style={{ flex: `1 1 ${basis || 150}px`, minWidth: 0, display: 'block' }}>
      <span style={{
        display: 'block', fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase',
        color: MUTED, fontWeight: 600, marginBottom: 3,
      }}>{label}</span>
      {children}
    </label>
  );
}

/**
 * ONE TAB'S ROWS — the filters, the sort, the count, and the table.
 *
 * The parent mounts this with `key={tab}`, so switching tabs RESETS the filters
 * by remounting rather than by remembering to clear nine fields; a filter left
 * on from another tab is the kind of thing that quietly hides rows.
 *
 * Everything here is client-side over rows already loaded. There is no server
 * round trip in this component — narrowing a list must never cost one of the
 * organisation's shared hourly calls.
 */
function TabRows({ section, label }) {
  const rows = useMemo(() => section.rows || [], [section.rows]);
  const cols = useMemo(() => COLUMNS[section.key] || fallbackColumns(rows), [section.key, rows]);
  /* Stringified ONCE per row per load rather than once per keystroke: 800+ rows
     re-serialised on every character typed is a visibly janky search box. */
  const haystacks = useMemo(() => rows.map((r) => haystack(r)), [rows]);
  const facets = useMemo(() => facetsFor(rows, cols), [rows, cols]);

  const blank = useMemo(() => ({
    ...NO_FILTERS,
    dateCol: facets.dateCols[0] || '',
    amountCol: facets.moneyCols[0] || '',
  }), [facets]);

  const [filters, setFilters] = useState(blank);
  const [sort, setSort] = useState(null);
  const set = (k, v) => setFilters((s) => ({ ...s, [k]: v }));

  const view = useMemo(
    () => applyRowView({ rows, cols, filters, sort, truncated: section.truncated, haystacks }),
    [rows, cols, filters, sort, section.truncated, haystacks]);
  const noun = String(label || 'rows').toLowerCase();
  const summary = viewSummary(view, { noun });
  const sorted = sortLabel(view.sort, cols);
  const showBar = rows.length > 3;
  const oneDate = facets.dateCols.length === 1 ? facets.dateCols[0] : null;
  const oneMoney = facets.moneyCols.length === 1 ? facets.moneyCols[0] : null;

  if (!rows.length) return null;

  return (
    <>
      {showBar && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
          <FilterField label="Search" basis={210}>
            <input className="input" style={CTRL} value={filters.q}
              onChange={(e) => set('q', e.target.value)}
              placeholder="an address, a company, a lender…" />
          </FilterField>

          {/* THE STATE PILL ON EVERY ROW, MADE INTO A FILTER. Offered only when
              there is something to choose between — a select with one option is
              furniture, and "state not recorded" appears only when such rows
              genuinely exist, so it is never a phantom option. */}
          {(facets.states.length > 1 || (facets.states.length >= 1 && facets.stateless > 0)) && (
            <FilterField label="State" basis={130}>
              <select style={CTRL} value={filters.state} onChange={(e) => set('state', e.target.value)}>
                <option value="">All states</option>
                {facets.states.map((s) => <option key={s} value={s}>{s}</option>)}
                {facets.stateless > 0 && (
                  <option value={UNKNOWN_STATE}>State not recorded ({facets.stateless})</option>
                )}
              </select>
            </FilterField>
          )}

          {facets.dateCols.length > 0 && (
            <>
              {!oneDate && (
                <FilterField label="Date field" basis={150}>
                  <select style={CTRL} value={filters.dateCol} onChange={(e) => set('dateCol', e.target.value)}>
                    {facets.dateCols.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </FilterField>
              )}
              <FilterField label={oneDate ? `${oneDate} from` : 'From'} basis={148}>
                <input className="input" type="date" style={CTRL} value={filters.from}
                  onChange={(e) => set('from', e.target.value)} />
              </FilterField>
              <FilterField label={oneDate ? `${oneDate} to` : 'To'} basis={148}>
                <input className="input" type="date" style={CTRL} value={filters.to}
                  onChange={(e) => set('to', e.target.value)} />
              </FilterField>
            </>
          )}

          {facets.moneyCols.length > 0 && (
            <>
              {!oneMoney && (
                <FilterField label="Amount field" basis={150}>
                  <select style={CTRL} value={filters.amountCol} onChange={(e) => set('amountCol', e.target.value)}>
                    {facets.moneyCols.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </FilterField>
              )}
              <FilterField label={oneMoney ? `${oneMoney} at least $` : 'At least $'} basis={132}>
                <input className="input" style={CTRL} inputMode="decimal" value={filters.min}
                  onChange={(e) => set('min', e.target.value)} placeholder="0" />
              </FilterField>
              <FilterField label={oneMoney ? `${oneMoney} at most $` : 'At most $'} basis={132}>
                <input className="input" style={CTRL} inputMode="decimal" value={filters.max}
                  onChange={(e) => set('max', e.target.value)} placeholder="no limit" />
              </FilterField>
            </>
          )}

          {/* PAID OFF IS A THREE-VALUED QUESTION. A recorded satisfaction says
              paid; a row that carries the field and has it empty has no payoff
              on record; a row that does not carry the field AT ALL cannot answer
              and gets its own option rather than being quietly counted as open. */}
          {facets.payoff && (
            <FilterField label="Payoff" basis={186}>
              <select style={CTRL} value={filters.payoff} onChange={(e) => set('payoff', e.target.value)}>
                <option value="">Paid off or not — everything</option>
                <option value="paid">{PAYOFF_LABELS.paid} ({facets.payoff.paid})</option>
                <option value="open">{PAYOFF_LABELS.open} — no payoff recorded ({facets.payoff.open})</option>
                <option value="unknown">{PAYOFF_LABELS.unknown} — cannot tell ({facets.payoff.unknown})</option>
              </select>
            </FilterField>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 13.5, color: INK, fontWeight: 600 }}>{summary.main}</span>
        {sorted && <span style={{ fontSize: 13, color: MUTED }}>· sorted by {sorted}</span>}
        <span style={{ flex: 1 }} />
        {view.active && (
          <button className="btn btn-ghost btn-sm" onClick={() => setFilters(blank)}>Clear filters</button>
        )}
        {view.sort && (
          <button className="btn btn-ghost btn-sm" onClick={() => setSort(null)}>Clear sort</button>
        )}
      </div>

      {summary.truncatedNote && (
        <div style={{ fontSize: 13, color: INK, background: '#FDF6E7', border: '1px solid #D9A441',
          borderRadius: 10, padding: '8px 11px', marginBottom: 8 }}>
          {summary.truncatedNote}
        </div>
      )}
      {summary.unknownNotes.map((t) => (
        <div key={t} style={{ fontSize: 13, color: MUTED, marginBottom: 6 }}>{t}</div>
      ))}

      {view.emptyReason === 'no-match' ? (
        /* NEVER A BLANK TABLE. An empty tab on this screen means "Elementix has
           none"; an empty FILTER means the officer asked a narrow question. They
           must not look the same. */
        <div style={{ border: `1px solid ${LINE}`, background: '#FAF8F3', borderRadius: 10,
          padding: '12px 14px', color: INK, fontSize: 14 }}>
          Nothing matches these filters. All {view.held.toLocaleString('en-US')} {noun} we hold are still here.
          {view.truncated ? ' (And what we hold is only part of what Elementix has.)' : ''}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={() => setFilters(blank)}>Clear filters</button>
        </div>
      ) : (
        <div style={{ overflowX: 'auto', maxWidth: '100%', border: `1px solid ${LINE}`, borderRadius: 10, background: '#FFFFFF' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead>
              <tr>
                {cols.map((c) => {
                  const on = !!(view.sort && view.sort.h === c.h);
                  return (
                    <th key={c.h}
                      aria-sort={on ? (view.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      style={{
                        textAlign: c.n ? 'right' : 'left', padding: '9px 11px',
                        borderBottom: `1px solid ${LINE}`, whiteSpace: 'nowrap', width: c.w || undefined,
                        background: on ? '#FAF6EC' : undefined,
                      }}>
                      <button type="button" onClick={() => setSort((s) => nextSort(s, c))}
                        title={`Sort by ${c.h}`}
                        style={{
                          background: 'none', border: 0, padding: 0, margin: 0, font: 'inherit',
                          fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', fontWeight: 700,
                          color: on ? GOLD_INK : MUTED, cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
                        }}>
                        {c.h}
                        <span aria-hidden="true" style={{ opacity: on ? 1 : 0.45 }}>
                          {on ? (view.sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    </th>
                  );
                })}
                <th style={{ borderBottom: `1px solid ${LINE}` }} />
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r, i) => (
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
      )}
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

/**
 * LOOK THEM UP — the only place on a PROFILE that can spend a credit.
 *
 * Until this existed the finder on the Leads screen was the single door that
 * bought a phone number, so a borrower profile could show somebody's three
 * hundred mortgages and give an officer no way to ring them. It behaves exactly
 * as the finder does, in the same order and with the same refusals:
 *
 *   1. NOTHING HAPPENS UNTIL SOMEBODY PRESSES. No status check on render, on a
 *      tab change or on Refresh — the free check still costs a slot of the
 *      allowance the whole organisation shares.
 *   2. THE FREE CHECK FIRST, and it decides which of the two things this is. The
 *      SERVER decides, not this screen: it asks our own store (detail we hold is
 *      proof we already paid) and the vendor second, and it says plainly when it
 *      could not ask at all — which is neither "free" nor a reason to warn about
 *      a credit we may not spend.
 *   3. THE PAID ONE NEEDS A TYPED REASON (≥4 characters, the same floor the
 *      route enforces) AND AN EXPLICIT CONFIRM. The free one needs neither,
 *      because there is nothing to be careful with.
 *   4. THE COUNTS COME FROM THE COST ROUTE; THE NUMBERS NEVER DO. That route
 *      answers `stored.phoneCount` / `stored.emailCount` and deliberately no
 *      longer carries the detail — the detail is re-read afterwards through the
 *      scoped door, which is what `onDone` does.
 */
function LookupPanel({ personId, personName, personState, held, onDone }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [reason, setReason] = useState('');
  const [usage, setUsage] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const who = personName || 'this person';
  const free = !!(status && status.free);
  const statusUnknown = !!(status && status.statusKnown === false);
  const stored = (status && status.stored) || null;

  const check = async () => {
    setOpen(true); setErr(''); setStatus(null);
    setBusy('status');
    try {
      setStatus(await costCheck(personId));
      api.elxUsage().then(setUsage).catch(() => {});
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const go = async () => {
    setErr('');
    if (!free) {
      if (reason.trim().length < 4) {
        setErr('Say in a few words why you are looking them up — it is kept with the credit that gets spent.');
        return;
      }
      const yes = await askConfirm(
        statusUnknown
          ? `Look up ${who}'s contact details? PILOT could not reach Elementix to check whether anybody here has already unlocked them, so this may spend one of the month's credits.`
          : `Look up ${who}'s contact details? Nobody here has unlocked them yet, so this spends one of the month's credits.`,
        { confirmLabel: 'Look them up' });
      if (!yes) return;
    }
    setBusy('go');
    try {
      const body = {
        name: personName || null,
        state: personState || null,
        reason: reason.trim() || 'Looked up from their profile',
      };
      const out = free
        ? await api.elxAddLead(personId, body)
        : await api.elxSkipTrace(personId, body);
      api.elxUsage().then(setUsage).catch(() => {});
      await onDone(out);
      setOpen(false); setStatus(null); setReason('');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const haveEmails = held && held.emails > 0;

  return (
    <div style={{ border: `1px solid ${LINE}`, background: '#FCF8F1', borderRadius: 12, padding: '11px 13px', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ flex: '1 1 240px', color: INK, fontSize: 14 }}>
          {haveEmails
            ? `PILOT holds ${held.emails} email address${held.emails === 1 ? '' : 'es'} for ${who} — but no telephone number.`
            : `PILOT has no way to contact ${who} — no telephone number, no email.`}
        </span>
        {usage && (
          <span style={{ color: MUTED, fontSize: 12.5 }}>
            {/* UNKNOWN IS AN ANSWER; BLANK IS NOT — this is a screen where money
                can be spent, so an unreadable ledger says so. */}
            {usage.ok
              ? `${usage.paidThisMonth} of ${usage.paidCap} lookups used this month`
              : `unknown of ${usage.paidCap != null ? usage.paidCap : '—'} lookups used this month`}
          </span>
        )}
        {!open && (
          <button className="btn primary btn-sm" onClick={check}>Look them up</button>
        )}
      </div>

      {err && <div role="alert" className="notice err" style={{ marginTop: 10 }}>{err}</div>}

      {open && busy === 'status' && (
        <div style={{ color: MUTED, fontSize: 14, marginTop: 10 }}>Checking whether anybody has looked them up… (this is free)</div>
      )}

      {open && status && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
          <div style={{ color: INK, fontSize: 14, marginBottom: 8 }}>
            {free
              ? <>Somebody here has already looked <strong>{who}</strong> up, so bringing their details onto this file is <strong>free</strong>.</>
              : statusUnknown
                ? <>PILOT could not reach Elementix to check whether anyone has looked <strong>{who}</strong> up. Going ahead <strong>may</strong> use one of the month’s credits — or may cost nothing, if they turn out to be unlocked already.</>
                : <>Nobody here has looked <strong>{who}</strong> up yet, so this will use <strong>one of the month’s credits</strong>.</>}
            {stored && (stored.phoneCount > 0 || stored.emailCount > 0) ? (
              <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
                We already hold {stored.phoneCount} number{stored.phoneCount === 1 ? '' : 's'} and {stored.emailCount} email{stored.emailCount === 1 ? '' : 's'} for them.
              </div>
            ) : null}
            <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
              They are added to your leads at the same time — that is how PILOT keeps the details.
            </div>
          </div>

          {!free && (
            <div style={{ marginBottom: 8, maxWidth: 420 }}>
              <FilterField label="Why are you looking them up?" basis={240}>
                <input className="input" style={CTRL} value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Calling about a bridge loan on 41 Arlington Ave" />
              </FilterField>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={busy === 'go'} onClick={go}>
              {busy === 'go' ? 'Working…' : free ? 'Add their details' : 'Look them up — one credit'}
            </button>
            <button className="btn btn-ghost" disabled={busy === 'go'}
              onClick={() => { setOpen(false); setStatus(null); setErr(''); }}>Not now</button>
          </div>
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
     succeeded or failed, so a second open never re-triggers it.
     AND NOTHING HERE IS THE PAID DOOR — every call on this path is a read. */
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

  /* WHAT HAPPENS AFTER A LOOKUP LANDS — and the reason it is a second request.
     The cost route answers COUNTS; the DETAIL is only ever read back through the
     scoped door, which checks this officer may see this record before it hands
     over a telephone number. Re-reading it here puts the "How to reach them"
     card on the screen with no page reload, and merges rather than replaces, so
     the profile that is already loaded is not thrown away. */
  const afterLookup = async (out) => {
    try {
      const r = await api.elxFor(kind, recordId);
      setState((s) => ({ ...s, contact: r.contact || null }));
    } catch (_) {
      /* The details are stored on the server either way — a failed re-read is
         not a failed lookup, and must not be reported as one. */
    }
    if (out && out.pending) {
      flash(out.detail || 'Elementix is still looking them up — their details will appear on their own.');
    } else if (out && out.charged) {
      flash('Looked them up — one credit used.');
    } else {
      flash('Their details are on the file. Nothing was charged: they had already been looked up.');
    }
  };

  const unlink = async () => {
    const yes = await askConfirm('Take this Elementix record off this file? Nothing is deleted from Elementix — it just stops showing here.', { confirmLabel: 'Unlink' });
    if (!yes) return;
    setBusy('unlink');
    try {
      await api.elxLink({ kind, recordId, personId: null });
      setState({ loading: false, linked: false, personId: null, profile: null, contact: null });
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

  const phonesHeld = ((state.contact && Array.isArray(state.contact.phones)) ? state.contact.phones : []).length;
  const emailsHeld = ((state.contact && Array.isArray(state.contact.emails)) ? state.contact.emails : []).length;

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
          {state.personId && !phonesHeld && (
            <LookupPanel personId={state.personId} personName={personName} personState={personState}
              held={{ phones: phonesHeld, emails: emailsHeld }} onDone={afterLookup} />
          )}
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
  const tabLabel = (TABS.find((t) => t.key === tab) || {}).label || 'rows';

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

        {/* THE WAY TO RING THEM, ON EVERY TAB. It sits above the tabs rather than
            inside the overview because the moment somebody needs it is while they
            are reading the person's three hundred mortgages. It disappears the
            instant a telephone number is on the file — there is nothing left to
            buy, and we never re-buy what we already hold. */}
        {state.personId && !phonesHeld && (
          <LookupPanel personId={state.personId}
            personName={(p.person && p.person.name) || personName}
            personState={(p.person && p.person.state) || personState}
            held={{ phones: phonesHeld, emails: emailsHeld }} onDone={afterLookup} />
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
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{
                  // GOLD AS A BACKGROUND FOR WHITE TEXT is #AE8746 at 3.31:1 — the single
                  // worst pair the repo's own contrast guard names. --gold-ink (#856529)
                  // reads 5.40:1 and is the same brand gold, darkened just enough.
                  border: `1px solid ${on ? GOLD_INK : LINE}`, background: on ? GOLD_INK : '#FFFFFF',
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

        <SectionNotice section={current} onRefresh={busy ? null : () => refresh(true)} />

        {tab === 'overview'
          ? <><ContactCard contact={state.contact} />
              <OverviewTab profile={p} busy={busy} onRefresh={busy ? null : () => refresh(true)} /></>
          : current && current.status !== 'unavailable' && (current.rows || []).length
            /* KEYED ON THE TAB — a tab change REMOUNTS this, which is what clears
               the filters and the sort. Carrying a filter from one tab to the
               next hides rows nobody asked to hide. */
            ? <TabRows key={tab} section={current} label={tabLabel} />
            : current && (current.status === 'ok' || current.status === 'partial')
              ? <div style={{ color: MUTED, fontSize: 14 }}>Elementix has nothing on record here.</div>
              : null}
      </div>
    </div>
  );
}

export { addressOf, money, count, day, COLUMNS, TABS, fallbackColumns };
