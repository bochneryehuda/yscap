import React, { useEffect, useState } from 'react';

/* THE FILE-OVERVIEW SLIDE-OVER (owner-directed 2026-08-18): a left-side panel
   on every file screen — staff, borrower and broker — with the whole deal at a
   glance: who, the property and transaction, the loan structure, and the
   liquidity picture. ONE component for all three surfaces; only the fetcher
   differs (each surface passes its own API call, so the audience boundary
   lives on the server, never here).

   A slim vertical tab sits on the left edge; clicking it slides the panel out
   over a backdrop. Esc or the backdrop closes it. The payload is fetched when
   first opened (and kept for the visit), so a closed tab costs nothing. */
export default function FileOverviewSlideOver({ fetcher, title = 'File overview' }) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState(null);
  const [state, setState] = useState('idle'); // idle | loading | ready | error

  useEffect(() => {
    if (!open || state === 'ready' || state === 'loading') return;
    setState('loading');
    Promise.resolve()
      .then(() => fetcher())
      .then((c) => { setCard(c); setState('ready'); })
      .catch(() => setState('error'));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button type="button" className="fov-tab" onClick={() => setOpen(true)}
        title="Open the file overview — the whole deal at a glance" aria-expanded={open}>
        <span className="fov-tab-text">{title}</span>
      </button>
      {open && <div className="fov-back" onClick={() => setOpen(false)} />}
      <aside className={`fov-panel${open ? ' fov-open' : ''}`} aria-hidden={!open} role="dialog" aria-label={title}>
        <div className="fov-head">
          <div>
            <div className="fov-eyebrow">{title}</div>
            {card && card.header && (
              <div className="fov-title">
                {card.header.address || 'This file'}
                {card.header.loanNumber && <span className="fov-loanno">{card.header.loanNumber}</span>}
              </div>
            )}
          </div>
          <button type="button" className="fov-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
        </div>
        <div className="fov-body">
          {state === 'loading' && <p className="fov-muted">Loading…</p>}
          {state === 'error' && (
            <p className="fov-muted">
              Couldn’t load the overview.{' '}
              <button type="button" className="fov-retry" onClick={() => setState('idle')}>Try again</button>
            </p>
          )}
          {state === 'ready' && card && (card.sections || []).map((sec) => (
            <section className="fov-sec" key={sec.title}>
              <div className="fov-sec-h">{sec.title}</div>
              <dl className="fov-rows">
                {sec.rows.map((r) => (
                  <div className={`fov-row${r.strong ? ' fov-strong' : ''}`} key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {state === 'ready' && card && !(card.sections || []).length && (
            <p className="fov-muted">Nothing to show yet — figures appear as the file is priced and registered.</p>
          )}
        </div>
      </aside>
    </>
  );
}
