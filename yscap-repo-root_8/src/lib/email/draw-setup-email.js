'use strict';
/**
 * Borrower-facing DESIGNED draw emails (owner-directed 2026-07-21). Pure content builders — no I/O,
 * no DB — so they unit-test standalone. Both are borrower-safe by construction (no note-buyer /
 * capital-partner name); the caller still runs the standard borrower scrub as defense-in-depth.
 *
 *   drawSetupNotifyOpts  — "your construction draw is set up, you can start requesting draws".
 *       Returns NOTIFY OPTS (type 'draw_setup') for notify.notifyAppBorrowers, so the borrower set,
 *       the officer BCC, the per-file reply-to (file+<id>@), the scrub and the Email-Center (draw
 *       section) recording all come for free; `bccExtra` loops the draw-coordinator desk (draws@).
 *       Branches on inspection METHOD (virtual = Sitewire app self-capture + virtual GC review;
 *       physical = request an amount, we send an on-site inspector). Names the property + budget,
 *       points to the Sitewire invite, previews the DocuSign wire-form step (wire releases only
 *       after it is signed) and the findings→review→release flow.
 *
 *   wireFormEmail  — a render() payload (for a catalog builder + mail.deliver) announcing the
 *       DocuSign wire-instructions form is ready, with a DIRECT link into DocuSign to sign it.
 */

function usd(cents) {
  var n = Math.round(Number(cents || 0)) / 100;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function firstName(name) {
  var s = String(name || '').trim();
  return s ? s.split(/\s+/)[0] : 'there';
}
// virtual (Sitewire 'mobile') vs physical (Sitewire 'traditional'/on-site). Anything else → virtual
// default (the common case); never throws.
function isPhysical(method) {
  var m = String(method || '').toLowerCase();
  return m === 'traditional' || m === 'physical' || m === 'onsite' || m === 'on-site' || m === 'in_person';
}

// The method-branched "how to request a draw" + "what happens next" instruction blocks.
function setupSections(physical, addr) {
  if (physical) {
    return [
      { title: 'How to request a draw', body: [
        'When you have completed work to fund, sign in to Sitewire — our inspection partner — and start a draw request for the amount you need.',
        'We will then send a licensed inspector to ' + addr + ' to verify the completed work in person.',
      ] },
      { title: 'After your inspection', body:
        'The inspector documents the work and shares the findings with us. You will review the results right here in PILOT and either confirm them or push back on any line item (with proof). Once it is settled, we release your wire.' },
    ];
  }
  return [
    { title: 'How to request a draw', body: [
      'You will request funds and submit progress photos and videos through Sitewire, our inspection technology partner.',
      'Look for the "Set up Sitewire" invitation email and open it on the phone you will use on site. If you do not see it, check your Promotions or Spam folder, or download the Sitewire app and sign in with the email you gave us.',
    ] },
    { title: 'Photos & videos', body:
      'Capture every photo and video live in the Sitewire app while on site — please do not upload from your camera roll. If you use an ad blocker or content filter, turn it off while using the app.' },
    { title: 'Bringing in help on site', body:
      'If you cannot visit the site yourself, you can add your general contractor or project manager in Sitewire — as a Delegate (submits photos and videos for your approval) or a Full User (can build and submit draw requests).' },
    { title: 'After you submit', body:
      'A licensed inspector reviews your submission and shares the findings with us. You will review the results right here in PILOT and either confirm them or push back on any line item (with proof). Once it is settled, we release your wire.' },
  ];
}

/**
 * @param {object} o { address, budgetCents, method } (borrower set + officer + reply-to come from notify)
 * @returns notify opts for notify.notifyAppBorrowers
 */
function drawSetupNotifyOpts(o) {
  o = o || {};
  var physical = isPhysical(o.method);
  var addr = o.address || 'your property';
  return {
    type: 'draw_setup',
    major: true, // a real milestone the borrower is waiting on — always email them
    kicker: 'Construction draws are open',
    title: 'Your construction draw account is ready',
    body: 'Congratulations on closing your loan. Your construction-draw account is now set up, so you can begin requesting funds as your project moves forward. Here is everything you need to get started.',
    hero: { label: 'Approved construction budget', value: usd(o.budgetCents), sub: addr, tone: 'positive' },
    sections: setupSections(physical, addr),
    callout: {
      tone: 'action',
      title: 'One step before your first wire',
      body: 'You will receive a separate DocuSign form to confirm your wire instructions — the bank details where your funds should be sent. Please complete it carefully; these details are used to send real money. Your wire can only be released once that form is signed.',
    },
    meta: [
      { label: 'Property', value: addr },
      { label: 'Construction budget', value: usd(o.budgetCents) },
      { label: 'How you request draws', value: physical ? 'Request an amount — we send an on-site inspector' : 'Sitewire app — self-guided photos & video' },
    ],
    ctaLabel: 'Open your PILOT portal',
    note: 'Questions about a draw or an inspection? Just reply to this email — your loan team and draw coordinator receive it. When contacting Sitewire support, always include your property address.',
    // Loop the draw-coordinator desk in (monitoring copy) alongside the auto officer BCC.
    bccExtra: ['draws@yscapgroup.com'],
  };
}

/**
 * @param {object} o { borrowerName, address, budgetCents, signUrl, portalUrl, officer }
 * @returns render() payload (delivered via a catalog builder + mail.deliver)
 */
function wireFormEmail(o) {
  o = o || {};
  var addr = o.address || 'your property';
  return {
    audience: 'borrower',
    kicker: 'Action needed · wire instructions',
    title: 'Confirm where to send your construction funds',
    greeting: 'Hi ' + firstName(o.borrowerName) + ',',
    intro: 'Before we can release your construction draw, we need your wire instructions on file — the bank account where your funds should be sent. We have prepared a secure form for you to review and sign.',
    callout: {
      tone: 'action',
      title: 'Please double-check every detail',
      body: 'Confirm your bank name and your routing and account numbers exactly. Wires are sent precisely as entered and cannot be reversed. Your funds can only be released after this form is signed.',
    },
    meta: [
      { label: 'Property', value: addr },
      { label: 'Construction budget', value: usd(o.budgetCents) },
    ],
    officer: o.officer || null,
    cta: o.signUrl ? { label: 'Review & sign the wire form', url: o.signUrl } : null,
    cta2: o.portalUrl ? { label: 'Open portal', url: o.portalUrl } : null,
    replyable: true,
    note: 'This secure link opens your form directly. If you were not expecting this or anything looks off, reply to this email or call your loan team before signing — never share these details anywhere else.',
  };
}

module.exports = { drawSetupNotifyOpts, wireFormEmail, _usd: usd, _isPhysical: isPhysical, _setupSections: setupSections };
