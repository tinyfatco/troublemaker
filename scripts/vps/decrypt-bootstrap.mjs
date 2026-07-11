#!/usr/bin/env node

import { constants, createDecipheriv, privateDecrypt } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [responsePath, privateKeyPath, outputDirArg] = process.argv.slice(2);
if (!responsePath || !privateKeyPath || !outputDirArg) {
	console.error("Usage: decrypt-bootstrap.mjs <response.json> <private-key.pem> <output-dir>");
	process.exit(2);
}

const outputDir = resolve(outputDirArg);
const response = JSON.parse(await readFile(responsePath, "utf8"));
const sealed = response.encrypted_bundle;
const storage = response.storage;
if (!sealed || sealed.algorithm !== "RSA-OAEP-256+A256GCM" || !storage) {
	throw new Error("Bootstrap response is missing the encrypted bundle or storage credentials");
}

const privateKey = await readFile(privateKeyPath, "utf8");
const contentKey = privateDecrypt({
	key: privateKey,
	padding: constants.RSA_PKCS1_OAEP_PADDING,
	oaepHash: "sha256",
}, Buffer.from(sealed.encrypted_key, "base64"));
const decipher = createDecipheriv("aes-256-gcm", contentKey, Buffer.from(sealed.iv, "base64"));
decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
const plaintext = Buffer.concat([
	decipher.update(Buffer.from(sealed.ciphertext, "base64")),
	decipher.final(),
]);
const bundle = JSON.parse(plaintext.toString("utf8"));

await mkdir(outputDir, { recursive: true, mode: 0o700 });
await atomicSecret("agent-id", `${bundle.agent_id}\n`);
await atomicSecret("workspace.key", `${bundle.workspace_key_hex}\n`);
await atomicSecret("tools-token", `${bundle.tools_token}\n`);
await atomicSecret("agent.env", buildEnv(bundle));
await atomicSecret("rclone.conf", buildRclone(storage));

if (bundle.secrets?.codex_credentials) {
	await atomicSecret("codex-auth.json", `${bundle.secrets.codex_credentials.trim()}\n`);
}
if (bundle.secrets?.gog_credentials) {
	await atomicSecret("gog-credentials.json", `${bundle.secrets.gog_credentials.trim()}\n`);
}

console.log(`Bootstrap material written to ${outputDir}`);

function buildEnv(bundle) {
	const secrets = bundle.secrets || {};
	const values = {
		HOME: "/srv/zip/workspace",
		PI_CODING_AGENT_DIR: "/srv/zip/workspace/.pi/agent",
		MOM_AGENT_ID: bundle.agent_id,
		MOM_MODEL_PROVIDER: "openai-codex",
		MOM_MODEL_ID: "gpt-5.6-sol",
		MOM_HTTP_PORT: "3002",
		MOM_SLACK_BOT_TOKEN: secrets.slack_bot_token,
		MOM_SLACK_APP_TOKEN: secrets.slack_app_token,
		MOM_TELEGRAM_BOT_TOKEN: secrets.telegram_bot_token,
		MOM_TELEGRAM_TAKEOVER: "true",
		MOM_EMAIL_TOOLS_TOKEN: bundle.tools_token,
		MOM_EMAIL_INBOUND_TOKEN: bundle.tools_token,
		MOM_EMAIL_SEND_URL: "https://tinyfat.com/api/email/send",
		FAT_TOOLS_TOKEN: bundle.tools_token,
	};
	return Object.entries(values)
		.filter(([, value]) => typeof value === "string" && value.length > 0)
		.map(([key, value]) => `${key}=${systemdEscape(value)}`)
		.join("\n") + "\n";
}

function buildRclone(storage) {
	for (const key of ["endpoint", "access_key_id", "secret_access_key", "session_token"]) {
		if (typeof storage[key] !== "string" || !storage[key]) throw new Error(`Storage response is missing ${key}`);
	}
	return [
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
}

function systemdEscape(value) {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("\n", "\\n")}"`;
}

async function atomicSecret(name, contents) {
	const target = resolve(outputDir, name);
	if (dirname(target) !== outputDir) throw new Error("Unsafe output path");
	const temporary = `${target}.tmp-${process.pid}`;
	await writeFile(temporary, contents, { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, target);
}
