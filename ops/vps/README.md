# Persistent VPS Agent

These helpers run an agent as a native, persistent Troublemaker process while keeping
its TinyFat workspace encrypted at rest in R2. The public ingress should expose
only `/email/inbound`; the gateway itself remains bound to localhost.

1. Install Node 22, `rclone`, `gocryptfs`, and `fuse3`.
2. Create a `<slug>-agent` system user and `/srv/<slug>/{r2-raw,workspace,cache}`.
3. Obtain an operator-authenticated `/api/v2/agents/<id>/bootstrap` response
   encrypted to a server-generated RSA public key.
4. Run `scripts/vps/decrypt-bootstrap.mjs <response> <key> /etc/<slug>-agent <slug>`,
   then delete the bootstrap response and RSA private key. Set the config directory
   to `root:<slug>-agent` mode `0750`. Keep `tools-token` root-only; set
   `rclone.conf` and `workspace.key` to `root:<slug>-agent` mode `0640`.
5. Install this repository at `/opt/troublemaker`, build it, then render units with
   `scripts/vps/render-systemd.mjs <slug> <agent-id> /etc/systemd/system`.
6. Route `<slug>-host.tinyfat.com` through a managed Cloudflare Tunnel to
   `http://localhost:3002`, restricted to `^/email/inbound$`.
7. Start `<slug>-r2`, `<slug>-workspace`, and `<slug>-agent` in that order. Enable
   the `<slug>-r2-refresh.timer`; credentials last seven days and renew every five.

For reverse-SSH ingress through a hardened router, pass a final
`user@host:remote-port` argument when rendering. Install `tunnel-key` and
`tunnel-known-hosts` in the agent config directory, then expose only the required
webhook path from the router's loopback remote port.

The R2 credentials are limited by Cloudflare to the agent's object prefix. The agent
runs as an unprivileged user with a 320 MB systemd memory ceiling and cannot
read the other applications' environment files. Credential renewal briefly
restarts Zip's mount chain and runtime.
