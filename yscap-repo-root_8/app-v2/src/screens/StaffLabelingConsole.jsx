import React, { useEffect, useState, useRef } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/**
 * Azure Custom Labeling Console (owner-directed 2026-07-22, R3.3).
 *
 * Super-admins train the package-splitter classifier + per-type neural
 * extractors by TAGGING past documents. This screen:
 *  1. Shows the training-readiness matrix (per doc type, how many examples
 *     are on file per project, and whether that hits the ≥5 threshold).
 *  2. Lets an admin upload a document + assign it a doc type + a project
 *     (classifier or extractor). The bytes land in the Azure blob container
 *     pilot-doc-ai-labels; a row lands in label_examples.
 *  3. Lets an admin kick off a training-run intent (records + audits; actual
 *     model training kicks off in Azure Studio against the labeled blobs).
 *
 * Super-admin only. Anything less shows an access-denied notice.
 */

const TYPE_LABEL = {
  bank_statement: 'Bank statement', insurance: "Homeowner's insurance dec page",
  operating_agreement: 'LLC operating agreement', drivers_license: "Driver's license / photo ID",
  settlement: 'Settlement statement / HUD', purchase_contract: 'Purchase contract',
};

export default function StaffLabelingConsole() {
  const { role } = useAuth();
  const isSuper = role === 'super_admin';
  const [state, setState] = useState({ loading: true, err: '' });
  const [data, setData] = useState({ examples: [], summary: {}, readyThreshold: 5, blobConfigured: false, classifierConfigured: false, docTypes: [] });
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const [addForm, setAddForm] = useState({ docType: 'bank_statement', targetProject: 'classifier', pages: '' });

  const load = React.useCallback(async () => {
    setState({ loading: true, err: '' });
    try {
      const r = await api.labelingExamples();
      setData(r || {});
      const rs = await api.labelingTrainingRuns();
      setRuns((rs && rs.runs) || []);
    } catch (e) { setState({ loading: false, err: (e && e.message) || 'failed to load' }); return; }
    setState({ loading: false, err: '' });
  }, []);
  useEffect(() => { if (isSuper) load(); }, [isSuper, load]);

  if (!isSuper) return (
    <div className="notice">Super-admin only. This screen trains the AI that reads your documents.</div>
  );

  const handleUpload = async (e) => {
    e.preventDefault();
    const f = fileRef.current && fileRef.current.files && fileRef.current.files[0];
    if (!f) { alert('Pick a file first.'); return; }
    setBusy(true);
    try {
      const dataUrl = await new Promise((res, rej) => {
        const rd = new FileReader(); rd.onerror = rej; rd.onload = () => res(rd.result); rd.readAsDataURL(f);
      });
      const b64 = String(dataUrl).split(',')[1] || '';
      await api.labelingAddExample({
        filename: f.name, contentType: f.type || 'application/pdf', dataBase64: b64,
        docType: addForm.docType, targetProject: addForm.targetProject,
        pages: addForm.pages || undefined,
      });
      fileRef.current.value = '';
      setAddForm({ ...addForm, pages: '' });
      await load();
    } catch (e) { alert('Upload failed: ' + (e && e.message || 'error')); }
    finally { setBusy(false); }
  };

  const remove = async (id) => {
    if (!window.confirm('Remove this example from training? (The uploaded file stays in Azure.)')) return;
    setBusy(true);
    try { await api.labelingDeleteExample(id); await load(); }
    catch (e) { alert('Could not remove: ' + (e && e.message || 'error')); }
    finally { setBusy(false); }
  };

  const kickTraining = async (targetProject, docType) => {
    const modelId = window.prompt(
      targetProject === 'classifier'
        ? 'Azure Custom Classification project id (e.g. pilot-doc-splitter):'
        : `Azure Custom Neural project id for ${docType} (e.g. pilot-${docType.replace(/_/g, '-')}):`,
      targetProject === 'classifier' ? 'pilot-doc-splitter' : `pilot-${(docType || '').replace(/_/g, '-')}`);
    if (!modelId || !modelId.trim()) return;
    setBusy(true);
    try {
      const r = await api.labelingRequestTraining({ targetProject, docType: targetProject === 'extractor' ? docType : null, modelId: modelId.trim() });
      if (r && r.note) alert(r.note);
      await load();
    } catch (e) { alert('Training request failed: ' + (e && e.message || 'error')); }
    finally { setBusy(false); }
  };

  const summary = data.summary || { classifier: [], extractor: [] };
  const grouped = {};
  for (const ex of (data.examples || [])) {
    const k = `${ex.target_project}:${ex.doc_type}`;
    (grouped[k] = grouped[k] || []).push(ex);
  }

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>AI Labeling Console</h2>
      <p style={{ color: 'var(--muted,#4B585C)', fontSize: 13, marginTop: 0, marginBottom: 12 }}>
        Train the AI that splits combined PDFs + reads each document type. Upload ~5 examples per
        document type per project. When both projects show <b>Ready</b> for a type, kick off training
        — the trained model reads real files without any developer changes.
      </p>

      {!data.blobConfigured && (
        <div className="error" style={{ marginBottom: 12 }}>
          Azure Blob storage is not configured. Add <code>AZURE_DOCAI_LABEL_SAS_TOKEN</code> (or
          <code> AZURE_DOCAI_LABEL_ACCOUNT_KEY</code>) in Render. Uploads are refused until then.
        </div>
      )}
      {!data.classifierConfigured && (
        <div className="notice" style={{ marginBottom: 12 }}>
          Classifier project id is not set (<code>AZURE_DOCINT_CLASSIFIER_ID</code>). Once the
          classifier is trained in Azure Studio, add that project id in Render and the splitter goes
          live automatically.
        </div>
      )}
      {state.err && <div className="error" style={{ marginBottom: 12 }}>{state.err}</div>}

      <h3 style={{ marginTop: 20 }}>Readiness matrix</h3>
      <table className="tbl" style={{ width: '100%', marginTop: 8, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--paper,#E9E4D3)' }}>
            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Document type</th>
            <th style={{ padding: '6px 8px' }}>Classifier examples</th>
            <th style={{ padding: '6px 8px' }}>Extractor examples</th>
            <th style={{ padding: '6px 8px' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {(data.docTypes || []).map((t) => {
            const cls = (summary.classifier || []).find((s) => s.docType === t) || { count: 0, ready: false };
            const ext = (summary.extractor || []).find((s) => s.docType === t) || { count: 0, ready: false };
            return (
              <tr key={t} style={{ borderBottom: '1px solid var(--paper,#F0EAD8)' }}>
                <td style={{ padding: '8px 8px' }}>{TYPE_LABEL[t] || t}</td>
                <td style={{ padding: '8px 8px', textAlign: 'center' }}>
                  <span style={{ color: cls.ready ? 'var(--good,#3F7A5B)' : 'var(--muted,#4B585C)', fontWeight: 600 }}>{cls.count}</span>
                  {cls.ready ? ' ✓' : ` / ${data.readyThreshold}`}
                </td>
                <td style={{ padding: '8px 8px', textAlign: 'center' }}>
                  <span style={{ color: ext.ready ? 'var(--good,#3F7A5B)' : 'var(--muted,#4B585C)', fontWeight: 600 }}>{ext.count}</span>
                  {ext.ready ? ' ✓' : ` / ${data.readyThreshold}`}
                </td>
                <td style={{ padding: '8px 8px', textAlign: 'right' }}>
                  <button className="btn ghost" style={{ fontSize: 11 }}
                    disabled={busy || !ext.ready} onClick={() => kickTraining('extractor', t)}>
                    Train {t} extractor
                  </button>
                </td>
              </tr>
            );
          })}
          <tr style={{ borderTop: '2px solid var(--paper,#E9E4D3)' }}>
            <td colSpan={3} style={{ padding: '10px 8px', fontStyle: 'italic', color: 'var(--muted,#4B585C)' }}>
              Classifier learns to distinguish all types at once. Train it after every type is ≥5 examples in the Classifier column.
            </td>
            <td style={{ padding: '10px 8px', textAlign: 'right' }}>
              <button className="btn primary" style={{ fontSize: 11 }}
                disabled={busy || !(summary.classifier || []).every((s) => s.ready)}
                onClick={() => kickTraining('classifier')}>Train classifier</button>
            </td>
          </tr>
        </tbody>
      </table>

      <h3 style={{ marginTop: 24 }}>Add example</h3>
      <form onSubmit={handleUpload} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end' }}>
        <label>Document type
          <select value={addForm.docType} onChange={(e) => setAddForm({ ...addForm, docType: e.target.value })}>
            {(data.docTypes || []).map((t) => <option key={t} value={t}>{TYPE_LABEL[t] || t}</option>)}
          </select>
        </label>
        <label>Project
          <select value={addForm.targetProject} onChange={(e) => setAddForm({ ...addForm, targetProject: e.target.value })}>
            <option value="classifier">Classifier (splitter)</option>
            <option value="extractor">Extractor (field reader)</option>
          </select>
        </label>
        <label>Pages (optional)
          <input type="text" placeholder="e.g. 1-3 (blank = all)" value={addForm.pages}
            onChange={(e) => setAddForm({ ...addForm, pages: e.target.value })}
            style={{ width: 130 }} />
        </label>
        <label>File
          <input ref={fileRef} type="file" accept="application/pdf,image/*" />
        </label>
        <button className="btn primary" type="submit" disabled={busy || !data.blobConfigured}>{busy ? 'Uploading…' : 'Upload example'}</button>
      </form>

      <h3 style={{ marginTop: 24 }}>Examples on file ({(data.examples || []).length})</h3>
      <div style={{ marginTop: 8 }}>
        {['classifier', 'extractor'].map((proj) => (
          <div key={proj} style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{proj === 'classifier' ? 'Classifier' : 'Extractor'} project</div>
            {(data.docTypes || []).map((t) => {
              const rows = grouped[`${proj}:${t}`] || [];
              if (!rows.length) return null;
              return (
                <div key={t} style={{ marginLeft: 12, marginBottom: 6 }}>
                  <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>
                    <b>{TYPE_LABEL[t] || t}</b> — {rows.length} example{rows.length === 1 ? '' : 's'}
                  </div>
                  {rows.map((ex) => (
                    <div key={ex.id} style={{ display: 'flex', gap: 10, fontSize: 12, alignItems: 'center', padding: '2px 0' }}>
                      <span style={{ color: 'var(--muted,#4B585C)' }}>{new Date(ex.uploaded_at).toLocaleString()}</span>
                      <span>{ex.original_filename}</span>
                      {ex.pages && <span style={{ color: 'var(--muted,#4B585C)' }}>· pp {ex.pages}</span>}
                      {ex.trained_at && <span style={{ color: 'var(--good,#3F7A5B)' }}>· trained</span>}
                      <button className="btn ghost" style={{ fontSize: 11 }} disabled={busy} onClick={() => remove(ex.id)}>Remove</button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <h3 style={{ marginTop: 24 }}>Training runs</h3>
      {(runs || []).length === 0 && <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>No training runs recorded yet.</div>}
      {(runs || []).map((r) => (
        <div key={r.id} style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px dashed var(--paper,#E9E4D3)' }}>
          <b>{r.target_project}{r.doc_type ? ' — ' + r.doc_type : ''}</b> ·
          {' '}model <code>{r.model_id}</code> ·
          {' '}{r.example_count} examples · {new Date(r.requested_at).toLocaleString()} ·
          {' '}<span style={{ color: r.status === 'succeeded' ? 'var(--good,#3F7A5B)' : r.status === 'failed' ? 'var(--crit,#B4483C)' : 'var(--amber,#B7791F)' }}>{r.status}</span>
        </div>
      ))}
    </div>
  );
}
