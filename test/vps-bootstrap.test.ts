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
		codex_credentials: JSON.stringify({ access: "codex-test" }),
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
], { encoding: "utf8" });
assert.equal(result.status, 0, result.stderr);
assert.equal(await readFile(join(outputPath, "workspace.key"), "utf8"), `${bundle.workspace_key_hex}\n`);
assert.equal(await readFile(join(outputPath, "tools-token"), "utf8"), "tools-secret\n");
assert.match(await readFile(join(outputPath, "agent.env"), "utf8"), /MOM_MODEL_ID="gpt-5\.6-sol"/);
assert.match(await readFile(join(outputPath, "rclone.conf"), "utf8"), /session_token = session-test/);
assert.deepEqual(JSON.parse(await readFile(join(outputPath, "codex-auth.json"), "utf8")), { access: "codex-test" });
