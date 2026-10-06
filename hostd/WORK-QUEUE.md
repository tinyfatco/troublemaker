# Scoped work queue

An optional `workQueue` configuration connects a host-owned poller to an authenticated business API. Configure `url`, `tokenEnv`, `targetId`, `managerEmail`, and trusted `instructions`. The target must exist and the manager must be a configured Zulip member. Use a dedicated workspace template for business-specific instructions. Provider credentials stay on the host.

The upstream API exposes POST `claim`, `ack`, `retry`, and `actions`. Claim returns `{job:null}` or `{job:{id,lease,work:{id,...}}}`. Work identity, rather than customer identity, deterministically binds one isolated context and private Zulip channel. The host journals the envelope before acknowledging upstream, resumes incomplete intake after crashes, then schedules an idempotent internal work event. Internal events carry negative message IDs and an explicit host-event label; they are not posted as provider messages. Only agents author external communication.

Runtime actions use a context-derived capability. The host supplies the authoritative work identity; runtimes cannot select another booking. An assignment additionally requires a native message from the configured manager in that exact channel. The model must interpret whether that message actually reports acceptance; identity verification does not independently prove driver consent. The business API must validate lifecycle, driver eligibility, concurrency, and test isolation transactionally.

The queue is paused by normal hostd drain. Start it only after collaboration ingress is ready. Retain the host SQLite database and private channel bindings during deployments. No global dispatch key or native provider credential belongs in a runtime.
