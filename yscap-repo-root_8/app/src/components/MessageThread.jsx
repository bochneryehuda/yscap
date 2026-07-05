import React, { useEffect, useRef, useState } from 'react';

/* Secure per-file conversation with rich media, reactions and entity mentions.
   The parent supplies:
     fetchMessages() -> [...]
     send(body, { makeTask, attachment, entityRefs })
     downloadAttachment(docId) -> { blob, filename }
     react(messageId, emoji) -> toggles (optional)
     fetchMentionables() -> { users, tasks, documents, applications } (optional)
     onOpenApplication(id) (optional; entity chip navigation)
   Type @ to mention a person (they get pinged) or # to mention a task,
   document, or application — inserted as a chip linked to the real record. */

const QUICK_EMOJI = ['👍', '❤️', '✅', '👀', '🎉', '❓'];
const REF_ICON = { task: '☑', document: '⎙', application: '🏠', borrower: '👤' };
const fmtSize = (n) => n == null ? '' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const readFileAsBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = rej; r.readAsDataURL(file);
});

/* Body renderer: entity chips (#Label from entity_refs) + @mention highlights. */
function renderBody(text, refs, onRef) {
  let nodes = [String(text)];
  (refs || []).forEach((ref, ri) => {
    const tag = '#' + ref.label;
    nodes = nodes.flatMap(n => {
      if (typeof n !== 'string') return [n];
      const segs = n.split(tag);
      return segs.flatMap((seg, i) => i < segs.length - 1
        ? [seg, <button key={`r${ri}-${i}`} className="entity-chip" title={ref.type} onClick={() => onRef && onRef(ref)}>
            <span>{REF_ICON[ref.type] || '#'}</span>{ref.label}
          </button>]
        : [seg]);
    });
  });
  return nodes.flatMap((n, i) => {
    if (typeof n !== 'string') return [n];
    const parts = n.split(/(@[A-Za-z][\w.'-]*(?:\s[A-Z][\w.'-]*)?)/g);
    return parts.map((p, k) => p && p.startsWith('@') ? <span key={`m${i}-${k}`} className="mention">{p}</span> : p);
  });
}

/* Aggregate raw reaction rows into chips: emoji -> {count, mine}. */
function groupReactions(list, mineKind) {
  const map = new Map();
  (list || []).forEach(r => {
    const g = map.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
    g.count++; if (r.kind === mineKind) g.mine = true;   // approximation: my kind reacted
    map.set(r.emoji, g);
  });
  return [...map.values()];
}

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
  if (m.attachment_kind === 'audio' && url) return <audio className="msg-att-audio" controls src={url} />;
  if (m.attachment_kind === 'video' && url) return <video className="msg-att-video" controls src={url} />;
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
  react, fetchMentionables, onOpenApplication,
  title = 'Messages', header = null, hint = '', taskOption = false, bare = false }) {
  const [msgs, setMsgs] = useState(null);
  const [body, setBody] = useState('');
  const [makeTask, setMakeTask] = useState(false);
  const [pending, setPending] = useState(null);
  const [pendingRefs, setPendingRefs] = useState([]);
  const [mentionables, setMentionables] = useState(null);
  const [picker, setPicker] = useState(null);          // {trigger:'@'|'#', query, start}
  const [reactFor, setReactFor] = useState(null);      // message id with open emoji picker
  const [recState, setRecState] = useState('idle');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const recRef = useRef(null);

  const load = () => fetchMessages().then(m => setMsgs(m || [])).catch(e => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    if (fetchMentionables) fetchMentionables().then(setMentionables).catch(() => {});
    // eslint-disable-next-line
  }, []);
  useEffect(() => { if (endRef.current) endRef.current.scrollIntoView({ block: 'nearest' }); }, [msgs]);

  /* ---------- @/# autocomplete ---------- */
  function pickerItems() {
    if (!picker || !mentionables) return [];
    const q = picker.query.toLowerCase();
    const match = (arr, type) => (arr || [])
      .filter(x => !q || String(x.label).toLowerCase().includes(q))
      .slice(0, 6).map(x => ({ ...x, type }));
    if (picker.trigger === '@') return match(mentionables.users, 'user');
    return [
      ...match(mentionables.tasks, 'task'),
      ...match(mentionables.documents, 'document'),
      ...match(mentionables.applications, 'application'),
    ].slice(0, 9);
  }
  function onBodyChange(e) {
    const v = e.target.value;
    setBody(v);
    const caret = e.target.selectionStart ?? v.length;
    const upto = v.slice(0, caret);
    const m = /(^|\s)([@#])([^@#\n]{0,40})$/.exec(upto);
    if (m && (fetchMentionables || m[2] === '@')) setPicker({ trigger: m[2], query: m[3], start: caret - m[3].length - 1 });
    else setPicker(null);
  }
  function choosePick(item) {
    const label = item.label;
    const before = body.slice(0, picker.start);
    const after = body.slice(picker.start + 1 + picker.query.length);
    const token = (picker.trigger === '@' ? '@' : '#') + label;
    setBody(before + token + ' ' + after);
    if (picker.trigger === '#') {
      setPendingRefs(refs => refs.some(r => r.id === item.id && r.type === item.type)
        ? refs : [...refs, { type: item.type, id: item.id, label }]);
    }
    setPicker(null);
  }

  /* ---------- attachments & voice ---------- */
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
      const usedRefs = pendingRefs.filter(r => text.includes('#' + r.label));
      await send(text, { makeTask, attachment: pending || undefined, entityRefs: usedRefs.length ? usedRefs : undefined });
      setBody(''); setMakeTask(false); setPending(null); setPendingRefs([]); setPicker(null);
      await load();
    } catch (e) { setErr(e.message || 'Could not send'); }
    finally { setBusy(false); }
  }

  async function doReact(mid, emoji) {
    setReactFor(null);
    if (!react) return;
    try { await react(mid, emoji); await load(); } catch { /* non-fatal */ }
  }
  function onRefClick(ref) {
    if (ref.type === 'document' && downloadAttachment) {
      downloadAttachment(ref.id).then(({ blob, filename }) => {
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u; a.download = filename || ref.label; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(u), 1500);
      }).catch(() => {});
    } else if (ref.type === 'application' && onOpenApplication) onOpenApplication(ref.id);
  }

  const items = pickerItems();

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
              const rx = groupReactions(m.reactions, mine);
              return (
                <div key={m.id} className={`msg-row ${isMine ? 'me' : 'them'}`}>
                  <div className={`msg-bubble ${isMine ? 'me' : 'them'}`}>
                    {!isMine && <div className="msg-from">{m.sender_name || (m.sender_kind === 'staff' ? 'Loan team' : 'Borrower')}</div>}
                    <Attachment m={m} download={downloadAttachment} />
                    {m.body && <div className="msg-body">{renderBody(m.body, m.entity_refs, onRefClick)}</div>}
                    {m.checklist_item_id && (
                      <div className="msg-task">✦ Saved as task{m.task_label ? `: ${m.task_label.slice(0, 60)}` : ''}{m.task_status ? ` · ${m.task_status}` : ''}</div>
                    )}
                    <div className="msg-time">
                      {new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      {isMine && <span className="msg-receipt">{m.read_at ? ' · ✓✓ Seen' : ' · ✓ Sent'}</span>}
                    </div>
                    {(rx.length > 0 || react) && (
                      <div className="msg-rx-row">
                        {rx.map(g => (
                          <button key={g.emoji} className={`msg-rx ${g.mine ? 'mine' : ''}`} onClick={() => doReact(m.id, g.emoji)}>
                            {g.emoji} {g.count}
                          </button>
                        ))}
                        {react && (
                          <span style={{ position: 'relative' }}>
                            <button className="msg-rx add" title="React" onClick={() => setReactFor(reactFor === m.id ? null : m.id)}>🙂+</button>
                            {reactFor === m.id && (
                              <span className="msg-rx-pick">
                                {QUICK_EMOJI.map(e => <button key={e} onClick={() => doReact(m.id, e)}>{e}</button>)}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    )}
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

      <div style={{ position: 'relative' }}>
        {picker && items.length > 0 && (
          <div className="mention-menu">
            {items.map(it => (
              <button key={it.type + it.id} className="mention-item" onMouseDown={e => { e.preventDefault(); choosePick(it); }}>
                <span className="t">{it.type === 'user' ? '@' : REF_ICON[it.type] || '#'}</span>
                <span className="l">{it.label}</span>
                <span className="k">{it.type}{it.status ? ` · ${it.status}` : ''}</span>
              </button>
            ))}
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
          <input className="input" placeholder={recState === 'recording' ? 'Recording voice note…' : 'Message — @ mentions people, # mentions tasks, documents & properties'}
            value={body} onChange={onBodyChange}
            onKeyDown={e => {
              if (picker && items.length && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); choosePick(items[0]); return; }
              if (e.key === 'Escape') setPicker(null);
              if (e.key === 'Enter' && !e.shiftKey && !picker) submit();
            }} />
          <button className="btn primary" disabled={busy || (!body.trim() && !pending)} onClick={submit}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
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
