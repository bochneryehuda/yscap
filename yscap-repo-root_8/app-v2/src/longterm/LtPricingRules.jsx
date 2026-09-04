import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ltApi } from './api.js';
import { INK, MUTED, SLATE, GOLD, GOLD_TEXT, CAUTION, DANGER, card, eyebrow, sub, input, label, LINE, WASH } from './ppeStyles.js';
import { askConfirm } from '../lib/dialog.js';

/**
 * THE PRICING RULE CENTER — our own rules, on top of every engine.
 *
 * ── THE OWNER'S ASK, IN WRITING (2026-09-04) ───────────────────────────────
 * *"a rule center connected to the general pricing engine. Separate section, not
 * part of the general settings, a separate center for pricing engine rules, where
 * I can manually start adding rules and it should be set up like a massive mega
 * rule center. The same type of deepness that we have on reporting rules and…
 * at the dashboard building customization."* And: *"it should actually be wired
 * in so it should not populate and it should add hold backs."* And: *"I don't
 * want you to pre-fill the rule — I want to put in the rules myself and test that
 * it actually works."*
 *
 * ── IT SHIPS EMPTY, AND SAYS SO ────────────────────────────────────────────
 * There is no starter rule, no example switched on, nothing pre-filled. The
 * screen opens on an empty list with the owner's own worked examples written out
 * as PROSE — things to write, never rules already written.
 *
 * ── IT ADDS NO RULE OF ITS OWN ─────────────────────────────────────────────
 * ⛔ Every field a rule may ask about, every operator that field takes, and
 * everything a rule may do come from the SERVER's `/catalog`. A browser working
 * any of that out again would be a second copy of the grammar the board prices
 * on, and the copy that drifts is the one somebody reads. Adding a field to the
 * registry puts it in this builder with no front-end deploy.
 *
 * ⛔ SUPER ADMIN ONLY, AND SILENT FOR EVERYBODY ELSE. Every door answers 404 to
 * anyone else, so this renders NOTHING rather than an error.
 *
 * ⛔ EVERY COLOUR IS AN EXPLICIT DARK. `--ink*` is a LIGHT paper colour in this
 * palette and renders white on white; `ppeStyles` is the one place these live.
 */

const btn = {
  border: `1px solid ${LINE}`, background: '#fff', color: INK, borderRadius: 10,
  padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
const btnPrimary = { ...btn, background: GOLD, borderColor: GOLD, color: '#fff' };
const btnSoft = { ...btn, background: '#FAF8F3', borderColor: 'transparent', fontWeight: 550 };
const btnDanger = { ...btn, color: DANGER, borderColor: 'rgba(138,47,47,.28)' };
const chip = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px',
  borderRadius: 999, fontSize: 11.5, fontWeight: 700, letterSpacing: '.02em',
};

/** The owner's own examples, as things to WRITE — never as rules already written. */
const IDEAS = [
  'If the property is in a state we are not licensed in, mark it ineligible with the licensing reason.',
  'If the price came from LoanNEX, the property is in New Jersey, the loan is under a certain amount and there is a prepayment penalty, mark it ineligible.',
  'If a particular investor is quoted in a county or ZIP we will not place there, block that investor.',
  'If a program is one we refuse for a state, mark it ineligible with the reason.',
  'Add a margin holdback on a shape of loan we price more conservatively — or give a discount or a credit on one we want.',
];

const blankRow = (fields) => ({ field: (fields[0] && fields[0].key) || '', operator: 'eq', value: '' });
const blankTree = (fields) => ({ combinator: 'and', rules: [blankRow(fields)] });
const isGroup = (n) => !!n && typeof n === 'object' && Array.isArray(n.rules);

export default function LtPricingRules() {
  const [cat, setCat] = useState(null);
  const [rules, setRules] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null);      // the draft rule, or null
  const [events, setEvents] = useState(null);
  /* TWO VIEWS OF ONE CENTRE — writing the rules, and checking they work.
     Owner-directed 2026-09-04: *"open audit engines to make sure that every rule
     is actually firing."* */
  const [view, setView] = useState('rules');

  const flatFields = useMemo(
    () => (cat ? cat.groups.flatMap((g) => g.fields) : []), [cat]);
  const byKey = useMemo(
    () => Object.fromEntries(flatFields.map((f) => [f.key, f])), [flatFields]);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [c, list] = await Promise.all([ltApi.pricingRuleCatalog(), ltApi.pricingRules(showArchived)]);
      setCat(c); setRules(list.rules || []);
    } catch (e) {
      /* A 404 here is the gate, not a fault — this screen belongs to a super
         admin and says nothing at all to anybody else. */
      if (e && (e.status === 404 || e.status === 403)) setDenied(true);
      else setErr(e && e.message ? e.message : 'The rule centre could not be read.');
    } finally { setLoading(false); }
  }, [showArchived]);

  useEffect(() => { load(); }, [load]);

  if (denied) return null;

  const startNew = () => setEditing({
    name: '', note: '', engine: 'all', priority: 100, enabled: true, reason: '',
    when: blankTree(flatFields), then: [{ type: 'add_holdback', points: 0.25 }],
  });

  const openRule = (r) => setEditing({ ...r, when: isGroup(r.when) ? r.when : blankTree(flatFields) });

  const afterWrite = async () => { setEditing(null); await load(); };

  const archive = async (r) => {
    /* ⛔ `askConfirm`, NEVER `window.confirm` — PILOT's own message box, not one
       stamped with the hosting hostname. `test-app-dialog-pure.mjs` fails the
       build otherwise, and it did on the first cut of this screen. The `await` is
       load-bearing: the promise it returns is TRUTHY, so a missing one reads as
       "yes" on every click. */
    const yes = await askConfirm(
      `Take "${r.name}" out of the rule centre?\n\nIt is kept — a rule that priced a loan is the explanation for that loan's price — and it stops governing every board straight away.`,
      { title: 'Take this rule out?', confirmLabel: 'Take it out' });
    if (!yes) return;
    try { await ltApi.pricingRuleArchive(r.id); await load(); } catch (e) { setErr(String(e && e.message || e)); }
  };
  const restore = async (r) => {
    try { await ltApi.pricingRuleRestore(r.id); await load(); } catch (e) { setErr(String(e && e.message || e)); }
  };
  const toggle = async (r) => {
    try {
      await ltApi.pricingRuleSave(r.id, { ...r, enabled: !r.enabled });
      await load();
    } catch (e) { setErr(String(e && e.message || e)); }
  };

  const live = rules.filter((r) => !r.archivedAt);

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 16px 64px' }}>
      <div style={{ ...eyebrow, color: GOLD_TEXT }}>Long-Term · Pricing</div>
      <h1 style={{ margin: '2px 0 6px', fontSize: 24, color: INK }}>Pricing Rule Center</h1>
      <p style={{ ...sub, maxWidth: 720 }}>
        Our own rules, laid on top of whatever the rate sheets answer. A rule can refuse a quote,
        block an investor, add a margin holdback, give a discount or give a credit — on the General
        Pricing Engine, the Combined one, or both. Nothing here is pre-filled: with no rules every
        board prices exactly as it does today.
      </p>

      {err && (
        <div style={{ ...card, borderColor: 'rgba(138,47,47,.28)', color: DANGER, marginBottom: 14 }}>{err}</div>
      )}

      <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: `1px solid ${LINE}` }}>
        {[['rules', 'The rules'], ['audit', 'Are they firing?']].map(([k, lbl]) => (
          <button
            key={k}
            type="button"
            onClick={() => setView(k)}
            aria-current={view === k ? 'page' : undefined}
            style={{
              border: 0, background: 'none', cursor: 'pointer', padding: '9px 14px',
              fontSize: 13.5, fontWeight: view === k ? 750 : 600,
              color: view === k ? INK : SLATE,
              borderBottom: `2px solid ${view === k ? GOLD : 'transparent'}`, marginBottom: -1,
            }}
          >{lbl}</button>
        ))}
      </div>

      {view === 'audit' && <AuditView byKey={byKey} cat={cat} onOpenRule={(id) => {
        const r = rules.find((x) => x.id === id);
        if (r) { setView('rules'); openRule(r); }
      }} />}

      {view === 'rules' && (<>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <button type="button" style={btnPrimary} onClick={startNew}>Write a rule</button>
        <button type="button" style={btnSoft} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Hide the ones taken out' : 'Show the ones taken out'}
        </button>
        <button
          type="button"
          style={btnSoft}
          onClick={async () => {
            if (events) { setEvents(null); return; }
            try { setEvents((await ltApi.pricingRuleEvents()).events || []); } catch (e) { setErr(String(e && e.message || e)); }
          }}
        >
          {events ? 'Hide the history' : 'History'}
        </button>
        <span style={{ fontSize: 12.5, color: MUTED }}>
          {loading ? 'Reading…' : `${live.length} rule${live.length === 1 ? '' : 's'} in the centre`}
        </span>
      </div>

      {!loading && !live.length && !showArchived && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 6 }}>No rules yet</div>
          <p style={{ fontSize: 13.5, color: SLATE, margin: '0 0 10px', lineHeight: 1.55 }}>
            Every board prices exactly as the rate sheets answer until you write one. Things this
            centre is for:
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, color: SLATE, fontSize: 13, lineHeight: 1.7 }}>
            {IDEAS.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </div>
      )}

      {rules.map((r) => (
        <RuleCard
          key={r.id}
          rule={r}
          byKey={byKey}
          actions={cat ? cat.actions : []}
          onOpen={() => openRule(r)}
          onToggle={() => toggle(r)}
          onArchive={() => archive(r)}
          onRestore={() => restore(r)}
        />
      ))}

      {events && <History events={events} />}
      </>)}

      {editing && cat && (
        <Editor
          draft={editing}
          setDraft={setEditing}
          cat={cat}
          byKey={byKey}
          onClose={() => setEditing(null)}
          onSaved={afterWrite}
          onError={setErr}
        />
      )}
    </div>
  );
}

/**
 * THE AUDIT — is every rule actually firing?
 *
 * Owner-directed 2026-09-04: *"open audit engines to make sure that every rule
 * is actually firing."*
 *
 * ⛔ IT DERIVES NOTHING. Every verdict, every sentence and every number comes
 * from the server (`/audit`, `/audit/dry-run`), which reads them from the one
 * module the board's own overlay reads. A screen that worked out "is this rule
 * broken?" for itself would be a second opinion, and the one that drifts is the
 * one somebody acts on.
 *
 * ⛔ AN UNREADABLE LEDGER SAYS SO. Every counter would be 0, which is the exact
 * sentence "this rule has never fired" — so a database hiccup would put the
 * whole centre on screen as broken. The server reports its own `ledgerProblem`
 * and this says it could not read the numbers instead of drawing zeroes.
 */
const VERDICT = {
  broken:      { label: 'Cannot run',   bg: 'rgba(138,47,47,.10)',  fg: DANGER },
  never_fired: { label: 'Never fired',  bg: 'rgba(138,47,47,.08)',  fg: DANGER },
  stale:       { label: 'Not lately',   bg: 'rgba(176,124,42,.12)', fg: CAUTION },
  not_asked:   { label: 'No boards yet', bg: '#F3F1EC',             fg: SLATE },
  off:         { label: 'Switched off', bg: '#F3F1EC',              fg: SLATE },
  archived:    { label: 'Taken out',    bg: '#F3F1EC',              fg: MUTED },
  firing:      { label: 'Firing',       bg: 'rgba(47,127,134,.12)', fg: '#1F5C61' },
};

function AuditView({ byKey, cat, onOpenRule }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true); setErr(null);
    try { setData(await ltApi.pricingRuleAudit()); }
    catch (e) { setErr(String((e && e.message) || e)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (busy && !data) return <div style={{ ...card }}>Reading the audit…</div>;
  if (err) return <div style={{ ...card, borderColor: 'rgba(138,47,47,.28)', color: DANGER }}>{err}</div>;
  if (!data) return null;

  const rows = data.rows || [];
  const needsWork = rows.filter((r) => r.verdict === 'broken' || r.verdict === 'never_fired');

  return (
    <div>
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 750, color: INK, marginBottom: 4 }}>{data.summary}</div>
        <p style={{ ...sub, margin: '0 0 10px' }}>
          Counted over the last {data.windowDays} days, from what the boards actually did. A rule can be
          saved, switched on and in the right order and still never touch a board — this is the screen
          that says so.
        </p>
        {data.ledgerProblem && (
          <div style={{ fontSize: 12.5, color: DANGER, fontWeight: 600 }}>
            The firing record could not be read, so the numbers below are not the real ones: {data.ledgerProblem}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {Object.entries(data.counts || {}).filter(([, n]) => n > 0).map(([k, n]) => (
            <span key={k} style={{ ...chip, background: (VERDICT[k] || {}).bg || '#F3F1EC', color: (VERDICT[k] || {}).fg || SLATE }}>
              {n} {(VERDICT[k] || {}).label || k}
            </span>
          ))}
          <button type="button" style={{ ...btnSoft, marginLeft: 'auto' }} onClick={load} disabled={busy}>
            {busy ? 'Reading…' : 'Read it again'}
          </button>
        </div>
      </div>

      {!!needsWork.length && (
        <div style={{ ...card, marginBottom: 14, borderColor: 'rgba(138,47,47,.28)' }}>
          <div style={{ fontSize: 13.5, fontWeight: 750, color: DANGER, marginBottom: 6 }}>
            {needsWork.length === 1 ? 'This one needs looking at' : 'These need looking at'}
          </div>
          <p style={{ fontSize: 12.5, color: SLATE, margin: 0, lineHeight: 1.6 }}>
            A rule that refuses loans and never fires is the dangerous one: nothing goes wrong that anybody
            can see, and it is only noticed when a loan we meant to refuse gets quoted.
          </p>
        </div>
      )}

      {rows.map((r) => <AuditRow key={r.ruleId || r.name} row={r} onOpen={() => onOpenRule && onOpenRule(r.ruleId)} />)}

      {!rows.length && (
        <div style={{ ...card }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: INK, marginBottom: 4 }}>Nothing to audit yet</div>
          <p style={{ ...sub, margin: 0 }}>Write a rule and this screen will tell you whether it is doing anything.</p>
        </div>
      )}

      <FireDrill cat={cat} byKey={byKey} onOpenRule={onOpenRule} />
    </div>
  );
}

/** One rule's standing — its verdict, its own sentence, and what it has done. */
function AuditRow({ row, onOpen }) {
  const [open, setOpen] = useState(false);
  const v = VERDICT[row.verdict] || VERDICT.not_asked;
  const f = row.firing || {};
  const nums = [
    ['Boards it was asked on', f.boardsSeen],
    ['Boards it matched', f.boardsMatched],
    ['Quotes it moved the price of', f.quotesAdjusted],
    ['Quotes it refused', f.quotesRefused],
    ['Investors it blocked', f.rowsBlocked],
  ].filter(([, n]) => Number(n) > 0);

  return (
    <div style={{ ...card, marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ ...chip, background: v.bg, color: v.fg }}>{v.label}</span>
        <span style={{ fontSize: 14.5, fontWeight: 700, color: INK }}>{row.name || '(unnamed)'}</span>
        <span style={{ fontSize: 12, color: MUTED }}>
          {row.engine === 'all' ? 'Both engines' : row.engine === 'general' ? 'General engine' : 'Combined engine'} · order {row.priority}
        </span>
        <button type="button" style={{ ...btnSoft, marginLeft: 'auto' }} onClick={() => setOpen((x) => !x)}>
          {open ? 'Less' : 'More'}
        </button>
        {onOpen && row.ruleId && <button type="button" style={btnSoft} onClick={onOpen}>Open the rule</button>}
      </div>

      <div style={{ fontSize: 13, color: row.verdict === 'broken' || row.verdict === 'never_fired' ? DANGER : SLATE, marginTop: 7, lineHeight: 1.55 }}>
        {row.headline}
      </div>

      {!!(row.problems || []).length && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: DANGER, fontSize: 12.5, lineHeight: 1.7 }}>
          {row.problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
      {!!(row.unreadableRows || []).length && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: DANGER, fontSize: 12.5, lineHeight: 1.7 }}>
          {row.unreadableRows.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}

      {open && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
          <div style={{ fontSize: 12.5, color: SLATE, marginBottom: 8, lineHeight: 1.6 }}>
            <strong style={{ color: INK }}>Says:</strong> {row.says}<br />
            <strong style={{ color: INK }}>Does:</strong> {row.does}
          </div>
          {nums.length ? (
            <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit,minmax(min(13rem,100%),1fr))' }}>
              {nums.map(([k, n]) => (
                <div key={k} style={{ background: WASH, borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontSize: 11.5, color: MUTED }}>{k}</div>
                  <div style={{ fontSize: 16, fontWeight: 750, color: INK }}>{Number(n).toLocaleString()}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: MUTED }}>Nothing recorded for this rule in this period.</div>
          )}
          {f.lastAt && (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
              Last did something {new Date(f.lastAt).toLocaleString()}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * THE FIRE DRILL — one loan, every rule, and for each one that does not fire,
 * WHICH condition stopped it.
 *
 * The owner's *"make sure that every rule that you fire will actually work"* in
 * its most direct form: instead of waiting for a board to prove a rule works,
 * describe a loan and ask.
 */
function FireDrill({ cat, byKey, onOpenRule }) {
  const [open, setOpen] = useState(false);
  const [scenario, setScenario] = useState({ state: 'NJ', loanAmount: 250000, ltv: 75, dscr: 1.2, fico: 720, prepayMonths: 60 });
  const [engine, setEngine] = useState('general');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async () => {
    setBusy(true); setErr(null);
    try { setOut(await ltApi.pricingRuleDryRun({ scenario, engine })); }
    catch (e) { setErr(String((e && e.message) || e)); }
    finally { setBusy(false); }
  };

  const set = (k) => (e) => setScenario((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 750, color: INK }}>Try every rule against one loan</div>
          <div style={{ ...sub, margin: 0 }}>Describe a loan and see which rules fire — and why the others do not.</div>
        </div>
        <button type="button" style={{ ...btnSoft, marginLeft: 'auto' }} onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : 'Open'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${LINE}`, paddingTop: 12 }}>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(min(9rem,100%),1fr))' }}>
            <div><label style={label}>State</label><input style={input} value={scenario.state || ''} onChange={set('state')} /></div>
            <div><label style={label}>Loan amount</label><input style={input} value={scenario.loanAmount ?? ''} onChange={set('loanAmount')} /></div>
            <div><label style={label}>LTV (%)</label><input style={input} value={scenario.ltv ?? ''} onChange={set('ltv')} /></div>
            <div><label style={label}>DSCR</label><input style={input} value={scenario.dscr ?? ''} onChange={set('dscr')} /></div>
            <div><label style={label}>FICO</label><input style={input} value={scenario.fico ?? ''} onChange={set('fico')} /></div>
            <div><label style={label}>Prepay (months)</label><input style={input} value={scenario.prepayMonths ?? ''} onChange={set('prepayMonths')} /></div>
            <div>
              <label style={label}>Board</label>
              <select style={input} value={engine} onChange={(e) => setEngine(e.target.value)}>
                <option value="general">General engine</option>
                <option value="combined">Combined engine</option>
              </select>
            </div>
          </div>

          <button type="button" style={{ ...btnPrimary, marginTop: 10 }} onClick={run} disabled={busy}>
            {busy ? 'Trying…' : 'Try every rule'}
          </button>

          {err && <div style={{ fontSize: 12.5, color: DANGER, marginTop: 8 }}>{err}</div>}

          {out && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: INK, marginBottom: 8 }}>{out.summary}</div>
              {(out.rows || []).map((r) => (
                <div key={r.ruleId || r.name} style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 10, marginBottom: 8, background: '#fff' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ ...chip, background: r.wouldRun ? 'rgba(47,127,134,.12)' : '#F3F1EC', color: r.wouldRun ? '#1F5C61' : SLATE }}>
                      {r.wouldRun ? 'Fires' : 'Does not fire'}
                    </span>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{r.name || '(unnamed)'}</span>
                    {!r.enabled && <span style={{ fontSize: 11.5, color: MUTED }}>switched off</span>}
                    {r.archived && <span style={{ fontSize: 11.5, color: MUTED }}>taken out</span>}
                    {!r.governs && <span style={{ fontSize: 11.5, color: CAUTION }}>written for the other board</span>}
                    {onOpenRule && r.ruleId && (
                      <button type="button" style={{ ...btnSoft, marginLeft: 'auto' }} onClick={() => onOpenRule(r.ruleId)}>Open</button>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, color: r.broken ? DANGER : SLATE, marginTop: 6, lineHeight: 1.55 }}>{r.headline}</div>
                  {!r.fires && !!(r.blockers || []).length && (
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: SLATE, fontSize: 12.5, lineHeight: 1.7 }}>
                      {r.blockers.map((b, i) => <li key={i}>{b.why}</li>)}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One rule, as a card that says what it does before anybody opens it. */
function RuleCard({ rule, byKey, actions, onOpen, onToggle, onArchive, onRestore }) {
  const off = !rule.enabled;
  const gone = !!rule.archivedAt;
  const stop = (rule.then || []).find((a) => a.type === 'ineligible' || a.type === 'block_investor');
  return (
    <div style={{ ...card, marginBottom: 12, opacity: gone ? 0.72 : 1 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontSize: 15.5, fontWeight: 700, color: INK }}>{rule.name}</span>
            {gone
              ? <span style={{ ...chip, background: '#F1EFEA', color: MUTED }}>Taken out</span>
              : off
                ? <span style={{ ...chip, background: '#F1EFEA', color: MUTED }}>Switched off</span>
                : <span style={{ ...chip, background: 'rgba(174,135,70,.14)', color: GOLD_TEXT }}>In force</span>}
            <span style={{ ...chip, background: '#F5F3EE', color: SLATE }}>
              {rule.engine === 'all' ? 'Both engines' : rule.engine === 'general' ? 'General' : 'Combined'}
            </span>
            <span style={{ fontSize: 11.5, color: MUTED }}>order {rule.priority}</span>
          </div>
          <div style={{ fontSize: 13, color: SLATE, lineHeight: 1.55 }}>
            <strong style={{ color: INK }}>When</strong> {sayTree(rule.when, byKey) || 'nothing yet'}
          </div>
          <div style={{ fontSize: 13, color: SLATE, lineHeight: 1.55, marginTop: 2 }}>
            <strong style={{ color: INK }}>Then</strong> {sayActions(rule.then, actions)}
          </div>
          {stop && stop.reason && (
            <div style={{ fontSize: 12.5, color: CAUTION, marginTop: 6 }}>
              The board will say: “{stop.reason}”
            </div>
          )}
          {rule.note && <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>{rule.note}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!gone && <button type="button" style={btnSoft} onClick={onOpen}>Open</button>}
          {!gone && <button type="button" style={btn} onClick={onToggle}>{off ? 'Turn on' : 'Turn off'}</button>}
          {!gone
            ? <button type="button" style={btnDanger} onClick={onArchive}>Take out</button>
            : <button type="button" style={btnSoft} onClick={onRestore}>Put back</button>}
        </div>
      </div>
    </div>
  );
}

/** The rule in words. The SERVER writes the same sentence; this is the live one while typing. */
function sayTree(tree, byKey, depth) {
  if (!isGroup(tree) || !tree.rules.length) return '';
  const joiner = tree.combinator === 'or' ? ' or ' : ' and ';
  return tree.rules.map((n) => {
    if (isGroup(n)) { const inner = sayTree(n, byKey, (depth || 0) + 1); return inner ? `(${inner})` : ''; }
    const f = byKey[n.field];
    if (!f) return '';
    const v = Array.isArray(n.value) ? n.value.join(', ') : n.value;
    const op = OPERATOR_WORDS[n.operator] || n.operator;
    return NO_VALUE.has(n.operator) ? `${f.label} ${op}` : `${f.label} ${op} ${v === '' || v == null ? '…' : v}`;
  }).filter(Boolean).join(joiner);
}

/* The wording is the SERVER's own table, fetched with the catalogue; these two are
   only the fallback while it is still loading, so a card is never blank. */
const OPERATOR_WORDS = {
  eq: 'is', neq: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  between: 'is between', in: 'is any of', not_in: 'is none of', contains: 'contains',
  not_contains: 'does not contain', starts_with: 'starts with', ends_with: 'ends with',
  is_empty: 'is empty', not_empty: 'is not empty', is_true: 'is yes', is_false: 'is no',
  before: 'is before', after: 'is after',
};
const NO_VALUE = new Set(['is_empty', 'not_empty', 'is_true', 'is_false']);

function sayActions(list, actions) {
  const spec = Object.fromEntries((actions || []).map((a) => [a.key, a]));
  return (list || []).map((a) => {
    const s = spec[a.type];
    if (!s) return a.type;
    if (s.money) return `${s.label.toLowerCase()} of ${a.points} point${Number(a.points) === 1 ? '' : 's'}`;
    if (a.reason) return `${s.label.toLowerCase()} — ${a.reason}`;
    return s.label.toLowerCase();
  }).join('; ') || 'nothing';
}

/** The builder. */
function Editor({ draft, setDraft, cat, byKey, onClose, onSaved, onError }) {
  const [problems, setProblems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(null);
  const [scenario, setScenario] = useState({ state: 'NJ', loan: 250000, prepayMonths: 60, dscr: 1.2 });

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const flat = cat.groups.flatMap((g) => g.fields);

  const save = async () => {
    setBusy(true); setProblems([]);
    try {
      const body = {
        name: draft.name, note: draft.note, engine: draft.engine, priority: Number(draft.priority),
        enabled: !!draft.enabled, when: draft.when, then: draft.then, reason: draft.reason,
      };
      if (draft.id) await ltApi.pricingRuleSave(draft.id, body);
      else await ltApi.pricingRuleCreate(body);
      await onSaved();
    } catch (e) {
      if (e && e.body && Array.isArray(e.body.problems)) setProblems(e.body.problems);
      else if (e && Array.isArray(e.problems)) setProblems(e.problems);
      else onError(String(e && e.message || e));
    } finally { setBusy(false); }
  };

  const tryIt = async () => {
    setBusy(true); setProblems([]);
    try {
      const out = await ltApi.pricingRuleTest({
        rule: { name: draft.name || 'trying it', engine: draft.engine, when: draft.when, then: draft.then, reason: draft.reason },
        scenario,
        engine: draft.engine === 'combined' ? 'combined' : 'general',
        quote: { price: 100, points: 0, noteRate: 7.5 },
      });
      setTried(out);
    } catch (e) {
      if (e && e.body && Array.isArray(e.body.problems)) setProblems(e.body.problems);
      else onError(String(e && e.message || e));
    } finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, marginTop: 18, borderColor: GOLD }}>
      <div style={{ ...eyebrow, color: GOLD_TEXT, marginBottom: 8 }}>{draft.id ? 'Edit this rule' : 'A new rule'}</div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(min(18rem,100%),1fr))' }}>
        <div>
          <label style={label} htmlFor="pr-name">Name</label>
          <input id="pr-name" style={input} value={draft.name} onChange={(e) => set({ name: e.target.value })}
            placeholder="What you would call this rule" />
        </div>
        <div>
          <label style={label} htmlFor="pr-engine">Which engine obeys it</label>
          <select id="pr-engine" style={input} value={draft.engine} onChange={(e) => set({ engine: e.target.value })}>
            {cat.engines.map((e) => <option key={e.v} value={e.v}>{e.label}</option>)}
          </select>
        </div>
        <div>
          <label style={label} htmlFor="pr-priority">Order (lower runs first)</label>
          <input id="pr-priority" style={input} type="number" value={draft.priority}
            onChange={(e) => set({ priority: e.target.value })} />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ ...eyebrow, marginBottom: 6 }}>When</div>
        <Group tree={draft.when} fields={cat.groups} byKey={byKey} cat={cat}
          onChange={(t) => set({ when: t })} depth={0} flat={flat} />
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ ...eyebrow, marginBottom: 6 }}>Then</div>
        <Actions list={draft.then} cat={cat} onChange={(t) => set({ then: t })} />
      </div>

      <div style={{ marginTop: 14 }}>
        <label style={label} htmlFor="pr-note">A note for whoever reads this next (optional)</label>
        <input id="pr-note" style={input} value={draft.note || ''} onChange={(e) => set({ note: e.target.value })} />
      </div>

      {!!problems.length && (
        <ul style={{ margin: '14px 0 0', paddingLeft: 18, color: DANGER, fontSize: 13, lineHeight: 1.6 }}>
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${LINE}` }}>
        <div style={{ ...eyebrow, marginBottom: 6 }}>Try it before you turn it on</div>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(min(10rem,100%),1fr))' }}>
          {[['state', 'State'], ['loan', 'Loan amount'], ['prepayMonths', 'Prepay (months)'], ['dscr', 'DSCR']].map(([k, l]) => (
            <div key={k}>
              <label style={label} htmlFor={`pr-sc-${k}`}>{l}</label>
              <input id={`pr-sc-${k}`} style={input} value={scenario[k] ?? ''}
                onChange={(e) => setScenario((s) => ({ ...s, [k]: e.target.value }))} />
            </div>
          ))}
        </div>
        <button type="button" style={{ ...btnSoft, marginTop: 10 }} onClick={tryIt} disabled={busy}>Try this loan</button>
        {tried && (
          <div style={{ marginTop: 10, fontSize: 13, color: SLATE, lineHeight: 1.6 }}>
            {tried.matched
              ? (
                <>
                  <div><strong style={{ color: INK }}>It matches this loan.</strong></div>
                  {tried.wouldStop && <div style={{ color: CAUTION }}>The quote would be taken off the board: “{tried.reason}”</div>}
                  {!tried.wouldStop && tried.adjustPoints !== 0 && (
                    <div>The price would go from {tried.priceBefore} to {tried.priceAfter} ({tried.adjustPoints > 0 ? '+' : ''}{tried.adjustPoints} points).</div>
                  )}
                </>
              )
              : <div>It does not match this loan, so nothing would change.</div>}
          </div>
        )}
      </div>

      <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" style={btnPrimary} onClick={save} disabled={busy}>
          {draft.id ? 'Save this rule' : 'Add this rule'}
        </button>
        <button type="button" style={btnSoft} onClick={onClose} disabled={busy}>Cancel</button>
        {!draft.id && (
          <span style={{ fontSize: 12.5, color: MUTED, alignSelf: 'center' }}>
            A new rule is in force as soon as it is saved.
          </span>
        )}
      </div>
    </div>
  );
}

/** A group of conditions — and, one level down, a group inside it. */
function Group({ tree, fields, byKey, cat, onChange, depth, flat }) {
  const rows = tree.rules || [];
  const setRow = (i, row) => onChange({ ...tree, rules: rows.map((r, j) => (j === i ? row : r)) });
  const drop = (i) => onChange({ ...tree, rules: rows.filter((_, j) => j !== i) });

  return (
    <div style={{
      border: `1px solid ${LINE}`, borderRadius: 12, padding: 12,
      background: depth ? '#fff' : WASH,
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>Match</span>
        <select
          style={{ ...input, width: 'auto', minWidth: 150 }}
          value={tree.combinator}
          onChange={(e) => onChange({ ...tree, combinator: e.target.value })}
        >
          <option value="and">all of these</option>
          <option value="or">any of these</option>
        </select>
      </div>

      {rows.map((row, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          {isGroup(row)
            ? (
              <div>
                <Group tree={row} fields={fields} byKey={byKey} cat={cat} depth={(depth || 0) + 1} flat={flat}
                  onChange={(t) => setRow(i, t)} />
                <button type="button" style={{ ...btnSoft, marginTop: 6 }} onClick={() => drop(i)}>Remove this group</button>
              </div>
            )
            : <Row row={row} fields={fields} byKey={byKey} cat={cat} onChange={(r) => setRow(i, r)} onDrop={() => drop(i)} />}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        <button type="button" style={btnSoft}
          onClick={() => onChange({ ...tree, rules: [...rows, blankRow(flat)] })}>+ Condition</button>
        {/* ONE NESTED LEVEL, the same depth as the reporting rules, the dashboard
            builder and the condition builder — a rule nobody can read on a screen
            is a rule nobody can maintain. The number of CONDITIONS is what is
            unlimited. */}
        {!depth && (
          <button type="button" style={btnSoft}
            onClick={() => onChange({ ...tree, rules: [...rows, { combinator: 'or', rules: [blankRow(flat)] }] })}>
            + Group (any of…)
          </button>
        )}
      </div>
    </div>
  );
}

/** One condition: a field, a test, a value. */
function Row({ row, fields, byKey, cat, onChange, onDrop }) {
  const f = byKey[row.field];
  const ops = (f && cat.operatorsByType[f.type]) || [];
  const noValue = cat.noValueOperators.includes(row.operator);
  const isList = cat.listOperators.includes(row.operator);
  const isRange = cat.rangeOperators.includes(row.operator);

  const pickField = (key) => {
    const nf = byKey[key];
    const allowed = (nf && cat.operatorsByType[nf.type]) || [];
    /* THE OPERATOR FOLLOWS THE FIELD. Changing the field while keeping an
       operator its type does not take produces a rule the server refuses on
       save, which reads as the builder being broken. */
    const op = allowed.includes(row.operator) ? row.operator : allowed[0];
    onChange({ field: key, operator: op, value: cat.noValueOperators.includes(op) ? undefined : '' });
  };

  return (
    <div style={{
      display: 'grid', gap: 8, alignItems: 'end',
      gridTemplateColumns: 'repeat(auto-fit,minmax(min(11rem,100%),1fr))',
      border: `1px solid ${LINE}`, borderRadius: 10, padding: 10, background: '#fff',
    }}>
      <div>
        <label style={label}>Field</label>
        <select style={input} value={row.field} onChange={(e) => pickField(e.target.value)}>
          {fields.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div>
        <label style={label}>Test</label>
        <select style={input} value={row.operator}
          onChange={(e) => onChange({ ...row, operator: e.target.value, value: cat.noValueOperators.includes(e.target.value) ? undefined : (row.value ?? '') })}>
          {ops.map((o) => <option key={o} value={o}>{cat.operatorLabels[o] || o}</option>)}
        </select>
      </div>
      {!noValue && (
        <div>
          <label style={label}>Value</label>
          <ValueInput field={f} operator={row.operator} isList={isList} isRange={isRange}
            value={row.value} onChange={(v) => onChange({ ...row, value: v })} />
        </div>
      )}
      <div>
        <button type="button" style={btnSoft} onClick={onDrop}>Remove</button>
      </div>
      {f && f.help && (
        <div style={{ gridColumn: '1/-1', fontSize: 12, color: MUTED }}>{f.help}</div>
      )}
    </div>
  );
}

function ValueInput({ field, isList, isRange, value, onChange }) {
  if (isRange) {
    const v = Array.isArray(value) ? value : ['', ''];
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <input style={input} value={v[0] ?? ''} onChange={(e) => onChange([e.target.value, v[1] ?? ''])} placeholder="from" />
        <input style={input} value={v[1] ?? ''} onChange={(e) => onChange([v[0] ?? '', e.target.value])} placeholder="to" />
      </div>
    );
  }
  if (field && field.options && field.options.length) {
    const picked = isList ? (Array.isArray(value) ? value : []) : value;
    if (isList) {
      /* "ANY OF THE ABOVE OR ALL OF THE ABOVE" — the owner's own words. A real
         multi-select, so a licensing rule naming twelve states is one condition. */
      return (
        <select
          multiple
          size={Math.min(8, field.options.length)}
          style={{ ...input, height: 'auto', minHeight: 96 }}
          value={picked}
          onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}
        >
          {field.options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      );
    }
    return (
      <select style={input} value={picked ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Pick one…</option>
        {field.options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    );
  }
  if (isList) {
    return (
      <input style={input} value={Array.isArray(value) ? value.join(', ') : (value ?? '')}
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
        placeholder="one, two, three" />
    );
  }
  return <input style={input} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

/** What the rule does. */
function Actions({ list, cat, onChange }) {
  const spec = Object.fromEntries(cat.actions.map((a) => [a.key, a]));
  const set = (i, a) => onChange(list.map((x, j) => (j === i ? a : x)));
  return (
    <div>
      {(list || []).map((a, i) => {
        const s = spec[a.type] || {};
        return (
          <div key={i} style={{
            display: 'grid', gap: 8, alignItems: 'end', marginBottom: 8,
            gridTemplateColumns: 'repeat(auto-fit,minmax(min(12rem,100%),1fr))',
            border: `1px solid ${LINE}`, borderRadius: 10, padding: 10, background: '#fff',
          }}>
            <div>
              <label style={label}>Do</label>
              <select style={input} value={a.type} onChange={(e) => set(i, { type: e.target.value, points: 0.25, reason: a.reason || '' })}>
                {cat.actions.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </div>
            {s.money && (
              <div>
                <label style={label}>Points</label>
                <input style={input} type="number" step="0.125" min="0" max={cat.maxPoints}
                  value={a.points ?? ''} onChange={(e) => set(i, { ...a, points: e.target.value })} />
              </div>
            )}
            {(s.needsReason || a.type === 'ineligible' || a.type === 'block_investor') && (
              <div style={{ gridColumn: '1/-1' }}>
                <label style={label}>Why — this is what the board shows</label>
                <input style={input} value={a.reason || ''} onChange={(e) => set(i, { ...a, reason: e.target.value })}
                  placeholder="We are not licensed to lend in this state." />
              </div>
            )}
            <div style={{ gridColumn: '1/-1', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {s.help && <span style={{ fontSize: 12, color: MUTED, flex: '1 1 auto' }}>{s.help}</span>}
              <button type="button" style={btnSoft} onClick={() => onChange(list.filter((_, j) => j !== i))}>Remove</button>
            </div>
          </div>
        );
      })}
      <button type="button" style={btnSoft}
        onClick={() => onChange([...(list || []), { type: 'add_holdback', points: 0.25 }])}>+ Another thing to do</button>
    </div>
  );
}

/** Who changed what, and when. */
function History({ events }) {
  return (
    <div style={{ ...card, marginTop: 18 }}>
      <div style={{ ...eyebrow, marginBottom: 8 }}>History</div>
      {!events.length && <div style={{ fontSize: 13, color: MUTED }}>Nothing has happened here yet.</div>}
      {events.map((e) => (
        <div key={e.id} style={{ padding: '8px 0', borderTop: `1px solid ${LINE}`, fontSize: 13, color: SLATE }}>
          <strong style={{ color: INK }}>{e.ruleName || 'a rule'}</strong>
          {' '}was {e.action}
          {' · '}<span style={{ color: MUTED }}>{new Date(e.at).toLocaleString()}</span>
          {e.note && <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>{e.note}</div>}
        </div>
      ))}
    </div>
  );
}
