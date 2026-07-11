#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [slug, agentId, outputDirArg, adapters = "email:webhook,mcp", reverseTunnelArg] = process.argv.slice(2);
if (!slug || !agentId || !outputDirArg) {
	console.error("Usage: render-systemd.mjs <runtime-slug> <agent-id> <output-dir> [adapters] [user@host:remote-port]");
	process.exit(2);
}
if (!/^[a-z][a-z0-9-]{0,31}$/.test(slug)) throw new Error("Invalid runtime slug");
if (!/^[0-9a-f-]{36}$/.test(agentId)) throw new Error("Invalid agent id");
if (!/^[a-z0-9:,.-]+$/.test(adapters)) throw new Error("Invalid adapter list");
const reverseTunnel = reverseTunnelArg?.match(/^([a-z][a-z0-9-]{0,31})@([a-zA-Z0-9.-]+):([0-9]{2,5})$/);
if (reverseTunnelArg && !reverseTunnel) throw new Error("Invalid reverse tunnel; expected user@host:remote-port");

const user = `${slug}-agent`;
const configDir = `/etc/${user}`;
const dataDir = `/srv/${slug}`;
const outputDir = resolve(outputDirArg);
await mkdir(outputDir, { recursive: true });

const units = {
	[`${slug}-r2.service`]: `[Unit]
Description=${slug} encrypted R2 backing mount
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=${user}
Group=${user}
ExecStart=/usr/bin/rclone mount ${slug}-r2:fat-agents-data/agents/${agentId} ${dataDir}/r2-raw --config ${configDir}/rclone.conf --vfs-cache-mode writes --vfs-cache-max-size 256M --cache-dir ${dataDir}/cache --dir-cache-time 1m --poll-interval 30s
ExecStop=/bin/fusermount3 -u ${dataDir}/r2-raw
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
`,
	[`${slug}-workspace.service`]: `[Unit]
Description=${slug} decrypted workspace mount
Requires=${slug}-r2.service
After=${slug}-r2.service

[Service]
Type=forking
User=${user}
Group=${user}
ExecStart=/usr/bin/gocryptfs -passfile ${configDir}/workspace.key -plaintextnames ${dataDir}/r2-raw ${dataDir}/workspace
ExecStop=/bin/fusermount3 -u ${dataDir}/workspace
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`,
	[`${slug}-agent.service`]: `[Unit]
Description=${slug} Troublemaker agent
Requires=${slug}-workspace.service
After=${slug}-workspace.service network-online.target

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=/opt/troublemaker
EnvironmentFile=${configDir}/agent.env
ExecStartPre=/usr/bin/install -d -m 0700 -o ${user} -g ${user} ${dataDir}/workspace/.pi/agent
ExecStartPre=/bin/sh -c 'test -f ${dataDir}/workspace/.pi/agent/auth.json || test ! -f ${configDir}/codex-auth.json || /usr/bin/install -m 0600 -o ${user} -g ${user} ${configDir}/codex-auth.json ${dataDir}/workspace/.pi/agent/auth.json'
ExecStart=/usr/bin/node /opt/troublemaker/dist/main.js --sandbox=host --adapter=${adapters} --host=127.0.0.1 --port=3002 ${dataDir}/workspace
Restart=on-failure
RestartSec=10
MemoryMax=320M
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
`,
	[`${slug}-r2-refresh.service`]: `[Unit]
Description=Renew ${slug} prefix-scoped R2 credentials

[Service]
Type=oneshot
User=root
ExecStart=/usr/bin/node /opt/troublemaker/scripts/vps/refresh-r2-credentials.mjs ${agentId} ${configDir}/tools-token ${configDir}/rclone.conf ${slug}-r2
ExecStart=/bin/systemctl stop ${slug}-agent.service ${slug}-workspace.service ${slug}-r2.service
ExecStart=/bin/systemctl start ${slug}-r2.service ${slug}-workspace.service ${slug}-agent.service
`,
	[`${slug}-r2-refresh.timer`]: `[Unit]
Description=Renew ${slug} R2 credentials every five days

[Timer]
OnBootSec=4d
OnUnitActiveSec=5d
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
`,
};

if (reverseTunnel) {
	const [, tunnelUser, tunnelHost, remotePort] = reverseTunnel;
	units[`${slug}-tunnel.service`] = `[Unit]
Description=${slug} reverse ingress tunnel
After=network-online.target ${slug}-agent.service
Wants=network-online.target ${slug}-agent.service

[Service]
Type=simple
User=${user}
Group=${user}
ExecStart=/usr/bin/ssh -NT -i ${configDir}/tunnel-key -o UserKnownHostsFile=${configDir}/tunnel-known-hosts -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:${remotePort}:127.0.0.1:3002 ${tunnelUser}@${tunnelHost}
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes

[Install]
WantedBy=multi-user.target
`;
}

for (const [name, contents] of Object.entries(units)) {
	await writeFile(resolve(outputDir, name), contents, { mode: 0o644 });
}
console.log(`Rendered ${Object.keys(units).length} units for ${slug} in ${outputDir}`);
