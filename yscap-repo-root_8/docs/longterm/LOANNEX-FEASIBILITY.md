# LoanNEX as a second pricing program — is it workable?

**Short answer: yes, and it is easier than Lender Price was.** Everything below was
decoded from the three recordings supplied on 2026-08-30 and is proven by two offline
tests that run in CI. Nothing is live; the whole thing is behind a switch that is off.

---

## 1. Is there API information going back and forth?

Yes — and it is unusually clean. LoanNEX is not a screen-scrape problem. Its own web
app is a single-page app talking to a **plain JSON REST API** at `nexapi.loannex.com`,
and the recordings capture every call it makes.

There is no *published* public API and no developer documentation, so this is the same
category as Lender Price: a private API we drive the way the browser drives it. The
difference is how legible it is.

| | Lender Price | LoanNEX |
|---|---|---|
| One pricing call returns | 27 programs | **1,718 price rows, 9 investors, 14 programs** |
| Time for that call | ~5–30 seconds | **~350–460 ms** |
| What we must send | The FULL cloned search model, or it answers 500 | A flat scenario object, 36 fields |
| The field vocabulary | Hand-decoded from captures (27 KB, rots on any rename) | **The vendor hands it to us** — one call returns all 95 fields with their exact allowed values |
| "Why did this investor say no?" | Two-phase asynchronous poll, takes minutes | **One call**, comes back with the price |
| Fee breakdown | Parsed out of the price build | Base price + every adjustment + floor/ceiling, structured |

That third row is the one that matters most for keeping this working long-term. On
Lender Price we maintain a hand-written list of what every field is called; the day
they rename one, our prices go quietly wrong. LoanNEX **tells us** its own field list,
so we read it live and a rename surfaces as a clear refusal instead of a bad price.

## 2. Can we do the web-based approach, like a human browsing — the way we did with Lender Price?

Yes, and the sign-in is simpler than Lender Price's. It is three steps:

1. **Sign in to the portal** — the ordinary username-and-password form.
2. The portal hands out a **one-time ticket**.
3. We swap that ticket for a **pass that is good for an hour**, and everything else uses it.

**Steps 2 and 3 are fully decoded and built.** Step 1 — the actual sign-in form — is
the one thing the recordings do **not** contain: all three of them start *after* the
browser was already signed in. So I have not guessed it. The code refuses and says
exactly what it is missing, because a guessed login fails in a way that looks
identical to a wrong password, and that is the kind of wrong that wastes days.

**This does not block anything today.** Paste one live ticket into the settings and the
entire pipeline — pricing, the reasons, the fee breakdowns, the merged board — runs for
real, right now. To make it run unattended I need **one more recording that includes the
sign-in itself** (open a private window, record, type the password, submit). That is
about a two-minute job on your side and a short, verified addition on mine.

## 3. Merging the two programs

Built. One search, both programs asked at the same time, one board back.

**For an investor only one program quotes**, you get it from that one, and it says so.

**For an investor both programs quote**, the board tells you which program to take them
from and *why*, with the measurement beside it — for example:

> **Amber (Acra Lending)** — take from **LoanNEX**. LoanNEX prices better on 510 of 510
> matched quotes (same product, same lock, same rate), by 0.250 in price on average.

Three rules keep that honest, and each exists because breaking it produces a confident
wrong answer:

- **Same product, same lock period, same rate — or no comparison at all.** A 30-year
  fixed is not a 5/6 ARM and a 30-day lock is not a 60-day one. Where two programs
  share no common ground, the board says *"no comparable basis"* and shows both rather
  than inventing a winner.
- **An investor we cannot identify is never merged.** Guessing that an unfamiliar name
  is somebody we already know would silently blend two different companies' pricing.
  It is reported by name instead.
- **A tie is a tie.** Identical execution elects nobody.

The recommendation sits *beside* the data — both programs' pricing stays on the board
for every investor, so anyone can disagree with the election and see exactly why.

### Investor overlap

Of the 9 investors LoanNEX quoted on the recorded scenario, **8 map onto investors we
already know**:

| LoanNEX | Ours | Consumer name |
|---|---|---|
| eResi | eResi Mortgage | Platinum |
| Acra Lending - Corr | Acra Lending | Amber |
| NQM Funding | NQM Funding | Ruby |
| AD Mortgage LLC - Correspondent | A&D Mortgage | Emerald |
| Onity (f/k/a PHH) | PHH Mortgage | Opal |
| Champions Funding - Corr | Champions Funding | Crown |
| PennyMac - Correspondent | PennyMac | Gold |
| American Heritage Lending: Corr | American Heritage | Liberty |
| **Button Finance, Inc.** | **— not on our sheet —** | **needs a name from you** |

*(A&D needed one small fix: LoanNEX writes it "AD Mortgage", without the ampersand, so
it matched nothing. That alias is added.)*

## 4. What I need from you

1. **A recording that includes the sign-in itself** — private window, start recording,
   type the password, submit. That closes the last gap and lets it run on its own.
2. **A name for Button Finance** — it prices on LoanNEX, it is not on the investor name
   sheet, so right now it has no consumer-safe name and is flagged rather than shown.
3. **Whether the investor-specific logins price differently.** The Acra and NQM
   recordings only cover signing in, not pricing — so I cannot yet tell whether their
   own portals quote better than the combined one. One scenario priced on each answers
   it, and if they do quote better, the merge already handles it (each portal is just
   another source).

## 5. It is live for ONE person, and it is a SECOND engine

Owner-directed 2026-08-30: *"Merge this live into domain only for super admin to be able to
see it and super admin to be able to test it… so I can audit everything before I want to go
live to the general pricing engine."* And: *"Don't touch our current setup that we currently
have: our General Pricing Engine."*

So it ships as **the Combined Pricing Engine** — its own screen, its own settings screen, its
own API mount — and every path answers **404 to anybody who is not a super admin**. 404 rather
than 403, so an engine under private audit does not advertise itself to the team. The General
Pricing Engine at `/api/lt/dscr/*` is byte-for-byte what it was; this only *adds* a second
engine beside it. `LT_COMBINED_PRICING=off` is the kill switch.

It is also **read-only by construction**. LoanNEX's API can lock and register loans;
this client refuses every one of those paths before a request is even built, and the
test proves it.

## 6. What is built

| | |
|---|---|
| `src/longterm/loannex/` | The client, the scenario builder, the response parser, the live field registry, county lookup |
| `src/longterm/loannex/capture/` | The recorded traffic every claim rests on |
| `src/longterm/pricing/merge.js` | Two boards in, one board out, with the per-investor election |
| `src/longterm/pricing/product-class.js` | What may be compared to what |
| `src/longterm/routes/combined-pricer.js` | `/api/lt/dscr/combined/*`, super-admin only |
| `scripts/test-lt-loannex-*-pure.js` | 57 checks, offline, in CI |

**How it is proven.** The pricing request we build is compared **byte for byte** against
the request LoanNEX's own app put on the wire and got 1,718 prices back for — so the
shape, the field order, and even the vendor's own spelling mistake in a field name are
all proven at once, against something no assertion of mine can talk its way past. The
election is proven by taking the real recorded board, shifting one side by an exact
known amount, and requiring the merge to report back exactly that amount in the right
direction across 510 matched quotes. Nine deliberate breakages of the production code
were each confirmed to make the tests go red.
