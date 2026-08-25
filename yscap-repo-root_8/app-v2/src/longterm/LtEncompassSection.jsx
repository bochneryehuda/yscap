import React, { useCallback, useEffect, useState } from 'react';
import { stamp, ago } from './format.js';
import { ltApi } from './api.js';

/**
 * The ENCOMPASS SYNCING section of one long-term file (#52, owner-directed
 * 2026-08-25): *"the pull, the refresh, the last pull, last refresh, last webhooks,
 * and stuff like that"*, plus a button that reads the loan again on the spot and
 * says what came back.
 *
 * The twin of `LtClickupSection` and built to the same three rules: everything is
 * DRAWN FROM THE SERVER's answer (this screen decides nothing about what a value
 * means), a confirmation is an INLINE two-step button (Long-Term may not import
 * RTL's dialog library, and a browser confirm is banned portal-wide), and every
 * colour is an explicit DARK — every `--ink*` token in this palette is LIGHT, so
 * one would render white on white.
 *
 * WHAT THIS SECTION IS FOR. A long-term loan reaches PILOT in two steps, and only
 * the second fills the file in: discovery finds it in the pipeline search and
 * stores nine fields, then the full read opens the loan itself. Between the two the
 * file is real and half empty — which is exactly what the owner was looking at on
 * three brand-new files, with nothing anywhere to tell "new" from "broken". Every
 * fact below already existed on the row; none of it was readable from a file.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const TEAL = '#2F7F86';
const RED = '#8A2D2D';
const GREEN = '#1F5F3F';
const AMBER = '#8A6A22';

/** A button that asks once, inline, before firing — never a browser confirm. */
function ArmedButton({ label, confirmLabel, className = 'btn', style, disabled, title, onFire }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className={className} disabled={disabled || busy} title={title}
      style={{ ...(style || {}), ...(armed ? { borderColor: GOLD, fontWeight: 700 } : {}) }}
      onClick={() => {
        if (!armed) { setArmed(true); return; }
        setArmed(false); setBusy(true);
        Promise.resolve(onFire()).finally(() => setBusy(false));
      }}>
      {busy ? 'Reading…' : armed ? (confirmLabel || `Yes — ${label}`) : label}
    </button>
  );
}

function Eyebrow({ children }) {
  return (
    <div style={{ fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase', color: MUTED, fontWeight: 700, marginBottom: 6 }}>
      {children}
    </div>
  );
}

/**
 * ONE DATE, SAID TWICE — how long ago, then exactly when.
 *
 * "10 hours ago" is what somebody actually wants to know and is useless on its own
 * for a disagreement; the exact stamp settles it. `absent` is worded by the CALLER
 * because "never read" and "Encompass has never changed it" are different facts
 * that happen to share a null.
 */
function WhenRow({ label, value, absent, hint }) {
  const exact = stamp(value);
  const rel = ago(value);
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', padding: '4px 0', borderTop: '1px solid rgba(20,27,34,.07)' }}>
      <span style={{ color: MUTED, fontSize: 12, minWidth: 190 }}>{label}</span>
      {exact ? (
        <>
          <strong style={{ color: INK, fontSize: 13 }}>{rel || exact}</strong>
          {rel ? <span style={{ color: MUTED, fontSize: 12 }}>{exact}</span> : null}
        </>
      ) : (
        <span style={{ color: MUTED, fontSize: 13 }}>{absent}</span>
      )}
      {hint ? <span style={{ color: MUTED, fontSize: 12 }}>{hint}</span> : null}
    </div>
  );
}

/** Waiting / read / refused, in the words the server chose. */
function ReadState({ data }) {
  const r = (data && data.read) || {};
  if (r.state === 'failed') {
    return (
      <div style={{ padding: 10, borderRadius: 8, background: '#FBEFEF', color: RED, fontSize: 13, lineHeight: 1.5 }}>
        <strong>The last read from Encompass was refused.</strong>
        <div style={{ marginTop: 4 }}>{r.error || r.why}</div>
        {r.everRead ? (
          <div style={{ marginTop: 4, color: INK }}>
            This file still shows what the last successful read brought back, so the figures below may be out of date.
          </div>
        ) : (
          <div style={{ marginTop: 4, color: INK }}>
            This file has never been read successfully, so only what the pipeline search returns is filled in.
          </div>
        )}
      </div>
    );
  }
  if (r.state === 'waiting') {
    return (
      <div style={{ padding: 10, borderRadius: 8, background: '#FBF4E8', color: INK, fontSize: 13, lineHeight: 1.5 }}>
        <strong>PILOT has not read this file from Encompass yet.</strong>
        <div style={{ marginTop: 4, color: MUTED }}>{r.why}</div>
      </div>
    );
  }
  return (
    <div style={{ padding: 10, borderRadius: 8, background: '#EAF3EC', color: GREEN, fontSize: 13 }}>
      <strong>This file has been read from Encompass.</strong>
    </div>
  );
}

/** What came back and what did not, as one list per step. */
function FieldList({ block, title, note }) {
  const [showAll, setShowAll] = useState(false);
  const rows = block && block.rows ? block.rows : [];
  const missing = rows.filter((f) => !f.filled);
  const shown = showAll ? rows : (missing.length ? missing : rows);
  const allThere = missing.length === 0;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ color: INK, fontWeight: 700, fontSize: 13 }}>{title}</span>
        <span style={{ color: allThere ? GREEN : AMBER, fontSize: 12, fontWeight: 600 }}>
          {block ? `${block.filled} of ${block.total} filled in` : '—'}
        </span>
        <button type="button" className="btn ghost" style={{ padding: '1px 8px', fontSize: 11 }}
          onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show only what is missing' : 'Show all'}
        </button>
      </div>
      {note ? <div style={{ color: MUTED, fontSize: 12, marginBottom: 6, lineHeight: 1.5 }}>{note}</div> : null}
      {allThere && !showAll ? (
        <div style={{ color: GREEN, fontSize: 13 }}>Everything this step brings back is filled in.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {shown.map((f) => (
                <tr key={f.column} style={{ borderTop: '1px solid rgba(20,27,34,.07)' }}>
                  <td style={{ padding: '4px 8px 4px 0', color: MUTED, whiteSpace: 'nowrap' }}>{f.label}</td>
                  <td style={{ padding: '4px 8px', color: f.filled ? INK : AMBER, fontWeight: f.filled ? 600 : 400 }}>
                    {f.filled ? String(f.value) : 'blank'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * THE BODY — everything the section DRAWS, from one payload, with no effects.
 *
 * Split out from the loader deliberately rather than as a test hook. A section
 * that fetches and draws in one component can only ever be proven to render its
 * LOADING state (server rendering cannot run effects), which is the state nobody
 * has a problem with; the states that carry the owner's facts stay unproven. As a
 * pure function of its payload this can be rendered with a real one — a file never
 * read, a file whose read was refused, a file read in full — and each asserted.
 */
export function EncompassSectionBody({ data, onRead, notice }) {
  const id = data.identity || {};
  const w = data.when || {};
  const n = data.nudge || {};
  const sw = data.switches || {};

  return (
    <div style={{ display: 'grid', gap: 14, color: INK }}>
      <div>
        <Eyebrow>The loan in Encompass</Eyebrow>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span style={{ fontWeight: 700, color: INK }}>{id.loanNumber || 'No loan number yet'}</span>
          {id.folder ? <span style={{ color: MUTED, fontSize: 13 }}>· {id.folder} folder</span> : null}
          {id.archived ? <span style={{ color: AMBER, fontSize: 12, fontWeight: 700 }}>· ARCHIVED IN ENCOMPASS</span> : null}
          {id.archivedDuplicate ? <span style={{ color: AMBER, fontSize: 12 }}>· an archived copy of a live file</span> : null}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 4, wordBreak: 'break-all' }}>
          {id.guid
            ? <>Encompass id {id.guid}</>
            : 'PILOT does not hold this loan’s Encompass id, so it cannot be opened and read.'}
        </div>
        {/* THE BUTTON CARRIES ITS OWN REASON WHEN IT CANNOT RUN. A greyed control
            with no explanation is the same dead end as one that does nothing when
            pressed — which is the complaint this whole section exists to answer. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <ArmedButton
            label="Read this file from Encompass now"
            confirmLabel="Yes — read it now"
            disabled={!!sw.blocked}
            title={sw.blocked || undefined}
            onFire={onRead} />
          {sw.blocked ? <span style={{ color: AMBER, fontSize: 12, maxWidth: 460, lineHeight: 1.5 }}>{sw.blocked}</span> : null}
        </div>
        {notice ? (
          <div style={{
            marginTop: 8, padding: '8px 10px', borderRadius: 8, fontSize: 13, lineHeight: 1.5,
            background: notice.tone === 'ok' ? '#EAF3EC' : '#FBEFEF',
            color: notice.tone === 'ok' ? GREEN : RED,
          }}>{notice.text}</div>
        ) : null}
      </div>

      <div>
        <Eyebrow>Where this file stands</Eyebrow>
        <ReadState data={data} />
      </div>

      <div>
        <Eyebrow>The pull, the refresh and the webhook</Eyebrow>
        <WhenRow label="Last read in full (the pull)" value={w.lastFullRead}
          absent="never — this file has not been opened and read yet" />
        <WhenRow label="Encompass last changed it" value={w.encompassChanged}
          absent="Encompass has not told us of a change"
          hint="Encompass’s own stamp for the loan, not ours — it being newer than the read above is what makes the file due." />
        <WhenRow label="Conditions last read" value={w.conditionsRead}
          absent="the Condition Center has not read this file" />
        <WhenRow label="Next automatic re-read" value={w.nextRotaDue}
          absent={w.rotaHours ? `once it has been read once, every ${w.rotaHours} hours from then` : 'the automatic re-read is switched off'}
          hint={w.rotaHours ? `PILOT re-reads every file at least every ${w.rotaHours} hours, whatever the stamps say.` : null} />
        <WhenRow label="Last webhook from Encompass" value={n.at}
          absent="never — Encompass has not pinged PILOT about this file"
          hint={n.viaWords ? `(${n.viaWords})` : null} />
        {n.count ? (
          <div style={{ fontSize: 12, color: MUTED, paddingTop: 4 }}>
            {/* ONE string, not three interpolations. React renders adjacent text
                nodes with separators between them, so a sentence assembled out of
                `{a} word{b}` fragments is not the sentence anybody reading the
                markup — or asserting on it — sees. */}
            {`${n.count} ping${n.count === 1 ? '' : 's'} about this file in total.`}
          </div>
        ) : null}
      </div>

      <div>
        <Eyebrow>What Encompass gave us, and what it did not</Eyebrow>
        <div style={{ display: 'grid', gap: 14 }}>
          <FieldList block={data.fields && data.fields.discovery} title="From the pipeline search"
            note="These arrive within seconds of the loan existing — PILOT finds it in Encompass’s pipeline and stores what that search returns." />
          <FieldList block={data.fields && data.fields.fullRead} title="From opening the loan itself"
            note="These need the full read. A blank here means either the file has not been read yet, or the loan in Encompass genuinely holds nothing for it." />
        </div>
      </div>
    </div>
  );
}

/** The loader: fetch the section, draw the body, run the read button. */
export default function LtEncompassSection({ loanId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    return ltApi.encompassFileSection(loanId)
      .then(setData)
      .catch((e) => setErr((e && e.message) || 'Could not read this file’s Encompass details.'));
  }, [loanId]);

  useEffect(() => { load(); }, [load]);

  const readNow = async () => {
    setNotice(null);
    try {
      const out = await ltApi.encompassFileRead(loanId);
      // The answer carries the file AS IT NOW STANDS, so the screen redraws from it
      // rather than firing a second request that could race the write.
      if (out && out.section) setData(out.section); else await load();
      setNotice({ tone: out && out.ok ? 'ok' : 'bad', text: (out && out.reason) || 'Read from Encompass.' });
    } catch (e) {
      setNotice({ tone: 'bad', text: (e && e.message) || 'The read did not work.' });
    }
  };

  if (err) return <div style={{ color: RED }}>{err}</div>;
  if (!data) return <div style={{ color: MUTED }}>Loading the Encompass section…</div>;

  return <EncompassSectionBody data={data} onRead={readNow} notice={notice} />;
}
