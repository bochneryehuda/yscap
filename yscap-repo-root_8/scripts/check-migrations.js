#!/usr/bin/env node
'use strict';

/**
 * Migration hygiene gate — runs in CI and is safe to run locally.
 *
 * Catches the ONE mistake that keeps slipping past git in this repo: two
 * parallel sessions each add `db/NNN_*.sql` with the SAME number NNN. Because
 * the filenames differ, git never reports a conflict, so the collision lands
 * silently (it happened three times: 033, 088, 113). Every migration is
 * replayed on every boot in filename order, so a duplicate number is "only"
 * latent today — but it breaks the "next free number" contract and is exactly
 * the kind of quiet drift this project can't afford.
 *
 * This also flags a few idempotency footguns, since migrate-boot.js re-runs
 * EVERY file on EVERY deploy: a bare `CREATE TABLE` / `CREATE INDEX` /
 * `ALTER TABLE ... ADD COLUMN` without `IF NOT EXISTS`, or an `ADD CONSTRAINT`
 * that isn't guarded, will throw on the second boot.
 *
 * Exit code: 0 = clean, 1 = a hard problem (duplicate number). Idempotency
 * findings are warnings by default (many legitimately use DO-blocks or
 * existence checks the regex can't see); pass --strict to fail on them too.
 *
 *   node scripts/check-migrations.js
 *   node scripts/check-migrations.js --strict
 */

const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '..', 'db');
const strict = process.argv.includes('--strict');

// Known, ACCEPTED historical number collisions that predate this gate. Both
// pairs are ancient (Jul 6 / Jul 12), both halves are already applied in
// production, and both are independent + idempotent — renumbering deeply-applied
// history is pure risk for zero benefit. They are baselined here so the gate
// protects against NEW collisions (114+) without forcing a risky rewrite of
// settled history. The newest collision (113) WAS resolved: address_canon_cache
// was renumbered to 115. Do NOT add to this list to silence a fresh collision —
// renumber the new file instead.
const ACCEPTED_COLLISIONS = new Set(['033', '088']);

function fail(msg) { console.error('  ✗ ' + msg); }
function warn(msg) { console.warn('  ! ' + msg); }

const files = fs.readdirSync(DB_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort();

let hardErrors = 0;
let warnings = 0;

// ---- 1. duplicate migration numbers (HARD) --------------------------------
const byNumber = new Map();
for (const f of files) {
  const num = f.match(/^(\d+)_/)[1];
  if (!byNumber.has(num)) byNumber.set(num, []);
  byNumber.get(num).push(f);
}
for (const [num, group] of byNumber) {
  if (group.length > 1) {
    if (ACCEPTED_COLLISIONS.has(num)) {
      warnings++;
      warn(`duplicate migration number ${num}: ${group.join(', ')} — accepted historical collision (baselined, already applied in prod)`);
    } else {
      hardErrors++;
      fail(`duplicate migration number ${num}: ${group.join(', ')} — renumber the newer file to the next free number (per CLAUDE.md merge rule, renumber YOURS, never one that may already be applied in prod)`);
    }
  }
}

// Report the next free number as a convenience for whoever adds the next one.
const nums = [...byNumber.keys()].map(Number).sort((a, b) => a - b);
const maxNum = nums.length ? nums[nums.length - 1] : 1;

// ---- 2. self-label mismatch (WARN) ----------------------------------------
// Many files carry a header comment naming themselves; a wrong number there
// (e.g. 113_chat still labelled "112_") signals a botched renumber.
for (const f of files) {
  const head = fs.readFileSync(path.join(DB_DIR, f), 'utf8').slice(0, 400);
  const m = head.match(/(\d{2,})_[a-z0-9_]+\.sql/i);
  if (m && !f.startsWith(m[1] + '_')) {
    warnings++;
    warn(`${f} header names itself "${m[0]}" — stale self-label from a renumber; update the comment`);
  }
}

// ---- 3. idempotency footguns (WARN unless --strict) -----------------------
const IDEMPOTENCY_CHECKS = [
  { re: /\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, what: 'CREATE TABLE without IF NOT EXISTS' },
  { re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS)/i, what: 'CREATE INDEX without IF NOT EXISTS' },
  { re: /\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i, what: 'ADD COLUMN without IF NOT EXISTS' },
];
for (const f of files) {
  const sql = fs.readFileSync(path.join(DB_DIR, f), 'utf8');
  // Strip line comments so a commented example doesn't false-positive.
  const code = sql.replace(/--[^\n]*/g, '');
  for (const { re, what } of IDEMPOTENCY_CHECKS) {
    if (re.test(code)) { warnings++; warn(`${f}: ${what} — re-runs every boot, will throw once applied`); }
  }
  // ADD CONSTRAINT is fine only if guarded (DROP ... IF EXISTS first, a DO block,
  // or a pg_constraint existence check). Flag the bare ones.
  if (/\bADD\s+CONSTRAINT\b/i.test(code)) {
    const guarded = /DROP\s+CONSTRAINT\s+IF\s+EXISTS/i.test(code) ||
                    /DO\s+\$\$/i.test(code) || /pg_constraint/i.test(code) ||
                    /IF\s+NOT\s+EXISTS/i.test(code);
    if (!guarded) { warnings++; warn(`${f}: ADD CONSTRAINT without a DROP IF EXISTS / DO-block / pg_constraint guard`); }
  }
}

// ---- N. AN ADD IN ONE FILE AND A DROP IN A LATER ONE IS A COUNTDOWN (HARD) ---
// `migrate-boot` runs every numbered file's FULL TEXT on EVERY boot, so the pair
// never settles: the earlier file re-ADDs what the later one DROPPED, the later
// one DROPs it again, and each round burns a permanent `pg_attribute` slot.
// Postgres allows 1600 per table, so it is a countdown to that table dying with
// "tables can have at most 1600 columns" — and nothing warns you on the way.
//
// MEASURED before this check existed: db/448 added 11 columns db/450 removed, and
// a database this branch had been booted against carried 1,476 dropped attributes
// on `properties` and 328 on `property_observations` — exactly 9 and 2 per boot
// over 164 boots — with `properties` sitting at attnum 1600, permanently dead.
//
// THE FIX IS ALWAYS THE SAME: stop CREATING the column in the earlier file. The
// later file keeps its DROP so a database that already ran the old version is
// cleaned up once, after which both are stable no-ops.
{
  const added = new Map();   // "table.column" -> file that creates it
  const addRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
  const dropRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(\w+)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(\w+)/gi;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(DB_DIR, f), 'utf8');
    // A DROP inside a DO-block guarded on the column's current TYPE is the
    // sanctioned retype (db/450's comp_research): it fires once and then never
    // again, so it does not churn. Only an unguarded top-level DROP counts.
    const guardedRetype = /DO\s+\$\$[\s\S]*?DROP\s+COLUMN[\s\S]*?END\s+\$\$/i.test(sql);
    let m;
    dropRe.lastIndex = 0;
    while ((m = dropRe.exec(sql))) {
      const key = `${m[1].toLowerCase()}.${m[2].toLowerCase()}`;
      const creator = added.get(key);
      if (creator && creator !== f && !guardedRetype) {
        hardErrors++;
        fail(`${f} DROPs ${key}, which ${creator} CREATES — every boot re-adds and re-drops it, `
          + 'burning a permanent column slot each time (1600 per table, then that table is dead). '
          + `Remove the ADD from ${creator} instead; keep the DROP here to clean up databases that `
          + 'already ran the old version.');
      }
    }
    addRe.lastIndex = 0;
    while ((m = addRe.exec(sql))) {
      const key = `${m[1].toLowerCase()}.${m[2].toLowerCase()}`;
      if (!added.has(key)) added.set(key, f);
    }
  }
}

// ---------------------------------------------------------------------------
// A TABLE CANNOT BE ALTERED BEFORE IT IS CREATED — the renumber-inversion check
// ---------------------------------------------------------------------------
// A renumber has to move the whole dependent CHAIN, not just the colliding file.
// Reproduced: main's dashboards work collided on 421/422/423, this branch's three
// were renumbered to 447/448/449 — and `424_warehouse_fact_placement.sql`, which
// exists to CORRECT two of them, was left behind. It then ran BEFORE the
// migration that CREATES `market_observations`, so its `ALTER TABLE` failed with
// 42P01 on every fresh database.
//
// NOTHING SAID SO. `migrate-boot` logs a failed file and keeps going ON PURPOSE —
// a migration hiccup must not stop the service booting — so `ensureSchema()`
// still resolved, the boot still succeeded, and the only evidence anywhere was a
// single "FAILED … — continuing" line in the log. It reached CI.
//
// This is a static read of the files, so it costs nothing and needs no database.
// Conservative by construction: a table this directory never CREATEs is skipped
// entirely (it belongs to `schema.sql`, which runs first), and a DROP TABLE
// resets the table's origin so a legitimate drop-and-recreate is not flagged.
{
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
  const dropTableRe = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
  const alterRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([a-z_][a-z0-9_]*)/gi;
  const createdIn = new Map();          // table -> the FIRST migration number that creates it
  const altersOf = new Map();           // table -> [{num, file}]

  for (const f of files) {
    const num = Number(f.slice(0, 3));
    const sql = fs.readFileSync(path.join(DB_DIR, f), 'utf8');
    let m;
    createRe.lastIndex = 0;
    while ((m = createRe.exec(sql))) {
      const t = m[1].toLowerCase();
      if (!createdIn.has(t)) createdIn.set(t, num);
    }
    // A drop-and-recreate is legitimate; forget the earlier origin so a later
    // CREATE in a later file becomes the one that counts.
    dropTableRe.lastIndex = 0;
    while ((m = dropTableRe.exec(sql))) {
      const t = m[1].toLowerCase();
      if (createdIn.has(t) && createdIn.get(t) < num) createdIn.delete(t);
    }
    alterRe.lastIndex = 0;
    while ((m = alterRe.exec(sql))) {
      const t = m[1].toLowerCase();
      if (!altersOf.has(t)) altersOf.set(t, []);
      altersOf.get(t).push({ num, file: f });
    }
  }

  for (const [table, uses] of altersOf) {
    const born = createdIn.get(table);
    if (born == null) continue;                     // created by schema.sql — always first
    for (const u of uses) {
      if (u.num < born) {
        hardErrors++;
        fail(`${u.file} alters "${table}", which is not created until migration ${born} — `
          + 'a renumber moved one file out of its chain. `migrate-boot` logs a failed '
          + 'migration and CONTINUES, so this fails silently on every fresh database. '
          + 'Move the whole dependent chain, not just the colliding file.');
      }
    }
  }
}

console.log(`Checked ${files.length} numbered migrations (highest number: ${maxNum}, next free: ${maxNum + 1}).`);
if (hardErrors) console.error(`\n${hardErrors} hard error(s).`);
if (warnings) console.warn(`${warnings} warning(s).`);
if (!hardErrors && !warnings) console.log('  ✓ clean');

if (hardErrors || (strict && warnings)) process.exit(1);
process.exit(0);
