"use strict";
/**
 * LT — THE TERM SHEET REACHES THE BORROWER, and it is the SAME document.
 *
 * The owner (2026-08-31): *"we should be able to put in an email address from a
 * borrower, which should deliver them the PDF and the nice email ... It should
 * deliver it from the loan officer's email address and from the loan officer's
 * name, and, of course, with the branding, same style emails that we have on the
 * short-term side."*
 *
 * ⛔ THE MAILER IS STUBBED AND THE WIRE PAYLOAD IS WHAT IS ASSERTED. A send that
 * "succeeds" against the noop provider proves nothing about who it was addressed
 * to, what rode along, or whether the body is a string at all — the RTL side has
 * already shipped an email whose whole HTML was the literal `[object Object]`
 * because every unit test passed against a provider that accepts anything. So this
 * captures the object handed to `email.sendMail` and reads it.
 *
 * ⛔ IT RENDERS A REAL PDF. `renderSheet` runs pdf-lib in-process, so the bytes
 * asserted on here are the bytes a borrower receives — no database needed, which
 * is why the whole of this can run in CI.
 *
 * The one thing a pure suite cannot see is the ROUTE: whether the door records the
 * send, and whether the downloaded copy and the emailed copy are byte-identical
 * end to end. That is `test-lt-term-sheet-deliver-db.js`.
 */

const path = require("path");
const fs = require("fs");

/* ── the mailer, stubbed BEFORE deliver.js is loaded ───────────────────────
   `deliver.js` captures the module at require time, so the stub has to be in the
   cache first. `sent` is every payload it was handed, in order. */
const MAIL = require.resolve("../src/lib/email/index.js");
const sent = [];
let nextSend = null;                       // null = accept; a function = its behaviour
require.cache[MAIL] = {
  id: MAIL, filename: MAIL, loaded: true, exports: {
    async sendMail(payload) {
      sent.push(payload);
      if (typeof nextSend === "function") return nextSend(payload, sent.length);
      return { ok: true, id: `stub-${sent.length}` };
    },
    fromWithName: (a) => a,
    rateStatus: () => ({}),
  },
};

const deliver = require("../src/longterm/termsheet/deliver.js");
const snapshot = require("../src/longterm/termsheet/snapshot.js");
const audience = require("../src/longterm/audience.js");

let bad = 0;
const ok = (c, m) => { if (c) console.log(`  ok   ${m}`); else { bad += 1; console.error(`  FAIL ${m}`); } };
const section = (t) => console.log(`\n${t}`);

// ── a real sheet, built the way the issue door builds one ──────────────────
const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const SCENARIO = {
  purpose: "Purchase", propertyType: "Single family", value: 500000, loan: 375000,
  ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: "NJ", city: "Lakewood", zip: "08701",
  rentMonthly: 3900, taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0,
  prepayMonths: 60, prepayStructure: "5 Year",
};
const quote = (label, ratePct, rawPrice) => ({
  label, consumerLabel: "Platinum", product: "30-Year Fixed DSCR", mode: "borrowerPaid",
  ratePct, rawPrice, scenario: SCENARIO, pricedAt: "2026-08-30T13:30:00.000Z",
});
const PREPARED = {
  borrowerName: "Miriam Rosenberg",
  propertyAddress: "14 Oak Street, Lakewood, NJ 08701",
  officerName: "Sara Klein", officerTitle: "Senior Loan Officer",
  officerEmail: "sara@yscapgroup.com", officerPhone: "(732) 555-0142", officerNmls: "1234567",
  companyName: "YS Capital Group", companyNmls: "2609746",
};

function sheetRow(selections, prepared) {
  const built = snapshot.buildSnapshot({
    selections, plan: PLAN, anchorIndex: 0, prepared: prepared || PREPARED,
  });
  if (!built.ok) throw new Error(`snapshot refused: ${built.error} — ${built.message}`);
  const created = new Date("2026-08-31T14:00:00.000Z");
  return {
    id: "11111111-2222-3333-4444-555555555555",
    code: "TS-4KH92B",
    borrower_name: "Miriam Rosenberg",
    snapshot: built.snapshot,
    created_at: created,
    expires_at: new Date(created.getTime() + 24 * 3600 * 1000),
  };
}
const COMPANY = { settings: {} };
const STR_WITH_CONTROLS = "a\u0000b\u0001c\u007Fd";

(async () => {
  // ==========================================================================
  section("A. the typed address — one borrower, or a sentence saying why not");
  // ==========================================================================
  {
    const bare = deliver.readAddress("miriam@example.com");
    ok(bare.ok && bare.email === "miriam@example.com", "A1 a bare address is taken");
    ok(bare.name === null, "A2 …with no name invented for it");

    const named = deliver.readAddress("  Miriam Rosenberg <Miriam@Example.COM>  ");
    ok(named.ok && named.email === "miriam@example.com",
      "A3 `Name <address>` is read, and the address is lower-cased so two spellings are one address");
    ok(named.name === "Miriam Rosenberg", "A4 …and the name comes back to greet them by");

    ok(deliver.readAddress('"Miriam Rosenberg" <m@e.com>').name === "Miriam Rosenberg",
      "A5 …quotes around the name are not part of the name");

    const list = deliver.readAddress("a@b.com, c@d.com");
    ok(!list.ok && list.error === "email_list",
      "A6 ⛔ a LIST is refused — a box that quietly sends to the first of three is worse than one that says it takes one");
    ok(/one borrower at a time/i.test(list.message), "A7 …and says so in words an officer can act on");
    ok(!deliver.readAddress("a@b.com; c@d.com").ok, "A8 …semicolons too");

    ok(!deliver.readAddress("").ok && deliver.readAddress("").error === "email_missing", "A9 nothing typed is its own answer");
    ok(!deliver.readAddress("   ").ok, "A10 …and so is whitespace");
    ok(!deliver.readAddress("nope").ok, "A11 junk is refused");
    ok(!deliver.readAddress("no@domain").ok, "A12 …an address with no dotted domain is refused");
    ok(/name@example\.com/.test(deliver.readAddress("nope").message),
      "A13 …showing what one looks like, rather than a bare 'invalid'");

    /* ⛔ HEADER INJECTION. A newline inside the typed value is how a second header
       is smuggled into a message. It is taken out before anything reads it. */
    const inj = deliver.readAddress("a@b.com\r\nBcc: someone@else.com");
    ok(!inj.ok || !/bcc/i.test(inj.email || ""),
      "A14 ⛔ a newline carrying a second header can never reach the address");
    ok(deliver._internals.str(STR_WITH_CONTROLS) === "a b c d",
      "A15 …and every control character is taken out of any string that goes on the wire");
  }

  // ==========================================================================
  section("B. the officer card is the DOCUMENT's officer, not the sender's");
  // ==========================================================================
  {
    const card = deliver.officerCard(PREPARED);
    ok(card && card.name === "Sara Klein", "B1 the card names the officer the paper names");
    ok(card.title === "Senior Loan Officer" && card.phone === "(732) 555-0142", "B2 …with their title and phone");
    ok(card.email === "sara@yscapgroup.com" && card.nmls === "1234567", "B3 …their email and their NMLS");
    ok(deliver.officerCard({}) === null,
      "B4 a sheet with no officer on it draws NO card — never an empty box with a blank name");
    ok(deliver.officerCard({ officerName: "Sara Klein" }).title === "Loan Officer",
      "B5 …and a missing title falls back to a true one rather than printing nothing");
  }

  // ==========================================================================
  section("C. the PDF — one renderer, and it is named for what it is");
  // ==========================================================================
  const doc = await deliver.renderSheet(sheetRow([quote("A", 7.375, 100.25)]), COMPANY);
  {
    ok(Buffer.isBuffer(doc.bytes) && doc.bytes.length > 2000, `C1 real PDF bytes come back (${doc.bytes.length})`);
    ok(doc.bytes.slice(0, 5).toString("latin1") === "%PDF-", "C2 …and they are a PDF, read off the bytes themselves");
    ok(doc.filename === "term-sheet-TS-4KH92B.pdf", `C3 named for the kind it is (${doc.filename})`);
    ok(doc.title === "Term Sheet TS-4KH92B", "C4 …and the document's own title says the same thing");
    ok(/^[0-9a-f]{64}$/.test(doc.sha256), "C5 the bytes are hashed, so a record can say WHICH document was sent");

    const cmp = await deliver.renderSheet(
      sheetRow([quote("A", 7.375, 100.25), quote("B", 7.75, 101.5)]), COMPANY);
    ok(cmp.filename === "comparison-sheet-TS-4KH92B.pdf",
      `C6 ⛔ a COMPARISON is named a comparison, never a term sheet (${cmp.filename})`);
    ok(cmp.kindWords === "comparison sheet", "C7 …from the same KIND_WORDS table the letter reads");
  }

  // ==========================================================================
  section("D. the letter QUOTES the document — it never re-derives a figure");
  // ==========================================================================
  {
    const row = sheetRow([quote("A", 7.375, 100.25)]);
    const letter = deliver.buildLetter({ row, doc, toName: "Miriam Rosenberg", note: null });

    ok(/Miriam/.test(letter.html), "D1 the borrower is greeted by name");
    ok(/TS-4KH92B/.test(letter.html), "D2 the reference is on it, so a telephone call can start with it");
    ok(/14 Oak Street/.test(letter.html), "D3 …and which property it is about");
    ok(/14 Oak Street/.test(letter.subject), "D4 the SUBJECT names the property — an inbox full of 'Your term sheet' names nothing");

    /* ⛔ THE FIGURES ARE THE DOCUMENT'S OWN HERO. Read the hero straight off the
       layout and require every one of its values to appear in the email, so the
       letter physically cannot state a rate the attachment disagrees with. */
    const hero = doc.layout.blocks.find((b) => b.t === "hero");
    ok(hero && hero.cells.length >= 2, `D5 the document has a hero to quote (${hero ? hero.cells.length : 0} cells)`);
    const missing = hero.cells.filter((c) => c.value && !letter.html.includes(c.value));
    ok(missing.length === 0,
      `D6 ⛔ EVERY headline figure on the paper is in the email${missing.length ? ` — missing ${missing.map((c) => c.value).join(", ")}` : ""}`);

    /* ⛔ THE CONTROL. D6 would also pass on a letter that ignored the hero and
       happened to contain those strings for another reason, so price the SAME
       sheet differently and require the email to move with it. */
    const other = sheetRow([quote("A", 9.125, 98.5)]);
    const otherDoc = await deliver.renderSheet(other, COMPANY);
    const otherLetter = deliver.buildLetter({ row: other, doc: otherDoc, toName: null, note: null });
    const otherHero = otherDoc.layout.blocks.find((b) => b.t === "hero");
    const rate = otherHero.cells.find((c) => /rate/i.test(c.label));
    ok(rate && otherLetter.html.includes(rate.value) && !letter.html.includes(rate.value),
      `D7 ⛔ CONTROL — re-price it and the email's own headline moves with the paper (${rate && rate.value})`);

    ok(/Sara Klein/.test(letter.html) && /sara@yscapgroup\.com/.test(letter.html),
      "D8 the officer is named on it, with their address");
    ok(/1234567/.test(letter.html), "D9 …and their NMLS number");
    ok(/attached/i.test(letter.html), "D10 it says the document is attached, so it is never a bare email with a mystery file");
    ok(/good through/i.test(letter.html), "D11 …and that the pricing has a clock on it");
    ok(typeof letter.text === "string" && letter.text.length > 50 && /TS-4KH92B/.test(letter.text),
      "D12 a plain-text part is rendered too — some clients show nothing else");

    const cmpRow = sheetRow([quote("A", 7.375, 100.25), quote("B", 7.75, 101.5)]);
    const cmpDoc = await deliver.renderSheet(cmpRow, COMPANY);
    const cmpLetter = deliver.buildLetter({ row: cmpRow, doc: cmpDoc, toName: null, note: null });
    ok(/comparison sheet/i.test(cmpLetter.html),
      "D13 ⛔ a comparison calls itself a comparison in the letter as well as on the paper");
    ok(/Nothing is committed/i.test(cmpLetter.html),
      "D14 …and says nothing is committed by any of them — a comparison commits to none");

    const anon = sheetRow([quote("A", 7.375, 100.25)], Object.assign({}, PREPARED, { borrowerName: null }));
    anon.borrower_name = null;
    const noName = deliver.buildLetter({ row: anon, doc, toName: null, note: null });
    ok(/Hello,/.test(noName.html) && !/Hi ,/.test(noName.html),
      "D15 with nobody to name it greets them plainly rather than 'Hi ,'");
  }

  // ==========================================================================
  section("E. RULE 10 — a note that names the investor is REFUSED, not scrubbed");
  // ==========================================================================
  {
    const row = sheetRow([quote("A", 7.375, 100.25)]);
    sent.length = 0;
    const out = await deliver.sendSheet({
      row, company: COMPANY, to: "miriam@example.com",
      note: "Deephaven came back with this one, take a look.",
      from: { name: "Sara Klein", email: "sara@yscapgroup.com" },
    });
    ok(!out.ok && out.error === "note_names_investor",
      "E1 ⛔ a note naming an investor is refused — the borrower may never learn who funds the loan");
    ok(sent.length === 0, "E2 ⛔ and NOTHING was sent — the refusal happens before the mailer is touched");
    ok(/take the name out/i.test(out.message), "E3 …with a sentence saying what to do about it");

    /* The check is the SHARED registry, never a hand-typed `!== 'Deephaven'` — a
       misspelling walks straight past one of those. Proven against the module's
       own recorded spellings rather than a list retyped here. */
    /* NOTE the registry holds {text, mode} entries, not bare strings — a first cut
       of this stringified them into "[object Object]" and cheerfully reported that
       twelve investors were refused, when it had tested one meaningless string
       twelve times. Read `.text`, and take only the unambiguous ones: `foundation`
       is on AMBIGUOUS_ALONE on purpose, because it is an ordinary English word. */
    const entries = audience._internals.spellings();
    const ambiguous = new Set(Array.from(audience._internals.AMBIGUOUS_ALONE || []));
    const sample = entries
      .map((e) => String((e && e.text) || e))
      .filter((t) => t.length > 6 && !ambiguous.has(t.toLowerCase()))
      .slice(0, 12);
    let leaked = 0;
    for (const name of sample) {
      sent.length = 0;
      const r = await deliver.sendSheet({
        row, company: COMPANY, to: "miriam@example.com", note: `Priced with ${name}.`,
        from: { name: "Sara Klein", email: "sara@yscapgroup.com" },
      });
      if (r.ok || sent.length) leaked += 1;
    }
    ok(sample.length > 0 && leaked === 0,
      `E4 ⛔ every recorded spelling tried (${sample.length}) is refused, none reaches the wire`);

    sent.length = 0;
    const clean = await deliver.sendSheet({
      row, company: COMPANY, to: "miriam@example.com",
      note: "Here is the pricing we discussed on Tuesday.",
      from: { name: "Sara Klein", email: "sara@yscapgroup.com" },
    });
    ok(clean.ok, "E5 …while an ordinary note goes out untouched");
    ok(/discussed on Tuesday/.test(sent[0].html), "E6 …and is what the borrower actually reads");
  }

  // ==========================================================================
  section("F. the wire payload — who it came from, and what rode along");
  // ==========================================================================
  {
    sent.length = 0;
    const row = sheetRow([quote("A", 7.375, 100.25)]);
    const out = await deliver.sendSheet({
      row, company: COMPANY, to: "Miriam Rosenberg <MIRIAM@example.com>",
      from: { name: "Sara Klein", email: "sara@yscapgroup.com" },
    });
    ok(out.ok, `F1 it sends${out.ok ? "" : ` — ${out.error}: ${out.message}`}`);
    const p = sent[0] || {};
    ok(sent.length === 1, "F2 ⛔ exactly ONE message — a borrower receiving their pricing twice is the failure to avoid");
    ok(p.to === "miriam@example.com", "F3 addressed to the borrower, lower-cased");
    ok(typeof p.html === "string" && !/\[object Object\]/.test(p.html),
      "F4 ⛔ the body is a STRING — `render()` returns an object, and handing that over is how an email of literal [object Object] ships");
    ok(typeof p.text === "string" && p.text.length > 0, "F5 …and a text part rode with it");
    ok(Array.isArray(p.attachments) && p.attachments.length === 1, "F6 the document is attached");
    ok(p.attachments && p.attachments[0].filename === "term-sheet-TS-4KH92B.pdf", "F7 …under the name the download uses");
    const back = p.attachments ? Buffer.from(p.attachments[0].content, "base64") : Buffer.alloc(0);
    ok(back.slice(0, 5).toString("latin1") === "%PDF-",
      "F8 ⛔ …and the attached bytes really are a PDF, decoded and read — not a stringified Buffer");
    /* ⛔ AGAINST THIS SEND'S OWN REPORT, never against a fresh render. The PDF is
       NOT byte-deterministic — two renders of one sheet come out the same length
       with different bytes — so comparing the attachment to a separately-rendered
       copy would fail for a reason that has nothing to do with delivery. What must
       hold is that the hash we RECORD describes the bytes we ATTACHED. */
    ok(require("crypto").createHash("sha256").update(back).digest("hex") === out.sha256,
      "F9 ⛔ the hash the send reports is the hash of the bytes that were actually attached");
    ok(back.length > 2000, `F9b …and the whole document rode along (${back.length} bytes)`);
    ok(/sara@yscapgroup\.com/i.test(String(p.from || "")),
      `F10 ⛔ it comes FROM the officer, which is what the owner asked for (${p.from})`);
    ok(/Sara Klein/.test(String(p.from || "")), "F11 …under their own name");
    ok(p.replyTo === "sara@yscapgroup.com", "F12 …and a reply reaches them");
    ok(p._skipCapture === true,
      "F13 ⛔ RULE 4 — a long-term send never writes the short-term Email Center");
    ok(p._ctx && p._ctx.audience === "borrower", "F14 …and it is recorded as going to a client, not to staff");

    ok(/^[0-9a-f]{64}$/.test(String(out.sha256)), "F15 the send reports a hash of what it sent");
    ok(typeof out.messageId === "string" && out.messageId.length > 0,
      "F16 …and the provider's own id, so an outcome can be traced back");
  }

  // ==========================================================================
  section("G. a person on another domain is sent FOR, never AS");
  // ==========================================================================
  {
    sent.length = 0;
    const out = await deliver.sendSheet({
      row: sheetRow([quote("A", 7.375, 100.25)]), company: COMPANY, to: "miriam@example.com",
      from: { name: "Sara Klein", email: "sara@gmail.com" },
    });
    ok(out.ok, "G1 it still sends");
    ok(!/sara@gmail\.com/i.test(String((sent[0] || {}).from || "")),
      "G2 ⛔ an address on a domain we have not verified never goes in the From line — DKIM alignment, not a preference");
    ok(/Sara Klein/.test(String((sent[0] || {}).from || "")), "G3 …their NAME still does");
    ok((sent[0] || {}).replyTo === "sara@gmail.com", "G4 …and every reply still reaches them");
  }

  // ==========================================================================
  section("H. a send that may have happened is never repeated");
  // ==========================================================================
  {
    sent.length = 0;
    nextSend = () => { throw new Error("fetch failed"); };
    const amb = await deliver.sendSheet({
      row: sheetRow([quote("A", 7.375, 100.25)]), company: COMPANY, to: "miriam@example.com",
      from: { name: "Sara Klein", email: "sara@yscapgroup.com" },
    });
    nextSend = null;
    ok(!amb.ok && amb.error === "send_unconfirmed" && amb.ambiguous === true,
      "H1 ⛔ a provider that stopped responding is reported as UNCONFIRMED, never as failed");
    ok(sent.length === 1,
      "H2 ⛔ …and it is NOT retried — the provider may already have taken it, and a retry sends the borrower their pricing twice");
    ok(/before sending it again/i.test(amb.message), "H3 …the message tells the officer to check before re-sending");

    sent.length = 0;
    nextSend = () => ({ ok: false, skipped: true });
    const off = await deliver.sendSheet({
      row: sheetRow([quote("A", 7.375, 100.25)]), company: COMPANY, to: "miriam@example.com",
      from: { name: "Sara Klein", email: "sara@yscapgroup.com" },
    });
    nextSend = null;
    ok(!off.ok,
      "H4 ⛔ a provider that SKIPPED the message is a failure — `{ok:false,skipped:true}` returns without throwing, and reporting it as sent is how a borrower waits on an email nobody sent");

    /* ⛔ H1–H3 ABOVE PROVE LESS THAN THEY LOOK. The retry is gated on
       `sender.fallbackOnFailure`, which is true ONLY under Microsoft Graph — so in
       an ordinary environment `throw first` fires for a reason that has nothing to
       do with ambiguity, and a mutation removing the ambiguity check sails straight
       through (it did; that is why this section exists). A gate with two
       independent reasons to refuse proves neither, so the fallback is made LIVE
       and the two cases are separated. */
    const ltCfg = require("../src/longterm/config.js");
    const realProvider = ltCfg.emailProvider;
    ltCfg.emailProvider = "graph";
    try {
      // THE CONTROL FIRST: with the fallback live, a PLAIN refusal really is retried
      // as the company — so the machinery under test is running.
      sent.length = 0;
      nextSend = (p, n) => {
        if (n === 1) throw new Error("REST API returned 400: the From address is not a mailbox in this tenant");
        return { ok: true, id: "stub-fallback" };
      };
      const fell = await deliver.sendSheet({
        row: sheetRow([quote("A", 7.375, 100.25)]), company: COMPANY, to: "miriam@example.com",
        from: { name: "Sara Klein", email: "sara@yscapgroup.com" },
      });
      nextSend = null;
      ok(fell.ok && sent.length === 2,
        `H5 CONTROL — under Graph a From that is not a mailbox is retried from the company address (${sent.length} sends)`);
      ok(!/sara@yscapgroup\.com/i.test(String((sent[1] || {}).from || "")),
        "H6 …from the company, with their name on it");

      // AND NOW THE THING THAT MATTERS: the same live fallback, an AMBIGUOUS failure.
      sent.length = 0;
      nextSend = () => { throw new Error("The operation was aborted due to timeout"); };
      const amb2 = await deliver.sendSheet({
        row: sheetRow([quote("A", 7.375, 100.25)]), company: COMPANY, to: "miriam@example.com",
        from: { name: "Sara Klein", email: "sara@yscapgroup.com" },
      });
      nextSend = null;
      ok(sent.length === 1,
        `H7 ⛔ THE ONE THAT MATTERS — with the fallback live, a TIMEOUT is still not retried: the provider may already have taken it, and the borrower would receive their pricing twice (${sent.length} sends)`);
      ok(!amb2.ok && amb2.ambiguous === true, "H8 …and it is reported as unconfirmed rather than failed");
    } finally {
      ltCfg.emailProvider = realProvider;
      nextSend = null;
    }
  }

  // ==========================================================================
  section("I. SOURCE — one renderer, and the door goes through it");
  // ==========================================================================
  {
    const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    /* Every long-term source file, comments stripped — the explanation of WHY there
       is one renderer necessarily names the call it replaced, and a guard that read
       comments would fail on its own explanation and then get "fixed" by deleting it. */
    const walk = (dir, out) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (/\.(js|mjs)$/.test(e.name)) out.push(full);
      }
      return out;
    };
    const ltFiles = walk(path.join(__dirname, "..", "src", "longterm"), []);
    const drawers = ltFiles.filter((f) => /renderTermSheet\s*\(/.test(stripComments(fs.readFileSync(f, "utf8")))
      && !/termsheet[\\/]pdf\.js$/.test(f));
    ok(drawers.length === 1 && /termsheet[\\/]deliver\.js$/.test(drawers[0] || ""),
      `I1 ⛔ exactly ONE place draws a long-term sheet, and it is deliver.js (${drawers.map((f) => path.basename(f)).join(", ") || "none"})`);

    const route = stripComments(read("src/longterm/routes/term-sheet.js"));
    ok((route.match(/deliver\.renderSheet\(/g) || []).length === 1,
      "I2 the download door goes through it, so it cannot assemble its own layout options");
    ok(/deliver\.sendSheet\(/.test(route),
      "I3 …and the email door goes through deliver.sendSheet, which renders through the same function");

    const del = stripComments(read("src/longterm/termsheet/deliver.js"));
    ok(/_skipCapture:\s*true/.test(del), "I4 ⛔ rule 4 is in the payload, not only in a comment");
    ok(/mentionsInvestor\(/.test(del), "I5 ⛔ rule 10 is enforced by the shared registry check");
    /* The module SENDS and does not RECORD: the door owns the row, so a bookkeeping
       failure can never look like a failed send. Asserted structurally — it holds
       no database handle at all — rather than by searching for the table's name,
       which its own `_ctx` label legitimately contains. */
    ok(!/require\(["'][^"']*\/db["']\)/.test(del) && !/\bdb\.query\(/.test(del) && !/INSERT INTO/i.test(del),
      "I6 ⛔ the module holds no database handle at all — it cannot record, so a bookkeeping failure can never look like a failed send");

    /* The settings reader is shared, or the emailed copy and the downloaded copy can
       come to disagree about the expiry window they were built with. */
    ok(/settingsStore\.pick\(/.test(del) && /const setting = settingsStore\.pick/.test(route),
      "I7 ⛔ both read settings through ONE reader");
  }

  console.log("");
  if (bad) { console.error(`${bad} FAILED`); process.exit(1); }
  console.log("ALL PASSED");
})().catch((e) => { console.error("crashed:", e); process.exit(1); });
