'use strict';
/**
 * PROOF, against a real Postgres, of the decision `people/links.js` calls the most
 * consequential row in the long-term build — and which no test had ever run.
 *
 * A confirmed staff link says "this Encompass login IS this PILOT person". From
 * that moment every long-term loan naming that login is attributed to them and —
 * for an officer or a processor, whose scope is `own` — it decides which files
 * they can OPEN. Link the wrong two people and somebody quietly gets another
 * officer's book with nothing on any screen to say so.
 *
 * A COVERAGE SWEEP OF ALL 120 LONG-TERM SUITES FOUND THIS MODULE NEVER LOADED.
 * Not under-tested — never executed, while live behind `routes/people.js` and
 * `pipeline.js`. Its refusals include one that is purely a security boundary (an
 * external TPO broker is a `staff_users` row and must never be handed a long-term
 * pipeline) and one that is a race the database settles, and neither had ever
 * been asked a question. The module reads well, which is exactly the point: every
 * refusal below was written from reasoning, and reasoning is what a test is for.
 *
 * WHY A DATABASE. Two of these facts live nowhere else: the partial unique index
 * on `staff_id WHERE confirmed` (two admins confirming at the same instant each
 * read "free" and both write, so the index is what makes one-person-one-login
 * true, not the check above it), and the retroactive re-attribution a confirm
 * fires. A pure test can stub both and prove nothing about either.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');

async function main() {
  // Both CI jobs run the one chain and `test` has no database, so this must skip
  // rather than dial one. BEFORE anything that opens a connection.
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-staff-link');

  const db = require('../src/longterm/db');
  const links = require('../src/longterm/people/links');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const tag = `sl-${Date.now().toString(36)}`;
  const loginA = `${tag}-a`;
  const loginB = `${tag}-b`;
  const staffIds = [];

  const seedLogin = async (id, name) => {
    await db.query(
      `INSERT INTO lt_encompass_users (login_id, full_name, is_active)
       VALUES ($1, $2, true) ON CONFLICT (login_id) DO NOTHING`,
      [id, name],
    );
    return id;
  };
  // An EXTERNAL identity cannot exist unscoped: `staff_users_external_firm_check`
  // is `(is_external AND tpo_firm_id IS NOT NULL) OR (NOT is_external AND
  // tpo_firm_id IS NULL)`. That is the TPO build's own invariant and it is why
  // seeding a broker here needs a firm — worth knowing, because it means the
  // refusal being tested below is the SECOND line of defence, not the first.
  let firmId = null;
  const seedFirm = async () => {
    if (firmId) return firmId;
    const { rows } = await db.query(
      `INSERT INTO tpo_firms (id, name, status) VALUES (gen_random_uuid(), $1, 'active') RETURNING id`,
      [`${tag} Brokerage`],
    );
    firmId = rows[0].id;
    return firmId;
  };
  const seedStaff = async (name, opts = {}) => {
    const firm = opts.external === true ? await seedFirm() : null;
    const { rows } = await db.query(
      `INSERT INTO staff_users (id, email, full_name, role, is_active, is_external, tpo_firm_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::uuid) RETURNING id`,
      [`${tag}-${name}@example.com`, name, opts.external === true ? 'tpo_officer' : 'loan_officer',
        opts.active !== false, opts.external === true, firm],
    );
    staffIds.push(rows[0].id);
    return rows[0].id;
  };
  const rowFor = async (login) => (await db.query(
    'SELECT * FROM lt_staff_links WHERE encompass_login_id = $1', [login])).rows[0] || null;

  /** Run something that must be refused, and hand back the refusal. */
  const refusal = async (fn) => {
    try { await fn(); return null; } catch (e) { return e; }
  };

  try {
    await seedLogin(loginA, 'Alex Officer');
    await seedLogin(loginB, 'Bailey Officer');
    const alex = await seedStaff('alex');
    const sam = await seedStaff('sam');
    const broker = await seedStaff('broker', { external: true });
    const retired = await seedStaff('retired', { active: false });

    // ── A. THE DECISION ITSELF ────────────────────────────────────────────
    const made = await links.confirmLink(loginA, alex, alex);
    eq(made.status, 'confirmed', 'confirming records the link as confirmed');
    eq(String(made.staff_id), String(alex), '…against the person who was named');
    ok(made.confirmed_at, '…stamped with WHEN, which is what the people screen shows');
    eq(String(made.confirmed_by), String(alex), '…and by WHOM — on this side the row is the only record there is, because Long-Term writes nothing to the RTL audit log');

    eq(await links.staffIdForLogin(loginA), String(alex),
      'and the login now resolves to that person — this is the function the loan sync attributes a book through');
    eq(await links.hasConfirmedLink(alex), true, 'and the person now has a confirmed Encompass identity');
    eq(await links.hasConfirmedLink(sam), false, '…while somebody else does not');

    // Confirming the same pair again is the ordinary result of two admins looking
    // at the same screen. It must settle, not raise.
    const again = await links.confirmLink(loginA, alex, alex);
    eq(again.status, 'confirmed', 'confirming the same pair twice is idempotent rather than an error');

    // ── B. A SUGGESTION IS NOT A DECISION ─────────────────────────────────
    //
    // The whole owner-directed shape is "auto-match by email, admin confirms". If
    // a suggested row satisfied the lookup, the auto-match would be deciding after
    // all — and it would decide by attributing somebody's entire book.
    await db.query(
      `INSERT INTO lt_staff_links (encompass_login_id, staff_id, status, match_method, updated_at)
       VALUES ($1, $2::uuid, 'suggested', 'email', now())
       ON CONFLICT (encompass_login_id) DO UPDATE SET staff_id = EXCLUDED.staff_id, status = 'suggested'`,
      [loginB, sam],
    );
    eq(await links.staffIdForLogin(loginB), null,
      'THE ONE THAT MATTERS: a SUGGESTED link resolves to nobody — a machine proposal nobody read must never attribute a book');
    eq(await links.hasConfirmedLink(sam), false, '…and the person it proposes is still unlinked');

    // ── C. EVERY REFUSAL, IN THE WORDS A SCREEN SHOWS ─────────────────────
    const blankLogin = await refusal(() => links.confirmLink('', alex, alex));
    eq(blankLogin && blankLogin.status, 400, 'naming no Encompass user is refused');
    ok(blankLogin && /which encompass user/i.test(blankLogin.plain || ''),
      '…in a sentence a screen can show verbatim rather than a stack trace');

    const blankStaff = await refusal(() => links.confirmLink(loginA, '', alex));
    eq(blankStaff && blankStaff.status, 400, 'naming no PILOT person is refused');

    const noLogin = await refusal(() => links.confirmLink(`${tag}-ghost`, alex, alex));
    eq(noLogin && noLogin.status, 404,
      'a login that is not in the roster is refused — a link pointing at nobody is worse than no link');

    const noPerson = await refusal(() => links.confirmLink(loginB, '00000000-0000-0000-0000-000000000000', alex));
    eq(noPerson && noPerson.status, 404, 'a person who does not exist is refused');

    const external = await refusal(() => links.confirmLink(loginB, broker, alex));
    eq(external && external.status, 400,
      'THE SECURITY ONE: an outside broker is refused — a TPO is a staff_users row, and linking one would hand an outside firm a long-term pipeline');
    ok(external && /outside broker/i.test(external.plain || ''), '…and is told why in plain words');

    const inactive = await refusal(() => links.confirmLink(loginB, retired, alex));
    eq(inactive && inactive.status, 400, 'a deactivated person is refused');

    const spoken = await refusal(() => links.confirmLink(loginB, alex, alex));
    eq(spoken && spoken.status, 409,
      'and a person already linked to another login is refused — one person, one login');
    ok(spoken && spoken.plain && spoken.plain.includes(loginA),
      '…NAMING the login they are already on, because "unlink that one first" is not actionable without it');

    // A refusal must leave nothing behind. The suggested row above is still the
    // row for loginB: had any of those refusals written, it would not be.
    const afterRefusals = await rowFor(loginB);
    eq(afterRefusals.status, 'suggested',
      'and not one refusal wrote anything — the row is exactly as it was');

    // ── D. UNDOING A DECISION ─────────────────────────────────────────────
    const rejected = await links.rejectLink(loginA, alex);
    eq(rejected.status, 'rejected', 'rejecting records the refusal');
    eq(rejected.staff_id, null,
      '…and clears the person, so a rejection can never be read as a link to them');
    eq(await links.staffIdForLogin(loginA), null, '…the login attributes to nobody again');
    eq(await links.hasConfirmedLink(alex), false, '…and the person is free to be linked elsewhere');

    // Rejecting is a DECISION and the row stays, so the sync will not re-propose
    // it. Unlinking is the way to reopen the question, which is a different thing.
    ok(await rowFor(loginA), 'a rejected login keeps its row — that is what stops the sync proposing it again every pass');
    const removed = await links.unlink(loginA);
    eq(removed.removed, 1, 'unlinking removes the row entirely');
    eq(await rowFor(loginA), null, '…returning the login to unlinked and proposable, which reject deliberately does not');
    eq((await links.unlink(loginA)).removed, 0, 'and unlinking nothing removes nothing rather than raising');

    // ── E. THE DATABASE IS WHAT MAKES ONE-PERSON-ONE-LOGIN TRUE ───────────
    //
    // The check inside confirmLink gives the common case a sentence. The partial
    // unique index is what holds when two admins confirm at the same instant and
    // each read "free" — so it is asserted here directly rather than trusted.
    await links.confirmLink(loginA, alex, alex);
    let raced = null;
    try {
      await db.query(
        `INSERT INTO lt_staff_links (encompass_login_id, staff_id, status, match_method, updated_at)
         VALUES ($1, $2::uuid, 'confirmed', 'manual', now())`,
        [`${tag}-c`, alex],
      );
    } catch (e) { raced = e; }
    eq(raced && raced.code, '23505',
      'the database itself refuses a second confirmed link for one person — the check in the code is the friendly half, this is the true one');

    // ── F. SEPARATION ─────────────────────────────────────────────────────
    //
    // Proven on the source, because a behavioural test can only ever show that
    // THIS run did not write one.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../src/longterm/people/links.js'), 'utf8');
    ok(!/UPDATE\s+staff_users|INSERT\s+INTO\s+staff_users|DELETE\s+FROM\s+staff_users/i.test(src),
      'the module never writes the shared staff record — it READS it to check the person is real, internal and active (authorized 2026-08-03) and nothing more');
    const written = [...src.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?!SET\b)([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]);
    ok(written.length > 0 && written.every((t) => /^lt_/.test(t)),
      `and every table it writes is a long-term one (${[...new Set(written)].join(', ')})`);
  } finally {
    await db.query('DELETE FROM lt_staff_links WHERE encompass_login_id LIKE $1', [`${tag}%`]).catch(() => {});
    await db.query('DELETE FROM lt_encompass_users WHERE login_id LIKE $1', [`${tag}%`]).catch(() => {});
    if (staffIds.length) {
      await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [staffIds]).catch(() => {});
    }
    if (firmId) await db.query('DELETE FROM tpo_firms WHERE id = $1::uuid', [firmId]).catch(() => {});
    await db.pool.end().catch(() => {});
    // AND THE RTL POOL. These suites require the app, which opens `src/db`'s pool
    // transitively; `db` here is the LONG-TERM one. Leaving the other open kept a
    // Postgres socket alive until its 30-second idle timeout, so the suite printed
    // its result and then sat there doing nothing. Across nine suites that was 270
    // of the 286 seconds the long-term database suites took.
    await require('../src/db').pool.end().catch(() => {});
  }

  console.log(`\n✓ lt staff-link (db): ${checks} assertions passed`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
