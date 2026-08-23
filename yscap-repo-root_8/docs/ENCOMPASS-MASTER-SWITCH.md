# The master Encompass switch — `ENCOMPASS_ENABLED`

**One setting turns the whole Encompass connection off, across both products.**
Owner-directed 2026-08-23: *"I want you to set in the credential something and give
me what I can set, like Encompass enabled, and I can click zero or one, whatever, to
make sure that the system disables all the Encompass credentials."* Restated the same
day: *"create a switch that I can, any time, switch to turn the entire integration on.
For now, leave it on."*

## How to use it

In the Render dashboard, on the web service's **Environment** tab:

| To do this | Set |
| --- | --- |
| **Turn Encompass OFF** | `ENCOMPASS_ENABLED` = `0` |
| **Turn Encompass back ON** | `ENCOMPASS_ENABLED` = `1`, or delete the variable entirely |

Render restarts the service when an environment value is saved, so it takes effect on
its own within a minute or two. `false`, `no` and `off` are accepted as OFF as well,
in any casing and with stray spaces.

**Today it is ON, and it is ON by default.** A deployment that has never set this
variable is unaffected — that is deliberate, and it is asserted by a test on its own,
because the expensive failure here is a deploy silently disconnecting a live tenant.

## What "off" actually does

Every Encompass connection in this system reports itself **not connected**, and no
request leaves the process — not a loan read, not a pipeline search, not a field read,
not a flood order, **not even the login**. There are exactly three Encompass clients
and all three are covered:

| Client | What it does | Off behaviour |
| --- | --- | --- |
| `src/lib/integrations/encompass.js` | the RTL read-only client (every RTL loan read) | reports not connected; refuses at its own guard |
| `src/encompass/flood-order.js` | flood ordering — the ONE authorized *write* into Encompass | reports not connected; refuses at its own guard |
| `src/longterm/encompass/client.js` | the Long-Term read-only client (the long-term sync) | reports not connected; refuses at its own guard |

Downstream, that means: the Long-Term background sync runs its passes and does nothing
(no Encompass call, no token, nothing on the wire), the "Pull everything from Encompass"
button answers with the reason instead of pretending to start, the API-Health page's
Encompass card says it is switched off, and the RTL admin Encompass screens refuse with
the same sentence.

**Nothing is deleted, rotated or rewritten.** The credentials stay exactly where they
are in the environment; they are simply not used while the switch is off, and the
connection is alive again the moment it is removed.

Every screen that explains a stopped connection reads the SAME sentence, from one
place (`OFF_REASON`), and each keeps its own separate "the credentials are not set"
wording — because those are two different states needing two different actions from
whoever is reading, and telling somebody to add a credential that is sitting right
there is worse than saying nothing.

**A note on how that is wired, for whoever changes it next.** Each call site asks the
pure switch module DIRECTLY rather than a method on the Encompass client. That is not
style: the test suites replace those client modules wholesale in `require.cache`, and a
stub only ever carries the handful of methods its own test needs — so a call site that
depended on a new client method would throw on every stubbed test. The switch modules
are pure and are never stubbed.

## What it deliberately does NOT do

- It does not stop PILOT itself. Every screen, every loan file, every other integration
  keeps working; the Encompass-sourced figures simply stop refreshing.
- It does not touch the **flood** feature's own switches
  (`ENCOMPASS_FLOOD_ENABLED` / `_OUTBOUND_ENABLED` / `_DRYRUN`), which stay as they were
  — this switch sits *above* them, so with it off flood ordering is off regardless.
- It does not change the READ-ONLY freeze. Encompass remains one-way; this only adds a
  way to stop the reads too.

## Why the rule is written twice

RTL and Long-Term are two separate systems and Long-Term may not import RTL code, so the
same rule lives in two files:

- `src/lib/integrations/encompass-enabled.js` (RTL)
- `src/longterm/encompass/enabled.js` (Long-Term)

Two copies of a rule drift, and the one that drifts is the one that leaks — a value read
as "off" on one side and "on" on the other would leave half the system logging in while
somebody believed Encompass was switched off. So
`scripts/test-lt-encompass-kill-switch-pure.js` runs **both** copies over the same inputs
and fails the build the moment they disagree. **Change one, change the other.**

## What proves it works

| Suite | Covers |
| --- | --- |
| `scripts/test-encompass-kill-switch-pure.js` | the rule; the RTL read-only client and the flood client both refusing; nothing reaching the wire; unset being unchanged; the wording |
| `scripts/test-lt-encompass-kill-switch-pure.js` | the Long-Term client; the guard itself; **the mirror** |

Both are in the ordinary `npm test` chain and neither needs a database, a network or a
real credential. Eleven deliberate breakages of the production code — each one removing a
single check — were each confirmed to turn the suites red, with an unmutated control green
either side.

**Honest note:** the read-only client's own fetch guard is a *backstop* that never bites
on any reachable route today, because every exported path in that module calls `ensure()`
first, and `ensure()` already refuses. It is kept for the route added next year that
forgets to ask. The Long-Term and flood guards are not redundant and are proven to bite.

## History

The research written before Encompass was built (`docs/encompass-research/findings/F1.md`,
`docs/ENCOMPASS-READONLY-GUARDRAILS.md`) specified exactly this variable, defaulting OFF,
and it was never actually built. This is that switch — with the default flipped to ON,
because Encompass is now live in production and shipping it default-off would have
disconnected the tenant on the next deploy.
