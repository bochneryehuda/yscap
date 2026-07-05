import React, { useEffect, useRef, useState } from 'react';

/* Secure per-file conversation with rich media. `mine` is the sender_kind that
   renders on the right. The parent supplies:
     fetchMessages() -> [...]                (channel-bound)
     send(body, { makeTask, attachment })    (attachment = {filename, contentType, dataBase64})
     downloadAttachment(docId) -> { blob, filename }
   Features: read receipts (Sent / Seen), photo + video + PDF + any-file
   attachments, and in-browser voice notes (MediaRecorder). */

const fmtSize = (n) => n == null ? '' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const readFileAsBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = rej; r.readAsDataURL(file);
});

/* Media bubble content — fetches the blob with auth and renders by kind. */
function Attachment({ m, download }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const auto = m.attachment_kind === 'image' || m.attachment_kind === 'audio' || m.attachment_kind === 'video';

  useEffect(() => {
    let alive = true, obj = null;
    if (auto && m.attachment_document_id) {
      download(m.attachment_document_id)
        .then(({ blob }) => { if (!alive) return; obj = URL.createObjectURL(blob); setUrl(obj); })
        .catch(() => alive && setErr(true));
    }
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
    // eslint-disable-next-line
  }, [m.attachment_document_id]);

  async function saveIt() {
    setBusy(true);
    try {
      const { blob, filename } = await download(m.attachment_document_id);
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u; a.download = filename || m.attachment_name || 'attachment';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 1500);
    } catch { setErr(true); }
    finally { setBusy(false); }
  }

  if (!m.attachment_document_id) return null;
  if (err) return <div className="msg-att-file">Attachment unavailable</div>;
  if (m.attachment_kind === 'image' && url)
    return <img className="msg-att-img" src={url} alt={m.attachment_name || 'photo'} onClick={saveIt} title="Click to download" />;
  if (m.attachment_kind === 'audio' && url)
    return <audio className="msg-att-audio" controls src={url} />;
  if (m.attachment_kind === 'video' && url)
    return <video className="msg-att-video" controls src={url} />;
  if (auto && !url) return <div className="msg-att-file">Loading media…</div>;
  return (
    <button className="msg-att-file" onClick={saveIt} disabled={busy} title="Download">
      <span className="ic">{m.attachment_kind === 'pdf' ? '⎙' : '📎'}</span>
      <span className="nm">{m.attachment_name || 'Attachment'}</span>
      <span className="sz">{fmtSize(m.attachment_size)}{busy ? ' · downloading…' : ''}</span>
    </button>
  );
}

export default function MessageThread({ mine, fetchMessages, send, downloadAttachment,
  title = 'Messages', header = null, hint = '', taskOption = false, bare = false }) {
  const [msgs, setMsgs] = useState(null);
  const [body, setBody] = useState('');
  const [makeTask, setMakeTask] = useState(false);
  const [pending, setPending] = useState(null);      // {filename, contentType, dataBase64, size}
  const [recState, setRecState] = useState('idle');  // idle | recording | unsupported
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const recRef = useRef(null);

  const load = () => fetchMessages().then(m => setMsgs(m || [])).catch(e => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (endRef.current) endRef.current.scrollIntoView({ block: 'nearest' }); }, [msgs]);

  async function onPickFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const dataBase64 = await readFileAsBase64(f);
      setPending({ filename: f.name, contentType: f.type || 'application/octet-stream', dataBase64, size: f.size });
      setErr('');
    } catch { setErr('Could not read that file.'); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  }

  async function toggleRecord() {
    if (recState === 'recording') { recRef.current && recRef.current.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { setRecState('unsupported'); setErr('Voice notes are not supported in this browser.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setRecState('idle');
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const dataBase64 = await readFileAsBase64(blob);
        setPending({ filename: 'voice-note.webm', contentType: blob.type, dataBase64, size: blob.size });
      };
      recRef.current = rec; rec.start(); setRecState('recording'); setErr('');
    } catch { setErr('Microphone access was denied.'); }
  }

  async function submit() {
    const text = body.trim();
    if (!text && !pending) return;
    setBusy(true); setErr('');
    try {
      await send(text, { makeTask, attachment: pending || undefined });
      setBody(''); setMakeTask(false); setPending(null);
      await load();
    } catch (e) { setErr(e.message || 'Could not send'); }
    finally { setBusy(false); }
  }

  return (
    <div className={bare ? '' : 'panel'} style={bare ? {} : { marginTop: 18 }}>
      {header || <h3 style={{ marginBottom: 10 }}>{title}</h3>}
      {hint && <p className="muted small" style={{ margin: '0 0 10px' }}>{hint}</p>}
      {err && <div className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
      <div className="msg-thread">
        {msgs == null ? <p className="muted small">Loading…</p>
          : msgs.length === 0 ? <p className="muted small">No messages yet. Start the conversation below.</p>
            : msgs.map(m => {
              const isMine = m.sender_kind === mine;
              return (
                <div key={m.id} className={`msg-row ${isMine ? 'me' : 'them'}`}>
                  <div className={`msg-bubble ${isMine ? 'me' : 'them'}`}>
                    {!isMine && <div className="msg-from">{m.sender_name || (m.sender_kind === 'staff' ? 'Loan team' : 'Borrower')}</div>}
                    <Attachment m={m} download={downloadAttachment} />
                    {m.body && <div className="msg-body">{m.body}</div>}
                    {m.checklist_item_id && (
                      <div className="msg-task">✦ Saved as task{m.task_label ? `: ${m.task_label.slice(0, 60)}` : ''}{m.task_status ? ` · ${m.task_status}` : ''}</div>
                    )}
                    <div className="msg-time">
                      {new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      {isMine && <span className="msg-receipt">{m.read_at ? ' · ✓✓ Seen' : ' · ✓ Sent'}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
        <div ref={endRef} />
      </div>

      {pending && (
        <div className="msg-pending">
          <span className="ic">{pending.contentType.startsWith('audio/') ? '🎤' : pending.contentType.startsWith('image/') ? '🖼' : pending.contentType.startsWith('video/') ? '🎬' : '📎'}</span>
          <span className="nm">{pending.filename}</span>
          <span className="sz">{fmtSize(pending.size)}</span>
          <button className="btn link small" onClick={() => setPending(null)}>Remove</button>
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
        <input ref={fileRef} type="file" style={{ display: 'none' }}
          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip" onChange={onPickFile} />
        <button className="btn ghost msg-tool" title="Attach a photo, video, PDF or file" onClick={() => fileRef.current && fileRef.current.click()}>📎</button>
        <button className={`btn ghost msg-tool ${recState === 'recording' ? 'rec' : ''}`}
          title={recState === 'recording' ? 'Stop recording' : 'Record a voice note'} onClick={toggleRecord}>
          {recState === 'recording' ? '■' : '🎤'}
        </button>
        <input className="input" placeholder={recState === 'recording' ? 'Recording voice note…' : 'Write a message…'} value={body}
          onChange={e => setBody(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && submit()} />
        <button className="btn primary" disabled={busy || (!body.trim() && !pending)} onClick={submit}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
      {taskOption && (
        <label className="muted small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={makeTask} onChange={e => setMakeTask(e.target.checked)} />
          Also save this message as a task on the file
        </label>
      )}
    </div>
  );
}
