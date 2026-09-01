"use strict";
/**
 * LONG-TERM — SENDING THE SHEET TO THE BORROWER.
 *
 * The owner (2026-08-31): *"we should be able to put in an email address from a
 * borrower, which should deliver them the PDF and the nice email ... It should
 * deliver it from the loan officer's email address and from the loan officer's
 * name, and, of course, with the branding, same style emails that we have on the
 * short-term side."*
 *
 * Until now a long-term term sheet could only be DOWNLOADED. The officer saved the
 * PDF out of the browser, attached it in their own mail client and typed something
 * around it — so the borrower's copy went out under whatever branding that client
 * had, worded differently every time, and PILOT held no record that the person had
 * ever been sent anything.
 *
 * ── THE ONE RENDERER IS THE POINT OF THIS FILE ──────────────────────────────
 *
 * `renderSheet` is the ONLY place a long-term sheet becomes a PDF, and BOTH the
 * download route and this email go through it. That is not tidiness: the layout is
 * built from options — the priced-apart window, the expiry hours read off the
 * DOCUMENT rather than off today's settings — and two callers assembling those
 * options separately is exactly how the copy a borrower is emailed comes to say a
 * different expiry from the copy the officer downloaded and filed. One function,
 * one set of options, one document.
 *
 * ── WHAT IS SHARED, AND WHAT IS OURS ────────────────────────────────────────
 *
 * SHARED, and authorized in `docs/LONG-TERM-AUTHORIZED-COPIES.md` (2026-08-30):
 * the branded renderer (`lib/email/template.js` — the owner asked for the same
 * Gmail-style box, and a second renderer would be a second brand), the mail
 * transport (`lib/email/index.js` — one account, one deliverability posture), the
 * from-line rule (`lib/send-as.js`), and the ambiguous-failure reading
 * (`lib/order-email.js`).
 *
 * OURS: every word of the letter. A vendor order asks somebody to do work; this
 * hands a borrower their own pricing. Sending them the order letter would be
 * sharing the WRONG thing.
 *
 * ── RULE 10 IS ENFORCED BY REFUSAL, NOT BY A WARNING ────────────────────────
 *
 * The investor's name never reaches a client. The officer's typed note is the one
 * piece of free text on this path, so it is put through `audience.mentionsInvestor`
 * — the ONE definition, built on the 117-spelling registry — and a note that names
 * an investor is REFUSED with a sentence saying which rule it hit. Same treatment
 * `snapshot.resolveProgramName` already gives a typed program name, and for the
 * same reason: a sentence under a text box is advice; the refusal is the control.
 *
 * The PDF needs no such guard here — `pdf.js` scrubs every string it draws at the
 * draw layer, so the attached document is client-safe by construction.
 *
 * ── NOTHING HERE MAY EVER SEND TWICE ────────────────────────────────────────
 *
 * A provider that stops responding mid-send may or may not have taken the message,
 * so an ambiguous failure is reported AS ambiguous and never retried — the same
 * rule the orders desk follows. A borrower receiving two copies of their pricing is
 * a worse outcome than an officer pressing the button again after looking.
 */

const crypto = require("crypto");

const cfg = require("../config");
const email = require("../../lib/email");
const tpl = require("../../lib/email/template");
const sendAs = require("../../lib/send-as");
const orderEmail = require("../../lib/order-email");

const audience = require("../audience");
const settingsStore = require("../settings/store");
const layout = require("./layout");
const pdf = require("./pdf");
const snapshot = require("./snapshot");

/* An attachment budget, stated rather than discovered. A term sheet is text and
   rules — a few pages, no photographs — so this is nowhere near what a real one
   weighs; it exists so that a document which somehow grows past what a provider
   will carry is REFUSED with a sentence rather than handed over to be rejected on
   the wire, where the officer would see "the email provider rejected the message"
   and have nothing to act on. */
const MAX_ATTACH_MB = 15;

/* Where a mail header ends and the next one begins. A newline or a carriage
   return inside a name or an address is how a header injection is written, and a
   comma or a semicolon is how a second recipient is smuggled into a box that says
   one address. Every one of them is stripped or refused at the door. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const ADDRESS_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/;
const NAMED_RE = /^\s*(.*?)\s*<\s*([^<>]+)\s*>\s*$/;

/** Trim, and take out anything that is not printable text. Never returns null. */
function str(v, max) {
  const s = String(v == null ? "" : v).replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return max && s.length > max ? s.slice(0, max).trim() : s;
}

/**
 * ONE typed address → who to send to, or a refusal saying what is wrong with it.
 *
 * Accepts a bare address or `Name <address>`, and REFUSES a list. The owner asked
 * for "an email address from a borrower" — singular — and a box that quietly sends
 * to the first of three typed addresses is worse than one that says it takes one.
 */
function readAddress(raw) {
  const typed = str(raw, 320);
  if (!typed) {
    return { ok: false, error: "email_missing", message: "Type the borrower's email address." };
  }
  if (/[,;]/.test(typed)) {
    return {
      ok: false,
      error: "email_list",
      message: "This sends to one borrower at a time. Take out the extra addresses and send it again for the other person.",
    };
  }
  const named = NAMED_RE.exec(typed);
  const addr = str(named ? named[2] : typed, 254);
  const name = named ? str(named[1].replace(/^"|"$/g, ""), 120) : "";
  if (!ADDRESS_RE.test(addr)) {
    return {
      ok: false,
      error: "email_invalid",
      message: `"${typed}" does not look like an email address. It should read like name@example.com.`,
    };
  }
  return { ok: true, email: addr.toLowerCase(), name: name || null };
}

/** The document's own words for what it is — the same table the filename uses. */
function kindWordsOf(docKind) {
  const k = docKind || snapshot.DOC_KINDS.TERM_SHEET;
  return snapshot.KIND_WORDS[k] || snapshot.KIND_WORDS[snapshot.DOC_KINDS.TERM_SHEET];
}

/**
 * THE OFFICER'S CARD, from the sheet's own `prepared` block.
 *
 * Read off the DOCUMENT rather than off the person sending the email, deliberately:
 * the card under the letter must name whoever the paper says prepared it, or a
 * covering assistant re-sending a colleague's sheet would put their own name beside
 * somebody else's document. `preparedFrom` fills that block from the roster at
 * issue time, so this is the roster's answer, recorded.
 */
function officerCard(prepared) {
  const p = prepared || {};
  const name = str(p.officerName, 120);
  if (!name) return null;
  return {
    name,
    title: str(p.officerTitle, 80) || "Loan Officer",
    email: str(p.officerEmail, 254) || null,
    phone: str(p.officerPhone, 40) || null,
    nmls: str(p.officerNmls, 40) || null,
  };
}

/** How long the sheet's own pricing was good for, in hours. Null when unreadable. */
function hoursBetween(from, to) {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round((b - a) / 3600000);
}

/**
 * THE PDF — one renderer, both doors.
 *
 * ⛔ THE EXPIRY WINDOW IS READ OFF THE DOCUMENT, NOT OFF TODAY'S SETTINGS. This
 * sheet was issued on the clock that was in force then; re-reading the setting
 * would make a replay of a 24-hour sheet announce 48 because somebody widened the
 * window last week.
 *
 * ⛔ THE DOWNLOAD IS NAMED FOR WHAT THE DOCUMENT IS. The words come from
 * `KIND_WORDS`, so the filename, the PDF's own title and anything a screen says
 * about it can never drift apart. The `TS-` code is deliberately left alone: it is
 * the durable identifier people read down a telephone and quote back.
 */
async function renderSheet(row, company) {
  const lay = layout.buildLayout(row.snapshot, {
    code: row.code,
    pricedApartMinutes: Number(settingsStore.pick(company, "termSheet.pricedApartMinutes", 60)) || 60,
    expiryHours: hoursBetween(row.created_at, row.expires_at),
  });
  const kindWords = kindWordsOf(lay.docKind);
  const titleWords = kindWords.replace(/(^|\s)\w/g, (c) => c.toUpperCase());
  const slug = kindWords.replace(/\s+/g, "-");
  const bytes = await pdf.renderTermSheet(lay, { title: `${titleWords} ${row.code}` });
  const buf = Buffer.from(bytes);
  return {
    bytes: buf,
    filename: `${slug}-${row.code}.pdf`,
    title: `${titleWords} ${row.code}`,
    titleWords,
    kindWords,
    docKind: lay.docKind,
    /* WHICH BYTES THESE ARE, so a delivery record can name the document it sent.
       ⛔ HONEST NOTE, MEASURED: this is NOT reproducible. Two renders of one sheet
       come out the same length with different bytes deep inside a compressed
       stream, so re-rendering a sheet and expecting its recorded hash back will
       always disagree. The CONTENT is settled — it is drawn from an immutable
       snapshot — but the bytes are not, so never build a "is this the same paper?"
       check on a fresh render. Hash the copy somebody actually holds. */
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    layout: lay,
  };
}

/** A date a borrower reads, in plain words. Null when unreadable. */
function dayText(v) {
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York",
  });
}

/** The first name somebody is greeted by, or nothing rather than a wrong guess. */
function firstNameOf(full) {
  const s = str(full, 120);
  if (!s) return null;
  const first = s.split(/\s+/)[0];
  return first && first.length > 1 ? first : null;
}

/**
 * THE LETTER.
 *
 * ⛔ THE FIGURES ARE QUOTED FROM THE DOCUMENT, NEVER RE-DERIVED. The headline
 * block is the layout's OWN hero — the same cells the PDF prints at the top of
 * page one — so the email physically cannot state a rate or a payment that the
 * attachment disagrees with. On a comparison that hero counts the options rather
 * than picking one, which is the honest headline for a document that commits to
 * none; that judgement already lives in `layout.heroCells` and is not repeated here.
 */
function buildLetter(opts = {}) {
  const { row, doc, toName, note } = opts;
  const s = row.snapshot || {};
  const p = s.prepared || {};
  const isTermSheet = doc.docKind === snapshot.DOC_KINDS.TERM_SHEET;

  const property = str(p.propertyAddress, 200);
  const greetName = firstNameOf(toName) || firstNameOf(row.borrower_name) || firstNameOf(p.borrowerName);
  const officer = officerCard(p);

  /* The hero, as the branded template's ranked money block: the document's first
     cell at headline weight, the rest small underneath. `figures` is rendered only
     when its primary carries a value, so a document with no hero simply prints the
     meta rows and the attachment — never an empty band. */
  // Through the shared flattener, not a bare `find`: a block can CONTAIN blocks,
  // and a walker that does not know it goes silently blind rather than erroring.
  const hero = layout.flattenBlocks(doc.layout.blocks || []).find((b) => b && b.t === "hero");
  const cells = hero && Array.isArray(hero.cells) ? hero.cells.filter((c) => c && c.value) : [];
  const figures = cells.length
    ? {
      primary: { label: cells[0].label, value: cells[0].value, sub: cells[0].note || null },
      secondary: cells.slice(1).map((c) => ({ label: c.label, value: c.value })),
    }
    : null;

  const goodThrough = dayText(row.expires_at);
  const meta = [
    { label: "Reference", value: row.code },
    property ? { label: "Property", value: property } : null,
    goodThrough ? { label: "Pricing good through", value: goodThrough } : null,
  ].filter(Boolean);

  /* WHAT THE ATTACHMENT IS, said in the document's own words. A borrower who
     opens this on a telephone sees the figures above and this line telling them
     the rest is in the file — never a bare email with a mystery attachment. */
  const optionCount = Array.isArray(s.members) ? s.members.length : 0;
  const enclosure = isTermSheet
    ? `Your full ${doc.kindWords} is attached as a PDF. It sets out the loan, the monthly payment, `
      + "the estimated cash to close and what happens next."
    : `Your ${doc.kindWords} is attached as a PDF${optionCount > 1 ? `, with all ${optionCount} options side by side` : ""}. `
      + "It sets out each option's rate, payment and cash to close so you can compare them.";

  const lines = [enclosure];
  lines.push("", isTermSheet
    ? "Nothing is owed and nothing is committed by reading it — if it looks right, reply and we will take it from there."
    : "Nothing is committed by any of these. Tell us which one you want to look at more closely and we will go from there.");

  const intro = note
    || (isTermSheet
      ? `Here is the pricing we put together${property ? ` for ${property}` : ""}.`
      : `Here are the options we put together${property ? ` for ${property}` : ""}.`);

  return tpl.render({
    title: `Your ${doc.kindWords}`,
    subjectTag: property || row.code,
    kicker: doc.kindWords,
    preheader: `${doc.titleWords} ${row.code}${property ? ` — ${property}` : ""}`,
    greeting: greetName ? `Hi ${greetName},` : "Hello,",
    intro,
    figures,
    lines,
    meta,
    officer,
    /* The expiry is stated in the letter as well as on the paper. A borrower who
       reads the email on their telephone and opens the PDF a week later should
       have been told once, in plain words, that the price has a clock on it. */
    note: goodThrough
      ? `This pricing is good through ${goodThrough}. After that we would price it again — rates move.`
      : "",
    replyable: true,
    audience: "borrower",
  });
}

/**
 * SEND IT.
 *
 * Returns `{ok:true, ...}` or `{ok:false, error, message}` where the message is a
 * sentence the officer can act on. Never throws for an ordinary refusal: a bad
 * address, a note that names an investor and a provider that refused the message
 * are all things a person fixes and tries again, and a 500 tells them none of it.
 */
async function sendSheet(opts = {}) {
  const { row, company, from } = opts;

  const to = readAddress(opts.to);
  if (!to.ok) return to;

  const typedNote = str(opts.note, 1000);
  /* ⛔ RULE 10 — THE INVESTOR NAME NEVER REACHES A CLIENT. Refused, not scrubbed:
     an officer whose note is silently rewritten never learns the rule exists, and
     the next one goes out on a surface that has no scrub. */
  if (typedNote && audience.mentionsInvestor(typedNote)) {
    return {
      ok: false,
      error: "note_names_investor",
      message: "That note names the investor, and a borrower's document may never name who funds the loan. "
        + "Take the name out and send it again — describe the program instead.",
    };
  }
  /* HONEST NOTE: with the refusal above this scrub is REDUNDANT TODAY — it runs on
     text `mentionsInvestor` has already cleared, and both read the same registry.
     It is kept because they are two separate definitions of "names an investor",
     and the cheap belt costs nothing on a path whose one failure mode is a name a
     borrower must never read. It is not what makes the rule hold; the refusal is. */
  const note = typedNote ? audience.scrubInvestorNames(typedNote, audience.AUDIENCES.BORROWER) : null;

  let doc;
  try {
    doc = await renderSheet(row, company);
  } catch (e) {
    console.error("[lt] term sheet render for delivery failed:", (e && e.message) || e);
    return { ok: false, error: "render_failed", message: "Could not draw that document, so nothing was sent." };
  }
  if (doc.bytes.length > MAX_ATTACH_MB * 1024 * 1024) {
    return {
      ok: false,
      error: "too_large",
      message: `That document is ${Math.round(doc.bytes.length / (1024 * 1024))} MB, which is more than an email will carry. `
        + "Download it and send it from your own mail.",
    };
  }

  const letter = buildLetter({ row, doc, toName: to.name, note });

  /* WHO IT COMES FROM (owner-directed): the officer's own name and address. The
     rule — and the reason a person on another domain is sent FOR rather than AS —
     is `lib/send-as.js`; this only supplies the person and the configuration. */
  const sender = sendAs.senderFor(from || {}, {
    notifyFrom: cfg.notifyFrom,
    domains: sendAs.sendingDomains({ notifyFrom: cfg.notifyFrom, configured: cfg.emailSendingDomains }),
    enabled: cfg.sendAsUser,
    provider: cfg.emailProvider,
    replyTo: (from && from.email) || cfg.replyToDefault || null,
  });

  const payload = {
    to: to.email,
    subject: letter.subject,
    html: letter.html,
    text: letter.text,
    attachments: [{ filename: doc.filename, content: doc.bytes.toString("base64") }],
    replyTo: sender.replyTo,
    from: sender.from || undefined,
    /* Rule 4 — a long-term send never writes the short-term Email Center. The
       durable record of this send is `lt_term_sheet_delivery`. */
    _skipCapture: true,
    _ctx: { type: "lt_term_sheet_delivery", audience: "borrower" },
  };

  let res;
  try {
    try {
      res = await email.sendMail(payload);
    } catch (first) {
      /* Under Graph a From that is not a real mailbox in the tenant does not
         degrade — the whole send FAILS. So a send-as-user attempt is retried ONCE
         as the company with their name on it, and never on an ambiguous failure:
         the provider may already have taken the first message, and retrying would
         send the borrower their pricing twice. */
      if (!sender.fallbackOnFailure || orderEmail.isAmbiguousSendFailure(first)) throw first;
      const asCompany = sendAs.senderFor(from || {}, {
        notifyFrom: cfg.notifyFrom,
        domains: [],
        enabled: cfg.sendAsUser,
        replyTo: (from && from.email) || cfg.replyToDefault || null,
      });
      console.warn(`[lt-termsheet] sending as ${sender.from} failed (${(first && first.message) || first}) - retrying from the company address.`);
      res = await email.sendMail({ ...payload, from: asCompany.from || undefined, replyTo: asCompany.replyTo });
      sender.mode = "company_fallback";
      sender.why = "The provider refused a send from that person's own address, so this went from the company address under their name.";
    }
  } catch (e) {
    if (orderEmail.isAmbiguousSendFailure(e)) {
      return {
        ok: false,
        error: "send_unconfirmed",
        ambiguous: true,
        message: "It may or may not have gone out — the email provider stopped responding while we were sending. "
          + "Check with the borrower before sending it again, so they do not receive it twice.",
      };
    }
    return {
      ok: false,
      error: "send_failed",
      message: "Could not send it — the email provider rejected the message. Nothing reached the borrower.",
    };
  }

  const verdict = orderEmail.sendVerdict(res);
  if (!verdict.ok) return { ok: false, error: verdict.reason, message: verdict.message };

  return {
    ok: true,
    to: to.email,
    toName: to.name,
    note,
    subject: letter.subject,
    filename: doc.filename,
    docKind: doc.docKind,
    sha256: doc.sha256,
    messageId: (res && res.id) || null,
    sentAs: { mode: sender.mode, from: sender.from, why: sender.why },
  };
}

module.exports = {
  MAX_ATTACH_MB,
  readAddress,
  officerCard,
  kindWordsOf,
  hoursBetween,
  renderSheet,
  buildLetter,
  sendSheet,
  _internals: { str, dayText, firstNameOf, ADDRESS_RE },
};
