import React, { useEffect, useState } from 'react';
import { ltApi } from './api.js';

/**
 * The long-term side's own shell.
 *
 * The owner asked for a pipeline dashboard that is "totally different" from the
 * short-term one, so this is a brand-new shell rather than the RTL sidebar with
 * items hidden. It shares the stylesheet (one global sheet, no import, no
 * crossing) and nothing else.
 *
 * THE CONDITION CENTER IS SET ASIDE (owner-directed 2026-08-14) and says so on its
 * own screen. Its nav entry is driven by `conditionsEnabled` from the server, so
 * turning it on is a settings change and not a deploy.
 */
export default function LtLayout({ children, title }) {
  const [me, setMe] = useState(null);
  useEffect(() => {
    let alive = true;
    ltApi.me().then((m) => { if (alive) setMe(m); }).catch(() => { if (alive) setMe({}); });
    return () => { alive = false; };
  }, []);

  return (
    <div style={{ padding: '0 0 40px' }}>
      {/* The NAV lives in the sidebar, which the product switch swaps wholesale —
          the owner's "the pipeline dashboard should be totally different". Repeating
          it as a tab row here would be two navs for one side. What stays is the one
          thing a person cannot see from the nav: how much of the book they are
          looking at. */}
      {me && me.ltRole && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '8px 12px', marginBottom: 14, borderRadius: 10,
          background: '#F4F1EA', border: '1px solid rgba(174,135,70,.28)',
          fontSize: 13, color: '#4B585C',
        }}>
          <span style={{
            fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase',
            color: '#4B585C', fontWeight: 700,
          }}>Long-term</span>
          <span>{me.scope === 'all' ? 'You see every long-term file' : 'You see your own long-term files'}</span>
        </div>
      )}
      {title && <h1 style={{ margin: '0 0 14px', fontSize: 24, color: '#141B22' }}>{title}</h1>}
      {children}
    </div>
  );
}
