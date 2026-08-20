import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { buildEmailWebhookBody } from "./prompt.mjs";
import { contextCapability } from "./security.mjs";
import {
	resolveContextRuntimeModel,
	runtimeModelEnvironment,
	runtimeModelVersionSuffix,
} from "./workers-ai.mjs";
import {
	resolveSiteDeploymentBinding,
	resolveSiteDeploymentBindings,
	resolveSiteFactory,
} from "./site-deployment-binding.mjs";

export function siteDeploymentBinding(config, store, target, contextId, routingKey, siteSlug) {
	return resolveSiteDeploymentBinding(config, store, target, contextId, routingKey, siteSlug);
}

export function siteDeploymentBindings(config, store, target, contextId, routingKey) {
	return resolveSiteDeploymentBindings(config, store, target, contextId, routingKey);
}

function safeRuntimeName(contextId) {
	const normalized = contextId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/-+/g, "-");
	return `troublemaker-${normalized}`.slice(0, 63);
}

export function hostOwnsScheduledWakes(config, contextId) {
	return config.scheduledWakes?.mode === "host"
		&& config.scheduledWakes.contextIds.includes(contextId);
}

export function scheduledWakeRuntimeVersion(config, target, contextId) {
	return hostOwnsScheduledWakes(config, contextId)
		? `${target.runtimeVersion}:scheduled-host-v1`
		: target.runtimeVersion;
}

/** Derive one context workspace without accepting path input from schedule files. */
export function contextWorkspacePath(target, contextId) {
	const contextDirectory = resolve(
		target.contextsDirectory,
		contextId.replace(/[^a-z0-9_.-]/gi, "_"),
	);
	const root = `${resolve(target.contextsDirectory)}/`;
	if (!`${contextDirectory}/`.startsWith(root)) {
		throw new Error(`context ${contextId} escaped its configured contexts directory`);
	}
	return join(contextDirectory, "workspace");
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function writePrivateFile(path, content) {
	const file = await open(path, "w", 0o600);
	try {
		await file.chmod(0o600);
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
}

async function replacePrivateFile(path, content) {
	const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	let file;
	try {
		file = await open(temporaryPath, "wx", 0o600);
		await file.chmod(0o600);
		await file.writeFile(content, "utf8");
		await file.sync();
		await file.close();
		file = undefined;
		await rename(temporaryPath, path);
	} catch (error) {
		await file?.close().catch(() => {});
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

async function rebindHostManagedPhoneChannelRegistry(
	workspace,
	fromContextId,
	toContextId,
	expectedThreadTarget,
) {
	const registryPath = join(workspace, "phone-channels.json");
	let originalContent;
	try {
		originalContent = await readFile(registryPath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT" && !expectedThreadTarget) return null;
		if (error?.code === "ENOENT") throw new Error("relationship phone registry is missing");
		throw error;
	}

	let registry;
	try {
		registry = JSON.parse(originalContent);
	} catch {
		throw new Error("relationship phone registry is invalid");
	}
	if (
		!registry
		|| registry.version !== 1
		|| !registry.channels
		|| typeof registry.channels !== "object"
		|| Array.isArray(registry.channels)
	) throw new Error("relationship phone registry is invalid");

	const managed = Object.entries(registry.channels).filter(([, record]) => record?.hostManaged === true);
	if (!expectedThreadTarget) {
		if (managed.length > 0) throw new Error("non-phone relationship retains host-managed phone authority");
		return null;
	}
	if (managed.length !== 1) {
		throw new Error("relationship phone registry is not exact-channel scoped");
	}
	const [registryKey, record] = managed[0];
	if (
		registryKey !== expectedThreadTarget
		|| record.channelId !== expectedThreadTarget
		|| record.hostContextId !== fromContextId
	) throw new Error("relationship phone registry conflicts with source custody");

	record.hostContextId = toContextId;
	await replacePrivateFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
	return { registryPath, originalContent };
}

export function serializeRuntimeEnvironment(environment) {
	return `${Object.entries(environment).map(([key, rawValue]) => {
		if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key)) {
			throw new Error(`runtime environment contains invalid key ${JSON.stringify(key)}`);
		}
		const value = String(rawValue);
		if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(value)) {
			throw new Error(`runtime environment ${key} contains unsupported control characters`);
		}
		return `${key}=${value}`;
	}).join("\n")}\n`;
}

export async function initializeChannelWorkingOutput(
	workspace,
	platform,
	channelId,
	{ migrateFromPlatforms = [] } = {},
) {
	if (platform === "mattermost" && !/^[a-z0-9]{26}$/.test(channelId)) {
		throw new Error("Mattermost working-output channel ID is invalid");
	}
	if (platform === "rocket-chat" && !/^[a-zA-Z0-9_-]{8,128}$/.test(channelId)) {
		throw new Error("Rocket.Chat working-output room ID is invalid");
	}
	if (platform === "zulip" && !/^[1-9]\d*$/.test(String(channelId))) {
		throw new Error("Zulip working-output channel ID is invalid");
	}
	if (!["mattermost", "rocket-chat", "zulip"].includes(platform)) {
		throw new Error("Unsupported customer-channel working-output platform");
	}
	const settingsPath = join(workspace, "settings.json");
	let settings = {};
	try {
		const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("settings.json must contain an object");
		}
		settings = parsed;
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	// The room is the private Operator's initial work surface, but self_configure
	// remains authoritative after initialization. A host-managed platform
	// cutover may replace only an old fixed customer-channel target; explicit
	// off/follow policies and all other self-configuration remain untouched.
	if (settings.workingOutput !== undefined) {
		const existingPlatform = settings.workingOutput?.mode === "fixed"
			? settings.workingOutput?.target?.platform
			: null;
		if (!migrateFromPlatforms.includes(existingPlatform)) return false;
	}
	settings.workingOutput = {
		mode: "fixed",
		target: { platform, channelId },
	};
	await writePrivateFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	return true;
}

export async function initializeMattermostWorkingOutput(workspace, channelId) {
	return initializeChannelWorkingOutput(workspace, "mattermost", channelId);
}

export async function initializeHostMcpSettings(
	workspace,
	connections,
	{ hostGateway, serverPort, tokenEnv = "MOM_MCP_OUTBOUND_TOKEN" },
) {
	const settingsPath = join(workspace, "settings.json");
	let settings = {};
	try {
		const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("settings.json must contain an object");
		}
		settings = parsed;
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const existing = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const unmanaged = existing.filter((entry) => entry?.managedBy !== "hostd");
	const unmanagedAliases = new Set(unmanaged.map((entry) => entry?.alias).filter(Boolean));
	const managed = connections.map((connection) => {
		if (unmanagedAliases.has(connection.alias)) {
			throw new Error(`Hostd MCP alias conflicts with workspace settings: ${connection.alias}`);
		}
		return {
			managedBy: "hostd",
			connectionId: connection.id,
			alias: connection.alias,
			transport: "http",
			url: `http://${hostGateway}:${serverPort}/v1/mcp/outbound/${encodeURIComponent(connection.contextId)}/${encodeURIComponent(connection.id)}`,
			tokenEnv,
			scopes: [],
		};
	});
	const nextServers = [...unmanaged, ...managed];
	if (JSON.stringify(existing) === JSON.stringify(nextServers)) return false;
	settings.mcpServers = nextServers;
	await writePrivateFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	return true;
}

export function mcpRuntimeVersionSuffix(config, store, contextId) {
	if (!config.mcp) return "";
	const state = {
		inbound: store.listMcpInboundGrants(contextId, { activeOnly: true })
			.filter((grant) => grant.profile === "relationship-operator-v1" && grant.relationshipId)
			.map((grant) => {
				const relationship = store.getMcpRelationship(grant.relationshipId);
				const phone = relationship?.source === "phone"
					? store.getPhoneConversationByProviderThread(relationship.providerThreadId)
					: null;
				return {
					id: grant.id,
					relationshipId: grant.relationshipId,
					profile: grant.profile,
					generation: grant.generation,
					updatedAt: grant.updatedAt,
					relationship: relationship ? {
						generation: relationship.generation,
						source: relationship.source,
						recipientHint: relationship.recipientHint,
						replyTarget: phone?.threadTarget,
					} : null,
				};
			}),
		outbound: store.listMcpOutboundConnections(contextId, { activeOnly: true }).map((connection) => ({
			id: connection.id,
			revision: connection.revision,
			updatedAt: connection.updatedAt,
		})),
	};
	const revision = createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 12);
	return `:mcp-${revision}`;
}

export function runtimeEngineRunFlags(engine) {
	const executable = basename(engine).toLowerCase();
	if (executable === "docker" || executable.startsWith("docker-")) {
		return [
			"--add-host",
			"host.docker.internal:host-gateway",
		];
	}
	return [
		"--replace",
		"--userns=keep-id",
		"--network=slirp4netns:allow_host_loopback=true",
	];
}

function usesDockerEngine(engine) {
	const executable = basename(engine).toLowerCase();
	return executable === "docker" || executable.startsWith("docker-");
}

async function run(command, args, { timeout = 120_000, allowFailure = false } = {}) {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		const stdout = [];
		const stderr = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${command} timed out`));
		}, timeout);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const result = {
				code: code ?? -1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			};
			if (!allowFailure && result.code !== 0) {
				reject(new Error(`${command} exited ${result.code}: ${result.stderr.slice(0, 500)}`));
				return;
			}
			resolvePromise(result);
		});
	});
}

async function waitForHealth(url, timeout = 90_000) {
	const started = Date.now();
	let lastError = "not ready";
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
			if (response.ok) return;
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
	}
	throw new Error(`runtime health check timed out: ${lastError}`);
}

async function waitForSteeringReady(url, stillHasRunningTurn, timeout = 5_000) {
	const started = Date.now();
	let lastState = "runtime idle";
	while (Date.now() - started < timeout) {
		if (!stillHasRunningTurn()) return;
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(500) });
			if (response.ok) {
				const status = await response.json();
				if (status?.idle === false) return;
				lastState = "runtime idle";
			} else {
				lastState = `HTTP ${response.status}`;
			}
		} catch (error) {
			lastState = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
	throw new Error(`runtime did not become steering-ready: ${lastState}`);
}

export class RuntimeManager {
	constructor(config, store, { mattermost, rocketChat, zulip, routingKey, sites } = {}) {
		this.config = config;
		this.store = store;
		this.mattermost = mattermost;
		this.rocketChat = rocketChat;
		this.zulip = zulip;
		this.routingKey = routingKey;
		this.sites = sites;
		this.externalActivityProbe = () => false;
		this.mcp = undefined;
		this.contextStartupLocks = new Map();
		this.pendingMcpRefresh = new Set();
	}

	setExternalActivityProbe(probe) {
		this.externalActivityProbe = typeof probe === "function" ? probe : () => false;
	}

	setMcp(mcp) {
		this.mcp = mcp;
	}

	async rehomeStoppedContext(target, fromContextId, toContextId, {
		relationshipId,
		phoneThreadTarget,
	} = {}) {
		const source = this.store.getContext(fromContextId);
		if (
			!source
			|| source.targetId !== target.id
			|| source.status !== "stopped"
			|| this.store.hasContextMaintenanceActivity(fromContextId)
		) throw new Error("relationship_context_not_stopped");
		if (this.store.getContext(toContextId)) throw new Error("relationship_context_destination_exists");
		if (source.runtimeName) {
			const inspect = await run(
				target.engine,
				["inspect", "--format", "{{.State.Running}}", source.runtimeName],
				{ allowFailure: true, timeout: 30_000 },
			);
			if (inspect.code === 0 && inspect.stdout.trim() === "true") {
				throw new Error("relationship_context_runtime_running");
			}
		}

		const sourceDirectory = dirname(contextWorkspacePath(target, fromContextId));
		const destinationDirectory = dirname(contextWorkspacePath(target, toContextId));
		if (sourceDirectory === destinationDirectory) {
			throw new Error("relationship_context_directory_collision");
		}
		if (await exists(destinationDirectory)) {
			throw new Error("relationship_context_destination_workspace_exists");
		}
		const moveWorkspace = await exists(sourceDirectory);
		let phoneRegistryMigration;
		if (moveWorkspace) {
			await rename(sourceDirectory, destinationDirectory);
			try {
				phoneRegistryMigration = await rebindHostManagedPhoneChannelRegistry(
					contextWorkspacePath(target, toContextId),
					fromContextId,
					toContextId,
					phoneThreadTarget,
				);
			} catch (error) {
				await rename(destinationDirectory, sourceDirectory);
				throw error;
			}
		} else if (phoneThreadTarget) {
			throw new Error("relationship phone workspace is missing");
		}
		try {
			const result = this.store.rehomeContext({
				fromContextId,
				toContextId,
				targetId: target.id,
				runtimeName: safeRuntimeName(toContextId),
				relationshipId,
			});
			return {
				...result,
				workspaceMoved: moveWorkspace,
				retainedStoppedRuntime: source.runtimeName || undefined,
			};
		} catch (error) {
			if (phoneRegistryMigration) {
				await replacePrivateFile(
					phoneRegistryMigration.registryPath,
					phoneRegistryMigration.originalContent,
				);
			}
			if (moveWorkspace) await rename(destinationDirectory, sourceDirectory);
			throw error;
		}
	}

	async acceptEvent(event) {
		const target = this.config.targetsById.get(event.targetId);
		if (!target) throw new Error(`unknown target ${event.targetId}`);
		const context = await this.ensureOciContext(target, event.contextId);
		if (event.deliveryMode === "steer") {
			await waitForSteeringReady(
				context.statusEndpoint,
				() => this.store.hasRunningEvent(event.contextId, event.id),
			);
		}
		const payload = event.payloadJson ? JSON.parse(event.payloadJson) : {};
		if (event.source === "gmail") {
			await this.deliverEmailWebhook(target, context, event, payload);
			return;
		}
		if (event.source === "mattermost") {
			await this.deliverMattermostWebhook(target, context, event, payload);
			return;
		}
		if (event.source === "rocket-chat") {
			await this.deliverRocketChatWebhook(target, context, event, payload);
			return;
		}
		if (event.source === "zulip") {
			await this.deliverZulipWebhook(target, context, event, payload);
			return;
		}
		if (event.source === "phone") {
			await this.deliverPhoneWebhook(target, context, event, payload);
			return;
		}
		if (event.source === "web_chat") {
			await this.deliverWebChatWebhook(target, context, event, payload);
			return;
		}
		if (event.source === "scheduled-prompt") {
			await this.deliverScheduledPromptWebhook(target, context, event, payload);
			return;
		}
		if (event.source === "mcp-operator") {
			await this.deliverMcpOperatorWebhook(target, context, event, payload);
			return;
		}
		throw new Error(`unsupported event source ${event.source}`);
	}

	hostReceipt(target, event) {
		return {
			url: `http://${target.hostGateway}:${this.config.server.port}/v1/events/${encodeURIComponent(event.id)}/receipt`,
			token: contextCapability(target.inboundToken, "receipt", event.contextId),
			leaseToken: event.leaseToken,
		};
	}

	async deliverEmailWebhook(target, context, event, input) {
		if (!this.config.gmail) throw new Error("Gmail event received without Gmail configuration");
		const inboundToken = contextCapability(target.inboundToken, "inbound", context.contextId);
		const response = await fetch(context.endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${inboundToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				from: input.sender,
				fromFull: input.metadata.from,
				to: input.metadata.to || this.config.gmail.account,
				subject: input.metadata.subject || "(no subject)",
				body: buildEmailWebhookBody(input),
				allRecipients: [...new Set([
					...(input.metadata.to?.split(",") ?? []),
					...(input.metadata.cc?.split(",") ?? []),
				].map((value) => value.trim()).filter(Boolean))],
				providerMessageId: input.message.id,
				providerThreadId: input.message.threadId,
				deliveryId: event.id,
				hostContextId: event.contextId,
				hostReceipt: this.hostReceipt(target, event),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`email runtime returned HTTP ${response.status}: ${text.slice(0, 200)}`);
		}
	}

	async deliverMattermostWebhook(target, context, event, input) {
		const inboundToken = contextCapability(target.inboundToken, "mattermost-inbound", context.contextId);
		const response = await fetch(context.mattermostEndpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${inboundToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				deliveryId: event.id,
				hostContextId: event.contextId,
				post: input.post,
				hostReceipt: this.hostReceipt(target, event),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`Mattermost runtime returned HTTP ${response.status}: ${text.slice(0, 200)}`);
		}
	}

	async deliverRocketChatWebhook(target, context, event, input) {
		const inboundToken = contextCapability(target.inboundToken, "rocketchat-inbound", context.contextId);
		const response = await fetch(context.rocketChatEndpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${inboundToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				deliveryId: event.id,
				hostContextId: event.contextId,
				message: input.message,
				hostReceipt: this.hostReceipt(target, event),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`Rocket.Chat runtime returned HTTP ${response.status}: ${text.slice(0, 200)}`);
		}
	}

	async deliverZulipWebhook(target, context, event, input) {
		const inboundToken = contextCapability(target.inboundToken, "zulip-inbound", context.contextId);
		const response = await fetch(context.zulipEndpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${inboundToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				deliveryId: event.id,
				hostContextId: event.contextId,
				message: input.message,
				hostReceipt: this.hostReceipt(target, event),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`Zulip runtime returned HTTP ${response.status}: ${text.slice(0, 200)}`);
		}
	}

	async deliverPhoneWebhook(target, context, event, input) {
		const inboundToken = contextCapability(
			target.inboundToken,
			"phone-inbound",
			context.contextId,
		);
		const response = await fetch(context.phoneEndpoint, {
			method: "POST",
				headers: {
					authorization: `Bearer ${inboundToken}`,
					"content-type": "application/json",
				},
			body: JSON.stringify({
				provider: "hostd",
				hostManaged: true,
				transport: "sms",
				direction: "inbound",
				status: "received",
				messageId: input.message?.id || event.providerMessageId,
				conversationId: input.phone?.threadTarget,
				channelId: input.phone?.threadTarget,
				displayName: input.phone?.displayName,
				from: input.sender,
				sender: "hostd",
				text: input.message?.body || "",
				...(input.operatorIntent ? { operatorIntent: input.operatorIntent } : {}),
				timestamp: input.message?.timestamp || event.receivedAt,
				hostContextId: event.contextId,
				deliveryId: event.id,
				hostReceipt: this.hostReceipt(target, event),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`phone runtime returned HTTP ${response.status}: ${text.slice(0, 200)}`);
		}
	}

	async deliverWebChatWebhook(target, context, event, input) {
		if (!this.config.webChat || !this.config.zulip || !context.zulip) {
			throw new Error("website chat event received without a Zulip binding");
		}
		const inboundToken = contextCapability(target.inboundToken, "zulip-inbound", context.contextId);
		const messageId = Number.parseInt(
			createHash("sha256").update(event.providerMessageId, "utf8").digest("hex").slice(0, 12),
			16,
		) + 1;
		const timestamp = Date.parse(input.message?.timestamp || event.receivedAt) / 1000;
		const response = await fetch(context.zulipEndpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${inboundToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				deliveryId: event.id,
				hostContextId: event.contextId,
				message: {
					id: messageId,
					type: "stream",
					stream_id: Number(context.zulip.channelId),
					display_recipient: context.zulip.channelName,
					sender_id: 2_147_483_647,
					sender_email: "website-visitor@example.com",
					sender_full_name: input.webChat?.displayName || input.sender || "Website visitor",
					sender_is_bot: false,
					subject: "",
					content: "",
					raw_content: input.message?.body || "",
					timestamp: Number.isFinite(timestamp) ? timestamp : Date.now() / 1000,
					is_mentioned: true,
				},
				hostReceipt: this.hostReceipt(target, event),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`website chat runtime returned HTTP ${response.status}: ${text.slice(0, 200)}`);
		}
	}

	async deliverScheduledPromptWebhook(target, context, event, input) {
		if (!hostOwnsScheduledWakes(this.config, event.contextId)) {
			throw new Error(`Hostd does not own schedules for context ${event.contextId}`);
		}
		const inboundToken = contextCapability(
			target.inboundToken,
			"scheduled-prompt-inbound",
			context.contextId,
		);
		const response = await fetch(context.scheduledPromptEndpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${inboundToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				deliveryId: event.id,
				hostContextId: event.contextId,
				schedule: input.schedule,
				event: input.event,
				hostReceipt: this.hostReceipt(target, event),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`scheduled prompt runtime returned HTTP ${response.status}: ${text.slice(0, 200)}`);
		}
	}

	async deliverMcpOperatorWebhook(target, context, event, input) {
		if (!this.mcp) throw new Error("MCP Operator delivery is unavailable");
		const { grant, relationship } = this.mcp.authorizeInstructionEvent(event, input);
		const inboundToken = this.mcp.operatorRuntimeToken(target, relationship);
		const relationshipScope = this.mcp.operatorRuntimeScope(relationship);
		const response = await fetch(context.relationshipOperatorEndpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${inboundToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				text: `Authenticated message from MCP connection ${JSON.stringify(grant.displayName)}:\n${input.message}`,
				relationshipScope,
				deliveryId: event.id,
				hostContextId: event.contextId,
				hostReceipt: this.hostReceipt(target, event),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`relationship Operator runtime returned HTTP ${response.status}: ${text.slice(0, 200)}`);
		}
	}

	async provisionOciContext(target, contextId) {
		let context = this.store.getContext(contextId);
		if (!context) {
			const port = this.store.nextAvailablePort(target.basePort, target.maxPort);
			context = this.store.createContext({
				id: contextId,
				targetId: target.id,
				driver: "oci",
				runtimeName: safeRuntimeName(contextId),
				port,
			});
		}
		const mattermost = this.mattermost ? await this.mattermost.ensureContext(contextId) : null;
		const rocketChat = this.rocketChat ? await this.rocketChat.ensureContext(contextId) : null;
		const zulip = this.zulip ? await this.zulip.ensureContext(contextId) : null;

		const workspace = contextWorkspacePath(target, contextId);
		const contextDirectory = dirname(workspace);
		if (!(await exists(workspace))) {
			await mkdir(contextDirectory, { recursive: true, mode: 0o700 });
			await cp(target.workspaceTemplate, workspace, {
				recursive: true,
				errorOnExist: true,
				preserveTimestamps: true,
			});
		}
		if (mattermost) {
			await initializeMattermostWorkingOutput(workspace, mattermost.channelId);
		}
		if (rocketChat) {
			await initializeChannelWorkingOutput(workspace, "rocket-chat", rocketChat.roomId);
		}
		if (zulip) {
			await initializeChannelWorkingOutput(
				workspace,
				"zulip",
				String(zulip.channelId),
				{ migrateFromPlatforms: ["mattermost", "rocket-chat"] },
			);
		}
		return { context, mattermost, rocketChat, zulip, contextDirectory, workspace };
	}

	async ensureOciContext(target, contextId) {
		const existing = this.contextStartupLocks.get(contextId);
		if (existing) return await existing;
		const startup = this.ensureOciContextUnlocked(target, contextId);
		this.contextStartupLocks.set(contextId, startup);
		try {
			return await startup;
		} finally {
			if (this.contextStartupLocks.get(contextId) === startup) {
				this.contextStartupLocks.delete(contextId);
			}
		}
	}

	async ensureOciContextUnlocked(target, contextId) {
		let {
			context,
			mattermost,
			rocketChat,
			zulip,
			contextDirectory,
			workspace,
		} = await this.provisionOciContext(target, contextId);
		if (this.sites) {
			try {
				await this.sites.ensureRelationshipFactory(target, contextId);
			} catch (error) {
				console.error(
					`troublemaker-hostd: relationship Sites custody unavailable for ${contextId}:`,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		const siteFactory = resolveSiteFactory(
			this.config,
			this.store,
			target,
			contextId,
			this.routingKey,
		);
		const runtimeModel = resolveContextRuntimeModel(
			this.config,
			this.store,
			this.routingKey,
			target,
			contextId,
		);
		const activeMcpRelationship = this.config.mcp && this.mcp
			? this.mcp.activeInboundRelationship(contextId)
			: null;
		const activeMcpOutboundConnections = this.config.mcp && this.mcp
			? this.mcp.activeOutboundConnections(contextId)
			: [];
		if (this.config.mcp) {
			await initializeHostMcpSettings(workspace, activeMcpOutboundConnections, {
				hostGateway: target.hostGateway,
				serverPort: this.config.server.port,
			});
		}
		const expectedRuntimeVersion = `${scheduledWakeRuntimeVersion(this.config, target, contextId)}${siteFactory ? ":sites-custody-v1" : ""}${this.config.webApp ? ":web-app-v1" : ""}${mcpRuntimeVersionSuffix(this.config, this.store, contextId)}${runtimeModelVersionSuffix(runtimeModel)}`;

		let inspect = await run(
			target.engine,
			["inspect", "--format", "{{.State.Running}}", context.runtimeName],
			{ allowFailure: true, timeout: 30_000 },
		);
		if (
			inspect.code === 0
			&& inspect.stdout.trim() === "true"
			&& context.runtimeVersion !== expectedRuntimeVersion
		) {
			console.log(
				`troublemaker-hostd: replacing ${contextId} runtime ${context.runtimeVersion || "unknown"} with ${expectedRuntimeVersion}`,
			);
			await this.stopOciContext(target, { ...context, contextId });
			this.pendingMcpRefresh.delete(contextId);
			inspect = { ...inspect, code: 1, stdout: "false" };
		}
		if (inspect.code !== 0 || inspect.stdout.trim() !== "true") {
			await this.evictForCapacity(target, contextId);
			this.store.updateContext(contextId, { status: "starting" });
			if (usesDockerEngine(target.engine)) {
				// Docker has no Podman-style --replace. Remove only this exact,
				// deterministic stopped runtime name before recreating it.
				await run(target.engine, ["rm", "--force", context.runtimeName], {
					allowFailure: true,
					timeout: 30_000,
				});
			}
			const envPath = join(contextDirectory, "runtime.env");
			const siteDeployments = siteDeploymentBindings(
				this.config,
				this.store,
				target,
				contextId,
				this.routingKey,
			);
			const scheduledWakesOwned = hostOwnsScheduledWakes(this.config, contextId);
			const env = {
				HOME: "/data",
				...(this.config.webApp ? {
					MOM_WEB_INPUT_TOKEN: contextCapability(target.inboundToken, "web-app", contextId),
				} : {}),
				...(this.config.gmail ? {
					MOM_EMAIL_INBOUND_TOKEN: contextCapability(target.inboundToken, "inbound", contextId),
					MOM_EMAIL_TOOLS_TOKEN: contextCapability(target.outboundToken, "outbound", contextId),
					MOM_EMAIL_SEND_URL: `http://${target.hostGateway}:${this.config.server.port}/v1/outbound/gmail`,
					MOM_EMAIL_TOOLS_ONLY: target.gmailToolsOnly ? "true" : "false",
				} : {}),
				TROUBLEMAKER_HOSTD_URL: `http://${target.hostGateway}:${this.config.server.port}`,
				TROUBLEMAKER_CONTEXT_ID: contextId,
				...(this.config.mcp ? {
					MOM_MCP_CONTROL_TOKEN: contextCapability(target.outboundToken, "mcp-control", contextId),
					MOM_MCP_OUTBOUND_TOKEN: contextCapability(target.outboundToken, "mcp-outbound", contextId),
				} : {}),
				...(activeMcpRelationship ? {
					MOM_OPERATOR_RELATIONSHIP_INBOUND_TOKEN: this.mcp.operatorRuntimeToken(
						target,
						activeMcpRelationship,
					),
					MOM_OPERATOR_RELATIONSHIP_SCOPE: JSON.stringify(
						this.mcp.operatorRuntimeScope(activeMcpRelationship),
					),
				} : {}),
				...(siteDeployments.length > 0 || siteFactory ? {
					MOM_SITE_DEPLOY_TOKEN: contextCapability(target.outboundToken, "site-deploy", contextId),
				} : {}),
				...(siteFactory ? { MOM_SITE_FACTORY_ENABLED: "1" } : {}),
				...(scheduledWakesOwned ? {
					MOM_HOSTD_SCHEDULE_OWNER: "host",
					MOM_SCHEDULED_PROMPT_INBOUND_TOKEN: contextCapability(
						target.inboundToken,
						"scheduled-prompt-inbound",
						contextId,
					),
				} : {}),
				...(mattermost ? {
					MOM_MATTERMOST_URL: `http://${target.hostGateway}:${this.config.server.port}/v1/mattermost/${encodeURIComponent(contextId)}`,
					MOM_MATTERMOST_BOT_TOKEN: contextCapability(target.outboundToken, "mattermost", contextId),
					MOM_MATTERMOST_INBOUND_TOKEN: contextCapability(target.inboundToken, "mattermost-inbound", contextId),
					MOM_MATTERMOST_ALLOWED_CHANNELS: mattermost.channelId,
					MOM_MATTERMOST_ALLOWED_DM_USERS: "",
					MOM_MATTERMOST_CHANNEL_MESSAGES_DIRECT: "true",
				} : {}),
				...(rocketChat ? {
					MOM_ROCKETCHAT_URL: `http://${target.hostGateway}:${this.config.server.port}/v1/rocketchat/${encodeURIComponent(contextId)}`,
					MOM_ROCKETCHAT_BOT_TOKEN: contextCapability(target.outboundToken, "rocketchat", contextId),
					MOM_ROCKETCHAT_INBOUND_TOKEN: contextCapability(target.inboundToken, "rocketchat-inbound", contextId),
					MOM_ROCKETCHAT_ALLOWED_ROOMS: rocketChat.roomId,
					MOM_ROCKETCHAT_AGENT_NAME: this.config.rocketChat.agentDisplayName,
				} : {}),
				...(zulip ? {
					MOM_ZULIP_URL: `http://${target.hostGateway}:${this.config.server.port}/v1/zulip/${encodeURIComponent(contextId)}`,
					MOM_ZULIP_BOT_TOKEN: contextCapability(target.outboundToken, "zulip", contextId),
					MOM_ZULIP_INBOUND_TOKEN: contextCapability(target.inboundToken, "zulip-inbound", contextId),
					MOM_ZULIP_ALLOWED_CHANNELS: String(zulip.channelId),
					MOM_ZULIP_AGENT_NAME: this.config.zulip.agentDisplayName,
				} : {}),
				...(this.config.phone ? {
					MOM_PHONE_HOST_MANAGED: "true",
					MOM_PHONE_DEFAULT_PROVIDER: "hostd",
					MOM_PHONE_INBOUND_TOKEN: contextCapability(
						target.inboundToken,
						"phone-inbound",
						contextId,
					),
					MOM_PHONE_SEND_URL: `http://${target.hostGateway}:${this.config.server.port}/v1/outbound/phone`,
					MOM_PHONE_SEND_TOKEN: contextCapability(
						target.outboundToken,
						"outbound",
						contextId,
					),
				} : {}),
				...target.runtimeEnv,
				...runtimeModelEnvironment(this.config, target, contextId, runtimeModel),
				TROUBLEMAKER_HOSTD_CONTAINER: "1",
			};
			await writePrivateFile(
				envPath,
				serializeRuntimeEnvironment(env),
			);
			const args = [
				"run",
				"--detach",
				"--name",
				context.runtimeName,
				...runtimeEngineRunFlags(target.engine),
				"--publish",
				`127.0.0.1:${context.port}:3002`,
				"--memory",
				target.memory,
				"--pids-limit",
				"512",
				"--cap-drop=all",
				"--security-opt=no-new-privileges",
				"--env-file",
				envPath,
				"--volume",
				`${workspace}:/data:rw`,
			];
			if (!target.immutableImage) {
				args.push("--volume", `${target.checkout}:/opt/troublemaker:ro`);
			}
			for (const [index, skillsPath] of target.skills.entries()) {
				args.push("--volume", `${skillsPath}:/opt/troublemaker-skills/${index}:ro`);
			}
			const adapters = [
				...(this.config.webApp ? ["web"] : []),
				...(this.config.gmail ? ["email:webhook"] : []),
				...(mattermost ? ["mattermost:webhook"] : []),
				...(rocketChat ? ["rocket-chat:webhook"] : []),
				...(zulip ? ["zulip:webhook"] : []),
				...(this.config.phone ? ["phone-messaging:webhook"] : []),
			];
			if (adapters.length === 0) throw new Error(`context ${contextId} has no configured adapters`);
			args.push(
				target.image,
				"node",
				"/opt/troublemaker/dist/main.js",
				"--sandbox=host",
				`--adapter=${adapters.join(",")}`,
				...target.skills.flatMap((_skillsPath, index) => [
					"--skills",
					`/opt/troublemaker-skills/${index}`,
				]),
				"--host=0.0.0.0",
				"--port=3002",
				"/data",
			);
			await run(target.engine, args, { timeout: 180_000 });
			this.store.updateContext(contextId, {
				status: "starting",
				lastStartedAt: new Date().toISOString(),
				runtimeVersion: expectedRuntimeVersion,
			});
		}

		const endpoint = `http://127.0.0.1:${context.port}/email/inbound`;
		await waitForHealth(`http://127.0.0.1:${context.port}/health`);
		this.store.updateContext(contextId, { status: "online", runtimeVersion: expectedRuntimeVersion });
		this.pendingMcpRefresh.delete(contextId);
		return {
			...this.store.getContext(contextId),
			contextId,
			endpoint,
			mattermostEndpoint: `http://127.0.0.1:${context.port}/mattermost/inbound`,
			rocketChatEndpoint: `http://127.0.0.1:${context.port}/rocketchat/inbound`,
			zulipEndpoint: `http://127.0.0.1:${context.port}/zulip/inbound`,
			zulip,
			phoneEndpoint: `http://127.0.0.1:${context.port}/phone-messaging/webhook`,
			scheduledPromptEndpoint: `http://127.0.0.1:${context.port}/scheduled-prompt/inbound`,
			relationshipOperatorEndpoint: `http://127.0.0.1:${context.port}/operator/relationship-message`,
			statusEndpoint: `http://127.0.0.1:${context.port}/status`,
		};
	}

	async evictForCapacity(target, requestedContextId) {
		const online = this.store.listContexts()
			.filter((context) => context.targetId === target.id && context.status === "online");
		if (online.length < this.config.scheduler.maxConcurrent) return;
		const candidate = online
			.filter((context) => (
				context.id !== requestedContextId
				&& !this.store.hasActiveEvent(context.id)
				&& !this.externalActivityProbe(context.id)
			))
			.sort((left, right) => Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt))[0];
		if (!candidate) throw new Error("all runtime slots are active");
		console.log(`troublemaker-hostd: evicting idle runtime ${candidate.id} for ${requestedContextId}`);
		await this.stopOciContext(target, { ...candidate, contextId: candidate.id });
	}

	async reconcileSiteRelationships() {
		if (!this.sites || !this.config.sites?.relationshipFactory) return;
		for (const context of this.store.listContexts()) {
			const target = this.config.targetsById.get(context.targetId);
			if (!target) continue;
			try {
				const factory = await this.sites.ensureRelationshipFactory(target, context.id);
				if (!factory || context.status !== "online") continue;
				await this.ensureOciContext(target, context.id);
			} catch (error) {
				console.error(
					`troublemaker-hostd: relationship Sites reconciliation failed for ${context.id}:`,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	}

	async reconcileScheduledWakeOwnership() {
		for (const context of this.store.listContexts()) {
			if (context.status !== "online") continue;
			const target = this.config.targetsById.get(context.targetId);
			if (!target) continue;
			const hostOwned = hostOwnsScheduledWakes(this.config, context.id);
			const siteFactory = resolveSiteFactory(
				this.config,
				this.store,
				target,
				context.id,
				this.routingKey,
			);
			const runtimeModel = resolveContextRuntimeModel(
				this.config,
				this.store,
				this.routingKey,
				target,
				context.id,
			);
			const expected = `${scheduledWakeRuntimeVersion(this.config, target, context.id)}${siteFactory ? ":sites-custody-v1" : ""}${this.config.webApp ? ":web-app-v1" : ""}${mcpRuntimeVersionSuffix(this.config, this.store, context.id)}${runtimeModelVersionSuffix(runtimeModel)}`;
			const wasHostOwned = context.runtimeVersion?.includes(":scheduled-host-v1") === true;
			if (context.runtimeVersion === expected || (!hostOwned && !wasHostOwned)) continue;
			await this.stopOciContext(target, { ...context, contextId: context.id });
			if (!hostOwned && wasHostOwned) {
				// Rollback to local ownership must restart an already-online runtime so
				// its historical in-process timers resume. Previously stopped contexts
				// remain stopped, preserving the pre-Hostd behavior.
				await this.ensureOciContext(target, context.id);
			}
		}
	}

	async refreshMcpContext(contextId) {
		const context = this.store.getContext(contextId);
		if (
			!context
			|| context.status !== "online"
			|| this.store.hasActiveEvent(contextId)
			|| this.externalActivityProbe(contextId)
		) {
			if (context?.status === "online") this.pendingMcpRefresh.add(contextId);
			return false;
		}
		const target = this.config.targetsById.get(context.targetId);
		if (!target) return false;
		await this.stopOciContext(target, { ...context, contextId });
		this.pendingMcpRefresh.delete(contextId);
		return true;
	}

	async reconcile() {
		for (const context of this.store.listContexts()) {
			const target = this.config.targetsById.get(context.targetId);
			if (!target) continue;
			const inspect = await run(
				target.engine,
				["inspect", "--format", "{{.State.Running}}", context.runtimeName],
				{ allowFailure: true, timeout: 30_000 },
			);
			const status = inspect.code === 0 && inspect.stdout.trim() === "true" ? "online" : "stopped";
			this.store.updateContext(context.id, { status, touch: false });
		}
	}

	async reapIdle() {
		const cutoff = Date.now() - this.config.scheduler.idleSeconds * 1000;
		for (const context of this.store.listContexts()) {
			if (
				context.status !== "online"
				|| this.store.hasActiveEvent(context.id)
				|| this.externalActivityProbe(context.id)
			) continue;
			if (this.pendingMcpRefresh.has(context.id)) {
				const target = this.config.targetsById.get(context.targetId);
				if (!target) continue;
				await this.stopOciContext(target, { ...context, contextId: context.id });
				this.pendingMcpRefresh.delete(context.id);
				console.log(`troublemaker-hostd: stopped runtime ${context.id} for MCP capability refresh`);
				continue;
			}
			if (Date.parse(context.lastSeenAt) > cutoff) continue;
			const target = this.config.targetsById.get(context.targetId);
			if (!target) continue;
			await this.stopOciContext(target, { ...context, contextId: context.id });
			console.log(`troublemaker-hostd: stopped idle runtime ${context.id}`);
		}
	}

	async stopOciContext(target, context) {
		const result = await run(target.engine, ["stop", "--time", "20", context.runtimeName], {
			allowFailure: true,
			timeout: 45_000,
		});
		if (result.code !== 0 && !/no such container/i.test(result.stderr)) {
			console.error(
				`troublemaker-hostd: failed to stop runtime ${context.runtimeName}: ${result.stderr.slice(0, 300)}`,
			);
			return;
		}
		this.store.updateContext(context.contextId, {
			status: "stopped",
			lastStoppedAt: new Date().toISOString(),
		});
	}
}
