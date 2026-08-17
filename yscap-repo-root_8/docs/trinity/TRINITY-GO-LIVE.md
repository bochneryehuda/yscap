# Turning on Trinity physical inspections — the go-live steps

Trinity is the company that sends a person out to look at the property before a draw is
released, on every file whose note buyer is **not** Blue Lake. (Blue Lake physical files go
to TrustPoint, and virtual inspections stay with Sitewire. Nothing here touches either of
those.)

Everything is built and tested. What is left is **four values** and **two switches** —
nothing in this list needs a developer, and nothing needs a deploy except the first step.

---

## 1. Put the production credentials in Render

**Where:** the Render dashboard → the **ys-capital-portal** service → **Environment**.

| Setting | What to put in it |
|---|---|
| `TRINITY_USERNAME` | the username Trinity gives you for the LIVE account |
| `TRINITY_PASSWORD` | the password for that account |
| **`TRINITY_FORM_ID`** | **`1079`** — see below. This one is not optional. |
| `TRINITY_BASE_URL` | leave it blank unless Trinity gives you a different web address for the live account |
| `TRINITY_WEBHOOK_TOKEN` | leave it alone — Render fills this in itself with a random secret |
| `TRINITY_COMPANY_ID` | **leave it blank.** The system asks Trinity who we are and gets the right answer on its own (checked live: 45798). If you type the practice number here, every order goes to the wrong place. |

### Why `TRINITY_FORM_ID` has to be 1079

**This is the one setting that would have stopped go-live, and we only found it by signing
in to the live account.** Trinity's practice system and your live system do not offer the
same inspection products — their own documentation warns of it: *"Not all form types are
available to all customers in production."*

- Practice account: **form 19**, "Blank General Purpose Line Item Draw"
- **Your live account: form 1079**, "General Purpose Line Item Draw PCR"

They are the same product with a different number. Checked against Trinity's published
specification field by field: identical order form, identical line items (cost, amount
requested, percent complete before and after, remarks), identical budget read-back. So
nothing had to be rebuilt — this is one setting.

Left at 19, **every single order would be refused**, on live files, after a coordinator had
already pressed the button.

The API Health page now checks this for you and says in plain words whether the form is
enabled on the account, before anything is ordered.

Two things to know:

- **Never paste a password into a chat, a document or a message.** If one has already been
  pasted anywhere, ask Trinity to change it before it is used here. That is a standing rule
  for every password in this system, not a Trinity one.
- **Until the username and password are filled in, nothing happens.** No order is placed,
  nothing is sent, and no file behaves any differently. The whole thing is switched off by
  the absence of a password, not by a setting somebody could forget.

Save, and let the service restart.

## 2. Check the connection

**Where:** PILOT → **API Health**.

Trinity will show as **connected**. If it does not, the username or password is wrong —
nothing else can cause it at this stage.

## 3. Turn it on, in test mode first

**Where:** the same API Health page. Three switches:

| Switch | What it does |
|---|---|
| **Trinity physical inspections** | reading and following orders. Turn this **ON**. |
| **Trinity orders — TEST MODE** | builds the whole order and sends nothing. Turn this **ON** for the first file. |
| **Place Trinity inspection orders** | actually sends orders. Leave this **OFF** for now. |

With test mode on, do one draw on a real physical file. PILOT will build the whole order —
the construction budget, how much has already been drawn on every line, the appraisal, the
scope of work and the previous inspection report — and send none of it. The draw desk shows
exactly what it would have sent.

## 4. Go live

On the same page, turn **TEST MODE off** and **"Place Trinity inspection orders" on**.

From that moment:

- **A draw the borrower submits orders the inspection on its own** — whether they submitted
  it in Sitewire or through the portal. Nobody has to remember.
- **You can also order one yourself.** On the file's draw desk, under *Trinity physical
  inspection*, pick the draw and press **Order the inspection**. It sends exactly the same
  package as an automatic order. Use it when a draw came in before Trinity was switched on,
  or if an order did not go through for any reason.

## 5. Let Trinity tell us the moment something changes (optional)

**Where:** PILOT → API Health → Trinity → **Register webhook**.

PILOT checks Trinity for updates on its own every few minutes, so this is not required —
it only makes updates arrive within seconds instead of within minutes. It needs
`TRINITY_WEBHOOK_TOKEN` from step 1, which Render has already filled in.

---

## What still needs a person, on purpose

**Nothing reaches the borrower on its own.** When the report comes back, the inspector's
figures fill themselves in and the draw desk gets a message saying *"the report is in —
review and deliver"*. Somebody then checks the numbers and presses **Deliver**. Only then
does the borrower hear anything, and what they get is the same accept-or-dispute page they
already know — the only thing that changed is who did the inspecting.

This is deliberate and is not a gap. Virtual inspections release on their own; physical ones
do not.

## What has now been checked against the live account

Signed in to the real Trinity production account on 2026-08-16 and read it (read-only —
nothing was ordered, changed or cancelled):

- **Sign-in works**, and the pass it hands back lasts 2 hours, exactly as expected.
- **The account is real**: company 45798, "YS Capital Group" — and the system worked that
  out by itself without being told.
- **There are already six completed inspections on it**, on form 1079. Somebody has been
  ordering these by hand.
- **The "report comes back" half is now proven on a real finished inspection** — this was
  the biggest unknown. Reading a genuinely completed order returned its status, its
  **6 budget lines**, **36 photographs**, its documents, the report and the invoice. Every
  one of those paths had only ever been tested against sample data before today.
- **The money adds up, on a real finished report.** Re-checked on 2026-08-17: PILOT read
  that completed inspection's six budget lines, worked out what each one had earned, and
  the total came to **$30,000.00 — the same figure to the cent that Trinity itself
  reports** for the job. This is the part that decides what a borrower is paid, and until
  now it had only ever been checked against practice data. If those two figures ever
  disagree by more than a rounding cent, PILOT refuses the report and asks for a person
  rather than releasing a number it cannot stand behind.
- **All 19 of Trinity's statuses** were read and compared to how we interpret them. All six
  flavours of "Report Completed" are recognised, so a **revised** report is never missed.
- **All five document folders** we file into exist on the live account.
- **The safety net that stops a duplicate order** (looking an order up by our own reference
  after a lost reply) works against the live system.

## The one thing still to watch

**The first delivery.** When you press Deliver on a draw the borrower submitted in Sitewire,
PILOT writes the inspector's figures onto that draw first. That write has never been tested
against a live Sitewire draw — there is no practice Sitewire to try it on. If Sitewire
refuses it, PILOT stops, sends the borrower nothing, and puts a message on the desk saying
so — it cannot go wrong quietly. Check the first one.

## If something looks wrong

- **An order refuses with a reason** ("Trinity needs a few things first: the contractor's
  email address is missing") — that is the system telling you what to fix on the file. Fix
  it and press the button again.
- **An inspection is not ordering by itself** — open the file's draw desk. If the file is not
  on physical inspections the card says so in plain words; if it is, order it by hand and the
  refusal (if any) will name the cause.
- **Nothing at all is happening** — check API Health. The two most common causes are the
  master switch being off and the password having been changed at Trinity's end.
