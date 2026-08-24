# Encompass → PILOT instant updates: the setup, step by step (#42)

**What this does, in one sentence.** Today PILOT re-checks Encompass on a timer; with this hooked
up, Encompass TELLS PILOT the moment a file changes (a milestone finishes, a brand-new file is
started), and PILOT re-reads that one file right away — so the ClickUp card moves within a few
minutes of the milestone, not whenever the file's turn comes around.

**How it stays safe.** The message from Encompass is treated as a doorbell, never as data. PILOT
reads NOTHING out of it except which loan it is about, and then goes and re-reads that loan itself
over the normal read-only connection. Even if somebody sent a fake message, the worst it could do
is make PILOT re-read a file it was going to read anyway — nothing in the message can ever change
a loan. And every message must carry the secret password header, or it is turned away.

---

## The answer to your question about the existing rule

You already have a working advanced-code rule in Encompass that fires when **MS.STATUS** changes
and posts to the drivekosher address with a secret header. **Yes — that exact mechanism is the
right one, and the right move is to ADD A SECOND rule just like it, pointed at PILOT. Do not edit
the working drivekosher rule** — it is serving something today, and a copy costs nothing. Because
MS.STATUS changes at EVERY milestone transition, that one rule covers every milestone — there is
no need for a rule per milestone.

**Use a NEW secret for the PILOT rule, not the old one.** The old secret has been shared around
(it appeared in chat, which counts as leaked); the PILOT rule gets its own fresh value that lives
only in Encompass and in PILOT's settings on Render.

---

## Step 1 — pick the secret password (2 minutes)

1. Make up a long random value (a password manager's generator is perfect — 30+ characters).
2. In Render, open the PILOT service → Environment → add:
   `LT_ENCOMPASS_WEBHOOK_SECRET = <that value>`
3. Until that variable is set, the PILOT endpoint refuses every message — so nothing can arrive
   before you are ready.

## Step 2 — the address Encompass will post to

```
https://yscap.onrender.com/api/lt/encompass-hook
```

with one extra header on the request:

```
X-Encompass-Secret: <the value from step 1>
```

## Step 3 — the milestone rule (copy the one you have)

In Encompass admin, where the existing MS.STATUS advanced-code rule lives:

1. Open the existing rule that posts to drivekosher. **Duplicate it** (make a copy) rather than
   editing it.
2. In the copy, change ONLY two things: the URL (step 2's address) and the secret header's value
   (step 1's value).
3. Make sure the body it sends includes the loan's GUID or the YSCAP loan number — the existing
   rule already does (PILOT finds either one anywhere in the message, so the exact wording of the
   body does not matter).
4. Save and activate the copy. The drivekosher rule keeps running untouched.

If the copy's code needs re-typing rather than duplicating, the shape (VB.NET, the same as the
existing rule) is:

```vb
Dim req As System.Net.HttpWebRequest = System.Net.WebRequest.Create("https://yscap.onrender.com/api/lt/encompass-hook")
req.Method = "POST"
req.ContentType = "application/json"
req.Headers.Add("X-Encompass-Secret", "PASTE-THE-STEP-1-VALUE-HERE")
Dim body As String = "{""loanGuid"":""" & Loan.Fields("GUID").Value & """,""loanNumber"":""" & Loan.Fields("364").Value & """,""msStatus"":""" & Loan.Fields("MS.STATUS").Value & """}"
Dim data As Byte() = System.Text.Encoding.UTF8.GetBytes(body)
req.ContentLength = data.Length
Using s As System.IO.Stream = req.GetRequestStream()
    s.Write(data, 0, data.Length)
End Using
req.GetResponse().Close()
```

## Step 4 — the NEW-FILE rule (one more copy)

Make one more copy of the same rule, but set its TRIGGER to the **Loan Number field (364)**
instead of MS.STATUS. A brand-new file gets its YSCAP number the moment it is created, so this
copy fires exactly once per new file. PILOT answers "not mirrored yet — the next discovery pass
will pick it up", and the file appears in PILOT (and gets its ClickUp card, once the card writer
is switched on) on the next sync pass.

## Step 5 — test it (1 minute, no Encompass needed)

From any computer, this pretends to be Encompass:

```
curl -X POST https://yscap.onrender.com/api/lt/encompass-hook \
  -H "Content-Type: application/json" \
  -H "X-Encompass-Secret: <the step-1 value>" \
  -d '{"loanNumber":"YSCAP258134741"}'
```

A good answer looks like `{"ok":true,"nudged":true,"loans":1}`. With the wrong secret you get
`403`; with no loan named you get `"no loan GUID or YSCAP loan number found"`.

## What happens after a nudge

PILOT clears that loan's "last read" stamp; the sync's next pass (they run every few minutes)
re-reads the loan from Encompass — the milestone ladder, every mapped field, the people on it —
and then the ClickUp writer (once switched on) updates the linked card, including moving its
status per the milestone rules. Nothing waits on the timer rotation any more.
