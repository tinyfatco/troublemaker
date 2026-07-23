import assert from "node:assert/strict";
import { constants, createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "troublemaker-vps-bootstrap-"));
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const bundle = {
	agent_id: "agent-test",
	workspace_key_hex: "ab".repeat(32),
	tools_token: "tools-secret",
	secrets: {
		slack_bot_token: "xoxb-test",
		slack_app_token: "xapp-test",
		telegram_bot_token: "telegram-test",
		loopmessage_api_key: "loop-key",
		loopmessage_base_url: "https://a.loopmessage.com",
		loopmessage_sender_id: "loop-sender",
		codex_credentials: JSON.stringify({ access: "codex-test", refresh: "refresh-test" }),
	},
};
const contentKey = randomBytes(32);
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
const ciphertext = Buffer.concat([cipher.update(JSON.stringify(bundle)), cipher.final()]);
const response = {
	encrypted_bundle: {
		algorithm: "RSA-OAEP-256+A256GCM",
		encrypted_key: publicEncrypt({
			key: publicKey,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
		}, contentKey).toString("base64"),
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	},
	storage: {
		endpoint: "https://r2.example.test",
		access_key_id: "access-test",
		secret_access_key: "secret-test",
		session_token: "session-test",
	},
};
const responsePath = join(directory, "response.json");
const privateKeyPath = join(directory, "private.pem");
const outputPath = join(directory, "output");
await writeFile(responsePath, JSON.stringify(response));
await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

const result = spawnSync(process.execPath, [
	join(process.cwd(), "scripts/vps/decrypt-bootstrap.mjs"),
	responsePath,
	privateKeyPath,
	outputPath,
	"gus",
], { encoding: "utf8" });
assert.equal(result.status, 0, result.stderr);
assert.equal(await readFile(join(outputPath, "workspace.key"), "utf8"), `${bundle.workspace_key_hex}\n`);
assert.equal(await readFile(join(outputPath, "tools-token"), "utf8"), "tools-secret\n");
assert.match(await readFile(join(outputPath, "agent.env"), "utf8"), /MOM_MODEL_ID="gpt-5\.6-sol"/);
const renderedEnv = await readFile(join(outputPath, "agent.env"), "utf8");
assert.match(renderedEnv, /HOME="\/srv\/gus\/workspace"/);
assert.match(renderedEnv, /LOOPMESSAGE_API_KEY="loop-key"/);
assert.match(renderedEnv, /LOOPMESSAGE_BASE_URL="https:\/\/a\.loopmessage\.com"/);
assert.match(renderedEnv, /LOOPMESSAGE_SENDER_ID="loop-sender"/);
assert.match(await readFile(join(outputPath, "rclone.conf"), "utf8"), /session_token = session-test/);
assert.match(await readFile(join(outputPath, "rclone.conf"), "utf8"), /^\[gus-r2\]/);
assert.deepEqual(JSON.parse(await readFile(join(outputPath, "codex-auth.json"), "utf8")), {
	"openai-codex": {
		type: "oauth",
		access: "codex-test",
		refresh: "refresh-test",
	},
});

const unitPath = join(directory, "units");
const renderResult = spawnSync(process.execPath, [
	join(process.cwd(), "scripts/vps/render-systemd.mjs"),
	"gus",
	"11111111-2222-4333-8444-555555555555",
	unitPath,
	"email:webhook,mcp",
	"gus-tunnel@203.0.113.10:63002",
], { encoding: "utf8" });
assert.equal(renderResult.status, 0, renderResult.stderr);
const agentUnit = await readFile(join(unitPath, "gus-agent.service"), "utf8");
assert.match(agentUnit, /--adapter=email:webhook,mcp --host=127\.0\.0\.1 --port=3002/);
assert.match(agentUnit, /User=gus-agent/);
const r2Unit = await readFile(join(unitPath, "gus-r2.service"), "utf8");
assert.match(r2Unit, /gus-r2:fat-agents-data\/agents\/11111111-2222-4333-8444-555555555555/);
const tunnelUnit = await readFile(join(unitPath, "gus-tunnel.service"), "utf8");
assert.match(tunnelUnit, /-R 127\.0\.0\.1:63002:127\.0\.0\.1:3002 gus-tunnel@203\.0\.113\.10/);
