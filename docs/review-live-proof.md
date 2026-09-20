# Review live-transport proof

This is a runnable proof procedure, **not execution evidence**. A successful
offline preflight or unit test is not live proof. Do not remove those labels
until the corresponding run has produced an inspected artifact.

## Scope

`scripts/proof-review-live.ts` invokes unchanged production delivery,
synchronization, and outstanding-write recovery functions using Carbon's real
Discord REST client. It creates one synthetic card in an empty test text
channel, verifies every payload with real GETs, and leaves the card intact.
The database is a fresh **local Wrangler D1 binding**, not deployed D1. The
synthetic archive goes through the actual authenticated forwarder HTTP bridge.
The bridge has a random per-run bearer secret and is stopped afterward.

The test account being assessed is the test bot itself. Its input is generated
fixture text, never channel history or real member telemetry. Only the
configured channel is accessed. Production review guild/channel IDs are refused.
Card comparisons ignore server-assigned component IDs and treat an omitted
button `disabled` flag as false; true and every rendered field remain checked.
The runner overrides review coordinates in its own process; production files,
bot endpoint, command registrations, and deployed services remain unchanged.

## Required configuration

Provide these to the process through the authorized runtime credential facility.
Do not paste tokens into chat, command lines, artifacts, or source files.

- `HERMIT_PROOF_GUILD_ID`: authorized nonproduction guild.
- `HERMIT_PROOF_CHANNEL_ID`: empty dedicated text channel in that guild.
- `DISCORD_CLIENT_ID` and `DISCORD_BOT_TOKEN`: existing authorized test bot.
- `OPENAI_API_KEY`: only if the optional paid provider proof is authorized.

Automatic screening must remain disabled. Do not change any existing bot's
interaction endpoint or redeploy its commands for this runner. If OpenClaw
requires Discord-scoped execution, launch from that actual conversation; do
not extract file-backed credentials to bypass the scope restriction.

Run from a **clean committed tree** (Bun on PATH):

```sh
bun --no-env-file scripts/proof-review-live.ts --preflight
bun --no-env-file scripts/proof-review-live.ts --live
```

To additionally exercise the unchanged evaluator and its real provider request,
use `--live --provider` instead of `--live`. This can make the configured primary
request and its fallback, and spends API credit. Both HTTP results and the
provider's returned model name are recorded; do not label fallback output as the
primary model. The runner never installs or claims a separate Krill service.

## Decisive sequence

1. Verify the token's bot identity, the channel's guild, and that the channel is
   empty. Apply migrations to fresh local D1. Fetch 24 synthetic observations
   through the authenticated production Discrawl bridge and analyze them.
2. Optionally request a real provider assessment. Create the case and deliver a
   card through `postReviewEscalationCard`. Fetch and compare the exact card.
   This is the normal-delivery preservation control.
3. Enter production `syncSharedReviewCard` for an older assessment. At the
   transport seam, hold its PATCH after production persisted the write ledger.
   Leave its caller unresolved: neither catch nor acknowledgment may run.
4. Save and synchronize a newer assessment. GET verifies the newer payload.
   Honor the actual 120-second due time, run outstanding-write recovery, GET
   verifies the card, and assert the original ledger is still present.
5. Forward the held PATCH through the original Carbon REST client. A real GET
   must now show the stale payload. Keep the original caller unresolved. Honor
   the next actual backoff, run recovery again, and GET must show latest state.
6. Assert desired/synced revisions match, the original unresolved ledger remains,
   and the test channel contains only the original card—not a replacement.

The barrier controls the ordering; waits only honor production retry eligibility.
No fake Discord responses, fabricated acknowledgment, clock rewrite, or fabricated
due timestamp is used. This injects a delayed/unacknowledged transport outcome;
it is **not** an actual Worker termination or proof about Discord latency bounds.

## Artifacts and limits

The private run directory is printed at exit under
`$XDG_STATE_HOME/hermit-live-proof/<run-id>` (or `~/.local/state/...`). It retains
`evidence.jsonl`, the synthetic fixture, generated local-only Wrangler config,
and local D1 state. A failure is recorded as failure. Proxies are disposed before
exit. No cleanup deletes remote cards or receipts automatically; inspect the
record before retrying, and use another empty test channel if needed.

Inspect and redact artifacts before PR publication. Evidence records HEAD,
ordering, actual GET assertions, revisions, retained obligations, provider
response model, and hashes. Never publish credentials, private endpoints, or
unrelated logs. Do not publish private Discord IDs without owner permission.

Still separate, even after this runner passes:

- Real `/review` and button ingress through the production Worker/Carbon router.
  Capture an authorized staff test action, stale-button rejection, the D1
  decision, and shared-card GET readback. Do not fabricate signed Discord events.
- Deployed staging Worker/D1 evidence, if required by the current review.
- An executed red baseline with the same transport harness; this script does
  not assert one ran or silently disable production checks to simulate it.
- Pilot policy sponsorship and upstream CI approval.

Update `## Real Behavior Proof` with only the observed scope, exact tested HEAD,
command, relevant output, inspected artifact, and these explicit limits.

## Actual Gateway interaction proof

`bun --no-env-file scripts/proof-review-interactions.ts --live` is a separate
opt-in ingress runner, not a claim of a completed run. It requires the same test
configuration plus `HERMIT_PROOF_ACTOR_IDS` (comma-separated authorized owners) and
`HERMIT_PROOF_STAFF_ROLE_ID` (operator-created zero-permission test role).
It refuses an existing guild `/review` command or an application with an HTTP
interaction endpoint. It adds only its own temporary guild command and maps the existing test role
as staff inside the test process. The actual actor starts without that role.
After a genuine rejected command, the owner assigns the role through Discord
for the authorized control. It deletes its own command in `finally`, including
failure/timeout cleanup. The owner must remove the temporary role afterward;
the bot is not granted role-management privileges.

It uses a separate zero-intent Carbon Gateway connection, listens only for test
channel/actor interactions, and passes their actual payloads unchanged to the
same Carbon interaction router used by the Worker. The production command and
button handlers are unchanged. Existing bot configuration, global commands,
and interaction endpoint are not modified. No message history is ingested.

In the authorized browser, run `/review user:<test bot>` twice (first denied,
then allowed), click Dismiss on the now-stale ephemeral command card, then click
Dismiss on the current shared card. The runner asserts real webhook responses,
D1 denial/preservation/decision, and exact real shared-card GET readback. Never
fabricate a Discord event or interaction token. Artifacts remain private under
`~/.local/state/hermit-interaction-proof/`. This exercises real Gateway ingress,
not deployed Worker HTTP signature validation. Provider execution is excluded
and `OPENAI_API_KEY` must be absent to keep that proof independent.
