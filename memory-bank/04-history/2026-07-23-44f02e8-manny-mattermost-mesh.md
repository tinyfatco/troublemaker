# Manny Mattermost Context Mesh

Date: 2026-07-23
Repository: `tinyfatco/troublemaker`
Runtime commit: `3553c163b878526e70c75d2c95d07f206201ec8b`

Commits:

- `6cfe4bc` — provision one private Mattermost room and Manny bot per hostd
  context
- `6f93d6e` — temporarily restrict private rooms to Manny and Batman
- `9fd1476` — restore Alex as a member of every private room
- `44f02e8` — route private Manny working output to Mattermost and add durable
  per-channel ambient attention controls
- `3553c16` — merge the current `origin/main` runtime into the hostd branch

The deterministic Gmail context router now provisions a private Mattermost
collaboration room for every isolated Manny context. Each room has exactly
Alex, Batman, and that context's private Manny bot. Context-specific bot tokens
remain in mode-`0600` files outside SQLite and outside the child workspace;
SQLite stores only the durable context-to-team/channel/bot binding.

Private Manny containers receive only their own Mattermost token and channel
allowlist. Their initial `workingOutput` target is the bound Mattermost room, so
tool activity and working narration are visible there without depending on the
email thread. The template deliberately omits a fixed channel ID: hostd injects
the context's actual channel on first initialization. An existing explicit
self-configuration remains authoritative.

Mattermost ambient awareness remains enabled by default. The
`mattermost.channel_attention` self-configuration surface can switch individual
channels between `ambient` and `mentions-only`. Mentions-only suppresses ambient
evaluation while preserving the durable transcript, `read_thread`, and
`@mention` wakeups.

Manny's workspace instructions now treat Batman delegation as asynchronous.
After handing work to Batman, Manny ends the current turn instead of sleeping,
polling, or repeatedly reading the Mattermost thread. Batman's eventual room
reply wakes a new Manny turn. This keeps email delivery turns bounded and
preserves agent-to-agent communication as the orchestration substrate.

Verification completed locally and on the Manny deployment candidate:

- `npm run typecheck`
- `npm run build`
- `npm run test:self-configure` — 104 passing tests
- `npm run test:working-output-routing`
- `npm run test:mattermost-adapter`
- `npm test --prefix hostd`
- `npm run test:vps-bootstrap`
- `npx tsx test/phone-messaging-loop-provider.test.ts`

Deployment:

- pushed branch `codex/troublemaker-hostd-20260723`
- pushed `origin/main` through merge commit `3553c16`
- updated Batman's clean checkout on `tiny-bat` to `3553c16`, rebuilt it,
  restarted `batman-agent.service`, and verified `127.0.0.1:3019`
- retained Batman's existing Slack working-output target and enabled Mattermost
  ambient attention
- deployed clean commit `3553c16` to `/opt/troublemaker` on the dedicated
  `manny-agent` VPS with the prior `6cfe4bc` checkout retained for rollback
- restarted and health-checked `manny-agent.service` on `127.0.0.1:3002` and
  `troublemaker-hostd.service` on `127.0.0.1:3099`
- stopped all existing private Manny containers so their next wake replaces
  them against the new checkout
- verified clean active checkouts on the Mac, `tiny-bat`, and Manny
- verified the three existing private workspace targets:
  - initial Alex intake → `4oednh57zf89j8845oihueuwba`
  - Alex personal intake → `9jtu1ni9a3d38qzxyoiu4zadph`
  - Pablo covered-call → `ytung9p4jbfm8yo9uwkm7xjw8y`

Live pressure tests:

1. An email from `alexgarcia042@gmail.com` created a new private intake
   context, private Mattermost room, and Manny bot. Manny built a balloon
   website, handed the archive to Batman in Mattermost, and Batman deployed and
   browser-verified `https://balloons.tinyfat.dev/`. Manny then delivered the
   verified production URL through the native Gmail thread.
2. While the balloon context was still active, an email from
   `pablojgarcia@gmail.com` deterministically resolved to the configured
   `covered-call` project and existing Gmail thread. A separate container and
   three-member Mattermost room were created. Manny answered in about eight
   seconds with covered-call/cave-machine context and no balloon-context leak.
   The event completed on its first delivery attempt.

The pressure test exposed one remaining architectural hardening item. Hostd
currently waits synchronously for a child email turn, so an unexpectedly long
turn can delay the next Gmail poll until the runtime request returns or fails.
The asynchronous handoff instructions prevent the observed sleep/poll pattern
on future contexts, but hostd should still dispatch different contexts
concurrently while serializing turns within each context. The event ledger must
also retain idempotent retry semantics when a runtime connection times out
after the agent has already performed external work.
