import React from 'react';
import { EmailInput } from './FormattedInputs.jsx';

/* ONE OR MORE EMAIL ADDRESSES FOR A CONTACT (owner-directed 2026-08-20: "we
   should be able to add additional email addresses for vendors, and all emails
   should be included when we send out the orders. In the condition, we should
   also be able to add additional email addresses, which should be included for
   the insurance contact and for title contact").

   THE FIRST ONE IS THE PRIMARY, and the label says so, because the primary is not
   just the top of a list: it is what the Orders desk card, the vendors screen and
   a dozen stored `vendor_email` columns display. The rest are additional
   recipients on the same order — a title company's closing@ inbox beside the
   rundown@ one, an agent's assistant beside the agent.

   IT IS AN ARRAY OF STRINGS, INCLUDING BLANK ONES, while it is being edited, and
   the caller trims. A component that pruned blanks as you typed would delete the
   row the moment you cleared it to retype — the field would vanish under the
   cursor. `clean()` is exported so a caller never invents its own rule for what
   counts as an entered address.

   Colours are explicit darks on the white portal (the HARD RULE): every `--ink*`
   token in this palette is a LIGHT paper colour and would render the hint
   invisible. */

/** The addresses actually entered — trimmed, blanks dropped, de-duplicated. */
export function clean(list) {
  const seen = new Set();
  const out = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** A list with at least one row, so the control always shows a field to type in. */
export function atLeastOne(list) {
  const arr = Array.isArray(list) && list.length ? list.slice() : [];
  return arr.length ? arr : [''];
}

/**
 * @param value    string[] — the rows as edited (blanks allowed)
 * @param onChange (string[]) => void
 * @param disabled
 * @param max      a sanity ceiling; a contact with fifteen addresses is a mistake
 * @param compact  tighter spacing for an inline row on a condition
 */
export default function EmailListInput({ value, onChange, disabled = false, max = 8, compact = false }) {
  const rows = atLeastOne(value);
  const set = (i, v) => { const next = rows.slice(); next[i] = v; onChange(next); };
  const add = () => { if (rows.length < max) onChange(rows.concat('')); };
  const remove = (i) => {
    const next = rows.slice();
    next.splice(i, 1);
    onChange(next.length ? next : ['']);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 4 : 6, minWidth: 0 }}>
      {rows.map((v, i) => (
        <div key={i} className="row" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}>
          <EmailInput value={v} disabled={disabled} style={{ flex: 1, minWidth: 0 }}
            placeholder={i === 0 ? 'name@example.com (primary)' : 'another address on the order'}
            aria-label={i === 0 ? 'Primary email' : `Additional email ${i}`}
            onChange={(nv) => set(i, nv)} />
          {rows.length > 1 && (
            <button type="button" className="btn ghost small" disabled={disabled}
              title="Remove this address" aria-label="Remove this address"
              onClick={() => remove(i)}>✕</button>
          )}
        </div>
      ))}
      {rows.length < max && (
        <div>
          <button type="button" className="btn ghost small" disabled={disabled} onClick={add}
            title="Add another address — every one of them receives the order">
            + Add another email
          </button>
          {!compact && (
            <span className="muted small" style={{ marginLeft: 8, color: '#4B585C' }}>
              Every address here is included when the order goes out.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
