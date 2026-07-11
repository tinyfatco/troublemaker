# Persistent VPS Agent

These units run Zip as a native, persistent Troublemaker process while keeping
its TinyFat workspace encrypted at rest in R2. The public ingress should expose
only `/email/inbound`; the gateway itself remains bound to localhost.

1. Install Node 22, `rclone`, `gocryptfs`, and `fuse3`.
2. Create the `zip-agent` system user and `/srv/zip/{r2-raw,workspace,cache}`.
3. Obtain an operator-authenticated `/api/v2/agents/<id>/bootstrap` response
   encrypted to a server-generated RSA public key.
4. Run `scripts/vps/decrypt-bootstrap.mjs` into `/etc/zip-agent`, then delete the
   bootstrap response and RSA private key. Set `/etc/zip-agent` to
   `root:zip-agent` mode `0750`. Keep `tools-token` root-only; set
   `rclone.conf` and `workspace.key` to `root:zip-agent` mode `0640`.
5. Install this repository at `/opt/troublemaker`, build it, and copy the units
   into `/etc/systemd/system`.
6. Start `zip-r2`, `zip-workspace`, and `zip-agent` in that order. Enable the
   `zip-r2-refresh.timer`; credentials last seven days and renew every five.

The R2 credentials are limited by Cloudflare to Zip's object prefix. The agent
runs as an unprivileged user with a 320 MB systemd memory ceiling and cannot
read the other applications' environment files. Credential renewal briefly
restarts Zip's mount chain and runtime.
