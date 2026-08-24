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

### What that advanced-code editor will and will not accept

Two things are settled, from this tenant's own compiler, and both change what the code can say:

- **An outbound HTTPS POST works.** The live drivekosher rule already does exactly that with
  `System.Net.HttpWebRequest`, so the sandbox is not network-locked.
- **`Loan` and `EncompassApplication` are NOT in scope.** Both were refused by name. Any sample
  that reads a field as `Loan.Fields("364").Value` — **including an earlier version of this very
  document, which was wrong** — does not compile here.

That leaves the editor's own square-bracket field reference (`[364]` is the loan number), which
Encompass substitutes before the code runs. **Whether that substitution reaches inside a quoted
string has not been confirmed on this tenant**, so the rule below is written so that it does not
have to be: if the bracket is substituted, the ping names the loan and PILOT re-reads that one
file; if it is not, PILOT receives a ping with no name on it and asks Encompass which loans just
changed instead. Both paths end in the same place — **the rule does not need the loan number to
work.** That is not a hope; it is what the receiver does, and it is covered by tests.

### The rule

1. Open the existing rule that posts to drivekosher. **Duplicate it** (make a copy) rather than
   editing it — it is serving something today.
2. In the copy, change the URL (step 2's address) and the secret header value (step 1's value).
3. Paste the code below over the copy's body. Save, and activate the copy. The drivekosher rule
   keeps running untouched.

```vb
Try
    ' Render will not negotiate below TLS 1.2 - measured, it refuses 1.0 and 1.1
    ' outright - and the .NET Framework default may still offer only those. 3072
    ' IS TLS 1.2: the numeric form compiles on every .NET version, where the named
    ' SecurityProtocolType.Tls12 does not. It is OR'd in rather than assigned over,
    ' so nothing another rule already relies on gets switched off.
    System.Net.ServicePointManager.SecurityProtocol = _
        System.Net.ServicePointManager.SecurityProtocol Or CType(3072, System.Net.SecurityProtocolType)

    Dim req As System.Net.HttpWebRequest = DirectCast( _
        System.Net.WebRequest.Create("https://yscap.onrender.com/api/lt/encompass-hook"), _
        System.Net.HttpWebRequest)
    req.Method = "POST"
    req.ContentType = "application/json"
    req.Timeout = 10000
    req.Headers.Add("X-Encompass-Secret", "PASTE-THE-STEP-1-VALUE-HERE")

    Dim body As String = "{""loanNumber"":""[364]""}"

    Dim data As Byte() = System.Text.Encoding.UTF8.GetBytes(body)
    req.ContentLength = data.Length
    Using s As System.IO.Stream = req.GetRequestStream()
        s.Write(data, 0, data.Length)
    End Using
    req.GetResponse().Close()
Catch ex As Exception
    ' Never let the doorbell block a loan officer. If PILOT is down, the secret is
    ' wrong, or the network is blocked, the rule gives up quietly and the loan saves
    ' exactly as it would have. PILOT still re-reads the file on its own rota.
End Try
```

**The Try/Catch is not optional.** Without it, a 403 (wrong secret) or an unreachable PILOT raises
an exception INSIDE Encompass, on a rule that fires at every milestone change — and it lands on
whoever happens to be saving the loan at the time.

**If the editor refuses `[364]` inside the string**, change that ONE line and nothing else:

```vb
Dim body As String = "{""ping"":""encompass""}"
```

The rule still does its whole job. PILOT answers a nameless ping by asking Encompass which loans
were modified most recently and re-reading the ones that actually moved.

### Which of the two happened

You do not have to know — both work. If you want to see it anyway, the PILOT service's log on
Render prints one line per ping:

- `[lt-encompass-hook] nudged 1 loan(s) (YSCAP…)` — the bracket WAS substituted; the ping named the loan.
- `[lt-encompass-hook] unnamed ping — asked Encompass what moved: checked …, nudged …` — it was
  not, and the fallback did the work.
- **No line at all** — the ping never reached PILOT. That is the one thing the Try/Catch hides, so
  it is the one thing worth checking after you activate the rule: change a milestone on any file
  and look for a line. Nothing means the secret is wrong, the URL is wrong, or the network out of
  Encompass is blocked — in that order of likelihood. Step 5's `curl` tells you which, because it
  answers `403` for a wrong secret and `503` if the secret was never set on Render at all.

Either address works — `https://yscap.onrender.com/...` and `https://yscapgroup.com/...` are the
same service. Use the onrender one in the rule; it does not depend on the domain's DNS.

## Step 4 — the NEW-FILE rule (one more copy)

Make one more copy of the same rule — same code, same URL, same secret — but set its TRIGGER to
the **Loan Number field (364)** instead of MS.STATUS. A brand-new file gets its YSCAP number the
moment it is created, so this copy fires exactly once per new file. The file appears in PILOT (and
gets its ClickUp card, once the card writer is switched on) on the next sync pass.

## Step 5 — test it (1 minute, no Encompass needed)

From any computer, this pretends to be Encompass:

```
curl -X POST https://yscap.onrender.com/api/lt/encompass-hook \
  -H "Content-Type: application/json" \
  -H "X-Encompass-Secret: <the step-1 value>" \
  -d '{"loanNumber":"YSCAP258134741"}'
```

A good answer looks like `{"ok":true,"nudged":true,"loans":1}`.

The nameless ping — the exact thing the rule sends if `[364]` is not substituted — is worth
testing too, because that is the path that has to work either way:

```
curl -X POST https://yscap.onrender.com/api/lt/encompass-hook \
  -H "Content-Type: application/json" \
  -H "X-Encompass-Secret: <the step-1 value>" \
  -d '{"ping":"encompass"}'
```

A good answer names the fallback: `{"ok":true,"nudged":…,"via":"recently-changed sweep",…}`.
`"nudged":false` there is not a failure — it means nothing had moved in Encompass since PILOT
last read it.

With the wrong secret you get `403`, with no secret configured on Render at all you get `503`,
and nothing in either case reaches a loan.

## What happens after a nudge

PILOT clears that loan's "last read" stamp; the sync's next pass (they run every few minutes)
re-reads the loan from Encompass — the milestone ladder, every mapped field, the people on it —
and then the ClickUp writer (once switched on) updates the linked card, including moving its
status per the milestone rules. Nothing waits on the timer rotation any more.
