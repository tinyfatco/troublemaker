import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function object(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value;
}

function text(value, label) {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value.trim();
}

function integer(value, fallback, label, minimum, maximum) {
	const candidate = value === undefined ? fallback : value;
	if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
	}
	return candidate;
}

function boolean(value, fallback, label) {
	const candidate = value === undefined ? fallback : value;
	if (typeof candidate !== "boolean") throw new Error(`${label} must be a boolean`);
	return candidate;
}

function scheduledWakesConfig(raw) {
	const scheduled = raw === undefined ? {} : object(raw, "scheduledWakes");
	const mode = scheduled.mode === undefined ? "off" : text(scheduled.mode, "scheduledWakes.mode").toLowerCase();
	if (!["off", "shadow", "host"].includes(mode)) {
		throw new Error("scheduledWakes.mode must be off, shadow, or host");
	}
	const rawContextIds = scheduled.contextIds ?? [];
	if (!Array.isArray(rawContextIds)) throw new Error("scheduledWakes.contextIds must be an array");
	const contextIds = rawContextIds.map((value, index) => {
		const contextId = text(value, `scheduledWakes.contextIds[${index}]`);
		if (contextId.length > 256 || /[\u0000-\u001f\u007f]/u.test(contextId)) {
			throw new Error(`scheduledWakes.contextIds[${index}] is invalid`);
		}
		return contextId;
	});
	if (new Set(contextIds).size !== contextIds.length) {
		throw new Error("scheduledWakes.contextIds cannot repeat a context");
	}
	if (contextIds.length > 64) throw new Error("scheduledWakes.contextIds cannot exceed 64 contexts");
	if (mode === "host" && contextIds.length === 0) {
		throw new Error("scheduledWakes.host mode requires at least one exact contextId");
	}
	const maximumSchedulesPerContext = integer(
		scheduled.maximumSchedulesPerContext,
		64,
		"scheduledWakes.maximumSchedulesPerContext",
		1,
		256,
	);
	const maximumScanFilesPerTick = integer(
		scheduled.maximumScanFilesPerTick,
		64,
		"scheduledWakes.maximumScanFilesPerTick",
		1,
		maximumSchedulesPerContext,
	);
	const maximumFileBytes = integer(
		scheduled.maximumFileBytes,
		64 * 1024,
		"scheduledWakes.maximumFileBytes",
		1024,
		1024 * 1024,
	);
	const maximumPromptBytes = integer(
		scheduled.maximumPromptBytes,
		32 * 1024,
		"scheduledWakes.maximumPromptBytes",
		1,
		maximumFileBytes,
	);
	return {
		mode,
		contextIds,
		maximumContextsPerTick: integer(
			scheduled.maximumContextsPerTick,
			64,
			"scheduledWakes.maximumContextsPerTick",
			1,
			256,
		),
		maximumSchedulesPerContext,
		maximumScanFilesPerTick,
		maximumFileBytes,
		maximumPromptBytes,
		minimumPeriodicSeconds: integer(
			scheduled.minimumPeriodicSeconds,
			300,
			"scheduledWakes.minimumPeriodicSeconds",
			300,
			86_400,
		),
		maximumHorizonDays: integer(
			scheduled.maximumHorizonDays,
			366,
			"scheduledWakes.maximumHorizonDays",
			1,
			366,
		),
		graceSeconds: integer(scheduled.graceSeconds, 600, "scheduledWakes.graceSeconds", 0, 86_400),
		maximumDuePerTick: integer(
			scheduled.maximumDuePerTick,
			4,
			"scheduledWakes.maximumDuePerTick",
			1,
			64,
		),
		maximumCatchUpSlots: integer(
			scheduled.maximumCatchUpSlots,
			64,
			"scheduledWakes.maximumCatchUpSlots",
			1,
			1024,
		),
		maximumOccurrencesPerHour: integer(
			scheduled.maximumOccurrencesPerHour,
			12,
			"scheduledWakes.maximumOccurrencesPerHour",
			1,
			120,
		),
	};
}

function envSecret(name, label, environment) {
	const key = text(name, label);
	const value = environment[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${label} references unavailable environment variable ${key}`);
	}
	return value.trim();
}

function normalizeAddress(value, label) {
	const address = text(value, label).toLowerCase();
	if (!/^[^@\s]+@[^@\s]+$/.test(address)) throw new Error(`${label} is not an email address`);
	return address;
}

function normalizePhoneAddress(value, label) {
	const address = text(value, label).replaceAll(/[().\s-]/g, "");
	if (!/^\+[1-9]\d{7,14}$/.test(address)) {
		throw new Error(`${label} must be an E.164 phone number`);
	}
	return address;
}

function host(value, fallback, label) {
	const candidate = value === undefined ? fallback : text(value, label);
	if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(candidate)) {
		throw new Error(`${label} must be a hostname or IP address`);
	}
	return candidate;
}

function httpUrl(value, label) {
	const candidate = text(value, label);
	let parsed;
	try {
		parsed = new URL(candidate);
	} catch {
		throw new Error(`${label} must be an http or https URL`);
	}
	if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
		throw new Error(`${label} must be an http or https URL without embedded credentials`);
	}
	return parsed.toString().replace(/\/$/, "");
}

function mattermostId(value, label) {
	const candidate = text(value, label);
	if (!/^[a-z0-9]{26}$/.test(candidate)) throw new Error(`${label} must be a Mattermost ID`);
	return candidate;
}

function mattermostUsername(value, label) {
	const candidate = text(value, label).toLowerCase();
	if (!/^[a-z][a-z0-9._-]{2,63}$/.test(candidate)) {
		throw new Error(`${label} must be a valid Mattermost username`);
	}
	return candidate;
}

function mattermostConfig(raw, environment) {
	if (raw === undefined) return undefined;
	const mattermost = object(raw, "mattermost");
	return {
		url: httpUrl(mattermost.url, "mattermost.url"),
		runtimeUrl: httpUrl(mattermost.runtimeUrl, "mattermost.runtimeUrl"),
		teamId: mattermostId(mattermost.teamId, "mattermost.teamId"),
		batmanUserId: mattermostId(mattermost.batmanUserId, "mattermost.batmanUserId"),
		adminToken: envSecret(mattermost.adminTokenEnv, "mattermost.adminTokenEnv", environment),
		credentialsDirectory: resolve(text(
			mattermost.credentialsDirectory,
			"mattermost.credentialsDirectory",
		)),
		botDisplayName: mattermost.botDisplayName === undefined
			? "Operator"
			: text(mattermost.botDisplayName, "mattermost.botDisplayName"),
		notifierUsername: mattermost.notifierUsername === undefined
			? "tinyfat"
			: mattermostUsername(mattermost.notifierUsername, "mattermost.notifierUsername"),
		notifierDisplayName: mattermost.notifierDisplayName === undefined
			? "TINYFAT"
			: text(mattermost.notifierDisplayName, "mattermost.notifierDisplayName"),
	};
}

function rocketChatUsername(value, label) {
	const candidate = text(value, label).toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate)) {
		throw new Error(`${label} must be a valid Rocket.Chat username`);
	}
	return candidate;
}

function rocketChatConfig(raw, environment) {
	if (raw === undefined) return undefined;
	const rocketChat = object(raw, "rocketChat");
	const memberUsernames = rocketChat.memberUsernames ?? [];
	if (!Array.isArray(memberUsernames)) {
		throw new Error("rocketChat.memberUsernames must be an array");
	}
	return {
		url: httpUrl(rocketChat.url, "rocketChat.url"),
		adminUserId: rocketChat.adminUserIdEnv
			? envSecret(rocketChat.adminUserIdEnv, "rocketChat.adminUserIdEnv", environment)
			: text(rocketChat.adminUserId, "rocketChat.adminUserId"),
		adminToken: envSecret(rocketChat.adminTokenEnv, "rocketChat.adminTokenEnv", environment),
		createTokensSecret: rocketChat.createTokensSecretEnv
			? envSecret(
					rocketChat.createTokensSecretEnv,
					"rocketChat.createTokensSecretEnv",
					environment,
				)
			: undefined,
		credentialsDirectory: resolve(text(
			rocketChat.credentialsDirectory,
			"rocketChat.credentialsDirectory",
		)),
		memberUsernames: memberUsernames.map((username, index) => rocketChatUsername(
			username,
			`rocketChat.memberUsernames[${index}]`,
		)),
		agentUsernamePrefix: rocketChat.agentUsernamePrefix === undefined
			? "operator"
			: rocketChatUsername(rocketChat.agentUsernamePrefix, "rocketChat.agentUsernamePrefix"),
		agentDisplayName: rocketChat.agentDisplayName === undefined
			? "Operator"
			: text(rocketChat.agentDisplayName, "rocketChat.agentDisplayName"),
		notifierUsername: rocketChat.notifierUsername === undefined
			? "tinyfat"
			: rocketChatUsername(rocketChat.notifierUsername, "rocketChat.notifierUsername"),
		notifierDisplayName: rocketChat.notifierDisplayName === undefined
			? "TINYFAT"
			: text(rocketChat.notifierDisplayName, "rocketChat.notifierDisplayName"),
	};
}

function emailArray(value, label) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((candidate, index) => normalizeAddress(candidate, `${label}[${index}]`));
}

function normalizeDomain(value, label) {
	const domain = text(value, label).toLowerCase();
	if (domain.length > 253 || !domain.includes(".")) {
		throw new Error(`${label} must be a domain name`);
	}
	const labels = domain.split(".");
	if (labels.some((candidate) => (
		candidate.length === 0
		|| candidate.length > 63
		|| !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(candidate)
	))) {
		throw new Error(`${label} must be a domain name`);
	}
	return domain;
}

function domainArray(value, label) {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${label} must contain at least one domain`);
	}
	return value.map((candidate, index) => normalizeDomain(candidate, `${label}[${index}]`));
}

function contactRelayConfig(raw, index, environment) {
	const relay = object(raw, `gmail.contactRelays[${index}]`);
	const project = object(relay.project, `gmail.contactRelays[${index}].project`);
	const signatureSecret = envSecret(
		relay.signatureSecretEnv,
		`gmail.contactRelays[${index}].signatureSecretEnv`,
		environment,
	);
	if (signatureSecret.length < 32) {
		throw new Error(`gmail.contactRelays[${index}].signatureSecretEnv must contain at least 32 characters`);
	}
	const slug = text(
		project.slug,
		`gmail.contactRelays[${index}].project.slug`,
	).toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || slug === "intake") {
		throw new Error(`gmail.contactRelays[${index}].project.slug is invalid or reserved`);
	}
	return {
		sender: normalizeAddress(relay.sender, `gmail.contactRelays[${index}].sender`),
		signatureSecret,
		project: {
			slug,
			name: text(
				project.name ?? project.slug,
				`gmail.contactRelays[${index}].project.name`,
			),
		},
	};
}

function zulipConfig(raw, environment) {
	if (raw === undefined) return undefined;
	const zulip = object(raw, "zulip");
	return {
		url: httpUrl(zulip.url, "zulip.url"),
		administratorEmail: normalizeAddress(zulip.administratorEmail, "zulip.administratorEmail"),
		administratorApiKey: envSecret(
			zulip.administratorApiKeyEnv,
			"zulip.administratorApiKeyEnv",
			environment,
		),
		agentEmail: normalizeAddress(zulip.agentEmail, "zulip.agentEmail"),
		agentApiKey: envSecret(zulip.agentApiKeyEnv, "zulip.agentApiKeyEnv", environment),
		projectorEmail: normalizeAddress(zulip.projectorEmail, "zulip.projectorEmail"),
		projectorApiKey: envSecret(zulip.projectorApiKeyEnv, "zulip.projectorApiKeyEnv", environment),
		memberEmails: emailArray(zulip.memberEmails, "zulip.memberEmails"),
		observerEmails: emailArray(zulip.observerEmails, "zulip.observerEmails"),
		agentDisplayName: zulip.agentDisplayName === undefined
			? "Operator"
			: text(zulip.agentDisplayName, "zulip.agentDisplayName"),
		projectorDisplayName: zulip.projectorDisplayName === undefined
			? "TINYFAT"
			: text(zulip.projectorDisplayName, "zulip.projectorDisplayName"),
	};
}

function phoneConfig(raw, environment) {
	if (raw === undefined) return undefined;
	const phone = object(raw, "phone");
	const ingress = phone.ingress === undefined ? undefined : object(phone.ingress, "phone.ingress");
	const relay = phone.relay === undefined ? undefined : object(phone.relay, "phone.relay");
	if (Boolean(ingress) === Boolean(relay)) {
		throw new Error("phone must configure exactly one of phone.ingress or phone.relay");
	}
	const provider = text(phone.provider, "phone.provider").toLowerCase();
	if (provider !== "sendly") throw new Error("phone.provider must be sendly");
	const directOnly = boolean(phone.directOnly, true, "phone.directOnly");
	if (!directOnly) throw new Error("phone.directOnly must remain true");
	const webhookSecret = envSecret(
		phone.webhookSecretEnv,
		"phone.webhookSecretEnv",
		environment,
	);
	if (webhookSecret.length < 24) {
		throw new Error("phone.webhookSecretEnv must contain at least 24 characters");
	}
	return {
		provider,
		directOnly,
		senderAddress: normalizePhoneAddress(phone.senderAddress, "phone.senderAddress"),
		webhookSecret,
		apiKey: envSecret(phone.apiKeyEnv, "phone.apiKeyEnv", environment),
		apiBaseUrl: httpUrl(
			phone.apiBaseUrl ?? "https://sendly.live/api/v1",
			"phone.apiBaseUrl",
		),
		ingress: ingress ? {
			host: host(ingress.host, "127.0.0.1", "phone.ingress.host"),
			port: integer(ingress.port, 3100, "phone.ingress.port", 1024, 65535),
			path: ingress.path === undefined
				? "/webhooks/sendly"
				: text(ingress.path, "phone.ingress.path"),
		} : undefined,
		relay: relay ? {
			url: httpUrl(relay.url, "phone.relay.url"),
			token: envSecret(relay.tokenEnv, "phone.relay.tokenEnv", environment),
			encryptionKey: envSecret(
				relay.encryptionKeyEnv,
				"phone.relay.encryptionKeyEnv",
				environment,
			),
			pollIntervalSeconds: integer(
				relay.pollIntervalSeconds,
				2,
				"phone.relay.pollIntervalSeconds",
				1,
				60,
			),
		} : undefined,
	};
}

async function sitesConfig(raw, environment) {
	if (raw === undefined) return undefined;
	const sites = object(raw, "sites");
	const hasPrivateKeyEnv = sites.capabilityPrivateKeyEnv !== undefined;
	const hasPrivateKeyFile = sites.capabilityPrivateKeyFile !== undefined;
	if (hasPrivateKeyEnv === hasPrivateKeyFile) {
		throw new Error("sites must configure exactly one of capabilityPrivateKeyEnv or capabilityPrivateKeyFile");
	}
	const capabilityPrivateKey = hasPrivateKeyEnv
		? envSecret(sites.capabilityPrivateKeyEnv, "sites.capabilityPrivateKeyEnv", environment)
		: await readFile(
			resolve(text(sites.capabilityPrivateKeyFile, "sites.capabilityPrivateKeyFile")),
			"utf8",
		);
	let key;
	try {
		key = createPrivateKey(capabilityPrivateKey);
	} catch {
		throw new Error("sites.capabilityPrivateKeyEnv must contain a valid private key");
	}
	if (key.asymmetricKeyType !== "ed25519") {
		throw new Error("sites.capabilityPrivateKeyEnv must contain an Ed25519 private key");
	}
	const keyId = text(sites.capabilityKeyId, "sites.capabilityKeyId");
	if (!/^[a-zA-Z0-9._-]{1,64}$/.test(keyId)) {
		throw new Error("sites.capabilityKeyId contains unsupported characters");
	}
	const previewNamespace = text(sites.previewNamespace, "sites.previewNamespace");
	const productionNamespace = text(sites.productionNamespace, "sites.productionNamespace");
	if (![previewNamespace, productionNamespace].every((value) => /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value))) {
		throw new Error("sites preview/production namespaces contain unsupported characters");
	}
	if (previewNamespace === productionNamespace) {
		throw new Error("sites previewNamespace and productionNamespace must differ");
	}
	const previewApex = normalizeDomain(sites.previewApex, "sites.previewApex");
	const maximumFileBytes = integer(
		sites.maximumFileBytes,
		25 * 1024 * 1024,
		"sites.maximumFileBytes",
		1024,
		100 * 1024 * 1024,
	);
	const maximumArtifactBytes = integer(
		sites.maximumArtifactBytes,
		75 * 1024 * 1024,
		"sites.maximumArtifactBytes",
		maximumFileBytes,
		200 * 1024 * 1024,
	);
	return {
		publishUrl: httpUrl(sites.publishUrl, "sites.publishUrl"),
		previewApex,
		previewNamespace,
		productionNamespace,
		capabilityPrivateKey,
		capabilityKeyId: keyId,
		capabilityIssuer: sites.capabilityIssuer === undefined
			? "troublemaker-hostd"
			: text(sites.capabilityIssuer, "sites.capabilityIssuer"),
		capabilityAudience: sites.capabilityAudience === undefined
			? "tinyfat-sites-publish"
			: text(sites.capabilityAudience, "sites.capabilityAudience"),
		capabilityTtlSeconds: integer(
			sites.capabilityTtlSeconds,
			60,
			"sites.capabilityTtlSeconds",
			15,
			120,
		),
		maximumFiles: integer(sites.maximumFiles, 1500, "sites.maximumFiles", 1, 5000),
		maximumFileBytes,
		maximumArtifactBytes,
		maximumCompressedBytes: integer(
			sites.maximumCompressedBytes,
			30 * 1024 * 1024,
			"sites.maximumCompressedBytes",
			1024,
			100 * 1024 * 1024,
		),
	};
}

function uuid(value, label) {
	const candidate = text(value, label).toLowerCase();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)) {
		throw new Error(`${label} must be a UUID`);
	}
	return candidate;
}

function siteDeploymentProjectConfig(raw, label) {
	if (raw === undefined) return undefined;
	const deployment = object(raw, label);
	const grantId = uuid(deployment.grantId, `${label}.grantId`);
	const customerId = uuid(deployment.customerId, `${label}.customerId`);
	const projectId = uuid(deployment.projectId, `${label}.projectId`);
	const siteId = uuid(deployment.siteId, `${label}.siteId`);
	const siteSlug = text(deployment.siteSlug, `${label}.siteSlug`).toLowerCase();
	if (!/^[a-z0-9](?:[a-z0-9-]{0,53}[a-z0-9])?$/.test(siteSlug)) {
		throw new Error(`${label}.siteSlug is invalid`);
	}
	const rawKinds = deployment.artifactKinds ?? ["static", "worker"];
	if (!Array.isArray(rawKinds) || rawKinds.length === 0) {
		throw new Error(`${label}.artifactKinds must contain static or worker`);
	}
	const artifactKinds = rawKinds.map((kind, index) => {
		const value = text(kind, `${label}.artifactKinds[${index}]`).toLowerCase();
		if (!['static', 'worker'].includes(value)) {
			throw new Error(`${label}.artifactKinds must contain only static or worker`);
		}
		return value;
	});
	if (new Set(artifactKinds).size !== artifactKinds.length) {
		throw new Error(`${label}.artifactKinds cannot repeat a value`);
	}
	const rawBranches = deployment.allowedBranches ?? ["*"];
	if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
		throw new Error(`${label}.allowedBranches must contain at least one branch or *`);
	}
	const allowedBranches = rawBranches.map((branch, index) => {
		const value = text(branch, `${label}.allowedBranches[${index}]`);
		if (value.length > 240 || value.includes("\0")) {
			throw new Error(`${label}.allowedBranches[${index}] is invalid`);
		}
		return value;
	});
	if (allowedBranches.includes("*") && allowedBranches.length !== 1) {
		throw new Error(`${label}.allowedBranches must use * alone`);
	}
	if (new Set(allowedBranches).size !== allowedBranches.length) {
		throw new Error(`${label}.allowedBranches cannot repeat a branch`);
	}
	return { grantId, customerId, projectId, siteId, siteSlug, artifactKinds, allowedBranches };
}

function targetConfig(raw, index, environment) {
	const target = object(raw, `targets[${index}]`);
	const id = text(target.id, `targets[${index}].id`);
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
		throw new Error(`targets[${index}].id contains unsupported characters`);
	}
	const driver = text(target.driver, `targets[${index}].driver`);
	if (driver !== "oci") {
		throw new Error(`targets[${index}].driver must be oci`);
	}
	const protocol = text(target.protocol, `targets[${index}].protocol`);
	if (protocol !== "email-webhook") {
		throw new Error(`targets[${index}].protocol must be email-webhook`);
	}
	const common = {
		id,
		driver,
		protocol,
		inboundToken: envSecret(target.inboundTokenEnv, `targets[${index}].inboundTokenEnv`, environment),
	};
	const basePort = integer(target.basePort, 32000, `targets[${index}].basePort`, 1024, 65535);
	const maxPort = integer(target.maxPort, basePort + 999, `targets[${index}].maxPort`, basePort, 65535);
	const runtimeEnv = target.runtimeEnv === undefined
		? {}
		: Object.fromEntries(
			Object.entries(object(target.runtimeEnv, `targets[${index}].runtimeEnv`)).map(([key, value]) => [
				text(key, `targets[${index}].runtimeEnv key`),
				text(value, `targets[${index}].runtimeEnv.${key}`),
			]),
		);
	const rawSkills = target.skills === undefined
		? []
		: (Array.isArray(target.skills) ? target.skills : [target.skills]);
	return {
		...common,
		engine: target.engine === undefined ? "docker" : text(target.engine, `targets[${index}].engine`),
		image: text(target.image, `targets[${index}].image`),
		checkout: resolve(text(target.checkout, `targets[${index}].checkout`)),
		skills: rawSkills.map((path, skillIndex) => resolve(
			text(path, `targets[${index}].skills[${skillIndex}]`),
		)),
		workspaceTemplate: resolve(text(target.workspaceTemplate, `targets[${index}].workspaceTemplate`)),
		contextsDirectory: resolve(text(target.contextsDirectory, `targets[${index}].contextsDirectory`)),
		basePort,
		maxPort,
		memory: target.memory === undefined ? "420m" : text(target.memory, `targets[${index}].memory`),
		stopAfterTurn: boolean(target.stopAfterTurn, false, `targets[${index}].stopAfterTurn`),
		gmailToolsOnly: boolean(target.gmailToolsOnly, false, `targets[${index}].gmailToolsOnly`),
		immutableImage: boolean(target.immutableImage, false, `targets[${index}].immutableImage`),
		runtimeVersion: target.runtimeVersion === undefined
			? text(target.image, `targets[${index}].image`)
			: text(target.runtimeVersion, `targets[${index}].runtimeVersion`),
		hostGateway: host(
			target.hostGateway,
			"host.containers.internal",
			`targets[${index}].hostGateway`,
		),
		outboundToken: envSecret(target.outboundTokenEnv, `targets[${index}].outboundTokenEnv`, environment),
		runtimeEnv,
	};
}

export async function loadConfig(path, environment = process.env) {
	const raw = object(JSON.parse(await readFile(path, "utf8")), "config");
	const company = object(raw.company, "company");
	const server = object(raw.server ?? {}, "server");
	const state = object(raw.state, "state");
	const gmail = raw.gmail === undefined ? undefined : object(raw.gmail, "gmail");
	const routing = object(raw.routing, "routing");
	const scheduler = object(raw.scheduler ?? {}, "scheduler");
	const scheduledWakes = scheduledWakesConfig(raw.scheduledWakes);
	if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
		throw new Error("targets must contain at least one target");
	}
	const targets = raw.targets.map((target, index) => targetConfig(target, index, environment));
	const targetIds = new Set(targets.map((target) => target.id));
	const actorTarget = text(routing.actorTarget, "routing.actorTarget");
	if (!targetIds.has(actorTarget)) throw new Error(`routing.actorTarget references unknown target ${actorTarget}`);
	const selectedTarget = targets.find((target) => target.id === actorTarget);
	if (selectedTarget?.driver !== "oci") throw new Error("routing.actorTarget must reference an OCI target");
	const knownPrincipals = routing.knownPrincipals === undefined ? [] : routing.knownPrincipals;
	if (!Array.isArray(knownPrincipals)) throw new Error("routing.knownPrincipals must be an array");
	const knownPhonePrincipals = routing.knownPhonePrincipals === undefined ? [] : routing.knownPhonePrincipals;
	if (!Array.isArray(knownPhonePrincipals)) {
		throw new Error("routing.knownPhonePrincipals must be an array");
	}
	const mattermost = mattermostConfig(raw.mattermost, environment);
	const rocketChat = rocketChatConfig(raw.rocketChat, environment);
	const zulip = zulipConfig(raw.zulip, environment);
	const phone = phoneConfig(raw.phone, environment);
	const sites = await sitesConfig(raw.sites, environment);
	if (phone?.ingress && !/^\/[a-z0-9/_-]+$/i.test(phone.ingress.path)) {
		throw new Error("phone.ingress.path must be an absolute URL path");
	}
	if (phone?.relay) {
		let key;
		try {
			key = Buffer.from(phone.relay.encryptionKey, "base64");
		} catch {
			throw new Error("phone.relay.encryptionKeyEnv must contain base64");
		}
		if (key.length !== 32) {
			throw new Error("phone.relay.encryptionKeyEnv must contain a base64-encoded 32-byte key");
		}
	}
	const rawContactRelays = gmail?.contactRelays === undefined ? [] : gmail.contactRelays;
	if (!Array.isArray(rawContactRelays)) throw new Error("gmail.contactRelays must be an array");
	const contactRelays = rawContactRelays.map((relay, index) => (
		contactRelayConfig(relay, index, environment)
	));
	if (new Set(contactRelays.map((relay) => relay.sender)).size !== contactRelays.length) {
		throw new Error("gmail.contactRelays cannot repeat a sender");
	}
	const gmailAccount = gmail ? normalizeAddress(gmail.account, "gmail.account") : undefined;
	const internalDomains = gmail ? domainArray(gmail.internalDomains, "gmail.internalDomains") : [];
	const alwaysTo = gmail ? emailArray(gmail.alwaysTo, "gmail.alwaysTo") : [];
	const alwaysCc = gmail ? emailArray(gmail.alwaysCc, "gmail.alwaysCc") : [];
	if (new Set(internalDomains).size !== internalDomains.length) {
		throw new Error("gmail.internalDomains cannot repeat a domain");
	}
	if (new Set(alwaysTo).size !== alwaysTo.length) {
		throw new Error("gmail.alwaysTo cannot repeat an address");
	}
	if (new Set(alwaysCc).size !== alwaysCc.length) {
		throw new Error("gmail.alwaysCc cannot repeat an address");
	}
	if (gmailAccount && alwaysTo.includes(gmailAccount)) {
		throw new Error("gmail.alwaysTo cannot include gmail.account");
	}
	if (gmailAccount && alwaysCc.includes(gmailAccount)) {
		throw new Error("gmail.alwaysCc cannot include gmail.account");
	}
	if (alwaysTo.some((address) => alwaysCc.includes(address))) {
		throw new Error("gmail.alwaysTo and gmail.alwaysCc cannot overlap");
	}
	if ([mattermost, rocketChat, zulip].filter(Boolean).length > 1) {
		throw new Error("configure only one operator workspace: mattermost, rocketChat, or zulip");
	}
	if (phone && !zulip) throw new Error("phone integration currently requires zulip");
	if (!phone && knownPhonePrincipals.length > 0) {
		throw new Error("routing.knownPhonePrincipals requires phone configuration");
	}
	if (!gmail && targets.some((target) => target.gmailToolsOnly)) {
		throw new Error("targets cannot enable gmailToolsOnly when Gmail is not configured");
	}
	if (phone?.ingress && phone.ingress.port === integer(
		server.port,
		3099,
		"server.port",
		1024,
		65535,
	)) {
		throw new Error("phone.ingress.port must differ from server.port");
	}

	const configuredPrincipals = knownPrincipals.map((candidate, index) => {
		const principalLabel = `routing.knownPrincipals[${index}]`;
		const principal = object(candidate, principalLabel);
		const projects = principal.projects === undefined ? [] : principal.projects;
		if (!Array.isArray(projects)) {
			throw new Error(`${principalLabel}.projects must be an array`);
		}
		return {
			email: normalizeAddress(principal.email, `${principalLabel}.email`),
			name: principal.name === undefined ? undefined : text(principal.name, `${principalLabel}.name`),
			projects: projects.map((rawProject, projectIndex) => {
				const projectLabel = `${principalLabel}.projects[${projectIndex}]`;
				const project = object(rawProject, projectLabel);
				const slug = text(project.slug, `${projectLabel}.slug`).toLowerCase();
				if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || slug === "intake") {
					throw new Error(`project slug ${slug} is invalid or reserved`);
				}
				const siteDeployment = siteDeploymentProjectConfig(
					project.siteDeployment,
					`${projectLabel}.siteDeployment`,
				);
				if (siteDeployment && !sites) {
					throw new Error(`${projectLabel}.siteDeployment requires top-level sites configuration`);
				}
				return {
					slug,
					name: text(project.name ?? project.slug, `${projectLabel}.name`),
					siteDeployment,
				};
			}),
		};
	});
	const configuredPhonePrincipals = knownPhonePrincipals.map((candidate, index) => {
		const principalLabel = `routing.knownPhonePrincipals[${index}]`;
		const principal = object(candidate, principalLabel);
		const siteDeployment = siteDeploymentProjectConfig(
			principal.siteDeployment,
			`${principalLabel}.siteDeployment`,
		);
		if (siteDeployment && !sites) {
			throw new Error(`${principalLabel}.siteDeployment requires top-level sites configuration`);
		}
		return {
			phone: normalizePhoneAddress(principal.phone, `${principalLabel}.phone`),
			name: principal.name === undefined ? undefined : text(principal.name, `${principalLabel}.name`),
			siteDeployment,
		};
	});
	if (new Set(configuredPhonePrincipals.map((principal) => principal.phone)).size !== configuredPhonePrincipals.length) {
		throw new Error("routing.knownPhonePrincipals cannot repeat a phone number");
	}
	const siteBindings = configuredPrincipals.flatMap((principal) => (
		principal.projects
			.filter((project) => project.siteDeployment)
			.map((project) => ({
				email: principal.email,
				projectSlug: project.slug,
				...project.siteDeployment,
			}))
	)).concat(configuredPhonePrincipals
		.filter((principal) => principal.siteDeployment)
		.map((principal) => ({ phone: principal.phone, projectSlug: "intake", ...principal.siteDeployment })));
	const duplicateSiteIds = siteBindings.filter((binding, index) => (
		siteBindings.findIndex((candidate) => candidate.siteId === binding.siteId) !== index
	));
	if (duplicateSiteIds.length > 0) {
		throw new Error("each sites deployment siteId must bind to exactly one principal/project");
	}
	const duplicateSiteSlugs = siteBindings.filter((binding, index) => (
		siteBindings.findIndex((candidate) => candidate.siteSlug === binding.siteSlug) !== index
	));
	if (duplicateSiteSlugs.length > 0) {
		throw new Error("each sites deployment siteSlug must bind to exactly one principal/project");
	}
	for (const key of ["grantId", "projectId"]) {
		if (siteBindings.some((binding, index) => (
			siteBindings.findIndex((candidate) => candidate[key] === binding[key]) !== index
		))) {
			throw new Error(`each sites deployment ${key} must bind to exactly one principal/project`);
		}
	}

	return {
		path: resolve(path),
		company: {
			id: text(company.id, "company.id"),
			actor: text(company.actor, "company.actor"),
		},
		server: {
			host: server.host === undefined ? "127.0.0.1" : text(server.host, "server.host"),
			port: integer(server.port, 3099, "server.port", 1024, 65535),
			operatorToken: server.operatorTokenEnv
				? envSecret(server.operatorTokenEnv, "server.operatorTokenEnv", environment)
				: undefined,
		},
		state: {
			database: resolve(text(state.database, "state.database")),
			routingKeyFile: resolve(text(state.routingKeyFile, "state.routingKeyFile")),
		},
		gmail: gmail ? {
			account: gmailAccount,
			internalDomains,
			gogPath: resolve(text(gmail.gogPath ?? "/usr/local/bin/gog", "gmail.gogPath")),
			pollIntervalSeconds: integer(gmail.pollIntervalSeconds, 60, "gmail.pollIntervalSeconds", 15, 3600),
			overlapSeconds: integer(gmail.overlapSeconds, 900, "gmail.overlapSeconds", 60, 86400),
			alwaysTo,
			alwaysCc,
			contactRelays,
		} : undefined,
		scheduler: {
			maxConcurrent: integer(scheduler.maxConcurrent, 6, "scheduler.maxConcurrent", 1, 64),
			leaseSeconds: integer(scheduler.leaseSeconds, 60, "scheduler.leaseSeconds", 15, 600),
			turnLeaseSeconds: integer(scheduler.turnLeaseSeconds, 900, "scheduler.turnLeaseSeconds", 60, 7200),
			idleSeconds: integer(scheduler.idleSeconds, 300, "scheduler.idleSeconds", 30, 86400),
			tickSeconds: integer(scheduler.tickSeconds, 2, "scheduler.tickSeconds", 1, 60),
			maximumAttempts: integer(scheduler.maximumAttempts, 5, "scheduler.maximumAttempts", 1, 20),
		},
		scheduledWakes,
		mattermost,
		rocketChat,
		zulip,
		phone,
		sites,
		routing: {
			actorTarget,
			knownPrincipals: configuredPrincipals,
			knownPhonePrincipals: configuredPhonePrincipals,
		},
		targets,
		targetsById: new Map(targets.map((target) => [target.id, target])),
	};
}
