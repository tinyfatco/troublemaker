#!/usr/bin/env node

import { chmod, chown, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [agentId, tokenPath, configPathArg] = process.argv.slice(2);
if (!agentId || !tokenPath || !configPathArg) {
	console.error("Usage: refresh-r2-credentials.mjs <agent-id> <tools-token-file> <rclone.conf>");
	process.exit(2);
}

const token = (await readFile(tokenPath, "utf8")).trim();
const response = await fetch(`https://crawdad.tinyfat.com/agents/${encodeURIComponent(agentId)}/vps/storage-credentials`, {
	method: "POST",
	headers: { Authorization: `Bearer ${token}` },
});
const payload = await response.json();
if (!response.ok || !payload.storage) {
	throw new Error(payload.error_description || `Credential refresh failed with HTTP ${response.status}`);
}

const storage = payload.storage;
const config = [
	"[zip-r2]",
	"type = s3",
	"provider = Cloudflare",
	`endpoint = ${storage.endpoint}`,
	`access_key_id = ${storage.access_key_id}`,
	`secret_access_key = ${storage.secret_access_key}`,
	`session_token = ${storage.session_token}`,
	"no_check_bucket = true",
	"",
].join("\n");
const configPath = resolve(configPathArg);
const existing = await stat(configPath);
const temporary = `${configPath}.tmp-${process.pid}`;
await writeFile(temporary, config, { mode: existing.mode & 0o777 });
await chmod(temporary, existing.mode & 0o777);
await chown(temporary, existing.uid, existing.gid);
await rename(temporary, configPath);
console.log(`R2 credentials renewed through ${storage.expires_at}`);
