import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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
	CLOUDFLARE_WORKERS_AI_API_TOKEN: "test-cloudflare-workers-ai-token",
	CLOUDFLARE_ACCOUNT_ANALYTICS_TOKEN: "test-cloudflare-account-analytics-token",
	LANDING_CHAT_RELAY_TOKEN: "test-landing-chat-relay-token-at-least-32-bytes",
	LANDING_CHAT_RELAY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
	TROUBLEMAKER_HOSTD_WEB_APP_SECRET: "test-web-app-secret-at-least-32-bytes",
};

test("loads a signed Gmail contact relay with a control-plane-owned project", async () => {
	const path = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const config = await loadConfig(path, ENVIRONMENT);

	assert.deepEqual(config.gmail.internalDomains, ["internal.example.com"]);
	assert.deepEqual(config.gmail.alwaysCc, ["archive@example.com"]);
	assert.deepEqual(config.gmail.alwaysTo, ["owner@example.com"]);
	assert.deepEqual(config.gmail.contactRelays, [{
		sender: "noreply@example.com",
		signatureSecret: "test-contact-relay-secret-at-least-32-bytes",
		project: {
			slug: "website",
			name: "Customer website",
		},
	}]);
	assert.equal(config.zulip.agentDisplayName, "Operator");
	assert.equal(config.scheduledWakes.mode, "off");
	assert.deepEqual(config.scheduledWakes.contextIds, []);
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
	assert.deepEqual(config.workersAi, {
		accountId: "0123456789abcdef0123456789abcdef",
		apiToken: "test-cloudflare-workers-ai-token",
		apiBaseUrl: "https://api.cloudflare.com/client/v4",
		allowedModels: ["@cf/zai-org/glm-5.2"],
		gatewayId: undefined,
		analyticsToken: "test-cloudflare-account-analytics-token",
		analyticsPollSeconds: 900,
		analyticsLookbackSeconds: 21_600,
		requestTimeoutMs: 600_000,
		maximumRequestBytes: 4 * 1024 * 1024,
		limits: {
			windowSeconds: 900,
			maximumRequestsPerContext: 12,
			maximumTokensPerContext: 1_000_000,
			maximumRequestsGlobal: 60,
			maximumTokensGlobal: 5_000_000,
			maximumConcurrentPerContext: 1,
			maximumConcurrentGlobal: 4,
		},
	});
	assert.deepEqual(config.webApp, {
		host: "127.0.0.1",
		port: 3120,
		assertionSecret: "test-web-app-secret-at-least-32-bytes",
		issuer: "fat-platform",
		audience: "troublemaker-hostd-web",
		assertionTtlSeconds: 60,
		maximumRequestBytes: 128 * 1024,
		defaultProject: undefined,
		principalAliases: [],
		agentName: "Operator",
	});
	assert.deepEqual(config.routing.knownPhonePrincipals[0].model, {
		provider: "cloudflare-workers-ai",
		id: "@cf/zai-org/glm-5.2",
	});
	assert.deepEqual(config.webChat, {
		relay: {
			url: "https://example.com/api/internal/landing-chat",
			token: "test-landing-chat-relay-token-at-least-32-bytes",
			encryptionKey: Buffer.alloc(32, 9).toString("base64"),
			pollIntervalSeconds: 1,
		},
	});
});

test("requires the web app gateway to remain loopback-only and use a distinct port", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-web-app-config-"));
	const path = join(directory, "config.json");
	try {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		raw.webApp.host = "0.0.0.0";
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(loadConfig(path, ENVIRONMENT), /webApp.host must remain loopback-only/);

		raw.webApp.host = "127.0.0.1";
		raw.webApp.port = raw.server.port;
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(loadConfig(path, ENVIRONMENT), /webApp.port must differ from server.port/);

		raw.webApp.port = 3120;
		raw.webApp.principalAliases = [{
			email: "signed-in@example.com",
			principalEmail: "customer@example.com",
		}];
		await writeFile(path, JSON.stringify(raw));
		const aliased = await loadConfig(path, ENVIRONMENT);
		assert.deepEqual(aliased.webApp.principalAliases, [{
			email: "signed-in@example.com",
			principalEmail: "customer@example.com",
		}]);

		raw.webApp.principalAliases[0].principalEmail = "unknown@example.com";
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(loadConfig(path, ENVIRONMENT), /references unknown principal/);

		raw.webApp.principalAliases = [];
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(
			loadConfig(path, { ...ENVIRONMENT, TROUBLEMAKER_HOSTD_WEB_APP_SECRET: "short" }),
			/at least 32 bytes/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
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

test("rejects phone model overrides outside the host Workers AI allowlist", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-workers-ai-config-"));
	const path = join(directory, "config.json");
	try {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		raw.routing.knownPhonePrincipals[0].model.id = "@cf/example/not-allowed";
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(
			loadConfig(path, ENVIRONMENT),
			/model\.id is not present in workersAi\.allowedModels/,
		);

		delete raw.routing.knownPhonePrincipals[0].model;
		raw.workersAi.allowedModels = ["glm-5.2"];
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(
			loadConfig(path, ENVIRONMENT),
			/must be a fully qualified @cf model ID/,
		);

		raw.workersAi.allowedModels = ["@cf/zai-org/glm-5.2"];
		raw.workersAi.limits.maximumRequestsGlobal = 1;
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(
			loadConfig(path, ENVIRONMENT),
			/maximumRequestsGlobal must cover one context limit/,
		);

		raw.workersAi.limits.maximumRequestsGlobal = 60;
		raw.workersAi.limits.windowSeconds = 60;
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(
			loadConfig(path, ENVIRONMENT),
			/workersAi\.limits\.windowSeconds must be an integer from 900 to 3600/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("loads a phone-only Zulip host without Gmail", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-phone-only-config-"));
	const path = join(directory, "config.json");
	try {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		delete raw.gmail;
		raw.routing.knownPrincipals = [];
		raw.targets[0].gmailToolsOnly = false;
		await writeFile(path, JSON.stringify(raw));
		const config = await loadConfig(path, ENVIRONMENT);
		assert.equal(config.gmail, undefined);
		assert.equal(config.phone.senderAddress, "+15555550100");
		assert.equal(config.zulip.agentDisplayName, "Operator");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects Gmail-only runtime tools on a phone-only host", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-phone-only-gmail-tools-"));
	const path = join(directory, "config.json");
	try {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		delete raw.gmail;
		raw.routing.knownPrincipals = [];
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(
			loadConfig(path, ENVIRONMENT),
			/targets cannot enable gmailToolsOnly when Gmail is not configured/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("requires unique valid Gmail internal domains", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-gmail-internal-domains-"));
	const path = join(directory, "config.json");
	try {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		for (const [internalDomains, expected] of [
			[undefined, /gmail.internalDomains must contain at least one domain/],
			[[], /gmail.internalDomains must contain at least one domain/],
			[["not a domain"], /gmail.internalDomains\[0\] must be a domain name/],
			[["internal.example.com", "INTERNAL.EXAMPLE.COM"], /gmail.internalDomains cannot repeat a domain/],
		]) {
			if (internalDomains === undefined) delete raw.gmail.internalDomains;
			else raw.gmail.internalDomains = internalDomains;
			await writeFile(path, JSON.stringify(raw));
			await assert.rejects(loadConfig(path, ENVIRONMENT), expected);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});


test("loads one exact principal/project Sites deploy binding with an Ed25519 signer", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-sites-config-"));
	const path = join(directory, "config.json");
	const { privateKey } = generateKeyPairSync("ed25519");
	const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	try {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		raw.sites = {
			publishUrl: "https://publish.example.com",
			previewApex: "example.com",
			previewNamespace: "example-sites-preview",
			productionNamespace: "example-sites-production",
			capabilityPrivateKeyEnv: "SITES_CAPABILITY_PRIVATE_KEY",
			capabilityKeyId: "hostd-example-1",
			relationshipFactory: {
				maximumSites: 1,
				artifactKinds: ["static"],
			},
		};
		raw.routing.knownPrincipals[0].projects.push({
			slug: "website",
			name: "Example website",
			siteDeployment: {
				grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				siteId: "11111111-1111-4111-8111-111111111111",
				siteSlug: "example-business",
				artifactKinds: ["static", "worker"],
				allowedBranches: ["*"],
			},
		});
		await writeFile(path, JSON.stringify(raw));
		const config = await loadConfig(path, {
			...ENVIRONMENT,
			SITES_CAPABILITY_PRIVATE_KEY: privatePem,
		});
		assert.equal(config.sites.publishUrl, "https://publish.example.com");
		assert.equal(config.sites.capabilityKeyId, "hostd-example-1");
		assert.equal(config.sites.previewApex, "example.com");
		assert.equal(config.sites.previewNamespace, "example-sites-preview");
		assert.equal(config.sites.productionNamespace, "example-sites-production");
		assert.equal(config.sites.capabilityTtlSeconds, 60);
		assert.deepEqual(config.sites.relationshipFactory, {
			maximumSites: 1,
			artifactKinds: ["static"],
			allowedBranches: ["main"],
			hostnameMode: "site-root-preview",
		});
		assert.deepEqual(config.routing.knownPrincipals[0].projects[0].siteDeployment, {
			grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			siteId: "11111111-1111-4111-8111-111111111111",
			siteSlug: "example-business",
			artifactKinds: ["static", "worker"],
			allowedBranches: ["*"],
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("loads one exact phone-intake Sites deploy binding without broadening phone custody", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-phone-sites-config-"));
	const path = join(directory, "config.json");
	const { privateKey } = generateKeyPairSync("ed25519");
	try {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		raw.sites = {
			publishUrl: "https://publish.example.com",
			previewApex: "example.com",
			previewNamespace: "example-sites-preview",
			productionNamespace: "example-sites-production",
			capabilityPrivateKeyEnv: "SITES_CAPABILITY_PRIVATE_KEY",
			capabilityKeyId: "hostd-example-1",
		};
		raw.routing.knownPhonePrincipals = [{
			phone: "+15551234567",
			name: "Example Owner",
			siteDeployment: {
				grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				siteId: "11111111-1111-4111-8111-111111111111",
				siteSlug: "example-business",
			},
		}];
		await writeFile(path, JSON.stringify(raw));
		const config = await loadConfig(path, {
			...ENVIRONMENT,
			SITES_CAPABILITY_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		});
		assert.equal(config.routing.knownPhonePrincipals[0].phone, "+15551234567");
		assert.equal(config.routing.knownPhonePrincipals[0].siteDeployment.siteSlug, "example-business");

		const duplicate = structuredClone(raw);
		duplicate.routing.knownPhonePrincipals.push(structuredClone(raw.routing.knownPhonePrincipals[0]));
		await writeFile(path, JSON.stringify(duplicate));
		await assert.rejects(
			loadConfig(path, {
				...ENVIRONMENT,
				SITES_CAPABILITY_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			}),
			/cannot repeat a phone number/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("loads two exact Sites grants for one phone intake without merging their identities", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-phone-multi-sites-config-"));
	const path = join(directory, "config.json");
	const { privateKey } = generateKeyPairSync("ed25519");
	try {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		raw.sites = {
			publishUrl: "https://publish.example.com",
			previewApex: "example.com",
			previewNamespace: "example-sites-preview",
			productionNamespace: "example-sites-production",
			capabilityPrivateKeyEnv: "SITES_CAPABILITY_PRIVATE_KEY",
			capabilityKeyId: "hostd-example-1",
		};
		raw.routing.knownPhonePrincipals = [{
			phone: "+15551234567",
			siteFactory: {
				customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				userId: "99999999-9999-4999-8999-999999999999",
				maximumSites: 25,
			},
			siteDeployments: [{
				grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				siteId: "11111111-1111-4111-8111-111111111111",
				siteSlug: "example-business",
			}, {
				grantId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
				customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				projectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				siteId: "22222222-2222-4222-8222-222222222222",
				siteSlug: "second-example",
				previewHostname: "second-example.example.com",
				allowedBranches: ["main"],
			}],
		}];
		await writeFile(path, JSON.stringify(raw));
		const config = await loadConfig(path, {
			...ENVIRONMENT,
			SITES_CAPABILITY_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		});
		assert.deepEqual(
			config.routing.knownPhonePrincipals[0].siteDeployments.map((binding) => binding.siteSlug),
			["example-business", "second-example"],
		);
		assert.equal(config.routing.knownPhonePrincipals[0].siteDeployment, undefined);
		assert.deepEqual(config.routing.knownPhonePrincipals[0].siteFactory, {
			customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			userId: "99999999-9999-4999-8999-999999999999",
			maximumSites: 25,
			artifactKinds: ["static", "worker"],
			allowedBranches: ["main"],
			hostnameMode: "site-root-preview",
		});
		assert.equal(
			config.routing.knownPhonePrincipals[0].siteDeployments[1].previewHostname,
			"second-example.example.com",
		);

		const broadRoot = structuredClone(raw);
		broadRoot.routing.knownPhonePrincipals[0].siteDeployments[1].allowedBranches = ["*"];
		await writeFile(path, JSON.stringify(broadRoot));
		await assert.rejects(
			loadConfig(path, {
				...ENVIRONMENT,
				SITES_CAPABILITY_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			}),
			/previewHostname requires allowedBranches to be exactly main/,
		);

		raw.routing.knownPhonePrincipals[0].siteDeployment = raw.routing.knownPhonePrincipals[0].siteDeployments[0];
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(
			loadConfig(path, {
				...ENVIRONMENT,
				SITES_CAPABILITY_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			}),
			/must configure siteDeployment or siteDeployments, not both/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("loads the host-owned Sites signer from a protected key file", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-sites-key-file-"));
	const path = join(directory, "config.json");
	const keyPath = join(directory, "sites-signing-key.pem");
	const { privateKey } = generateKeyPairSync("ed25519");
	try {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		raw.sites = {
			publishUrl: "https://publish.example.com",
			previewApex: "example.com",
			previewNamespace: "example-sites-preview",
			productionNamespace: "example-sites-production",
			capabilityPrivateKeyFile: keyPath,
			capabilityKeyId: "hostd-example-file-1",
		};
		await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
		await writeFile(path, JSON.stringify(raw));
		const config = await loadConfig(path, ENVIRONMENT);
		assert.equal(config.sites.capabilityKeyId, "hostd-example-file-1");

		raw.sites.capabilityPrivateKeyEnv = "SITES_CAPABILITY_PRIVATE_KEY";
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(
			loadConfig(path, {
				...ENVIRONMENT,
				SITES_CAPABILITY_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			}),
			/exactly one of capabilityPrivateKeyEnv or capabilityPrivateKeyFile/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects broad, duplicate, or non-Ed25519 Sites deploy custody", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-sites-invalid-config-"));
	const path = join(directory, "config.json");
	const { privateKey: edPrivate } = generateKeyPairSync("ed25519");
	const { privateKey: rsaPrivate } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const base = JSON.parse(await readFile(examplePath, "utf8"));
	base.sites = {
		publishUrl: "https://publish.example.com",
		previewApex: "example.com",
		previewNamespace: "example-sites-preview",
		productionNamespace: "example-sites-production",
		capabilityPrivateKeyEnv: "SITES_CAPABILITY_PRIVATE_KEY",
		capabilityKeyId: "hostd-example-1",
	};
	base.routing.knownPrincipals[0].projects.push({
		slug: "website",
		name: "Example website",
		siteDeployment: {
			grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			siteId: "11111111-1111-4111-8111-111111111111",
			siteSlug: "example-business",
		},
	});
	try {
		await writeFile(path, JSON.stringify(base));
		await assert.rejects(
			loadConfig(path, {
				...ENVIRONMENT,
				SITES_CAPABILITY_PRIVATE_KEY: rsaPrivate.export({ type: "pkcs8", format: "pem" }).toString(),
			}),
			/must contain an Ed25519 private key/,
		);

		const sameNamespace = structuredClone(base);
		sameNamespace.sites.productionNamespace = sameNamespace.sites.previewNamespace;
		await writeFile(path, JSON.stringify(sameNamespace));
		await assert.rejects(
			loadConfig(path, {
				...ENVIRONMENT,
				SITES_CAPABILITY_PRIVATE_KEY: edPrivate.export({ type: "pkcs8", format: "pem" }).toString(),
			}),
			/previewNamespace and productionNamespace must differ/,
		);

		const broadFactory = structuredClone(base);
		broadFactory.sites.relationshipFactory = { maximumSites: 2, artifactKinds: ["static"] };
		await writeFile(path, JSON.stringify(broadFactory));
		await assert.rejects(
			loadConfig(path, {
				...ENVIRONMENT,
				SITES_CAPABILITY_PRIVATE_KEY: edPrivate.export({ type: "pkcs8", format: "pem" }).toString(),
			}),
			/sites.relationshipFactory.maximumSites/,
		);

		const duplicate = structuredClone(base);
		duplicate.routing.knownPrincipals.push({
			email: "other@example.com",
			projects: [{
				slug: "other-website",
				name: "Other website",
				siteDeployment: {
					grantId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
					customerId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
					projectId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
					siteId: "11111111-1111-4111-8111-111111111111",
					siteSlug: "other-business",
				},
			}],
		});
		await writeFile(path, JSON.stringify(duplicate));
		await assert.rejects(
			loadConfig(path, {
				...ENVIRONMENT,
				SITES_CAPABILITY_PRIVATE_KEY: edPrivate.export({ type: "pkcs8", format: "pem" }).toString(),
			}),
			/siteId must bind to exactly one principal\/project/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("loads bounded scheduled wake shadow and exact host ownership", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-scheduled-wakes-config-"));
	const path = join(directory, "config.json");
	try {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		delete raw.scheduledWakes;
		await writeFile(path, JSON.stringify(raw));
		let config = await loadConfig(path, ENVIRONMENT);
		assert.equal(config.scheduledWakes.mode, "off");
		assert.deepEqual(config.scheduledWakes.contextIds, []);

		raw.scheduledWakes = {
			mode: "shadow",
			contextIds: [],
			maximumContextsPerTick: 7,
			maximumSchedulesPerContext: 12,
			maximumScanFilesPerTick: 9,
			maximumOccurrencesPerHour: 4,
		};
		await writeFile(path, JSON.stringify(raw));
		config = await loadConfig(path, ENVIRONMENT);
		assert.deepEqual({
			mode: config.scheduledWakes.mode,
			contextIds: config.scheduledWakes.contextIds,
			maximumContextsPerTick: config.scheduledWakes.maximumContextsPerTick,
			maximumSchedulesPerContext: config.scheduledWakes.maximumSchedulesPerContext,
			maximumScanFilesPerTick: config.scheduledWakes.maximumScanFilesPerTick,
			maximumOccurrencesPerHour: config.scheduledWakes.maximumOccurrencesPerHour,
		}, {
			mode: "shadow",
			contextIds: [],
			maximumContextsPerTick: 7,
			maximumSchedulesPerContext: 12,
			maximumScanFilesPerTick: 9,
			maximumOccurrencesPerHour: 4,
		});

		raw.scheduledWakes = { mode: "host", contextIds: [] };
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(loadConfig(path, ENVIRONMENT), /host mode requires at least one exact contextId/);

		raw.scheduledWakes = { mode: "host", contextIds: ["front-desk:example:intake", "front-desk:example:intake"] };
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(loadConfig(path, ENVIRONMENT), /cannot repeat a context/);

		raw.scheduledWakes = {
			mode: "host",
			contextIds: ["front-desk:example:intake"],
			maximumSchedulesPerContext: 2,
			maximumScanFilesPerTick: 3,
		};
		await writeFile(path, JSON.stringify(raw));
		await assert.rejects(loadConfig(path, ENVIRONMENT), /maximumScanFilesPerTick must be an integer from 1 to 2/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
