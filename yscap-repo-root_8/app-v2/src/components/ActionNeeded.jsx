import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

/* The borrower's cross-file "Action needed" home card (owner-directed 2026-07-20:
   "he needs to see outstanding stuff for him right away … without going into the
   file"). ONE call to /api/borrower/action-items returns everything they must do —
   signatures, fixes, documents to provide — already priority-sorted. Tapping a row
   opens the right file. Fails quiet (returns nothing) so it can never blank the
   dashboard; when there's nothing to do it renders nothing (the "all caught up"
   strip covers that). */
const KIND = {
  sign:     { chip: 'Sign now', cls: 'sign' },
  fix:      { chip: 'Needs a fix', cls: 'fix' },
  document: { chip: 'Provide', cls: 'doc' },
};

export default function ActionNeeded() {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api.actionItems()
      .then((d) => { if (live) setData(d && Array.isArray(d.items) ? d : { items: [], counts: {} }); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  if (failed || !data) return null;
  const items = data.items || [];
  if (!items.length) return null;

  const c = data.counts || {};
  const summ = [
    c.toSign ? `${c.toSign} to sign` : '',
    c.toFix ? `${c.toFix} to fix` : '',
    c.toProvide ? `${c.toProvide} to provide` : '',
  ].filter(Boolean).join('  ·  ');

  return (
    <section className="action-needed" aria-label="Action needed">
      <div className="an-head">
        <div>
          <h2 className="an-title">Action needed</h2>
          <p className="an-sub">The quickest way to move your loan forward — tap any item to take care of it.</p>
        </div>
        {summ && <span className="an-summary">{summ}</span>}
      </div>
      <ul className="an-list">
        {items.map((it) => {
          const k = KIND[it.kind] || KIND.document;
          return (
            <li key={it.id}>
              <button type="button" className={`an-item ${k.cls}`} onClick={() => nav(it.route)}>
                <span className="an-bar" aria-hidden="true" />
                <span className="an-main">
                  <span className="an-label">{it.label}</span>
                  {it.hint && <span className="an-hint">{it.hint}</span>}
                  {(it.property || it.loanNumber) && (
                    <span className="an-file">{it.property || it.loanNumber}</span>
                  )}
                </span>
                <span className={`an-chip ${k.cls}`}>{k.chip}</span>
                <svg className="an-arrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.7"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
