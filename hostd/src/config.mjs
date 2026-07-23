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
			? "Manny"
			: text(mattermost.botDisplayName, "mattermost.botDisplayName"),
	};
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
	const gmail = object(raw.gmail, "gmail");
	const routing = object(raw.routing, "routing");
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
		gmail: {
			account: normalizeAddress(gmail.account, "gmail.account"),
			gogPath: resolve(text(gmail.gogPath ?? "/usr/local/bin/gog", "gmail.gogPath")),
			pollIntervalSeconds: integer(gmail.pollIntervalSeconds, 60, "gmail.pollIntervalSeconds", 15, 3600),
			overlapSeconds: integer(gmail.overlapSeconds, 900, "gmail.overlapSeconds", 60, 86400),
		},
		mattermost: mattermostConfig(raw.mattermost, environment),
		routing: {
			actorTarget,
			knownPrincipals: knownPrincipals.map((candidate, index) => {
				const principal = object(candidate, `routing.knownPrincipals[${index}]`);
				const projects = principal.projects === undefined ? [] : principal.projects;
				if (!Array.isArray(projects)) {
					throw new Error(`routing.knownPrincipals[${index}].projects must be an array`);
				}
				return {
					email: normalizeAddress(principal.email, `routing.knownPrincipals[${index}].email`),
					projects: projects.map((rawProject, projectIndex) => {
						const project = object(
							rawProject,
							`routing.knownPrincipals[${index}].projects[${projectIndex}]`,
						);
						const slug = text(
							project.slug,
							`routing.knownPrincipals[${index}].projects[${projectIndex}].slug`,
						).toLowerCase();
						if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || slug === "intake") {
							throw new Error(`project slug ${slug} is invalid or reserved`);
						}
						return {
							slug,
							name: text(
								project.name ?? project.slug,
								`routing.knownPrincipals[${index}].projects[${projectIndex}].name`,
							),
						};
					}),
				};
			}),
		},
		targets,
		targetsById: new Map(targets.map((target) => [target.id, target])),
	};
}
