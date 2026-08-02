import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* THE DOCUMENT DOSSIER — one document's whole story.
   Owner-directed 2026-08-02: the Documents & exports list said "General upload"
   for anything not on a condition and showed a one-word status. This panel
   answers the four questions that were missing: WHERE did it land, WHY was it
   asked for, WHAT is it, and WHAT HAPPENED to it.

   TEXT COLOR RULE (session rule): never a `--ink*` token — those are LIGHT
   (page background). Primary text #141B22, secondary #4B585C. */
const INK = '#141B22';
const MUTED = '#4B585C';

const TONE_COLOR = {
  ok: 'var(--ok,#2F7F86)', bad: 'var(--danger,#B3261E)',
  warn: 'var(--gold,#AE8746)', outstanding: 'var(--gold,#AE8746)',
  muted: MUTED, info: MUTED,
};

function when(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function Row({ label, children }) {
  if (children == null || children === '' || children === false) return null;
  return (
    <div style={{ display: 'flex', gap: 10, padding: '3px 0', alignItems: 'baseline' }}>
      <span style={{ flex: 'none', width: 128, color: MUTED, fontSize: 12 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, color: INK, fontSize: 13, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

function Block({ title, children, note }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 600, color: INK, fontSize: 13, marginBottom: 4 }}>{title}</div>
      {note && <div style={{ color: MUTED, fontSize: 12, marginBottom: 6 }}>{note}</div>}
      {children}
    </div>
  );
}

/** The event timeline — oldest first, because a document's history reads as a
    story rather than as a news feed. */
function Timeline({ events }) {
  if (!events || !events.length) {
    return <p style={{ color: MUTED, fontSize: 12 }}>Nothing has happened to this document yet beyond its upload.</p>;
  }
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, borderLeft: '2px solid var(--line,#EAE4D7)' }}>
      {events.map((e, i) => (
        <li key={i} style={{ position: 'relative', padding: '7px 0 7px 14px' }}>
          <span aria-hidden style={{ position: 'absolute', left: -10, top: 7, fontSize: 13, lineHeight: '16px' }}>{e.icon || '•'}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <strong style={{ color: TONE_COLOR[e.tone] || INK, fontSize: 13 }}>{e.title}</strong>
            {e.actor && <span style={{ color: MUTED, fontSize: 12 }}>by {e.actor}</span>}
            <span style={{ flex: 1 }} />
            <span style={{ color: MUTED, fontSize: 11, whiteSpace: 'nowrap' }}>{when(e.at) || 'time not recorded'}</span>
          </div>
          {e.detail && (
            <div style={{ color: MUTED, fontSize: 12, marginTop: 2, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{e.detail}</div>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * `docId` is all this needs — it loads its own dossier the first time it is
 * opened and keeps it, so opening a row is cheap and closing it loses nothing.
 */
export default function DocumentDossier({ docId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    let alive = true;
    api.staffDocDossier(docId)
      .then((d) => { if (alive) { setData(d); setErr(''); } })
      .catch((e) => { if (alive) setErr((e && e.message) || 'Could not load this document’s history.'); });
    return () => { alive = false; };
  }, [docId]);
  useEffect(load, [load]);

  if (err) return <p style={{ color: 'var(--danger,#B3261E)', fontSize: 12, margin: '8px 0' }}>{err}</p>;
  if (!data) return <p style={{ color: MUTED, fontSize: 12, margin: '8px 0' }}>Loading this document’s history…</p>;

  const { identity: id, placement: pl, purpose: pu, review, storage, authenticity, versions, timeline, counts } = data;
  const cond = pl && pl.condition;
  const roles = data.roles || [];
  const access = data.access || [];

  return (
    <div style={{ marginTop: 8, padding: '12px 14px', background: 'var(--paper,#F6F3EC)', borderRadius: 10, border: '1px solid var(--line,#EAE4D7)' }}>

      {/* WHY — the headline, because "what is this for" is the first question. */}
      <div style={{ color: INK, fontSize: 13, fontWeight: 600 }}>{pu.headline}</div>
      {pu.why && pu.why.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: MUTED, fontSize: 12 }}>
          {pu.why.map((w, i) => <li key={i} style={{ marginBottom: 2 }}>{w}</li>)}
        </ul>
      )}

      {/* WHERE */}
      <Block title="Where it lives">
        {pl.lines.map((l, i) => (
          <div key={i} style={{ color: MUTED, fontSize: 12, marginBottom: 2 }}>{l}</div>
        ))}
        {cond && (
          <div style={{ marginTop: 6 }}>
            <Row label="Condition">{cond.label}</Row>
            <Row label="Its status">{[cond.status, cond.isGate ? 'gate' : null, cond.isRequired ? 'required' : 'optional'].filter(Boolean).join(' · ')}</Row>
            <Row label="Shown to">{cond.audience}</Row>
            <Row label="Signed off">{cond.signedOffAt ? `${when(cond.signedOffAt)}${cond.signedOffBy ? ` by ${cond.signedOffBy}` : ''}` : (cond.waivedAt ? `Waived ${when(cond.waivedAt)}` : 'Not yet')}</Row>
          </div>
        )}
      </Block>

      {/* WHAT */}
      <Block title="The document itself">
        <Row label="File">{id.filename}</Row>
        <Row label="Kind">{id.kind}</Row>
        <Row label="Size / type">{[id.size, id.contentType].filter(Boolean).join(' · ')}</Row>
        <Row label="Pages">{id.pages}</Row>
        <Row label="Uploaded">{[when(id.uploadedAt), id.uploadedBy ? `by ${id.uploadedBy}` : null].filter(Boolean).join(' ')}</Row>
        <Row label="Arrived as">{id.arrivedAs}</Row>
        <Row label="Visible to">{id.visibility}</Row>
        <Row label="Fingerprint">{id.sha256 ? <code style={{ fontSize: 11 }}>{id.sha256.slice(0, 16)}…</code> : null}</Row>
        {authenticity && (
          <Row label="Authenticity">
            <span style={{ color: TONE_COLOR[authenticity.tone] || INK }}>
              {authenticity.label}{authenticity.score == null ? '' : ` (score ${authenticity.score})`}
            </span>
          </Row>
        )}
      </Block>

      {/* REVIEW */}
      <Block title="Review">
        <Row label="Status">
          <span style={{ color: TONE_COLOR[review.tone] || INK, fontWeight: 600 }}>{review.label}</span>
        </Row>
        <Row label="What it means">{review.note}</Row>
        <Row label="Reviewed">{review.reviewedAt ? `${when(review.reviewedAt)}${review.reviewedBy ? ` by ${review.reviewedBy}` : ''}` : null}</Row>
        <Row label="Rejected for">{review.rejectionReason}</Row>
      </Block>

      {/* SYNC */}
      <Block title="Backup & sync">
        <Row label="SharePoint">
          <span style={{ color: TONE_COLOR[storage.mirror.tone] || INK }}>{storage.mirror.label}</span>
          {storage.syncedAt ? <span style={{ color: MUTED }}> · {when(storage.syncedAt)}</span> : null}
        </Row>
        <Row label="Integrity">{storage.integrity ? <span style={{ color: TONE_COLOR[storage.integrity.tone] || INK }}>{storage.integrity.label}</span> : null}</Row>
        <Row label="Last error">{storage.error || storage.deadReason}</Row>
        <Row label="Not mirrored">{storage.skippedReason}</Row>
        {storage.webUrl && (
          <Row label="In SharePoint">
            <a href={storage.webUrl} target="_blank" rel="noreferrer">Open the mirrored copy</a>
          </Row>
        )}
      </Block>

      {/* VERSIONS */}
      {versions && versions.length > 0 && (
        <Block title={`Versions (${versions.length})`}>
          {versions.map((v) => (
            <div key={`${v.relation}-${v.id}`} style={{ color: MUTED, fontSize: 12, marginBottom: 2 }}>
              {v.relation === 'replaced_by' ? 'Replaced by' : 'It replaced'} <span style={{ color: INK }}>{v.filename}</span> · {when(v.created_at)} · {v.review_status}
            </div>
          ))}
        </Block>
      )}

      {/* WHAT IT IS ELSEWHERE — the credit report, the appraisal, the signed
          package. A document that IS something has that fact recorded on
          another table entirely; this is where it surfaces. */}
      {roles.length > 0 && (
        <Block title="It is also">
          {roles.map((r, i) => (
            <div key={i} style={{ color: MUTED, fontSize: 12, marginBottom: 2 }}>
              This document is <span style={{ color: INK }}>{r.label}</span>
              {r.at ? ` · ${when(r.at)}` : ''}
              {r.middle_score ? ` · middle score ${r.middle_score}` : ''}
              {r.flood_zone ? ` · zone ${r.flood_zone}` : ''}
              {r.status ? ` · ${r.status}` : ''}
              {r.superseded ? ' · superseded' : ''}
            </div>
          ))}
        </Block>
      )}

      {/* HISTORY */}
      <Block title={`History — ${counts.events} event${counts.events === 1 ? '' : 's'}`}
        note="Oldest first — everything that has happened to this document.">
        <Timeline events={timeline} />
      </Block>

      {/* WHO LOOKED AT IT. Kept out of the timeline on purpose: a busy document
          produces hundreds of views and would drown its own story. */}
      {access.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', color: INK, fontWeight: 600, fontSize: 13 }}>
            Who opened it — {access.length} access record{access.length === 1 ? '' : 's'}
            {access.some((a) => a.denied) && (
              <span style={{ color: 'var(--danger,#B3261E)', fontWeight: 400 }}> · includes refused attempts</span>
            )}
          </summary>
          <div style={{ marginTop: 6, maxHeight: 260, overflowY: 'auto' }}>
            {access.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12, flexWrap: 'wrap' }}>
                <span style={{ color: MUTED, minWidth: 150 }}>{when(a.at)}</span>
                <span style={{ color: a.denied ? 'var(--danger,#B3261E)' : INK, flex: 1, minWidth: 180 }}>
                  <strong>{a.who}</strong>{a.role ? ` (${String(a.role).replace(/_/g, ' ')})` : ''} — {a.what}
                </span>
                {a.ip && <span style={{ color: MUTED }}>{a.ip}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
