"use strict";
/**
 * LT — EVENING OUT A PRICE, OVER THE REAL DOORS (§40).
 *
 * `test-lt-price-adjust-pure.js` proves the arithmetic, the snapshot and the
 * screen's shape. Three things it structurally cannot see, and they are the three
 * this exists for:
 *
 *   ⛔ THE SUGGESTIONS COME FROM THE SERVER'S OWN COMPENSATION. The plan is
 *     resolved per person — theirs, then the company's, with the company figure as
 *     a floor — and is deliberately never sent to the browser. Only a real request
 *     under a real officer's identity proves the door answers from THAT resolution
 *     rather than from something the caller passed in.
 *
 *   ⛔ THE ADJUSTMENT SURVIVES BEING ISSUED. The money decision is recorded on the
 *     staff-side row (db/651), which is the only place "why is this price 101.000?"
 *     is answerable a month later — and no pure test can see a database column.
 *
 *   ⛔ THE DOCUMENT THAT COMES OUT IS PRICED ON IT. The PDF is drawn from the
 *     STORED snapshot, so the proof is the issued sheet's own bytes, read back.
 *
 * DB-GATED: with no DATABASE_URL it SKIPS and says so.
 */

const http = require("http");
const path = require("path");

(async () => {
  await require(path.join(__dirname, "lib", "db-gate")).skipUnlessDb("lt-price-adjust-door");

  const app = require("../src/server");
  const crypto = require("../src/lib/crypto");
  const db = require("../src/db");
  const ltDb = require("../src/longterm/db");
  const { ensureSchema } = require("../src/migrate-boot");

  let bad = 0;
  const ok = (c, m) => { if (c) console.log(`  ok   ${m}`); else { bad += 1; console.error(`  FAIL ${m}`); } };
  const section = (t) => console.log(`\n${t}`);

  await ensureSchema();

  const U = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let server = null;
  let staff = null;
  const madeSheets = [];

  const SCENARIO = {
    purpose: "Purchase", propertyType: "Single family", value: 500000, loan: 375000,
    ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: "NJ", city: "Lakewood", zip: "08701",
    rentMonthly: 3900, taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0,
    prepayMonths: 60, prepayStructure: "5 Year",
  };
  const selection = (adjust) => ({
    label: "A", consumerLabel: "Platinum", product: "30-Year Fixed DSCR", mode: "borrowerPaid",
    ratePct: 7.375, rawPrice: 103.1, scenario: SCENARIO, pricedAt: "2026-08-30T13:30:00.000Z",
    priceAdjustment: adjust,
    internal: { investor: "Deephaven Select", rawPrice: 103.1 },
  });
  const PREPARED = { borrowerName: "Miriam Rosenberg", propertyAddress: "14 Oak Street, Lakewood, NJ 08701" };

  try {
    const row = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1, 'Sara Klein', 'loan_officer', true) RETURNING id, token_version`,
      [`lt-adj-${U}@yscapgroup.com`],
    )).rows[0];
    staff = {
      id: row.id,
      token: crypto.signJwt({ sub: String(row.id), kind: "staff", role: "loan_officer", tv: row.token_version, sid: U }),
    };

    /* ⛔ THE OFFICER NEEDS A REAL COMPENSATION PLAN, or this suite proves nothing.
       With nothing set the resolved plan is ZERO points, the displayed price equals
       the raw price, and "the door used the server's own compensation" becomes
       indistinguishable from "the door echoed what the caller sent". A first cut
       had exactly that and reported a pass on A4 for the wrong reason. */
    const settingsStore = require("../src/longterm/settings/store");
    await settingsStore.save(
      { "comp.lenderPaid": 2, "comp.borrowerPaid": 2, "comp.ysp": 2 },
      { scope: `user:${staff.id}`, staffId: staff.id, keepDefault: true },
    );
    settingsStore.bust();

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const P = "/api/lt/dscr/term-sheet";

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

    // ====================================================================
    section("A. the suggestions door — the server's compensation, never the caller's");
    // ====================================================================
    let priceNow = null;
    {
      const anon = await call("POST", `${P}/price-adjust`, { mode: "borrowerPaid", rawPrice: 103.1 }, null);
      ok(anon.status === 401, "A1 signed out, it is refused");

      const out = await call("POST", `${P}/price-adjust`, { mode: "borrowerPaid", rawPrice: 103.1 });
      ok(out.status === 200 && out.body.ok, `A2 it answers (${out.status})`);
      priceNow = out.body.priceNow;
      ok(typeof priceNow === "number", `A3 …saying what the price reads at now (${priceNow})`);

      /* ⛔ THE PROOF THAT IT USED OUR OWN COMPENSATION. The caller sent a RAW price
         and nothing else — no plan, no comp — so a price that differs from the raw
         one can only have come from the server's own resolution. A door that echoed
         the caller would answer 103.1. */
      ok(priceNow !== 103.1,
        "A4 ⛔ …and it is NOT the raw price the caller sent — the compensation came from the server's own plan");

      ok(Array.isArray(out.body.suggestions) && out.body.suggestions.length > 0,
        `A5 it offers somewhere to round to (${(out.body.suggestions || []).length})`);
      const targets = (out.body.suggestions || []).map((x) => x.target);
      ok(targets.every((t) => Math.abs(t * 4 - Math.round(t * 4)) < 1e-9),
        `A6 …every one of them a round quarter or whole (${targets.join(", ")})`);
      ok((out.body.suggestions || []).every((x) => x.compAfter >= 0),
        "A7 ⛔ …and not one of them would take our compensation below zero");
      ok((out.body.suggestions || []).every((x) => typeof x.detail === "string" && /compensation/.test(x.detail)),
        "A8 …each saying what it costs us, which is the point of a suggestion here");

      const typed = await call("POST", `${P}/price-adjust`, {
        mode: "borrowerPaid", rawPrice: 103.1, deltaPoints: -0.1,
      });
      ok(typed.body.applied && typed.body.applied.ok, "A9 a typed adjustment is worked out too");
      ok(typed.body.applied.priceAfter === Math.round((priceNow - 0.1) * 1000) / 1000,
        `A10 ⛔ the owner's own example: it lands on ${typed.body.applied && typed.body.applied.priceAfter}`);

      const slip = await call("POST", `${P}/price-adjust`, {
        mode: "borrowerPaid", rawPrice: 103.1, deltaPoints: 9,
      });
      ok(slip.status === 200 && slip.body.applied && slip.body.applied.ok === false,
        "A11 a decimal slip comes back as a refusal, not an error");
      ok(/capped at 2 points/.test(slip.body.applied.message),
        "A12 …in the module's own words, so the officer reads the same sentence wherever they typed it");

      const raw = await call("POST", `${P}/price-adjust`, { mode: "raw", rawPrice: 103.1 });
      ok(raw.status === 200 && raw.body.suggestions.length === 0 && raw.body.priceNow === null,
        "A13 raw pricing offers none and claims no price — there is nothing of ours to give away");

      const noprice = await call("POST", `${P}/price-adjust`, { mode: "borrowerPaid" });
      ok(noprice.status === 422, "A14 …and no price at all is a refusal with a sentence, not a 500");
    }

    // ====================================================================
    section("B. issued — the document is priced on it, and the record remembers");
    // ====================================================================
    {
      const plain = await call("POST", P, { selections: [selection(null)], prepared: PREPARED });
      ok(plain.status === 200, `B1 an unadjusted sheet issues (${plain.status})`);
      madeSheets.push(plain.body.code);

      const moved = await call("POST", P, { selections: [selection(-0.1)], prepared: PREPARED });
      ok(moved.status === 200, `B2 …and an adjusted one issues too (${moved.status})`);
      madeSheets.push(moved.body.code);

      const priceOf = async (code) => (await ltDb.query(
        `SELECT snapshot -> 'members' -> 0 -> 'charges' ->> 'displayPrice' AS p FROM lt_term_sheet WHERE code = $1`,
        [code],
      )).rows[0].p;
      const p1 = Number(await priceOf(plain.body.code));
      const p2 = Number(await priceOf(moved.body.code));
      ok(p1 === priceNow, `B3 the unadjusted sheet stored the price the door quoted (${p1})`);
      ok(Math.abs(p2 - (p1 - 0.1)) < 1e-9,
        `B4 ⛔ and the adjusted one is exactly 0.1 lower — the typed number reached the STORED document (${p2})`);

      const recOf = async (code) => (await ltDb.query(
        `SELECT sc.internal FROM lt_term_sheet_scenario sc
           JOIN lt_term_sheet t ON t.id = sc.cart_id AND sc.parent_kind = 'sheet'
          WHERE t.code = $1 ORDER BY sc.position LIMIT 1`,
        [code],
      )).rows[0].internal;
      const r1 = await recOf(plain.body.code);
      const r2 = await recOf(moved.body.code);
      ok(r2.adjustmentPoints === -0.1, "B5 ⛔ the staff record says by how much it was evened out");
      ok(r2.compBefore != null && r2.compAfter != null && r2.compAfter > r2.compBefore,
        `B6 …and out of whose money it came (${r2.compBefore} → ${r2.compAfter})`);
      ok(r1.adjustmentPoints === undefined,
        "B7 ⛔ …while the unadjusted sheet records nothing at all, exactly as it always did");
      ok(r2.investor === "Deephaven Select" && r1.investor === "Deephaven Select",
        "B8 …both still record who was behind the price");

      /* ⛔ AND NONE OF IT IS ON THE DOCUMENT. The snapshot IS what a borrower may
         hold, so the compensation arithmetic must not be anywhere in it. */
      const snapText = (await ltDb.query("SELECT snapshot::text AS s FROM lt_term_sheet WHERE code = $1",
        [moved.body.code])).rows[0].s;
      ok(!/adjustmentPoints|compBefore|compAfter|priceBeforeAdjustment/.test(snapText),
        "B9 ⛔ the stored document carries none of the compensation arithmetic");
      ok(!/Deephaven/i.test(snapText),
        "B10 …and no investor name either — rule 10, unchanged by any of this");

      const slip = await call("POST", P, { selections: [selection(9)], prepared: PREPARED });
      ok(slip.status === 422 && slip.body.error === "delta_too_large",
        "B11 ⛔ a decimal slip refuses the ISSUE — nothing is minted at a price nobody meant");
      ok(/capped at 2 points/.test(slip.body.message || ""), "B12 …with the sentence an officer can act on");
    }

    // ====================================================================
    section("C. and it is the SHEET's own paper that moved");
    // ====================================================================
    {
      const [plainCode, movedCode] = madeSheets;
      const textOf = async (code) => {
        const res = await fetch(`${base}${P}/${code}/pdf`, { headers: { authorization: `Bearer ${staff.token}` } });
        const buf = Buffer.from(await res.arrayBuffer());
        const { getDocumentProxy } = await import("unpdf");
        const doc = await getDocumentProxy(new Uint8Array(buf));
        const out = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
          const tc = await (await doc.getPage(i)).getTextContent();
          out.push(tc.items.map((it) => it.str).join(" "));
        }
        return out.join("\n");
      };
      const a = await textOf(plainCode);
      const b = await textOf(movedCode);
      ok(a.length > 200 && b.length > 200, "C1 both sheets draw");
      ok(a !== b, "C2 ⛔ …and they are not the same document — the adjustment reached the paper");
      ok(!/Deephaven/i.test(b), "C3 …with no investor named on either");
    }

    console.log("");
    if (bad) { console.error(`${bad} FAILED`); process.exit(1); }
    console.log("ALL PASSED");
  } finally {
    for (const c of madeSheets) {
      if (!c) continue;
      await ltDb.query(
        `DELETE FROM lt_term_sheet_scenario WHERE cart_id IN (SELECT id FROM lt_term_sheet WHERE code = $1)`, [c],
      ).catch(() => {});
      await ltDb.query("DELETE FROM lt_term_sheet WHERE code = $1", [c]).catch(() => {});
    }
    if (staff) await db.query("DELETE FROM staff_users WHERE id = $1::uuid", [staff.id]).catch(() => {});
    if (server) await new Promise((r) => server.close(r));
  }
  process.exit(0);
})().catch((e) => { console.error("crashed:", e); process.exit(1); });
