# Resident Personal Agent

Date: 2026-07-11
Status: Product and runtime direction

## Thesis

Troublemaker in host mode on a persistent server is a first-class product
shape. It preserves the central MOM idea: one agent process inhabits a real
computer, shares one awareness history across channels, uses direct tools, and
continues operating between interactive sessions.

This is distinct from Flight's relationship-scoped operator runtime. Flight is
appropriate where many roles, threads, grants, supervisors, and delivery
ledgers must be isolated and coordinated. A trusted personal agent should not
inherit that complexity merely because Flight is the platform default.

## Proven Shape

Zip on `psychedelic-news` currently demonstrates:

- native systemd lifecycle;
- unprivileged host-mode tool execution;
- encrypted R2 workspace mounted through gocryptfs;
- GPT-5.6 through Codex OAuth;
- Slack Socket Mode, Telegram polling, and authenticated email ingress;
- one unified awareness context across those surfaces;
- short-lived prefix-scoped R2 credentials with automatic renewal.

The migration also exposed an operational invariant: exactly one runtime must
own each resident channel connection. A retired Slack Durable Object remained
connected with the same app token and intermittently consumed events until it
was explicitly disabled.

## Security Boundary

Host mode requires more than an unprivileged user. The target production shape
adds default-deny process/cgroup egress and routes provider calls through a
credential-injecting TinyFat proxy. The proxy should accept a scoped per-agent
capability token and enforce semantic operation, destination, payload, and
audit policy. Direct on-host provider credentials should be minimized and
documented as exceptions.

The runtime should remain small and legible. Control-plane concerns such as
server provisioning, DNS, tunnels, encrypted secret custody, health, and
backups belong outside Troublemaker.

## Learning Direction

Hermes demonstrates a useful optional loop: after a completed foreground turn,
a restricted background fork reviews the transcript and proposes or writes
memory and procedural-skill updates. Troublemaker should study the mechanism
without adopting Hermes's aggressive default-to-write behavior.

A suitable first slice would:

1. detect durable preference, correction, or procedure signals;
2. produce a provenance-linked memory or skill patch;
3. require approval by default;
4. validate scripts or procedures before activation where possible;
5. retain rollback history and age out unused agent-created guidance.

Unified cross-channel awareness gives Troublemaker unusually strong input for
this reflection because the learning signal is not confined to one session or
messaging surface.

