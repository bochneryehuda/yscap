'use strict';
/**
 * WHO AN EMAIL COMES FROM — and whether we are allowed to say so.
 *
 * The owner: *"it should not come from the no-reply or from the PILOT email, it
 * should try to come from their own email"*, and *"make sure all the orders are
 * coming from the user that is actually ordering, from his email, from his name."*
 *
 * This is the ONE rule that decides. It is PURE — hand it a person and the
 * configuration, get back the `from` and `replyTo` to send with, plus WHY, so a
 * screen or a log can say what happened rather than leaving somebody to guess why an
 * order went out under the company's name.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE RESEARCH, because the answer is not a preference — it is arithmetic
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Putting somebody's address in the From line is not a display choice. Three
 * mechanisms decide whether the mail is delivered at all, and all three key on the
 * DOMAIN of that address:
 *
 *  · SPF answers "was this server allowed to send for this domain?" — and it checks
 *    the ENVELOPE sender (the Return-Path), not the From line a human reads.
 *  · DKIM answers "was this message signed by a key published in that domain's
 *    DNS?" Our provider signs with a key at `resend._domainkey.<our domain>`, which
 *    is what a VERIFIED DOMAIN means: the provider verifies the DOMAIN, not each
 *    address on it. That is the whole reason `notifications@` and `chaya@` are the
 *    same deliverability question and `chaya@gmail.com` is a different one.
 *  · DMARC answers "do those two agree with the From line?" — ALIGNMENT. A message
 *    whose From says gmail.com, signed by our key, sent from our servers, is aligned
 *    with nothing, and since Google's and Yahoo's 2024 sender rules that is not a
 *    grey area: it lands in spam or is rejected outright.
 *
 * SO THE RULE IS: we may send AS somebody when their address is on a domain we have
 * verified for sending, and we may not otherwise. There is no third option that both
 * shows their address and arrives.
 *
 * WHAT WE DO INSTEAD when we may not, and why it is not a fudge: the From stays on
 * our own verified domain with THEIR NAME on it and "via PILOT" after it, and the
 * Reply-To is their real address. Every reply reaches them, their name is what the
 * recipient reads, and nothing about the message is a lie — which matters, because
 * the alternative ("spoof it and hope") is precisely what the spam rules exist to
 * catch, and a vendor who never receives the order is worse than one who sees our
 * domain in small print.
 *
 * ── CAN WE USE THE EXISTING CONFIGURATION? ─────────────────────────────────
 *
 * YES, for everybody whose email is on the company domain, with nothing new to set
 * up. `NOTIFY_FROM` already sends from that domain and the provider already verifies
 * it, so `chaya@yscapgroup.com` is authenticated by exactly the same DKIM key as
 * `notifications@yscapgroup.com`. `EMAIL_SENDING_DOMAINS` exists to name a SECOND
 * verified domain later; unset, it derives the one we already send from, so this
 * works on the configuration that is live today.
 *
 * ── THE ONE PROVIDER-SPECIFIC HAZARD, STATED RATHER THAN DISCOVERED ────────
 *
 * Under Microsoft Graph the send is `POST /users/{from}/sendMail`, so the From must
 * be a REAL MAILBOX in the tenant and the app must hold permission on it. A From
 * that is merely on the right domain but is not a mailbox does not degrade — the
 * whole send FAILS. A failed order is worse than one from the company address, so
 * the caller is told (`fallbackOnFailure`) to retry once as the company if a
 * send-as-user attempt throws. Under Resend there is no such hazard: the domain is
 * what is verified.
 *
 * ── WHAT ELSE KEEPS THESE OUT OF SPAM ──────────────────────────────────────
 *
 * The rest is already true of every letter this system sends, and is written down
 * here so a future change does not undo it without noticing:
 *   · a REAL, MONITORED From and Reply-To — never a no-reply (already enforced in
 *     `config.resolveNotifyFrom`, and a no-reply From is itself a spam signal);
 *   · a text/plain part beside the HTML, which `email/template.js` always produces —
 *     an HTML-only message scores badly everywhere;
 *   · a real RFC `Message-ID` on our own domain, and `In-Reply-To`/`References` on a
 *     follow-up, so a chase threads instead of looking like a fresh cold email;
 *   · a plain subject that names the property and the loan number — no exclamation
 *     marks, no "URGENT", no all-caps;
 *   · few images, no tracking pixel on a vendor letter, no link shorteners, and
 *     links only to our own domain;
 *   · ONE sending domain, used consistently, rather than a new subdomain per feature
 *     — reputation is per domain and a cold one starts at zero.
 *
 * Deliberately NOT added: a `List-Unsubscribe` header. These are one-to-one
 * transactional messages to a company we are doing business with, and offering a
 * title company an unsubscribe link on a title order is both wrong and a signal that
 * this is bulk mail.
 *
 * PURE. No config, no network, no database — every input is a parameter.
 */

/** The domain part of an address or a `Name <addr>` form, lower-cased, or null. */
function domainOf(addr) {
  const s = String(addr == null ? '' : addr).trim();
  if (!s) return null;
  const m = /<([^>]+)>\s*$/.exec(s);
  const bare = (m ? m[1] : s).trim().toLowerCase();
  const at = bare.lastIndexOf('@');
  if (at <= 0 || at === bare.length - 1) return null;
  const d = bare.slice(at + 1).replace(/[>\s]+$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

/** The bare address out of a `Name <addr>` form, lower-cased, or null. */
function addressOf(addr) {
  const s = String(addr == null ? '' : addr).trim();
  if (!s) return null;
  const m = /<([^>]+)>\s*$/.exec(s);
  const bare = (m ? m[1] : s).trim().toLowerCase();
  // One @, something either side, no whitespace, no comma — a value that fails this
  // must never reach a header, where it would break the whole message rather than
  // one field.
  return /^[^\s@,<>"]+@[^\s@,<>"]+\.[a-z]{2,}$/i.test(bare) ? bare : null;
}

/** A display name safe to put in a header: no quotes, no angle brackets, no
    line breaks (a CRLF in a display name is header injection). */
function cleanName(name) {
  return String(name == null ? '' : name)
    .replace(/[\r\n]+/g, ' ')
    .replace(/["<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Which domains we are allowed to put in a From line.
 *
 * `EMAIL_SENDING_DOMAINS` (comma-separated) when set; otherwise the domain of the
 * address we already send from, which is the one the provider has verified. Deriving
 * it is what makes send-as-user work on the configuration that is live today rather
 * than waiting for somebody to set a variable.
 */
function sendingDomains({ notifyFrom, configured } = {}) {
  const out = [];
  const push = (d) => {
    const v = String(d || '').trim().toLowerCase().replace(/^@+/, '');
    if (v && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v) && !out.includes(v)) out.push(v);
  };
  if (configured) String(configured).split(/[,\s]+/).forEach(push);
  if (!out.length) push(domainOf(notifyFrom));
  return out;
}

/**
 * WHO THIS EMAIL COMES FROM.
 *
 * @param {{name?:string, email?:string}} person  the staffer placing the order
 * @param {object} opts
 * @param {string} opts.notifyFrom   the company From (`Name <addr>` or a bare address)
 * @param {string[]} opts.domains    the domains we may send as (see sendingDomains)
 * @param {boolean} [opts.enabled]   false → always the company From (the switch)
 * @param {string} [opts.replyTo]    a more specific Reply-To (an order's own address)
 * @param {string} [opts.provider]   'resend' | 'graph' | 'none'
 * @param {string} [opts.viaLabel]   what to call ourselves in the on-behalf name
 *
 * @returns {{from:string, replyTo:string|null, mode:'as_user'|'on_behalf'|'company',
 *            why:string, fallbackOnFailure:boolean}}
 *
 * NEVER THROWS, and every unreadable input falls to `company` — the mode that is
 * always deliverable. Guessing in the other direction costs the message.
 */
function senderFor(person, opts = {}) {
  const notifyFrom = String(opts.notifyFrom || '').trim();
  const companyAddr = addressOf(notifyFrom);
  const companyName = (() => {
    const m = /^\s*"?([^"<]*?)"?\s*</.exec(notifyFrom);
    return cleanName(m ? m[1] : '') || 'PILOT by YS Capital';
  })();
  const company = {
    from: notifyFrom || null,
    replyTo: opts.replyTo || null,
    mode: 'company',
    why: 'Sent from the company address.',
    fallbackOnFailure: false,
  };

  const name = cleanName(person && person.name);
  const addr = addressOf(person && person.email);

  if (opts.enabled === false) {
    return { ...company, why: 'Sending as the person who ordered is switched off, so this went from the company address.' };
  }
  if (!addr) {
    return {
      ...company,
      // The NAME still rides even with no usable address — a vendor reading "Chaya
      // Gruber — YS Capital" knows who to answer, which is most of the point.
      from: name && companyAddr ? `"${name} — ${companyName}" <${companyAddr}>` : company.from,
      why: name ? 'That person has no email address on their staff record, so this went from the company address under their name.'
        : 'Nobody was named as the sender, so this went from the company address.',
    };
  }

  const domains = Array.isArray(opts.domains) ? opts.domains : [];
  const d = domainOf(addr);
  const mayBeThem = !!d && domains.includes(d);

  if (mayBeThem) {
    return {
      from: name ? `"${name}" <${addr}>` : addr,
      replyTo: opts.replyTo || null,
      mode: 'as_user',
      why: `Sent as ${addr}, which is on a domain we are verified to send from.`,
      // Under Graph the From must be a real mailbox in the tenant, and a From that is
      // merely on the right domain but is not one makes the whole send FAIL rather
      // than degrade. A failed order is worse than one from the company address.
      fallbackOnFailure: String(opts.provider || '') === 'graph',
    };
  }

  // NOT OUR DOMAIN — their name, our domain, their address on the Reply-To. Every
  // reply reaches them and nothing about the message is untrue; putting their
  // address in the From here would fail DMARC alignment and land in spam.
  const via = cleanName(opts.viaLabel) || 'via PILOT';
  /* THE ORDER'S OWN REPLY ADDRESS ALWAYS WINS when the caller states one, and that is
     not a compromise: that address is what files a vendor's returned documents onto
     the right condition, so redirecting replies to a person's inbox would take the
     documents off the file. The person is reachable anyway — the recipient rule puts
     the loan officer on the Cc of every order, so a reply-all reaches them. Only when
     no order address exists does their own address become the Reply-To. */
  return {
    from: companyAddr ? `"${name ? `${name} ` : ''}${via}" <${companyAddr}>` : company.from,
    replyTo: opts.replyTo || addr,
    mode: 'on_behalf',
    why: `${addr} is not on a domain we are verified to send from, so this went from the company address under their name`
      + (opts.replyTo ? ' (they are on the Cc, so a reply reaches them).' : ', with replies going to them.')
      + ' Putting their own address in the From line would fail the receiving server’s sender checks and land in spam.',
    fallbackOnFailure: false,
  };
}

module.exports = { senderFor, sendingDomains, domainOf, addressOf, cleanName };
