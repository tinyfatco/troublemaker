# Scoped work queue

An optional `workQueue` configuration connects a host-owned poller to an authenticated business API. Configure `url`, `tokenEnv`, `targetId`, `managerEmail`, and trusted `instructions`. The target must exist and the manager must be a configured Zulip member. Use a dedicated workspace template for business-specific instructions. Provider credentials stay on the host.

The upstream API exposes POST `claim`, `ack`, `retry`, and `actions`. Claim returns `{job:null}` or `{job:{id,lease,work:{id,...}}}`. Work identity, rather than customer identity, deterministically binds one isolated context and private Zulip channel. The host journals the envelope before acknowledging upstream, resumes incomplete intake after crashes, then schedules an idempotent internal work event. Internal events carry negative message IDs and an explicit host-event label; they are not posted as provider messages. Only agents author external communication.

Runtime actions use a context-derived capability. The host supplies the authoritative work identity; runtimes cannot select another booking. An assignment additionally requires a native message from the configured manager in that exact channel. The model must interpret whether that message actually reports acceptance; identity verification does not independently prove driver consent. The business API must validate lifecycle, driver eligibility, concurrency, and test isolation transactionally.

The queue is paused by normal hostd drain. Start it only after collaboration ingress is ready. Retain the host SQLite database and private channel bindings during deployments. No global dispatch key or native provider credential belongs in a runtime.

Optional `modelCredentialUrl` and `modelCredentialTokenEnv` enable a loopback-only broker running under an existing model-account owner. `model-credential-server.mjs` uses `MODEL_AUTH_MODULE`, `MODEL_PROVIDER`, `MODEL_CREDENTIAL_TOKEN`, and `MODEL_CREDENTIAL_PORT`. It refreshes using the account owner's existing auth storage and returns only the access key. The host writes that key to the isolated workspace before startup; refresh credentials never enter the context. Broker-backed targets must use `stopAfterTurn: true` so each turn can obtain fresh credentials. Missing model credentials fail the queued delivery before runtime acceptance.

Work-context native messages include their original message IDs in internal routing metadata. The scoped `get` response supplies exact action examples; upstream validation errors are returned to the agent so it can correct a request without guessing the schema.

## Verified customer signup

The poller also supports `onboarding_claim`, `onboarding_contact`,
`onboarding_ack`, and `onboarding_retry`. A claim contains only an opaque event
ID, lease, and `kind: customer_signup`. The host resolves the verified contact,
reuses its existing SMS context (including any active work binding), journals
intake and acknowledges upstream before scheduling one internal signup event.
Contact addresses never enter the event payload. Opted-out contacts are
acknowledged without waking a runtime.

The internal event distinguishes an unpaid website draft from a confirmed work
item and labels customer fields untrusted. It asks the agent for one brief
introduction/help offer without repeating the website's automated welcome.
Existing work uses its scoped customer action. A new SMS context uses the host's
scoped outbound endpoint with a stable signup key, so it works before the
customer's first inbound SMS has registered a runtime phone channel. Signup does
not authorize driver outreach or assignment. Native customer replies retain the
same routing. Duplicate delivery and crash recovery reuse the event and context.
