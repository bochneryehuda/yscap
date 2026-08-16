'use strict';
/**
 * "MARK TABLE FUNDED" ON THE SIGN-OFFS PANEL (owner-directed 2026-08-13) — pure.
 *
 * THE REPORT: "This file is a table-funded file. ClickUp shows 'already table
 * funded', and Campus shows 'table funded', but Pilot doesn't say 'table funded'.
 * There is no option here to select that Pilot should also be table funded … On
 * that same screen where we need to finish everything, we should have the button
 * to change Pilot to Table Funding to be able to finish requalification."
 *
 * The Sign-offs & reconciliation panel showed a read-only "Not table funded" whose
 * hint pointed at the Funding card above — a correct instruction and a bad answer:
 * the closer is standing on the screen they are trying to finish and the one thing
 * blocking them is a control in another card. The button now sits there.
 *
 * WHAT THIS FILE GUARDS is the property that made it safe to add a SECOND button:
 * there is still exactly ONE field. `table_funded` stays DERIVED from the warehouse
 * (closing.tableFundedFor), and the new button writes that same `warehouse` through
 * the same endpoint the Funding picker uses. The failure this prevents is somebody
 * later "simplifying" it into its own flag or its own endpoint, at which point the
 * two surfaces can disagree about whether a loan was sold at the closing table —
 * which decides whether the file goes to the purchasing desk to be sold at all.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const closing = require('../src/lib/closing');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); checks += 1; };

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const panel = read('app-v2/src/components/ClosingPanel.jsx');
const closingSrc = read('src/lib/closing.js');

// ── A. THE DERIVATION IS UNCHANGED ──────────────────────────────────────────────
{
  ok(typeof closing.TABLE_FUNDING === 'string' && closing.TABLE_FUNDING.length > 0,
    'A1 the table-funding warehouse line is a named constant');
  ok(closing.WAREHOUSES.includes(closing.TABLE_FUNDING),
    'A2 …and it is one of the warehouse lines the picker offers');
  eq(closing.tableFundedFor(closing.TABLE_FUNDING), true, 'A3 funding on that line IS table funded');
  eq(closing.tableFundedFor('Stride Bank'), false, 'A4 …and any other line is not');
  eq(closing.tableFundedFor(null), false, 'A5 …and an unset warehouse is not');
  eq(closing.tableFundedFor(''), false, 'A6 …nor a blank one');
}

// ── B. THE NAME TRAVELS FROM THE SERVER — THE CLIENT NEVER SPELLS IT ────────────
{
  ok(/tableFundingWarehouse:\s*TABLE_FUNDING/.test(closingSrc),
    'B1 the workspace sends the line name from the constant, not a literal');

  /* THE CLIENT MUST NOT CARRY ITS OWN COPY. A hard-coded 'Table Funding' in the
     panel is a second spelling of a server constant: rename the line and the button
     silently starts writing an unrecognised warehouse, so the file never reads as
     table funded and the button appears to do nothing. Comments may say the words —
     only a STRING LITERAL is the bug. */
  const withoutComments = panel
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  ok(!/['"]Table Funding['"]/.test(withoutComments),
    'B2 the panel never hard-codes the warehouse name — it uses the value the server sent');
  ok(/tfWarehouse=\{ws\.tableFundingWarehouse/.test(panel),
    'B3 …and takes it from the workspace payload');
}

// ── C. ONE FIELD, TWO BUTTONS ───────────────────────────────────────────────────
{
  ok(/api\.closingUpdate\(appId,\s*\{\s*warehouse:\s*tfWarehouse\s*\}\)/.test(panel),
    'C1 the new button writes the WAREHOUSE — the one field that decides this');

  /* NO SECOND FLAG, EVER. `table_funded` is derived; a client that could set it
     directly would be able to contradict the warehouse the loan actually funded on. */
  const withoutComments = panel
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  ok(!/closingUpdate\([^)]*tableFunded/.test(withoutComments),
    'C2 nothing sets a table-funded FLAG — it is derived from the warehouse');
  ok(!/tprRequired[^)]*tableFunded/.test(withoutComments),
    'C3 …and it is not smuggled through another field');

  // The Funding picker is still there and still writes the same field.
  ok(/api\.closingUpdate\(appId,\s*\{\s*warehouse:\s*e\.target\.value/.test(panel),
    'C4 the Funding picker still writes the same warehouse field');
}

// ── D. IT IS GATED AND DELIBERATE ───────────────────────────────────────────────
{
  const btn = panel.slice(panel.indexOf('cl-signrow cl-tf'), panel.indexOf('Investor delivery signed off'));
  ok(btn.length > 200, 'D0 (fixture) found the table-funding row');
  ok(/isCloser && !cw\.table_funded && tfWarehouse/.test(btn),
    'D1 the button shows only for a closer, only when the file is NOT already table funded, '
    + 'and only when the server actually sent the line name');
  ok(/await askConfirm\(/.test(btn),
    'D2 it confirms first — this decides whether the file goes to the purchasing desk to be sold');
  ok(/purchasing desk/i.test(btn),
    'D3 …and the confirm says that consequence out loud');
  ok(/Change warehouse/.test(btn),
    'D4 an already-table-funded file offers the way back');
  ok(/cl-funding/.test(panel),
    'D5 …which points at the Funding picker, the only control that can ask WHICH line it funded on');

  /* The server refuses a non-closer's warehouse write, so the hidden button is the
     second layer, not the only one. */
  ok(closing.CLOSER_ONLY_CLOSING_FIELDS.includes('warehouse'),
    'D6 the server refuses a warehouse write from anyone but the closer/admin');
}

console.log(`test-table-funding-control-pure: ${checks} checks passed`);
