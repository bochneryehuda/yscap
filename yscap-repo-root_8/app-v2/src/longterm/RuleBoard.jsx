import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { INK, MUTED, SLATE, PAPER, DANGER, CAUTION, card, h2, sub, eyebrow, input, mono, label } from './ppeStyles.js';

// ---------------------------------------------------------------------------
// THE RULE BOARD — what our engine's own rules actually are, and a place to draft one.
//
// WHAT WAS WRONG. Five routes on this surface were built, tested and reachable by nothing a person
// can press: the stored rule set, its coverage read, the suggestion miner, the rate-sheet version
// diff, and a program's Lender Price scope. Beneath them, the whole rule-AUTHORING service
// (`ppe/rule-authoring.js`, `rule-authoring-store.js`, and the two libraries under them) had no HTTP
// door at all. So "our engine enforces these rules" was a sentence with no screen behind it: nobody
// could see the rules, nobody could see where they double-charge, and nobody could write one.
//
// ⛔ THE ONE THING THIS SCREEN MUST NEVER BLUR: A DRAFT IS NOT IN FORCE. A draft is stored in its own
// table that nothing in the pricing path reads, so it prices nothing and declines nobody however
// finished it looks. That is said on the card, on every draft row, and beside every render — not once
// at the top where it scrolls away.
//
// ⛔ AND THERE IS NO PUBLISH BUTTON, ON PURPOSE. Publishing a rule changes what a loan is priced at.
// Who is allowed to do that is an owner decision that has not been made (§2.51 in
// docs/longterm/LENDER-PRICE-PARITY-STATUS.md), the server publishes no route for it, and this screen
// says so rather than leaving a person to wonder which button they are missing.
//
// ⛔ THE MINER IS A BUTTON, NEVER A LOAD. `POST /ppe/suggestions/mine` polls Lender Price, which is a
// live vendor call with a cost. Firing it on mount would spend money every time somebody opened this
// page, so it is only ever pressed, by somebody who has a search key in hand.
//
// SPLIT IN TWO ON PURPOSE. `RuleBoardView` is presentational and takes everything it draws;
// `RuleBoard` is the container that fetches. `renderToString` never runs `useEffect`, so a screen
// whose loaded states live inside the fetching component can only ever be tested empty — the split is
// what lets the LOADED text be asserted as rendered text rather than as source.
//
// Dark text on the white pilot canvas throughout — never a `--ink*` token, which is a LIGHT paper
// colour in this palette and renders white on white.
//
// No `window.alert` / `confirm` / `prompt`: refusals are shown inline beside the control that was
// refused, which is also where a person can act on them. (The shared dialog helper lives in RTL's
// folders and Long-Term may not import RTL code — the separation gate is right to refuse it.)
// ---------------------------------------------------------------------------

/** A short label for a rule's reach, in the words a person would use. */
export function scopeTextOf(rule, names = {}) {
  if (!rule) return '';
  if (rule.program_id) {
    const n = names.programs && names.programs[rule.program_id];
    return `This program only — ${n || rule.program_id}`;
  }
  if (rule.investor_id) {
    const n = names.investors && names.investors[rule.investor_id];
    return `This investor only — ${n || rule.investor_id}`;
  }
  return 'House rule — applies to every investor';
}

function Chip({ tone, children }) {
  const tones = {
    warn: { bg: 'rgba(174,135,70,.12)', fg: CAUTION, bd: 'rgba(174,135,70,.40)' },
    bad: { bg: 'rgba(158,58,58,.10)', fg: DANGER, bd: 'rgba(158,58,58,.32)' },
    flat: { bg: PAPER, fg: SLATE, bd: 'rgba(20,27,34,.14)' },
  };
  const t = tones[tone] || tones.flat;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12,
      fontWeight: 600, background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
    }}>{children}</span>
  );
}

function Err({ children }) {
  return <div style={{ fontSize: 13, color: DANGER, marginTop: 6 }}>{children}</div>;
}

/**
 * The board, as pure markup. Everything it draws arrives as a prop; every handler defaults to a
 * no-op so it renders on a server with nothing wired.
 */
export function RuleBoardView({
  rules = null, rulesError = '', names = {},
  coverage = null, coverageError = '',
  programs = null,
  mine = null, mineError = '', mineKey = '', onMineKey = () => {}, onMine = () => {},
  diff = null, diffError = '', diffVersion = '', onDiffVersion = () => {},
  diffAgainst = '', onDiffAgainst = () => {}, onDiff = () => {},
  lpScope = null, lpScopeError = '', lpProgram = '', onLpProgram = () => {}, onLpScope = () => {},
  drafts = null, draftsError = '', catalog = null,
  draftOp = 'add_llpa', onDraftOp = () => {},
  draftDetails = '', onDraftDetails = () => {},
  draftNote = '', onDraftNote = () => {},
  draftSaveError = '', draftRefusals = [], draftWarnings = [],
  onSaveDraft = () => {},
  openDraft = null, openDraftError = '', onOpenDraft = () => {},
  rendered = null, renderedError = '', onRenderDraft = () => {},
  onDiscardDraft = () => {}, discardError = '',
  onPublishDraft = () => {}, publishArmedId = null, publishError = '', published = null,
  busy = false,
}) {
  const ruleRows = Array.isArray(rules) ? rules : [];
  const overlaps = (coverage && Array.isArray(coverage.overlaps)) ? coverage.overlaps : [];
  const gaps = (coverage && Array.isArray(coverage.gaps)) ? coverage.gaps : [];
  const skipped = (coverage && coverage.analyzed && Array.isArray(coverage.analyzed.gapsSkippedOn))
    ? coverage.analyzed.gapsSkippedOn : [];
  const draftRows = Array.isArray(drafts) ? drafts : [];
  const programRows = (programs && Array.isArray(programs.programs)) ? programs.programs : [];
  const intents = (catalog && Array.isArray(catalog.intents)) ? catalog.intents : [];

  return (
    <>
      {/* ---- the rules our engine actually enforces ---- */}
      <div style={card}>
        <h2 style={h2}>Rules in force</h2>
        <p style={sub}>
          Every rule our engine evaluates, with how far it reaches. A house rule applies to every
          investor; the others are narrowed to one investor or one of its programs.
        </p>
        {rulesError ? <Err>{rulesError}</Err> : null}
        {!rulesError && rules && ruleRows.length === 0 ? (
          <p style={{ ...sub, marginBottom: 0 }}>
            No rules are in force. Our engine prices from the rate sheet alone, with no overlay of ours
            on top of it.
          </p>
        ) : null}
        {!rulesError && ruleRows.length > 0 ? (
          <div>
            <p style={sub}>{ruleRows.length} rules in force.</p>
            {ruleRows.map((r) => (
              <div key={r.id} style={{ borderTop: '1px solid rgba(20,27,34,.10)', padding: '10px 0' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: INK, fontWeight: 600 }}>{r.code}</span>
                  <Chip tone="flat">{r.kind}</Chip>
                  <Chip tone="flat">{r.source || 'base'}</Chip>
                </div>
                <div style={{ fontSize: 13, color: SLATE, marginTop: 2 }}>{scopeTextOf(r, names)}</div>
                {r.description ? (
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{r.description}</div>
                ) : null}
                {r.decline_reason ? (
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>Declines with: {r.decline_reason}</div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* ---- what that set does to itself ---- */}
      <div style={card}>
        <h2 style={h2}>Where those rules overlap, and where they stop</h2>
        <p style={sub}>
          Two pricing rules that both fire on one loan adjust it twice. A hole is a band nothing
          charges on, between bands that do — often deliberate, always worth answering. This reports;
          it refuses nothing.
        </p>
        {coverageError ? <Err>{coverageError}</Err> : null}
        {!coverageError && coverage ? (
          <p style={sub}>
            {(coverage.analyzed && coverage.analyzed.banded) || 0} of{' '}
            {(coverage.analyzed && coverage.analyzed.pricingRules) || 0} pricing rules could be read as
            a band. Only those were checked for overlap.
          </p>
        ) : null}
        {!coverageError && coverage && overlaps.length === 0 && gaps.length === 0 ? (
          <p style={{ ...sub, marginBottom: 0 }}>
            No overlap and no hole was found in what could be read.
          </p>
        ) : null}
        {overlaps.length > 0 ? (
          <div>
            <div style={eyebrow}>Charged twice</div>
            {overlaps.map((o, i) => (
              <div key={`o${i}`} style={{ fontSize: 13, color: SLATE, padding: '6px 0' }}>{o.detail}</div>
            ))}
          </div>
        ) : null}
        {gaps.length > 0 ? (
          <div style={{ marginTop: 10 }}>
            <div style={eyebrow}>Nothing charges here</div>
            {gaps.map((g, i) => (
              <div key={`g${i}`} style={{ fontSize: 13, color: SLATE, padding: '6px 0' }}>{g.detail}</div>
            ))}
          </div>
        ) : null}
        {skipped.length > 0 ? (
          <p style={{ ...sub, marginTop: 10, marginBottom: 0, color: CAUTION }}>
            Holes were not looked for on {skipped.join(', ')}, so an empty list above is not a clean
            bill of health on those.
          </p>
        ) : null}
      </div>

      {/* ---- mining new proposals out of a Lender Price decline ---- */}
      <div style={card}>
        <h2 style={h2}>Mine new rule suggestions from a Lender Price decline</h2>
        <p style={sub}>
          Lender Price computes its disqualifications asynchronously and hands back a search key. Given
          that key, this turns their declines into PROPOSALS a person can accept — it never writes a
          rule. It costs a live Lender Price call, so it only runs when this button is pressed.
        </p>
        <label style={label} htmlFor="lt-mine-key">Search key from a disqualify kickoff</label>
        <input
          id="lt-mine-key"
          style={{ ...input, maxWidth: 420 }}
          value={mineKey}
          onChange={(e) => onMineKey(e.target.value)}
          placeholder="the searchKey Lender Price returned"
        />
        <div style={{ marginTop: 8 }}>
          <button className="btn" disabled={busy || !mineKey.trim()} onClick={onMine}>
            Mine suggestions (costs a Lender Price call)
          </button>
        </div>
        {mineError ? <Err>{mineError}</Err> : null}
        {mine && mine.status === 'computing' ? (
          <p style={{ ...sub, marginTop: 8, marginBottom: 0, color: CAUTION }}>
            Lender Price is still computing that disqualification. Nothing was mined; try the same key
            again shortly.
          </p>
        ) : null}
        {mine && mine.status !== 'computing' ? (
          <p style={{ ...sub, marginTop: 8, marginBottom: 0 }}>
            Saved {typeof mine.saved === 'number' ? mine.saved : 0} proposals out of{' '}
            {typeof mine.suggestionCount === 'number' ? mine.suggestionCount : 0} mined, across{' '}
            {typeof mine.investorCount === 'number' ? mine.investorCount : 0} investors. They are
            proposals: each one waits for a person to accept it before it becomes a rule.
          </p>
        ) : null}
        {mine && typeof mine.unmappedCount === 'number' && mine.unmappedCount > 0 ? (
          <p style={{ ...sub, marginTop: 6, marginBottom: 0, color: CAUTION }}>
            {mine.unmappedCount} of their declines could not be mapped onto anything we price, so no
            proposal was made for those. They are not agreements.
          </p>
        ) : null}
      </div>

      {/* ---- what changed between two versions of a rate sheet ---- */}
      <div style={card}>
        <h2 style={h2}>What changed between two versions of a rate sheet</h2>
        <p style={sub}>
          A new version is loaded by pasting a vendor&apos;s grid over the last one. This says which
          cells actually moved, and splits ordinary numeric refreshes from changes that need reading.
          It applies nothing.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 260 }}>
            <label style={label} htmlFor="lt-diff-version">Rate-sheet version id</label>
            <input id="lt-diff-version" style={input} value={diffVersion} onChange={(e) => onDiffVersion(e.target.value)} />
          </div>
          <div style={{ minWidth: 260 }}>
            <label style={label} htmlFor="lt-diff-against">Compare against (optional)</label>
            <input id="lt-diff-against" style={input} value={diffAgainst} onChange={(e) => onDiffAgainst(e.target.value)} placeholder="the previous version of this program" />
          </div>
          <button className="btn" disabled={busy || !diffVersion.trim()} onClick={onDiff}>Compare</button>
        </div>
        {diffError ? <Err>{diffError}</Err> : null}
        {diff && !diff.against ? (
          <p style={{ ...sub, marginTop: 8, marginBottom: 0 }}>{diff.note}</p>
        ) : null}
        {diff && diff.against ? (
          <div style={{ marginTop: 8 }}>
            <p style={sub}>
              {(diff.changed || []).length} cells moved, {(diff.added || []).length} added,{' '}
              {(diff.removed || []).length} removed, {typeof diff.unchanged === 'number' ? diff.unchanged : 0}{' '}
              unchanged.
            </p>
            <p style={{ ...sub, marginBottom: 0 }}>
              {(diff.needsReading || []).length} of those need reading — a rule change or a large move —
              and {(diff.ordinary || []).length} are ordinary numeric refreshes. Nothing here was
              applied, published or accepted.
            </p>
          </div>
        ) : null}
      </div>

      {/* ---- a program's Lender Price scope, read from the server ---- */}
      <div style={card}>
        <h2 style={h2}>A program&apos;s Lender Price scope</h2>
        <p style={sub}>
          Which of Lender Price&apos;s programs one of our sheets is measured against. Setting a scope
          re-reads it from the write&apos;s own answer, which proves the request was accepted and
          nothing about what is stored. This is the read that can disagree with it.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 300 }}>
            <label style={label} htmlFor="lt-scope-program">Program</label>
            <select id="lt-scope-program" className="input" value={lpProgram} onChange={(e) => onLpProgram(e.target.value)}>
              <option value="">Pick a program</option>
              {programRows.map((p) => (
                <option key={p.id} value={p.id}>{p.name || p.code || p.id}</option>
              ))}
            </select>
          </div>
          <button className="btn" disabled={busy || !lpProgram} onClick={onLpScope}>Read the stored scope</button>
        </div>
        {lpScopeError ? <Err>{lpScopeError}</Err> : null}
        {lpScope ? (
          <div style={{ marginTop: 8 }}>
            <p style={sub}>Stored scope: {lpScope.describe || 'none'}</p>
            {lpScope.note ? <p style={{ ...sub, marginBottom: 0, color: CAUTION }}>{lpScope.note}</p> : null}
            {lpScope.setBy ? <p style={{ ...sub, marginBottom: 0 }}>Set by {lpScope.setBy}.</p> : null}
          </div>
        ) : null}
      </div>

      {/* ---- drafts: authoring, which is not publishing ---- */}
      <div style={card}>
        <h2 style={h2}>Rule drafts</h2>
        <p style={{ fontSize: 13, color: DANGER, fontWeight: 600, margin: '0 0 8px' }}>
          A draft is not in force. It prices nothing and declines nobody, whatever it says.
        </p>
        <p style={sub}>
          A draft is stored in its own table. Nothing in the pricing path reads it, so it cannot move a
          priced number — that is the shape of the data, not a promise anybody has to keep.
        </p>
        <p style={{ ...sub, color: CAUTION }}>
          There is no publish button on this screen and no publish route on the server. Publishing a
          rule changes what a real loan is priced at, and who is allowed to do that has not been
          decided yet — the question is written down and waiting for the owner.
        </p>

        {/* the create form */}
        <div style={{ borderTop: '1px solid rgba(20,27,34,.10)', paddingTop: 12 }}>
          <div style={eyebrow}>Draft a rule</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 6 }}>
            <div style={{ minWidth: 260 }}>
              <label style={label} htmlFor="lt-draft-op">What to author</label>
              <select id="lt-draft-op" className="input" value={draftOp} onChange={(e) => onDraftOp(e.target.value)}>
                {intents.map((i) => <option key={i.op} value={i.op}>{i.label}</option>)}
              </select>
            </div>
            <div style={{ minWidth: 260, flex: 1 }}>
              <label style={label} htmlFor="lt-draft-note">Note (why you are drafting it)</label>
              <input id="lt-draft-note" style={input} value={draftNote} onChange={(e) => onDraftNote(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={label} htmlFor="lt-draft-details">The rest of the intent, as JSON</label>
            <textarea
              id="lt-draft-details"
              style={mono}
              value={draftDetails}
              onChange={(e) => onDraftDetails(e.target.value)}
            />
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn" disabled={busy || !draftOp} onClick={onSaveDraft}>Save as a draft</button>
          </div>
          {draftSaveError ? <Err>{draftSaveError}</Err> : null}
          {draftRefusals.length > 0 ? (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: DANGER }}>
              {draftRefusals.map((r, i) => <li key={`rf${i}`}>{r.message}</li>)}
            </ul>
          ) : null}
          {draftWarnings.length > 0 ? (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: CAUTION }}>
              {draftWarnings.map((w, i) => <li key={`wn${i}`}>{w.message}</li>)}
            </ul>
          ) : null}
        </div>

        {/* the drafts themselves */}
        {draftsError ? <Err>{draftsError}</Err> : null}
        {!draftsError && drafts && draftRows.length === 0 ? (
          <p style={{ ...sub, marginTop: 12, marginBottom: 0 }}>Nobody is drafting a rule right now.</p>
        ) : null}
        {draftRows.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            {draftRows.map((d) => (
              <div key={d.id} style={{ borderTop: '1px solid rgba(20,27,34,.10)', padding: '10px 0' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: INK, fontWeight: 600 }}>{d.code}</span>
                  <Chip tone="flat">{d.kind}</Chip>
                  <Chip tone="warn">{d.status} — not in force</Chip>
                </div>
                {d.note ? <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{d.note}</div> : null}
                <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                  <button className="btn ghost" disabled={busy} onClick={() => onOpenDraft(d)}>Open</button>
                  <button className="btn ghost" disabled={busy} onClick={() => onRenderDraft(d)}>
                    Check it against the rules in force
                  </button>
                  <button className="btn ghost" disabled={busy || d.status !== 'draft'} onClick={() => onDiscardDraft(d)}>
                    Discard
                  </button>
                  {/* THE ONE CONTROL ON THIS SCREEN THAT MOVES A PRICE, so it arms first and says
                      what it will do before it will do it. It is never hidden by role — this screen
                      cannot know the role, and the server's refusal names who may. */}
                  <button
                    className="btn"
                    disabled={busy || d.status !== 'draft'}
                    onClick={() => onPublishDraft(d)}
                  >
                    {String(publishArmedId) === String(d.id) ? 'Press again to publish it' : 'Publish it'}
                  </button>
                </div>
                {String(publishArmedId) === String(d.id) ? (
                  <div style={{ fontSize: 12, color: DANGER, marginTop: 6 }}>
                    Publishing puts this rule IN FORCE. It changes what the next borrower quoted on this
                    program is offered. Only a super admin can do it.
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {discardError ? <Err>{discardError}</Err> : null}
        {publishError ? <Err>{publishError}</Err> : null}
        {published ? (
          <div style={{ marginTop: 12, background: PAPER, borderRadius: 8, padding: 12 }}>
            <div style={eyebrow}>In force</div>
            <div style={{ fontSize: 13, color: INK, fontWeight: 600 }}>
              {(published.draft && published.draft.code) || 'That rule'} is now pricing loans.
            </div>
            <div style={{ fontSize: 12, color: SLATE, marginTop: 2 }}>
              {published.liveNote || 'It prices the next loan quoted against this program.'}
              {published.draft && published.draft.publishedBy
                ? ` Published by ${published.draft.publishedBy}.` : ''}
            </div>
            {Array.isArray(published.warnings) && published.warnings.length > 0 ? (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: CAUTION }}>
                {published.warnings.map((w, i) => <li key={`pw${i}`}>{w.message}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
        {openDraftError ? <Err>{openDraftError}</Err> : null}
        {openDraft ? (
          <div style={{ marginTop: 12, background: PAPER, borderRadius: 8, padding: 12 }}>
            <div style={eyebrow}>As it was stored</div>
            <div style={{ fontSize: 13, color: SLATE }}>
              {openDraft.code} — drafted by {openDraft.createdBy || 'somebody unnamed'}, status{' '}
              {openDraft.status}. It is not in force.
            </div>
          </div>
        ) : null}
        {renderedError ? <Err>{renderedError}</Err> : null}
        {rendered && rendered.render ? (
          <div style={{ marginTop: 12, background: PAPER, borderRadius: 8, padding: 12 }}>
            <div style={eyebrow}>Checked against the rules in force right now</div>
            <div style={{ fontSize: 14, color: INK, fontWeight: 600, marginTop: 4 }}>{rendered.render.headline}</div>
            <div style={{ fontSize: 13, color: SLATE, marginTop: 4 }}>{rendered.render.liveNote}</div>
            {(rendered.blockedBy || []).length > 0 ? (
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: DANGER }}>
                {(rendered.blockedBy || []).map((r, i) => <li key={`b${i}`}>{r.message}</li>)}
              </ul>
            ) : null}
            {(rendered.warnings || []).length > 0 ? (
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: CAUTION }}>
                {(rendered.warnings || []).map((w, i) => <li key={`rw${i}`}>{w.message}</li>)}
              </ul>
            ) : null}
            {rendered.publishNote ? (
              <p style={{ fontSize: 13, color: SLATE, margin: '8px 0 0' }}>{rendered.publishNote}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * The container. It fetches the four things a person needs on arrival — the rules, their coverage,
 * the programs (for the scope picker and for naming a rule's reach) and the open drafts — and
 * NOTHING that costs money.
 */
export default function RuleBoard() {
  const [rules, setRules] = useState(null);
  const [rulesError, setRulesError] = useState('');
  const [coverage, setCoverage] = useState(null);
  const [coverageError, setCoverageError] = useState('');
  const [programs, setPrograms] = useState(null);
  const [drafts, setDrafts] = useState(null);
  const [draftsError, setDraftsError] = useState('');
  const [catalog, setCatalog] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadRules = useCallback(() => {
    ltApi.ppeRules()
      .then((r) => { setRules((r && r.rules) || []); setRulesError(''); })
      // Said, never swallowed. An empty list drawn after a failed read says "our engine enforces
      // nothing", which is the most reassuring possible way to show a broken query.
      .catch((e) => { setRules(null); setRulesError(e.message || 'Could not read the rules in force.'); });
    ltApi.ppeRuleCoverage()
      .then((r) => { setCoverage(r); setCoverageError(''); })
      .catch((e) => { setCoverage(null); setCoverageError(e.message || 'Could not read the rule coverage.'); });
  }, []);
  useEffect(loadRules, [loadRules]);

  const loadPrograms = useCallback(() => {
    ltApi.ppePrograms().then(setPrograms).catch(() => setPrograms(null));
  }, []);
  useEffect(loadPrograms, [loadPrograms]);

  const loadDrafts = useCallback(() => {
    ltApi.ppeRuleDrafts()
      .then((r) => {
        setDrafts((r && r.drafts) || []);
        setCatalog((r && r.catalog) || null);
        setDraftsError('');
      })
      .catch((e) => { setDrafts(null); setDraftsError(e.message || 'Could not read the drafts.'); });
  }, []);
  useEffect(loadDrafts, [loadDrafts]);

  // Names for a rule's reach. Built from the programs read, which already carries the investor each
  // program hangs off — so this screen holds no second list of investors that could drift.
  const names = { programs: {}, investors: {} };
  for (const p of (programs && programs.programs) || []) {
    names.programs[p.id] = p.name || p.code || p.id;
    if (p.investorId) names.investors[p.investorId] = p.investorName || p.investorCode || p.investorId;
  }

  // ---- the miner: a button, never a load -------------------------------------------------------
  const [mineKey, setMineKey] = useState('');
  const [mine, setMine] = useState(null);
  const [mineError, setMineError] = useState('');
  const runMine = async () => {
    setBusy(true); setMineError(''); setMine(null);
    try {
      setMine(await ltApi.ppeMineSuggestions({ searchKey: mineKey.trim() }));
    } catch (e) {
      setMineError(e.message || 'That mining run was refused.');
    } finally { setBusy(false); }
  };

  // ---- the rate-sheet version diff -------------------------------------------------------------
  const [diffVersion, setDiffVersion] = useState('');
  const [diffAgainst, setDiffAgainst] = useState('');
  const [diff, setDiff] = useState(null);
  const [diffError, setDiffError] = useState('');
  const runDiff = async () => {
    setBusy(true); setDiffError(''); setDiff(null);
    try {
      setDiff(await ltApi.ppeRateSheetDiff(diffVersion.trim(), diffAgainst.trim() ? { against: diffAgainst.trim() } : {}));
    } catch (e) {
      setDiffError(e.message || 'Those two versions could not be compared.');
    } finally { setBusy(false); }
  };

  // ---- a program's stored Lender Price scope ----------------------------------------------------
  const [lpProgram, setLpProgram] = useState('');
  const [lpScope, setLpScope] = useState(null);
  const [lpScopeError, setLpScopeError] = useState('');
  const readLpScope = async () => {
    setBusy(true); setLpScopeError(''); setLpScope(null);
    try {
      setLpScope(await ltApi.ppeProgramLpScope(lpProgram));
    } catch (e) {
      setLpScopeError(e.message || 'That scope could not be read.');
    } finally { setBusy(false); }
  };

  // ---- drafting -------------------------------------------------------------------------------
  const [draftOp, setDraftOp] = useState('add_llpa');
  const [draftDetails, setDraftDetails] = useState('{\n}');
  const [draftNote, setDraftNote] = useState('');
  const [draftSaveError, setDraftSaveError] = useState('');
  const [draftRefusals, setDraftRefusals] = useState([]);
  const [draftWarnings, setDraftWarnings] = useState([]);

  const saveDraft = async () => {
    setBusy(true); setDraftSaveError(''); setDraftRefusals([]); setDraftWarnings([]);
    let details;
    try {
      details = draftDetails.trim() ? JSON.parse(draftDetails) : {};
    } catch (e) {
      // Refused HERE rather than sent: unreadable JSON would come back as a shape complaint from the
      // builder, which names a field the person never typed.
      setDraftSaveError('That is not readable JSON, so nothing was sent. Fix the braces and quotes.');
      setBusy(false);
      return;
    }
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      setDraftSaveError('The details have to be a JSON object — { … } — because they are the rest of the intent.');
      setBusy(false);
      return;
    }
    try {
      const out = await ltApi.ppeSaveRuleDraft({
        intent: { op: draftOp, ...details },
        note: draftNote.trim() || undefined,
      });
      setDraftWarnings((out && out.warnings) || []);
      setDraftDetails('{\n}');
      setDraftNote('');
      loadDrafts();
    } catch (e) {
      // The service refuses by RETURNING a list of plain-language refusals; the client turns a
      // non-2xx into a throw, so they arrive on `e.data`. Showing them is the whole point — each one
      // names what to change.
      const list = (e && e.data && Array.isArray(e.data.refusals)) ? e.data.refusals : [];
      setDraftRefusals(list);
      setDraftWarnings((e && e.data && Array.isArray(e.data.warnings)) ? e.data.warnings : []);
      if (!list.length) setDraftSaveError(e.message || 'That draft was refused.');
    } finally { setBusy(false); }
  };

  const [openDraft, setOpenDraft] = useState(null);
  const [openDraftError, setOpenDraftError] = useState('');
  const [rendered, setRendered] = useState(null);
  const [renderedError, setRenderedError] = useState('');
  const [discardError, setDiscardError] = useState('');

  const readDraft = async (d) => {
    setOpenDraftError(''); setOpenDraft(null);
    try {
      const out = await ltApi.ppeRuleDraft(d.id);
      setOpenDraft((out && out.draft) || null);
    } catch (e) { setOpenDraftError(e.message || 'That draft could not be read.'); }
  };

  const renderDraft = async (d) => {
    setRenderedError(''); setRendered(null);
    try {
      setRendered(await ltApi.ppeRenderRuleDraft(d.id));
    } catch (e) { setRenderedError(e.message || 'That draft could not be checked.'); }
  };

  // PUBLISHING ARMS FIRST. A misfired click here changes what a real borrower is quoted, so the first
  // press only states what the second one does. Arming is per DRAFT (never a single boolean), or
  // arming one row would arm the button on every other row too.
  const [publishArmedId, setPublishArmedId] = useState(null);
  const [publishError, setPublishError] = useState('');
  const [published, setPublished] = useState(null);

  const publishDraft = async (d) => {
    if (String(publishArmedId) !== String(d.id)) {
      setPublishArmedId(d.id); setPublishError(''); setPublished(null);
      return;
    }
    setBusy(true); setPublishError('');
    try {
      const out = await ltApi.ppePublishRuleDraft(d.id);
      setPublished(out || null);
      setPublishArmedId(null);
      setOpenDraft(null);
      setRendered(null);
      // RE-READ BOTH from the server. The write's own answer is not evidence of what the tables hold,
      // and the rule LIST is the one that shows it actually joined the set that prices.
      loadDrafts();
      loadRules();
    } catch (e) {
      setPublishArmedId(null);
      setPublishError(e.message || 'That rule could not be published.');
    } finally { setBusy(false); }
  };

  const discardDraft = async (d) => {
    setBusy(true); setDiscardError('');
    try {
      await ltApi.ppeDiscardRuleDraft(d.id);
      setOpenDraft(null);
      setRendered(null);
      // Re-read from the SERVER rather than dropping the row locally: the write's own 200 is not
      // evidence of what the table now holds.
      loadDrafts();
    } catch (e) { setDiscardError(e.message || 'That draft could not be discarded.'); } finally { setBusy(false); }
  };

  return (
    <RuleBoardView
      rules={rules}
      rulesError={rulesError}
      names={names}
      coverage={coverage}
      coverageError={coverageError}
      programs={programs}
      mine={mine}
      mineError={mineError}
      mineKey={mineKey}
      onMineKey={setMineKey}
      onMine={runMine}
      diff={diff}
      diffError={diffError}
      diffVersion={diffVersion}
      onDiffVersion={setDiffVersion}
      diffAgainst={diffAgainst}
      onDiffAgainst={setDiffAgainst}
      onDiff={runDiff}
      lpScope={lpScope}
      lpScopeError={lpScopeError}
      lpProgram={lpProgram}
      onLpProgram={setLpProgram}
      onLpScope={readLpScope}
      drafts={drafts}
      draftsError={draftsError}
      catalog={catalog}
      draftOp={draftOp}
      onDraftOp={setDraftOp}
      draftDetails={draftDetails}
      onDraftDetails={setDraftDetails}
      draftNote={draftNote}
      onDraftNote={setDraftNote}
      draftSaveError={draftSaveError}
      draftRefusals={draftRefusals}
      draftWarnings={draftWarnings}
      onSaveDraft={saveDraft}
      openDraft={openDraft}
      openDraftError={openDraftError}
      onOpenDraft={readDraft}
      rendered={rendered}
      renderedError={renderedError}
      onRenderDraft={renderDraft}
      onDiscardDraft={discardDraft}
      discardError={discardError}
      onPublishDraft={publishDraft}
      publishArmedId={publishArmedId}
      publishError={publishError}
      published={published}
      busy={busy}
    />
  );
}
