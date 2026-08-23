/* The 'none' provider: it contacts nothing and sends nothing.

   `outbound: false` is what keeps it OUT of the shared send-rate queue
   (src/lib/email/rate-limit.js, wired at the one chokepoint in ./index.js).
   That limit exists to respect RESEND'S quota — a remote service's ceiling —
   and this provider issues no request to any remote service, so there is
   nothing here for a rate limit to protect. Metering it would only throttle
   us: index.js's own contract is that the portal "still records in-app
   notifications, so nothing breaks before you wire a provider", and pacing a
   fan-out at 10/second while sending nowhere breaks exactly that. Measured:
   with it metered, the public lead door's admin fan-out paced at 100ms a
   recipient and blew an 8-second request timeout with no provider configured
   at all (CI run 32627383211, scripts/test-column-bounds-doors-db.js).

   A provider that does NOT declare the flag is metered — the safe direction,
   so the one that forgets it errs toward the limit rather than past it. */
module.exports = {
  name: 'none',
  outbound: false,
  async sendMail({ to, subject }) {
    console.log(`[email:none] would send "${subject}" -> ${to}`);
    return { ok: false, skipped: true };
  },
};
