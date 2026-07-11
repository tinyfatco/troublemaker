# VPS FUSE Permission Correction

**Date:** 2026-07-11  
**Commit:** `af7021a`

Corrected the persistent VPS runbook and Zip unit after live mount validation.
`/etc/zip-agent` must be traversable by the `zip-agent` group, and the initial
Codex auth copy must run as `zip-agent` because the user-owned FUSE mount does
not permit root traversal by default.

Verification passed with `systemd-analyze verify`; both R2 and gocryptfs mounts
are active and the encrypted Zip workspace is readable by the dedicated user.
Live runtime/channel QA remains in progress.
