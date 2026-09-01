"use strict";
/**
 * LT — THE EMAIL DOOR: it records what it sent, and it sends the SAME document
 * the officer downloads.
 *
 * `test-lt-term-sheet-deliver-pure.js` proves the module — the address rules, the
 * letter, rule 10, the wire payload. Two things it structurally cannot see, and
 * they are the two this exists for:
 *
 *   ⛔ THE ROW. The email lands in a mailbox we cannot read, and rule 4 keeps a
 *     long-term send out of the short-term Email Center — so `lt_term_sheet_delivery`
 *     is the ONLY answer to "what did we actually send this person, and when". A
 *     door that sends and records nothing looks identical from the module's side.
 *
 *   ⛔ THE SAME DOCUMENT. "One renderer" is a claim about two HTTP doors, and no
 *     unit test of the renderer can check that the download door and the email
 *     door reach it. So both are called over real HTTP and the two PDFs are read
 *     back and compared BY THEIR TEXT — the bytes are deliberately not compared,
 *     because they are not deterministic (measured: same length, different bytes
 *     inside a compressed stream), and a byte comparison would fail for a reason
 *     that has nothing to do with delivery.
 *
 * The mailer is stubbed and inspected. A send that "succeeds" against the noop
 * provider proves nothing about who it reached.
 *
 * DB-GATED: with no DATABASE_URL it SKIPS and says so.
 */

const http = require("http");
const path = require("path");

(async () => {
  await require(path.join(__dirname, "lib", "db-gate")).skipUnlessDb("lt-term-sheet-deliver");

  /* The mailer, stubbed BEFORE the server is required — every module that sends
     captures it at require time. */
  const MAIL = require.resolve("../src/lib/email/index.js");
  const sent = [];
  require.cache[MAIL] = {
    id: MAIL, filename: MAIL, loaded: true, exports: {
      async sendMail(payload) { sent.push(payload); return { ok: true, id: `stub-${sent.length}` }; },
      fromWithName: (a) => a,
      rateStatus: () => ({}),
    },
  };

  const app = require("../src/server");
  const crypto = require("../src/lib/crypto");
  const db = require("../src/db");
  const ltDb = require("../src/longterm/db");
  const snapshot = require("../src/longterm/termsheet/snapshot");
  const { ensureSchema } = require("../src/migrate-boot");

  let bad = 0;
  const ok = (c, m) => { if (c) console.log(`  ok   ${m}`); else { bad += 1; console.error(`  FAIL ${m}`); } };
  const section = (t) => console.log(`\n${t}`);

  await ensureSchema();

  const U = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  /* ⛔ MINTED BY THE REAL MINTER. The code alphabet deliberately drops the letters
     that are misread down a telephone (I, L, O, U), so a code invented from a
     timestamp is rejected by `normalizeCode` as malformed — and every door then
     answers 400, which reads as "the email door is broken" when the fixture is
     what is wrong. Ask the module that owns the rule. */
  const CODE = require("../src/longterm/termsheet/code").mintCode();
  const OFFICER_EMAIL = `lt-deliver-${U}@yscapgroup.com`;

  let server = null;
  let staff = null;
  let sheetId = null;

  const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
  const SCENARIO = {
    purpose: "Purchase", propertyType: "Single family", value: 500000, loan: 375000,
    ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: "NJ", city: "Lakewood", zip: "08701",
    rentMonthly: 3900, taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0,
    prepayMonths: 60, prepayStructure: "5 Year",
  };

  try {
    // ── the officer, on the roster ────────────────────────────────────────
    const staffRow = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, title, phone, nmls, is_active)
       VALUES ($1, 'Sara Klein', 'loan_officer', 'Senior Loan Officer', '(732) 555-0142', '1234567', true)
       RETURNING id, token_version`,
      [OFFICER_EMAIL],
    )).rows[0];
    staff = {
      id: staffRow.id,
      token: crypto.signJwt({
        sub: String(staffRow.id), kind: "staff", role: "loan_officer",
        tv: staffRow.token_version, sid: U,
      }),
    };

    // ── an issued sheet, built exactly as the issue door builds one ───────
    const built = snapshot.buildSnapshot({
      selections: [{
        label: "A", consumerLabel: "Platinum", product: "30-Year Fixed DSCR", mode: "borrowerPaid",
        ratePct: 7.375, rawPrice: 100.25, scenario: SCENARIO, pricedAt: "2026-08-30T13:30:00.000Z",
      }],
      plan: PLAN,
      anchorIndex: 0,
      prepared: {
        borrowerName: "Miriam Rosenberg",
        propertyAddress: "14 Oak Street, Lakewood, NJ 08701",
        officerName: "Sara Klein", officerTitle: "Senior Loan Officer",
        officerEmail: OFFICER_EMAIL, officerPhone: "(732) 555-0142", officerNmls: "1234567",
        companyName: "YS Capital Group", companyNmls: "2609746",
      },
    });
    if (!built.ok) throw new Error(`snapshot refused: ${built.error} — ${built.message}`);

    sheetId = (await ltDb.query(
      /* `lt_term_sheet.id` carries no default — `store.insertWithFreshCode` mints
         it, because a term sheet's code is retried on a collision. */
      `INSERT INTO lt_term_sheet
         (id, code, borrower_name, created_by_staff, created_by, mode, kind, comp_plan,
          snapshot, snapshot_hash, priced_at, expires_at)
       VALUES (gen_random_uuid(), $1, 'Miriam Rosenberg', $2::uuid, 'officer', 'borrowerPaid', 'single', $3::jsonb,
               $4::jsonb, $5, now(), now() + interval '24 hours')
       RETURNING id`,
      [CODE, staff.id, JSON.stringify(PLAN), JSON.stringify(built.snapshot), `h-${U}`],
    )).rows[0].id;

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const P = `/api/lt/dscr/term-sheet/${CODE}`;

    const call = async (method, p, body, who = staff) => {
      const res = await fetch(base + p, {
        method,
        headers: {
          ...(who ? { authorization: `Bearer ${who.token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let out = null;
      try { out = await res.json(); } catch (_) { out = null; }
      return { status: res.status, body: out };
    };
    const rowsFor = async () => (await ltDb.query(
      `SELECT * FROM lt_term_sheet_delivery WHERE sheet_id = $1::uuid ORDER BY created_at`, [sheetId],
    )).rows;

    // ====================================================================
    section("A. the door refuses before it sends, and records nothing");
    // ====================================================================
    {
      sent.length = 0;
      const anon = await call("POST", `${P}/email`, { to: "m@example.com" }, null);
      ok(anon.status === 401, "A1 signed out, it is refused");
      ok(sent.length === 0, "A2 …and nothing was sent");

      const junk = await call("POST", `${P}/email`, { to: "nope" });
      ok(junk.status === 422, `A3 a typed address that is not one answers 422, not 500 (${junk.status})`);
      ok(/name@example\.com/.test((junk.body && junk.body.message) || ""),
        "A4 …with a sentence an officer can act on");
      ok(sent.length === 0, "A5 …and nothing was sent");

      const list = await call("POST", `${P}/email`, { to: "a@b.com, c@d.com" });
      ok(list.status === 422 && list.body.error === "email_list", "A6 a list of addresses is refused");

      const investor = await call("POST", `${P}/email`, {
        to: "miriam@example.com", note: "Deephaven priced this one.",
      });
      ok(investor.status === 422 && investor.body.error === "note_names_investor",
        "A7 ⛔ RULE 10 — a note naming the investor is refused at the door");
      ok(sent.length === 0, "A8 …and the borrower is sent nothing at all");

      ok((await rowsFor()).length === 0,
        "A9 ⛔ four refusals later there is still NO delivery row — a refusal is never recorded as a send");

      const nosuch = await call("POST", "/api/lt/dscr/term-sheet/TS-ZZZZZZ/email", { to: "m@example.com" });
      ok(nosuch.status === 404, "A10 a sheet that was never issued is a 404, not a send");
    }

    // ====================================================================
    section("B. a real send — and the row that is the only record of it");
    // ====================================================================
    let emailedPdf = null;
    {
      sent.length = 0;
      const out = await call("POST", `${P}/email`, {
        to: "Miriam Rosenberg <Miriam@Example.com>",
        note: "Here is the pricing we discussed on Tuesday.",
      });
      ok(out.status === 200 && out.body.ok, `B1 it sends (${out.status})`);
      ok(sent.length === 1, "B2 ⛔ exactly one message left the building");
      ok(sent[0].to === "miriam@example.com", "B3 …addressed to the borrower");
      ok(new RegExp(OFFICER_EMAIL, "i").test(String(sent[0].from || "")),
        `B4 ⛔ FROM the officer's own address, off the roster (${sent[0].from})`);
      ok(/Sara Klein/.test(String(sent[0].from || "")), "B5 …under their own name");
      emailedPdf = Buffer.from(sent[0].attachments[0].content, "base64");
      ok(emailedPdf.slice(0, 5).toString("latin1") === "%PDF-", "B6 …with a real PDF attached");

      const rows = await rowsFor();
      ok(rows.length === 1, `B7 ⛔ and it is RECORDED — one row (${rows.length})`);
      const r = rows[0] || {};
      ok(r.to_email === "miriam@example.com", "B8 the row names who it went to");
      ok(r.to_name === "Miriam Rosenberg", "B9 …and what they were called");
      ok(r.code === CODE, "B10 …which sheet it was");
      ok(r.filename === `term-sheet-${CODE}.pdf`,
        `B11 …the filename the borrower received, named for the kind it is (${r.filename})`);
      ok(r.doc_kind === "term_sheet", "B12 …what kind of document it was");
      ok(/^[0-9a-f]{64}$/.test(r.doc_sha256 || ""), "B13 …and a hash of the exact bytes");
      /* ⛔ NULL-SAFE ON PURPOSE. With the recording removed there is no row, and
         `createHash().update(undefined)` THROWS — which stops the battery where it
         stands and reports a crash instead of the four honest failures above it. A
         crashing test also "fails" and looks like proof; make it fail cleanly. */
      ok(!!r.doc_sha256 && require("crypto").createHash("sha256").update(emailedPdf).digest("hex") === r.doc_sha256,
        "B14 ⛔ the recorded hash is the hash of the bytes that were ACTUALLY attached");
      ok(String(r.sent_by_staff) === String(staff.id), "B15 …who sent it");
      ok(r.note === "Here is the pricing we discussed on Tuesday.", "B16 …and the note as it went out");
      ok(new RegExp(OFFICER_EMAIL, "i").test(r.from_email || ""), "B17 …from which address");
      ok(typeof r.sent_as_mode === "string" && r.sent_as_mode.length > 0,
        `B18 …and HOW it was addressed, so "it came from me" is a claim this row can settle (${r.sent_as_mode})`);
    }

    // ====================================================================
    section("C. the emailed copy IS the downloadable copy");
    // ====================================================================
    {
      const res = await fetch(`${base}${P}/pdf`, { headers: { authorization: `Bearer ${staff.token}` } });
      ok(res.status === 200, "C1 the download door answers");
      ok(/attachment; filename="term-sheet-/.test(res.headers.get("content-disposition") || ""),
        "C2 …naming the file for what the document is");
      const downloaded = Buffer.from(await res.arrayBuffer());
      ok(downloaded.slice(0, 5).toString("latin1") === "%PDF-", "C3 …with a real PDF");

      /* ⛔ COMPARED BY TEXT, NOT BY BYTES. The render is not byte-deterministic
         (measured), so a byte comparison would fail on a document that is in every
         way the same. What "one renderer" actually promises is that the borrower's
         copy and the officer's copy SAY the same thing. */
      const { getDocumentProxy } = await import("unpdf");
      const textOf = async (buf) => {
        const doc = await getDocumentProxy(new Uint8Array(buf));
        const out = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
          const tc = await (await doc.getPage(i)).getTextContent();
          out.push(tc.items.map((it) => it.str).join(" "));
        }
        return out.join("\n");
      };
      const a = await textOf(downloaded);
      const b = await textOf(emailedPdf);
      ok(a.length > 200, `C4 the downloaded sheet has real text on it (${a.length} chars)`);
      ok(a === b,
        "C5 ⛔ THE TWO DOORS DRAW THE SAME DOCUMENT — word for word, page for page");
      ok(/Sara Klein/.test(a) && new RegExp(OFFICER_EMAIL, "i").test(a),
        "C6 …and the officer's branding is on the paper as well as in the letter");
      ok(!/Deephaven/i.test(a), "C7 ⛔ and no investor is named on it");
    }

    // ====================================================================
    section("D. every send is kept, and the screen can read them back");
    // ====================================================================
    {
      sent.length = 0;
      const again = await call("POST", `${P}/email`, { to: "second@example.com" });
      ok(again.status === 200, "D1 a re-send to a corrected address is allowed");
      const rows = await rowsFor();
      ok(rows.length === 2,
        `D2 ⛔ BOTH sends are on the record — one column would have kept only the last of them (${rows.length})`);

      const list = await call("GET", `${P}/deliveries`);
      ok(list.status === 200 && Array.isArray(list.body.deliveries), "D3 the screen can read them back");
      ok(list.body.deliveries.length === 2, "D4 …all of them");
      /* Null-safe for the same reason B14 is: with the recording removed the list is
         empty, and reading a field off `[0]` throws — a crash where four honest
         failures should be. */
      const first = (list.body.deliveries || [])[0] || {};
      ok(first.to_email === "second@example.com",
        "D5 …newest first, so 'has she been sent it?' is answerable before sending another copy");
      ok(list.body.deliveries.length > 0 && !("doc_sha256" in first),
        "D6 …and the listing carries what a person reads, not the plumbing");
    }

    console.log("");
    if (bad) { console.error(`${bad} FAILED`); process.exit(1); }
    console.log("ALL PASSED");
  } finally {
    if (sheetId) {
      await ltDb.query("DELETE FROM lt_term_sheet_delivery WHERE sheet_id = $1::uuid", [sheetId]).catch(() => {});
      await ltDb.query("DELETE FROM lt_term_sheet WHERE id = $1::uuid", [sheetId]).catch(() => {});
    }
    if (staff) await db.query("DELETE FROM staff_users WHERE id = $1::uuid", [staff.id]).catch(() => {});
    if (server) await new Promise((r) => server.close(r));
  }
  process.exit(0);
})().catch((e) => { console.error("crashed:", e); process.exit(1); });
