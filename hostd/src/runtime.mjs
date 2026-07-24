import { spawn } from "node:child_process";
import { cp, mkdir, open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildEmailWebhookBody } from "./prompt.mjs";
import { contextCapability } from "./security.mjs";

function safeRuntimeName(contextId) {
	const normalized = contextId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/-+/g, "-");
	return `troublemaker-${normalized}`.slice(0, 63);
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

export async function initializeMattermostWorkingOutput(workspace, channelId) {
	if (!/^[a-z0-9]{26}$/.test(channelId)) {
		throw new Error("Mattermost working-output channel ID is invalid");
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
	// The room is the private Manny's initial work surface, but self_configure
	// remains authoritative after initialization.
	if (settings.workingOutput !== undefined) return false;
	settings.workingOutput = {
		mode: "fixed",
		target: { platform: "mattermost", channelId },
	};
	await writePrivateFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	return true;
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

export class RuntimeManager {
	constructor(config, store, mattermost) {
		this.config = config;
		this.store = store;
		this.mattermost = mattermost;
	}

	async deliver({ event, route, message, metadata, sender, thread }) {
		const target = this.config.targetsById.get(route.targetId);
		if (!target) throw new Error(`unknown target ${route.targetId}`);
		const context = await this.ensureOciContext(target, route.contextId);
		try {
			return await this.deliverEmailWebhook(target, context, { event, route, message, metadata, sender, thread });
		} finally {
			if (target.stopAfterTurn) await this.stopOciContext(target, context);
		}
	}

	async deliverEmailWebhook(target, context, input) {
		const inboundToken = contextCapability(target.inboundToken, "inbound", context.contextId);
		const response = await fetch(context.endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${inboundToken}`,
				"content-type": "application/json",
				"x-troublemaker-wait-for-completion": "1",
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
				deliveryId: input.event.id,
				hostContextId: input.route.contextId,
			}),
			signal: AbortSignal.timeout(10 * 60 * 1000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`email runtime returned HTTP ${response.status}: ${text.slice(0, 200)}`);
		}
	}

	async ensureOciContext(target, contextId) {
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
		const mattermost = this.mattermost
			? await this.mattermost.ensureContext(contextId)
			: null;

		const contextDirectory = resolve(target.contextsDirectory, contextId.replace(/[^a-z0-9_.-]/gi, "_"));
		const workspace = join(contextDirectory, "workspace");
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

		const inspect = await run(
			target.engine,
			["inspect", "--format", "{{.State.Running}}", context.runtimeName],
			{ allowFailure: true, timeout: 30_000 },
		);
		if (inspect.code !== 0 || inspect.stdout.trim() !== "true") {
			this.store.updateContext(contextId, { status: "starting" });
			const envPath = join(contextDirectory, "runtime.env");
			const env = {
				HOME: "/data",
				MOM_EMAIL_INBOUND_TOKEN: contextCapability(target.inboundToken, "inbound", contextId),
				MOM_EMAIL_TOOLS_TOKEN: contextCapability(target.outboundToken, "outbound", contextId),
				MOM_EMAIL_SEND_URL: `http://${target.hostGateway}:${this.config.server.port}/v1/outbound/gmail`,
				MOM_EMAIL_TOOLS_ONLY: target.gmailToolsOnly ? "true" : "false",
				TROUBLEMAKER_HOSTD_URL: `http://${target.hostGateway}:${this.config.server.port}`,
				TROUBLEMAKER_CONTEXT_ID: contextId,
				...(mattermost ? {
					MOM_MATTERMOST_URL: mattermost.runtimeUrl,
					MOM_MATTERMOST_BOT_TOKEN: mattermost.botToken,
					MOM_MATTERMOST_ALLOWED_CHANNELS: mattermost.channelId,
					MOM_MATTERMOST_ALLOWED_DM_USERS: "",
					MOM_MATTERMOST_CHANNEL_MESSAGES_DIRECT: "true",
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
				"--replace",
				"--name",
				context.runtimeName,
				"--userns=keep-id",
				"--network=slirp4netns:allow_host_loopback=true",
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
				`${target.checkout}:/opt/troublemaker:ro`,
				"--volume",
				`${workspace}:/data:rw`,
			];
			for (const [index, skillsPath] of target.skills.entries()) {
				args.push("--volume", `${skillsPath}:/opt/troublemaker-skills/${index}:ro`);
			}
			args.push(
				target.image,
				"node",
				"/opt/troublemaker/dist/main.js",
				"--sandbox=host",
				`--adapter=email:webhook${mattermost ? ",mattermost" : ""}`,
				...target.skills.flatMap((_skillsPath, index) => [
					"--skills",
					`/opt/troublemaker-skills/${index}`,
				]),
				"--host=0.0.0.0",
				"--port=3002",
				"/data",
			);
			await run(target.engine, args, { timeout: 180_000 });
		}

		const endpoint = `http://127.0.0.1:${context.port}/email/inbound`;
		await waitForHealth(`http://127.0.0.1:${context.port}/health`);
		this.store.updateContext(contextId, { status: "online" });
		return { ...context, contextId, endpoint };
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
		this.store.updateContext(context.contextId, { status: "stopped" });
	}
}
