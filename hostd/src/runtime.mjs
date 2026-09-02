import { spawn } from "node:child_process";
import { cp, mkdir, open, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { buildEmailWebhookBody } from "./prompt.mjs";
import { contextCapability } from "./security.mjs";
import { resolveSiteDeploymentBinding } from "./site-deployment-binding.mjs";

export function siteDeploymentBinding(config, store, target, contextId, routingKey) {
	return resolveSiteDeploymentBinding(config, store, target, contextId, routingKey);
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
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
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
	constructor(config, store, { mattermost, rocketChat, zulip, routingKey } = {}) {
		this.config = config;
		this.store = store;
		this.mattermost = mattermost;
		this.rocketChat = rocketChat;
		this.zulip = zulip;
		this.routingKey = routingKey;
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
		if (event.source === "scheduled-prompt") {
			await this.deliverScheduledPromptWebhook(target, context, event, payload);
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
				"x-tinyfat-hostd-verified": "true",
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
		let {
			context,
			mattermost,
			rocketChat,
			zulip,
			contextDirectory,
			workspace,
		} = await this.provisionOciContext(target, contextId);
		const expectedRuntimeVersion = scheduledWakeRuntimeVersion(this.config, target, contextId);

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
			const scheduledWakesOwned = hostOwnsScheduledWakes(this.config, contextId);
			const siteDeployment = siteDeploymentBinding(
				this.config,
				this.store,
				target,
				contextId,
				this.routingKey,
			);
			const env = {
				HOME: "/data",
				...(this.config.gmail ? {
					MOM_EMAIL_INBOUND_TOKEN: contextCapability(target.inboundToken, "inbound", contextId),
					MOM_EMAIL_TOOLS_TOKEN: contextCapability(target.outboundToken, "outbound", contextId),
					MOM_EMAIL_SEND_URL: `http://${target.hostGateway}:${this.config.server.port}/v1/outbound/gmail`,
					MOM_EMAIL_TOOLS_ONLY: target.gmailToolsOnly ? "true" : "false",
				} : {}),
				TROUBLEMAKER_HOSTD_URL: `http://${target.hostGateway}:${this.config.server.port}`,
				TROUBLEMAKER_CONTEXT_ID: contextId,
				...(scheduledWakesOwned ? {
					MOM_HOSTD_SCHEDULE_OWNER: "host",
					MOM_SCHEDULED_PROMPT_INBOUND_TOKEN: contextCapability(
						target.inboundToken,
						"scheduled-prompt-inbound",
						contextId,
					),
				} : {}),
				...(siteDeployment ? {
					MOM_SITE_DEPLOY_TOKEN: contextCapability(target.outboundToken, "site-deploy", contextId),
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
			};
			await writePrivateFile(
				envPath,
				`${Object.entries(env).map(([key, value]) => `${key}=${String(value).replaceAll("\n", "")}`).join("\n")}\n`,
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
		return {
			...this.store.getContext(contextId),
			contextId,
			endpoint,
			mattermostEndpoint: `http://127.0.0.1:${context.port}/mattermost/inbound`,
			rocketChatEndpoint: `http://127.0.0.1:${context.port}/rocketchat/inbound`,
			zulipEndpoint: `http://127.0.0.1:${context.port}/zulip/inbound`,
			phoneEndpoint: `http://127.0.0.1:${context.port}/phone-messaging/webhook`,
			scheduledPromptEndpoint: `http://127.0.0.1:${context.port}/scheduled-prompt/inbound`,
			statusEndpoint: `http://127.0.0.1:${context.port}/status`,
		};
	}

	async evictForCapacity(target, requestedContextId) {
		const online = this.store.listContexts()
			.filter((context) => context.targetId === target.id && context.status === "online");
		if (online.length < this.config.scheduler.maxConcurrent) return;
		const candidate = online
			.filter((context) => context.id !== requestedContextId && !this.store.hasActiveEvent(context.id))
			.sort((left, right) => Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt))[0];
		if (!candidate) throw new Error("all runtime slots are active");
		console.log(`troublemaker-hostd: evicting idle runtime ${candidate.id} for ${requestedContextId}`);
		await this.stopOciContext(target, { ...candidate, contextId: candidate.id });
	}

	async reconcileScheduledWakeOwnership() {
		for (const context of this.store.listContexts()) {
			if (context.status !== "online") continue;
			const target = this.config.targetsById.get(context.targetId);
			if (!target) continue;
			const hostOwned = hostOwnsScheduledWakes(this.config, context.id);
			const expected = scheduledWakeRuntimeVersion(this.config, target, context.id);
			const wasHostOwned = context.runtimeVersion?.endsWith(":scheduled-host-v1") === true;
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
			if (context.status !== "online" || this.store.hasActiveEvent(context.id)) continue;
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
