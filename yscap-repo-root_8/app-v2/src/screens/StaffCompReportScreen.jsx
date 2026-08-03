import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import CompReport from '../components/CompReport.jsx';
import { LAYOUTS } from '../lib/compReport.js';

/* THE REPORT, ON ITS OWN PAGE — so it prints as the document rather than as a
   printout of a working screen. The layout is in the URL, so a chosen layout can
   be sent to somebody and comes back the same. */
export default function StaffCompReportScreen() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const layout = LAYOUTS[sp.get('layout')] ? sp.get('layout') : 'standard';
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.valuation(id).then(setD).catch((e) => setErr(e.message || 'Could not load that report'));
  }, [id]);
  useEffect(() => { setD(null); setErr(''); load(); }, [id, load]);

  if (err) return <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A' }}>{err}</div>;
  if (!d) return <div className="card" style={{ color: '#4B585C' }}>Loading…</div>;

  return (
    <div>
      <div className="rpt-controls" style={{ marginBottom: 10 }}>
        <Link to={`/internal/research/valuation/${id}`} style={{ color: '#4B585C', fontSize: 13 }}>
          &larr; Back to the working screen
        </Link>
      </div>
      <CompReport
        data={d}
        layout={layout}
        onLayout={(k) => setSp({ layout: k }, { replace: true })}
      />
    </div>
  );
}
