import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BrandLockup } from '../components/Layout.jsx';

/* THE SIMPLE CONDITION CENTER — no login (owner-directed 2026-08-28: "another
   way for borrowers to manage their conditions if they're not so technical. A
   more simple condition center for them, with an email directly with links to
   upload and enter the information over there").

   The emailed link's token (?t=…) is exchanged for a jailed guest session
   (src/lib/condition-link.js): a real borrower session that can reach ONLY this
   file's condition list, uploads, information answers, tool saves and the
   appraisal-card form — nothing else, with the borrower's personal details
   stripped from every response. So this page is a THIN, plain rendering over the
   same borrower endpoints the full portal uses; there is no second API and no
   second rule anywhere behind it.

   DESIGN: one item per card, one obvious action per item. Big Upload buttons,
   plain words, progress you can see. Nothing about accounts or passwords —
   opening the email link IS being signed in, for this page only. */

const DARK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const LINE = '#E4DFD3';

/* The guest session, self-contained (the portal's api.js manages the logged-in
   session — this page must never touch that). The token slides via
   X-Refresh-Token exactly like every session here. */
function makeClient(initialToken) {
  let token = initialToken;
  const call = async (method, path, body) => {
    const r = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const fresh = r.headers.get('X-Refresh-Token');
    if (fresh) token = fresh;
    let j = null; try { j = await r.json(); } catch (_) { /* not json */ }
    if (!r.ok) { const e = new Error((j && j.error) || 'Something went wrong.'); e.status = r.status; throw e; }
    return j;
  };
  return { call };
}

const STATUS_WORDS = {
  outstanding: { label: 'Needed', tone: '#8a6d3b' },
  requested: { label: 'Needed', tone: '#8a6d3b' },
  issue: { label: 'Needs a new version', tone: '#b3261e' },
  received: { label: 'Received — being reviewed', tone: '#2F7F86' },
  satisfied: { label: 'Done', tone: '#2e7d32' },
};

/* Which items still need the borrower — the same OPEN reading the portal uses. */
const OPEN = ['outstanding', 'requested', 'issue'];

export default function GuestConditions() {
  const [params] = useSearchParams();
  const token = params.get('t') || '';
  const focusItem = params.get('item') || '';
  const [client, setClient] = useState(null);
  const [appId, setAppId] = useState('');
  const [err, setErr] = useState('');
  const [file, setFile] = useState(null);
  const [items, setItems] = useState(null);
  const [msg, setMsg] = useState(null);   // { tone, text }

  // Exchange the emailed token for the jailed session, then load the list.
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        if (!token) { setErr('This link is missing its key — open it straight from the email you received.'); return; }
        const r = await fetch('/auth/condition-link', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (!dead) setErr(j.error || 'This link is no longer active.'); return; }
        const c = makeClient(j.accessToken);
        if (dead) return;
        setClient(c); setAppId(j.applicationId);
        const [f, list] = await Promise.all([
          c.call('GET', `/api/borrower/applications/${j.applicationId}`).catch(() => null),
          c.call('GET', `/api/borrower/applications/${j.applicationId}/checklist`),
        ]);
        if (dead) return;
        setFile(f); setItems(list);
      } catch (e) {
        if (!dead) setErr(e.message || 'This link could not be opened.');
      }
    })();
    return () => { dead = true; };
  }, [token]);

  const reload = async () => {
    if (!client || !appId) return;
    try { setItems(await client.call('GET', `/api/borrower/applications/${appId}/checklist`)); }
    catch (_) { /* keep what we have */ }
  };

  // Scroll to the item the email's per-item link named, once the list is in.
  const didFocus = useRef(false);
  useEffect(() => {
    if (didFocus.current || !focusItem || !items) return;
    didFocus.current = true;
    setTimeout(() => {
      const el = document.getElementById(`c-${focusItem}`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.outline = `2px solid ${GOLD}`; }
    }, 150);
  }, [focusItem, items]);

  const open = useMemo(() => (items || []).filter((it) => OPEN.includes(it.status) && !it.waived), [items]);
  const inReview = useMemo(() => (items || []).filter((it) => it.status === 'received' && !it.waived), [items]);
  const done = useMemo(() => (items || []).filter((it) => (it.status === 'satisfied' || it.signed_off || it.waived)), [items]);

  const address = file && (file.property_address ? (file.property_address.oneLine
    || [file.property_address.street, file.property_address.city, file.property_address.state].filter(Boolean).join(', ')) : '');

  if (err) {
    return (
      <Shell>
        <div style={{ maxWidth: 560, margin: '48px auto', textAlign: 'center' }}>
          <h2 style={{ color: DARK }}>This link isn’t working</h2>
          <p style={{ color: MUTED }}>{err}</p>
          <p style={{ color: MUTED }}>Reply to the email your loan team sent you and they’ll send a fresh link.</p>
        </div>
      </Shell>
    );
  }
  if (!items) return <Shell><p style={{ textAlign: 'center', color: MUTED, marginTop: 48 }}>Opening your items…</p></Shell>;

  return (
    <Shell>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 14px 60px' }}>
        <h1 style={{ color: DARK, fontSize: 26, marginBottom: 2 }}>Your loan — what’s still needed</h1>
        {address && <p style={{ color: MUTED, margin: '2px 0 0' }}>{address}</p>}
        <p style={{ color: MUTED, marginTop: 10 }}>
          Everything you send here lands straight on your loan file — no account or password needed.
          {open.length ? ` ${open.length} item${open.length === 1 ? '' : 's'} still need${open.length === 1 ? 's' : ''} you.` : ' Nothing needs you right now.'}
        </p>
        {msg && (
          <div role="status" style={{ margin: '10px 0', padding: '10px 12px', borderRadius: 10,
            border: `1px solid ${msg.tone === 'err' ? '#b3261e' : GOLD}`,
            background: msg.tone === 'err' ? '#fdf3f2' : '#fbf7ee', color: DARK }}>
            {msg.text}
          </div>
        )}

        {open.length === 0 && (
          <div style={{ margin: '18px 0', padding: 18, border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', textAlign: 'center' }}>
            <div style={{ fontSize: 22 }}>✓</div>
            <b style={{ color: DARK }}>You’re all caught up.</b>
            <p style={{ color: MUTED, margin: '4px 0 0' }}>Your loan team will email you if anything else comes up.</p>
          </div>
        )}

        {open.map((it, i) => (
          <ItemCard key={it.id} it={it} n={i + 1} client={client} appId={appId}
            onDone={(t) => { setMsg({ tone: 'ok', text: t }); reload(); }}
            onErr={(t) => setMsg({ tone: 'err', text: t })} />
        ))}

        {inReview.length > 0 && (
          <>
            <h3 style={{ color: DARK, marginTop: 26 }}>With your loan team — being reviewed</h3>
            {inReview.map((it) => (
              <div key={it.id} id={`c-${it.id}`} style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', padding: '10px 14px', marginTop: 8 }}>
                <b style={{ color: DARK }}>{it.label}</b>
                <span style={{ color: '#2F7F86', marginLeft: 8, fontSize: 13 }}>Received — being reviewed</span>
              </div>
            ))}
          </>
        )}

        {done.length > 0 && (
          <details style={{ marginTop: 22 }}>
            <summary style={{ color: MUTED, cursor: 'pointer' }}>Completed items ({done.length})</summary>
            {done.map((it) => (
              <div key={it.id} style={{ color: MUTED, padding: '6px 2px', borderBottom: `1px solid ${LINE}` }}>✓ {it.label}</div>
            ))}
          </details>
        )}

        <p style={{ color: MUTED, marginTop: 30, fontSize: 13 }}>
          Questions? Just reply to the email this link came in — it reaches your loan team directly.
        </p>
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#F6F3EC' }}>
      <header style={{ padding: '18px 16px 10px', maxWidth: 720, margin: '0 auto' }}>
        <BrandLockup />
      </header>
      {children}
    </div>
  );
}

/* One outstanding item: what it is, why (the hint / sent-back reason), and ONE
   obvious way to answer it — upload for a document, a typed box for an
   information item, the tool link where a tool exists. */
function ItemCard({ it, n, client, appId, onDone, onErr }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState(it.field_value != null ? String(it.field_value) : '');

  const isInfo = it.tool_key === 'info_field' && it.field_key;
  const isSow = it.tool_key === 'rehab_budget';
  const isTrackRecord = it.tool_key === 'track_record';
  const sentBack = it.status === 'issue';

  const upload = async (files) => {
    if (!files || !files.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files).slice(0, 10)) {
        const dataBase64 = await new Promise((resolve, reject) => {
          const rd = new FileReader();
          rd.onload = () => resolve(String(rd.result).split(',')[1] || '');
          rd.onerror = () => reject(new Error('Could not read that file.'));
          rd.readAsDataURL(f);
        });
        await client.call('POST', '/api/borrower/documents', {
          applicationId: appId, checklistItemId: it.id,
          filename: f.name, contentType: f.type || 'application/octet-stream', dataBase64,
        });
      }
      onDone(`Uploaded — “${it.label}” is with your loan team for review.`);
    } catch (e) { onErr(e.message || 'The upload did not go through — try again.'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const saveInfo = async () => {
    if (!String(value).trim()) return;
    setBusy(true);
    try {
      await client.call('POST', `/api/borrower/applications/${appId}/checklist/${it.id}/info`, { value: value.trim() });
      onDone(`Saved — “${it.label}” went straight to your file.`);
    } catch (e) { onErr(e.message || 'That could not be saved — try again.'); }
    finally { setBusy(false); }
  };

  const field = it.field_def || null;

  return (
    <div id={`c-${it.id}`} style={{ border: `1px solid ${sentBack ? '#b3261e' : LINE}`, borderRadius: 12, background: '#fff', padding: '14px 16px', marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
        <span style={{ color: GOLD, fontWeight: 700 }}>{n})</span>
        <div style={{ flex: 1 }}>
          <b style={{ color: DARK, fontSize: 16 }}>{it.label}</b>
          {sentBack && it.rejection_reason && (
            <div style={{ color: '#b3261e', marginTop: 4, fontSize: 14 }}>Needs a new version — {it.rejection_reason}</div>
          )}
          {it.hint && <div style={{ color: MUTED, marginTop: 4, fontSize: 14, whiteSpace: 'pre-wrap' }}>{it.hint}</div>}
          {it.external_note && it.external_note.text && (
            <div style={{ color: DARK, marginTop: 6, fontSize: 14, background: '#fbf7ee', border: `1px solid ${GOLD}`, borderRadius: 8, padding: '6px 10px' }}>
              From your loan team: {it.external_note.text}
            </div>
          )}
          {Array.isArray(it.still_needed) && it.still_needed.length > 0 && (
            <div style={{ color: MUTED, marginTop: 4, fontSize: 13 }}>Still needed: {it.still_needed.join(' · ')}</div>
          )}

          {/* THE ACTION */}
          {isInfo && field ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {field.options && field.options.length ? (
                <select value={value} onChange={(e) => setValue(e.target.value)} disabled={busy}
                  style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${LINE}`, minWidth: 200 }}>
                  <option value="">Choose…</option>
                  {field.options.map((o) => <option key={String(o.value != null ? o.value : o)} value={String(o.value != null ? o.value : o)}>{String(o.label || o)}</option>)}
                </select>
              ) : (
                <input value={value} onChange={(e) => setValue(e.target.value)} disabled={busy}
                  type={field.type === 'number' || field.type === 'money' || field.type === 'int' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                  placeholder={field.label || 'Type your answer'}
                  style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${LINE}`, minWidth: 220, flex: '1 1 220px' }} />
              )}
              <button type="button" disabled={busy || !String(value).trim()} onClick={saveInfo}
                style={btnStyle(true)}>{busy ? 'Saving…' : 'Save to my file'}</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => upload(e.target.files)} />
              <button type="button" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()} style={btnStyle(true)}>
                {busy ? 'Uploading…' : '⬆ Upload for this item'}
              </button>
              {isSow && (
                <a href="https://www.yscapgroup.com/suite" target="_blank" rel="noreferrer" style={{ color: DARK, textDecoration: 'underline', fontSize: 14 }}>
                  Build your rehab budget (scope of work) in our Investor Suite → then upload it here
                </a>
              )}
              {isTrackRecord && (
                <span style={{ color: MUTED, fontSize: 13 }}>
                  Upload your completed-project documents (settlement statements, deeds, leases) — your loan team fills your track record from them.
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function btnStyle(primary) {
  return {
    padding: '10px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 600,
    border: `1px solid ${primary ? DARK : LINE}`,
    background: primary ? DARK : '#fff', color: primary ? '#fff' : DARK,
  };
}
