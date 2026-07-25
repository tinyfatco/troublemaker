import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

const ENVIRONMENT = {
	TROUBLEMAKER_HOSTD_OPERATOR_TOKEN: "fake-operator-token",
	ZULIP_HOSTD_ADMIN_API_KEY: "fake-admin-key",
	ZULIP_HOSTD_AGENT_API_KEY: "fake-agent-key",
	ZULIP_HOSTD_PROJECTOR_API_KEY: "fake-projector-key",
	FRONT_DESK_RUNTIME_INBOUND_TOKEN: "fake-inbound-token",
	FRONT_DESK_RUNTIME_OUTBOUND_TOKEN: "fake-outbound-token",
	CONTACT_RELAY_SECRET: "test-contact-relay-secret-at-least-32-bytes",
	PHONE_WEBHOOK_SECRET: "test-phone-webhook-secret-at-least-24-bytes",
	PHONE_API_KEY: "test-phone-api-key",
};

test("loads a signed Gmail contact relay with a control-plane-owned project", async () => {
	const path = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const config = await loadConfig(path, ENVIRONMENT);

	assert.deepEqual(config.gmail.contactRelays, [{
		sender: "noreply@example.com",
		signatureSecret: "test-contact-relay-secret-at-least-32-bytes",
		project: {
			slug: "website",
			name: "Customer website",
		},
	}]);
	assert.equal(config.zulip.agentDisplayName, "Operator");
	assert.deepEqual(config.phone, {
		provider: "sendly",
		directOnly: true,
		senderAddress: "+15555550100",
		webhookSecret: "test-phone-webhook-secret-at-least-24-bytes",
		apiKey: "test-phone-api-key",
		apiBaseUrl: "https://sendly.live/api/v1",
		ingress: {
			host: "127.0.0.1",
			port: 3100,
			path: "/webhooks/sendly",
		},
		relay: undefined,
	});
});

test("loads encrypted edge relay polling without a public Hostd listener", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-phone-relay-config-"));
	const path = join(directory, "config.json");
	try {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		raw.phone = {
			provider: "sendly",
			senderAddress: "+15555550100",
			webhookSecretEnv: "PHONE_WEBHOOK_SECRET",
			apiKeyEnv: "PHONE_API_KEY",
			directOnly: true,
			relay: {
				url: "https://relay.example/api/v2/hostd/phone",
				tokenEnv: "PHONE_RELAY_TOKEN",
				encryptionKeyEnv: "PHONE_RELAY_KEY",
				pollIntervalSeconds: 3,
			},
		};
		await writeFile(path, JSON.stringify(raw));
		const config = await loadConfig(path, {
			...ENVIRONMENT,
			PHONE_RELAY_TOKEN: "example-relay-token",
			PHONE_RELAY_KEY: Buffer.alloc(32, 4).toString("base64"),
		});
		assert.equal(config.phone.ingress, undefined);
		assert.deepEqual(config.phone.relay, {
			url: "https://relay.example/api/v2/hostd/phone",
			token: "example-relay-token",
			encryptionKey: Buffer.alloc(32, 4).toString("base64"),
			pollIntervalSeconds: 3,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
