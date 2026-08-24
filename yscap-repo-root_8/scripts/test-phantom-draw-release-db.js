'use strict';
/* THE PHANTOM DRAW RELEASE — a draw nobody released, announced as released
 * (owner-reported 2026-08-24, YSCAP258134629 / 117 Brook St, Barnegat NJ, draw #1).
 *
 * WHAT WENT OUT. A draw the borrower had just submitted for review — no inspection, no
 * approval, nothing entered in TrustPoint — emailed the team "Released to you $6,200 · no
 * draw fee on this release" beside "$70,200 Approved", printed "Released" on the draw desk,
 * and drew a PDF saying the same.
 *
 * THE ONE FIELD UNDERNEATH ALL OF IT. `trustpoint_draws.disbursed_cents` is TrustPoint's
 * PROJECTED net, pre-populated the moment a draw is keyed in: requested minus the per-draw
 * fee. $6,450 - $250 = $6,200, exactly the figure that went out. This is the SECOND live
 * incident from that field — the first (YSCAP258134754, "your construction draw of
 * $49,750.00 is on its way", $50,000 - $250) is why `mirrorDisbursement` was fixed on
 * 2026-07-27 to require the wire DATE. Two OTHER readers of the same field were never
 * fixed and are what produced this one: db/302, which replays on every boot, and the
 * desk's own release badge.
 *
 * WHY EVERY SECTION IS HERE:
 *
 *   A. `releaseConfirmed` is the ONE definition of "the administrator wired this", and the
 *      thing that matters is the DIRECTION of its doubt: an amount with no wire date is
 *      never a release. Three surfaces ask it now, so it is tested on its own.
 *   B. THE OWNER'S FILE, REPRODUCED. A CONTROL first — the phantom really does appear, with
 *      every figure they saw, or the rest of this suite proves nothing. It takes TWO boots:
 *      db/302 writes the untied row, db/184 correctly binds the file's one free draw. Then
 *      db/626 removes it and the desk reads the truth.
 *   C+D. IT MUST NEVER EAT A REAL RELEASE. A genuinely wired draw, and a release a human
 *      typed, both survive — that is the whole risk of a migration that DELETES money rows.
 *   E. Idempotent across boots, and AUDITED: the row is gone afterwards, so the audit line
 *      is the only record it was ever there.
 *   F. THE SAME CLASS ONE LAYER UP: `drawMoney` treats a stored net as final, so a ledger
 *      row that is NOT released must not become the draw's net. `auto-release` writes such
 *      a row deliberately (lien-waiver gate) and says in its own header that it must
 *      "never [be] silently reported as released" — the rollup was doing exactly that.
 *   G. SOURCE GUARDS, because a back end is not a feature: the desk must read the server's
 *      answer rather than re-deriving the rule from the raw field.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-phantom-draw-release-db.js
 */

const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

// ---------------------------------------------------------------------------
// G. SOURCE GUARDS — pure, and they run even with no database
// ---------------------------------------------------------------------------
{
  const panel = fs.readFileSync(R + '/app-v2/src/components/DrawsPanel.jsx', 'utf8');
  // Comments necessarily NAME the old expression to explain the fix, so a guard that read
  // them would fail on its own explanation and then get "fixed" by deleting the note.
  const code = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the desk renders the release badge from the SERVER’s answer',
    /d\.release_confirmed\s*\?/.test(code));
  ok('and no longer decides "released" from the raw projected amount itself',
    !/\(\s*d\.disbursed_at\s*\|\|\s*Number\(d\.disbursed_cents\)\s*>\s*0\s*\)/.test(code));

  const route = fs.readFileSync(R + '/src/routes/trustpoint.js', 'utf8');
  ok('the overview route actually SENDS release_confirmed (a rule nothing carries is no rule)',
    /release_confirmed:\s*tpMirror\.releaseConfirmed\(/.test(route));

  const roll = fs.readFileSync(R + '/src/sitewire/rollup.js', 'utf8');
  ok('the rollup only lets a RELEASED row speak for the net',
    /netReleaseCents:\s*\(l\s*&&\s*l\.released\)\s*\?/.test(roll));

  const mirror = fs.readFileSync(R + '/src/trustpoint/mirror.js', 'utf8');
  ok('the money mirror gates on the shared predicate rather than its own copy',
    /if\s*\(!releaseConfirmed\(row\)\)/.test(mirror));
}

// ---------------------------------------------------------------------------
// A. THE PREDICATE — pure
// ---------------------------------------------------------------------------
{
  const { releaseConfirmed } = require(R + '/src/trustpoint/mirror');
  const WIRED = '2026-08-01T14:00:00Z';
  ok('a wired, completed draw is a release', releaseConfirmed({ disbursed_at: WIRED, status: 'COMPLETED' }) === true);
  ok('a wired, approved draw is a release', releaseConfirmed({ disbursed_at: WIRED, status: 'APPROVED' }) === true);
  // The owner's own row: a DRAFT carrying TrustPoint's projection and no wire date.
  ok('THE REPORTED CASE — a draft carrying a projected amount is NOT a release',
    releaseConfirmed({ disbursed_at: null, status: 'DRAFT', disbursed_cents: 620000 }) === false);
  ok('an amount alone is never enough, whatever the status',
    releaseConfirmed({ disbursed_at: null, status: 'APPROVED', disbursed_cents: 620000 }) === false);
  ok('a wire date on an undecided draw is not enough either',
    releaseConfirmed({ disbursed_at: WIRED, status: 'IN_REVIEW' }) === false);
  ok('nothing readable is not a release', releaseConfirmed(null) === false && releaseConfirmed('x') === false);
}

if (!process.env.DATABASE_URL) {
  console.log(`test-phantom-draw-release-db: partial OK (${pass} assertions) — SKIPPED the database sections (no DATABASE_URL)`);
  process.exit(fail ? 1 : 0);
}

const db = require(R + '/src/db');
const APPROVAL = require(R + '/src/sitewire/approval');
const ROLLUP = require(R + '/src/sitewire/rollup');
const { ensureSchema } = require(R + '/src/migrate-boot');

const SQL = (f) => fs.readFileSync(path.join(R, 'db', f), 'utf8');
const M184 = '184_disbursement_require_draw_backfill.sql';
const M302 = '302_trustpoint_money_baseline.sql';
const M626 = '626_drop_phantom_trustpoint_releases.sql';

/** One deploy, in filename order — the only order production ever runs these in. */
async function boot({ withFix = true } = {}) {
  await db.query(SQL(M184));
  await db.query(SQL(M302));
  if (withFix) await db.query(SQL(M626));
}

const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  // A brand-new column must exist before the first write races it into being.
  await ensureSchema();
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const made = { apps: [], borrowers: [] };

  /** The owner's file: a real Sitewire draw, and a TrustPoint row beside it. */
  async function file({ tpStatus, disbursedCents, disbursedAt, tpRequested = 645000, swRequested = 7020000 }) {
    const bid = (await db.query(
      `INSERT INTO borrowers (first_name, last_name, email, shares_email)
       VALUES ('Phantom','Draw',$1,true) RETURNING id`, [`phantom-${sfx}-${made.borrowers.length}@test.local`])).rows[0].id;
    made.borrowers.push(bid);
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, status, program, loan_type)
       VALUES ($1,'{"line1":"117 Brook St","city":"Barnegat","state":"NJ","zip":"08005"}'::jsonb,
               'funded','Fix & Flip w/ Construction','Purchase') RETURNING id`, [bid])).rows[0].id;
    made.apps.push(appId);
    const swId = Number((await db.query(`SELECT (floor(random()*8e8)+1e8)::bigint AS n`)).rows[0].n);
    await db.query(
      `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, sitewire_property_id, number, status,
          historical, total_requested_cents, total_approved_cents)
       VALUES ($1,$2,555,1,'inspecting',false,$3,0)`, [appId, swId, swRequested]);
    const tpId = `tp-${sfx}-${made.apps.length}`;
    await db.query(
      `INSERT INTO trustpoint_draws (application_id, tp_project_id, tp_draw_id, number, status,
          requested_cents, approved_cents, disbursed_cents, to_disburse_cents, disbursed_at, fees, sitewire_draw_id)
       VALUES ($1,$2,$3,1,$4,$5,NULL,$6,NULL,$7,'[{"name":"Per Draw Fee","amount":250}]'::jsonb,NULL)`,
      [appId, `proj-${sfx}`, tpId, tpStatus, tpRequested, disbursedCents, disbursedAt]);
    return { appId, swId, tpId };
  }

  const ledgerOf = (appId) => db.query(
    `SELECT sitewire_draw_id, fee_cents, net_release_cents, release_date, funded_status, note, created_by
       FROM draw_disbursements WHERE application_id=$1 ORDER BY id`, [appId]).then((r) => r.rows);

  /** Exactly what the desk row, the email hero and the PDF print for this draw. */
  async function deskMoney(appId, swId) {
    const roll = await ROLLUP.loadRollup(db, appId);
    return (roll.draws || []).find((d) => Number(d.sitewire_draw_id) === swId) || null;
  }

  try {
    // -----------------------------------------------------------------------
    // B. THE OWNER'S FILE, REPRODUCED — control first, then the fix
    // -----------------------------------------------------------------------
    {
      const f = await file({ tpStatus: 'DRAFT', disbursedCents: 620000, disbursedAt: null });

      // --- CONTROL: without db/626, the phantom really does appear ---
      await boot({ withFix: false });                 // deploy 1: db/302 writes it untied
      let rows = await ledgerOf(f.appId);
      ok('CONTROL deploy 1 — db/302 invents a release from the projection alone', rows.length === 1);
      eq('CONTROL — and it is a RELEASE, of the projected net, with no fee and no wire date',
        rows[0] && [Number(rows[0].net_release_cents), Number(rows[0].fee_cents), rows[0].funded_status, rows[0].release_date, rows[0].sitewire_draw_id],
        [620000, 0, 'released', null, null]);

      await boot({ withFix: false });                 // deploy 2: db/184 binds it to the real draw
      rows = await ledgerOf(f.appId);
      ok('CONTROL deploy 2 — db/184 binds the untied release to the borrower’s real draw',
        rows.length === 1 && Number(rows[0].sitewire_draw_id) === f.swId);

      const bad = await deskMoney(f.appId, f.swId);
      ok('CONTROL — the desk calls the draw RELEASED', bad && bad.approval_stage === 'released');
      eq('CONTROL — and prints the owner’s exact figures',
        bad && [money(bad.requested_cents), money(bad.approved_cents), money(bad.fee_cents), money(bad.net_release_cents)],
        ['$70,200.00', '$0.00', '$0.00', '$6,200.00']);

      // --- THE FIX ---
      await boot();                                    // the next deploy, with db/626 last
      rows = await ledgerOf(f.appId);
      eq('db/626 removes the phantom release', rows.length, 0);

      const good = await deskMoney(f.appId, f.swId);
      ok('the draw is no longer "Released"', good && good.approval_stage !== 'released');
      ok('and it is not called released by any other name either', good && good.released === false && good.is_released === false);
      ok('the net is no longer the projection off a different draw', good && Number(good.net_release_cents) !== 620000);
      eq('the requested amount is untouched — this only ever removed a release',
        good && money(good.requested_cents), '$70,200.00');
    }

    // -----------------------------------------------------------------------
    // C. A REAL RELEASE IS NEVER TOUCHED
    // -----------------------------------------------------------------------
    {
      const f = await file({ tpStatus: 'COMPLETED', disbursedCents: 620000, disbursedAt: '2026-08-01T14:00:00Z' });
      await boot(); await boot();
      const rows = await ledgerOf(f.appId);
      ok('a genuinely wired draw still records its release', rows.length === 1);
      ok('and db/626 leaves it exactly where it is, across two more deploys',
        rows[0] && Number(rows[0].net_release_cents) === 620000 && rows[0].funded_status === 'released');
      const m = await deskMoney(f.appId, f.swId);
      ok('so the desk still reports it as released', m && m.approval_stage === 'released');
    }

    // -----------------------------------------------------------------------
    // C2. THE WIRE THAT LANDS AFTER THE PROJECTION WAS RECORDED
    // -----------------------------------------------------------------------
    // The case that makes `t.disbursed_at IS NULL` load-bearing rather than a second
    // opinion. db/302 records the projection while the draw is still a draft (no wire
    // date, so the row carries no release_date either); TrustPoint then wires it for
    // real. From that moment the row can no longer be PROVEN phantom — the money did
    // move — so db/626 must leave it and let the live mirror correct the figures. Fail
    // closed: deleting a release we cannot judge is the expensive direction.
    {
      const f = await file({ tpStatus: 'DRAFT', disbursedCents: 620000, disbursedAt: null });
      await boot({ withFix: false });                        // the projection is recorded
      const before = (await db.query(
        `SELECT id FROM draw_disbursements WHERE application_id=$1`, [f.appId])).rows;
      ok('the projected row is on the ledger before the wire', before.length === 1);
      await db.query(
        `UPDATE trustpoint_draws SET status='COMPLETED', disbursed_at='2026-08-22T15:00:00Z' WHERE tp_draw_id=$1`,
        [f.tpId]);                                            // the administrator wires it
      await boot();
      // The SAME row, by id. Asserting only a count would miss this: db/302 legitimately
      // re-creates the row on the NEXT boot (now with a real release date), so a delete
      // here would be invisible one deploy later — and the ledger would have been a
      // release short in between.
      const after = (await db.query(
        `SELECT id FROM draw_disbursements WHERE application_id=$1`, [f.appId])).rows;
      ok('once the money has actually moved, db/626 no longer removes the row',
        after.length === 1 && String(after[0].id) === String(before[0].id));
    }

    // -----------------------------------------------------------------------
    // C3. A ROW THE LIVE MIRROR WROTE IS NOT db/302's TO REMOVE
    // -----------------------------------------------------------------------
    // What makes the note guard load-bearing: `mirrorDisbursement` writes its own row
    // with its own wording, and db/626 must only ever undo db/302's work.
    {
      const f = await file({ tpStatus: 'DRAFT', disbursedCents: 0, disbursedAt: null });
      await db.query(
        `INSERT INTO draw_disbursements (application_id, sitewire_draw_id, trustpoint_draw_id, approved_cents,
            fee_cents, retainage_held_cents, net_release_cents, release_date, funded_status, kind, source, note)
         VALUES ($1,$2,$3,7020000,25000,0,6995000,NULL,'released','draw','trustpoint',
                 'Mirrored from the draw administrator — the note buyer wires these draws directly.')`,
        [f.appId, f.swId, f.tpId]);
      await boot(); await boot();
      ok('a row the live money mirror wrote is left alone', (await ledgerOf(f.appId)).length === 1);
    }

    // -----------------------------------------------------------------------
    // D. A HUMAN'S OWN RELEASE IS NEVER TOUCHED
    // -----------------------------------------------------------------------
    {
      const f = await file({ tpStatus: 'DRAFT', disbursedCents: 620000, disbursedAt: null });
      const staff = (await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
         VALUES ($1,'Draw Coordinator','draw_coordinator',true,false,'x',0) RETURNING id`,
        [`phantom-staff-${sfx}@test.local`])).rows[0].id;
      // The worst case this guard is for: a row that matches db/302's shape in EVERY other
      // respect — its note, no release date, an unwired TrustPoint draw — and that a human
      // nonetheless put there. `created_by` is the only thing standing between a person's
      // own entry and a migration that deletes money rows, so it is tested on its own.
      await db.query(
        `INSERT INTO draw_disbursements (application_id, sitewire_draw_id, trustpoint_draw_id, approved_cents,
            fee_cents, retainage_held_cents, net_release_cents, release_date, funded_status, kind, source, note, created_by)
         VALUES ($1,$2,$3,7020000,25000,0,6995000,NULL,'released','draw','trustpoint',
                 'Backfilled at phase-5 rollout — this draw was released before the money mirror went live.',$4)`,
        [f.appId, f.swId, f.tpId, staff]);
      await boot(); await boot();
      const rows = await ledgerOf(f.appId);
      ok('a release a human typed survives every deploy',
        rows.length === 1 && Number(rows[0].net_release_cents) === 6995000 && rows[0].created_by === staff);
      await db.query(`DELETE FROM staff_users WHERE id=$1`, [staff]).catch(() => {});
    }

    // -----------------------------------------------------------------------
    // E. IDEMPOTENT, AND AUDITED
    // -----------------------------------------------------------------------
    {
      const f = await file({ tpStatus: 'DRAFT', disbursedCents: 620000, disbursedAt: null });
      await boot();
      const audits = () => db.query(
        `SELECT detail FROM audit_log WHERE action='draw_phantom_release_removed' AND entity_id=$1`,
        [f.appId]).then((r) => r.rows);
      const a1 = await audits();
      ok('the removal is recorded — the row is gone, so this is the only trace it existed', a1.length === 1);
      eq('and the audit names the amount and the draw it came from',
        a1[0] && [Number(a1[0].detail.net_release_cents), a1[0].detail.trustpoint_draw_id],
        [620000, f.tpId]);
      // db/302 re-inserts on the next boot and db/626 removes it again — one audit line per
      // removal, and the ledger never carries the row into a running system.
      await boot();
      ok('a further deploy leaves no phantom behind', (await ledgerOf(f.appId)).length === 0);
      ok('and does not silently stop auditing what it removed', (await audits()).length === 2);
    }

    // -----------------------------------------------------------------------
    // F. A HELD ROW MUST NOT BECOME THE DRAW'S NET
    // -----------------------------------------------------------------------
    {
      const f = await file({ tpStatus: 'DRAFT', disbursedCents: 0, disbursedAt: null });
      await db.query(
        `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id,
            job_item_name, requested_cents, approved_cents)
         VALUES ($1,$2,1,'Roof',7020000,7020000)`,
        [f.swId, Number((await db.query(`SELECT (floor(random()*8e8)+1e8)::bigint AS n`)).rows[0].n)]);
      // What `auto-release` writes when the lien-waiver gate does not pass: recorded, so the
      // money is never lost, but HELD with NOTHING wired — and its own header says such a row
      // must never read as released. A stored net of 0 is what makes this assertion bite:
      // without the guard the desk prints "$0.00" as the net of a $70,200 approved draw, which
      // is the very "APPROVED FOR RELEASE $0" the whole approval ladder was built to end.
      await db.query(
        `INSERT INTO draw_disbursements (application_id, sitewire_draw_id, approved_cents, fee_cents,
            retainage_held_cents, net_release_cents, funded_status, kind, source, note)
         VALUES ($1,$2,7020000,25000,0,0,'held','draw','pilot','held pending lien waivers')`,
        [f.appId, f.swId]);
      await boot();
      const m = await deskMoney(f.appId, f.swId);
      ok('a HELD row does not make the draw read as released', m && m.approval_stage !== 'released' && m.released === false);
      ok('and its stored net does not silently become the draw’s net',
        m && Number(m.net_release_cents) !== 0);
      eq('the honest projection is shown instead — approved less the fee',
        m && money(m.net_release_cents), money(7020000 - Number(m.fee_cents)));
      ok('while the fee it recorded is still ours to count', m && Number(m.fee_cents) === 25000);
    }
  } finally {
    for (const a of made.apps) await db.query(`DELETE FROM applications WHERE id=$1`, [a]).catch(() => {});
    for (const b of made.borrowers) await db.query(`DELETE FROM borrowers WHERE id=$1`, [b]).catch(() => {});
  }

  console.log(`test-phantom-draw-release-db: ${fail ? 'FAILED' : 'OK'} (${pass} assertions${fail ? `, ${fail} failed` : ''})`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-phantom-draw-release-db CRASHED:', e && e.stack || e); process.exit(1); });
