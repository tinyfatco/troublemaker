/**
 * Slash command handler for troublemaker.
 *
 * Intercepts /model (and future commands) at the handler level
 * before the message reaches the agent loop.
 */

import { spawn } from "child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import type { PlatformAdapter, SlashCommandResult } from "./adapters/types.js";
import type { AgentRunner } from "./agent.js";
import { findModel, getCurrentModelSelection, listModels, resolveModel } from "./model-config.js";
import {
	DEFAULT_REALTIME_VOICE,
	formatRealtimeVoiceList,
	normalizeRealtimeVoiceName,
	realtimeVoiceDescription,
} from "./realtime-voices.js";
import * as log from "./log.js";
import { formatUsageSummary, formatTokens } from "./log.js";
import type { AuthEvent, AuthPrompt, Credential } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Pending input — when a command needs the user's next message (e.g. /login),
 * it registers a resolver here. handleEvent checks this before processing.
 */
interface PendingInput {
	resolve: (text: string) => void;
	reject: (err: Error) => void;
}

const pendingInput = new Map<string, PendingInput>();


const GOOGLE_LOGIN_ALIASES = new Set(["google", "gog", "gogcli"]);
const GOG_DEFAULT_SERVICES = "gmail,calendar,drive,contacts,docs,sheets";
const GOG_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const GOG_COMMAND_TIMEOUT_MS = 60 * 1000;
const DEFAULT_GOG_KEYRING_PASSWORD = "";

function handled(pending?: Promise<void>): SlashCommandResult {
	return pending ? { handled: true, pending } : true;
}

/**
 * Check if a channel has a pending input request.
 * If so, resolve it with the given text and return true.
 */
export function resolvePendingInput(channelId: string, text: string): boolean {
	const pending = pendingInput.get(channelId);
	if (pending) {
		const trimmed = text.trim();
		const lower = trimmed.toLowerCase();
		if (trimmed.startsWith("/") && lower !== "/cancel") {
			return false;
		}
		pendingInput.delete(channelId);
		if (lower === "/cancel") {
			pending.reject(new Error("Cancelled"));
		} else {
			pending.resolve(text);
		}
		return true;
	}
	return false;
}

export function cancelPendingInput(channelId: string): boolean {
	const pending = pendingInput.get(channelId);
	if (!pending) return false;
	pendingInput.delete(channelId);
	pending.reject(new Error("Cancelled"));
	return true;
}

export function hasPendingInput(channelId: string): boolean {
	return pendingInput.has(channelId);
}

/**
 * Wait for the user's next message on a channel.
 * Returns a promise that resolves with the message text.
 */
function waitForInput(channelId: string): Promise<string> {
	return new Promise((resolve, reject) => {
		pendingInput.set(channelId, { resolve, reject });
	});
}


function waitForInputWithTimeout(channelId: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingInput.delete(channelId);
			reject(new Error("Login timed out. Try /login google again."));
		}, timeoutMs);

		waitForInput(channelId).then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

function appendOutput(current: string, chunk: Buffer | string): string {
	const next = current + chunk.toString();
	return next.length > 20_000 ? next.slice(-20_000) : next;
}

function runCommand(
	command: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { env: options.env });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};

		timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish({
				code: null,
				stdout,
				stderr: appendOutput(stderr, `Timed out after ${options.timeoutMs ?? GOG_COMMAND_TIMEOUT_MS}ms`),
			});
		}, options.timeoutMs ?? GOG_COMMAND_TIMEOUT_MS);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = appendOutput(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendOutput(stderr, chunk);
		});
		child.on("error", (error) => {
			finish({ code: null, stdout, stderr: appendOutput(stderr, error.message), error });
		});
		child.on("close", (code) => {
			finish({ code, stdout, stderr });
		});
	});
}

function runGog(args: string[], timeoutMs = GOG_COMMAND_TIMEOUT_MS): Promise<CommandResult> {
	return runCommand(process.env.GOG_CLI_PATH || "gog", args, {
		timeoutMs,
		env: {
			...process.env,
			GOG_KEYRING_BACKEND: process.env.GOG_KEYRING_BACKEND || "file",
			GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || DEFAULT_GOG_KEYRING_PASSWORD,
		},
	});
}

function commandNotFound(result: CommandResult): boolean {
	const code = result.error && "code" in result.error ? String((result.error as NodeJS.ErrnoException).code) : "";
	return code === "ENOENT";
}

function redactOAuthDetails(text: string): string {
	return text
		.replace(/([?&]code=)[^&\s]+/gi, "$1[redacted]")
		.replace(/([?&]state=)[^&\s]+/gi, "$1[redacted]");
}

function gogFailureMessage(action: string, result: CommandResult): string {
	if (commandNotFound(result)) return "`gog` is not installed in this container yet.";
	const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
	return detail ? `${action}: ${redactOAuthDetails(detail)}` : action;
}

function parseJsonObject(output: string, action: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(output);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// Fall through to the formatted error below.
	}
	throw new Error(`${action}: gog returned invalid JSON`);
}

/** Write a system action to context.jsonl so it shows in the awareness stream. */
function logSystemAction(workingDir: string, channelLabel: string, text: string): void {
	const contextFile = join(workingDir, "awareness", "context.jsonl");
	const entry = {
		type: "message",
		id: randomUUID().substring(0, 8),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text: `[${new Date().toISOString()}] [${channelLabel}] [system]: ${text}` }],
		},
	};
	try {
		appendFileSync(contextFile, JSON.stringify(entry) + "\n");
	} catch {
		// awareness dir may not exist yet on first boot
	}
}

/**
 * Handle a slash command. Returns true if the command was handled.
 */
export async function handleSlashCommand(
	text: string,
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
	runner?: AgentRunner,
): Promise<SlashCommandResult> {
	const parts = text.trim().split(/\s+/);
	const cmd = parts[0].toLowerCase();

	switch (cmd) {
		case "/model":
			await handleModelCommand(parts.slice(1), channelId, workingDir, platform);
			return true;
		case "/voice":
			await handleVoiceCommand(parts.slice(1), channelId, workingDir, platform);
			return true;
		case "/context":
			await handleContextCommand(channelId, platform, runner);
			return true;
		case "/compact":
			await handleCompactCommand(parts.slice(1), channelId, workingDir, platform, runner);
			return true;
		case "/clear":
			await handleClearCommand(channelId, platform, runner);
			return true;
		case "/login":
			return handleLoginCommand(parts.slice(1), channelId, workingDir, platform);
		case "/cancel":
			await handleCancelCommand(channelId, platform);
			return handled();
		default:
			return false;
	}
}

async function handleModelCommand(
	args: string[],
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
): Promise<void> {
	// /model (no args) — show current model
	if (args.length === 0) {
		const model = getCurrentModelSelection(workingDir);

		let response = `*Current model:* ${model.provider}/${model.id}\n\n`;
		response += `Use \`/model <name>\` to switch. Examples:\n`;
		response += `\`/model claude-sonnet-4-6\`\n`;
		response += `\`/model gptfive\`\n`;
		response += `\`/model anthropic/claude-opus-4-6\`\n`;

		await platform.postMessage(channelId, response);
		return;
	}

	// /model list — show all available models
	if (args[0] === "list") {
		const models = listModels(workingDir);
		const currentModel = resolveModel(workingDir);

		const byProvider = new Map<string, typeof models>();
		for (const m of models) {
			const list = byProvider.get(m.provider) || [];
			list.push(m);
			byProvider.set(m.provider, list);
		}

		let response = `*Available models:*\n`;
		for (const [provider, providerModels] of byProvider) {
			response += `\n*${provider}:*\n`;
			for (const m of providerModels.slice(0, 10)) {
				const current = m.provider === currentModel.provider && m.id === currentModel.id ? " ← current" : "";
				response += `  ${m.id}${current}\n`;
			}
			if (providerModels.length > 10) {
				response += `  _(${providerModels.length - 10} more)_\n`;
			}
		}

		await platform.postMessage(channelId, response);
		return;
	}

	// /model <query> — switch model
	const query = args.join(" ");
	const match = findModel(query, workingDir);

	if (!match) {
		await platform.postMessage(
			channelId,
			`Model not found: "${query}"\n\nUse \`/model list\` to see available models.`,
		);
		return;
	}

	// Write to settings.json
	const settingsPath = join(workingDir, "settings.json");
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			// Start fresh
		}
	}

	settings.defaultProvider = match.provider;
	settings.defaultModel = match.id;
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

	log.logInfo(`Model switched to ${match.provider}/${match.id} via /model command`);
	logSystemAction(workingDir, "system", `/model → ${match.provider}/${match.id}`);
	await platform.postMessage(
		channelId,
		`Switched to *${match.provider}/${match.id}*\n_(takes effect on next message)_`,
	);
}

async function handleVoiceCommand(
	args: string[],
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
): Promise<void> {
	const settings = readSettingsJson(workingDir);
	const currentVoice = currentRealtimeVoice(settings);
	const subcommand = args[0]?.toLowerCase();

	if (!subcommand || subcommand === "list" || subcommand === "available") {
		await platform.postMessage(channelId, formatRealtimeVoiceList(currentVoice));
		return;
	}

	const nextVoice = normalizeRealtimeVoiceName(subcommand);
	if (!nextVoice) {
		await platform.postMessage(
			channelId,
			`Unknown voice: "${args[0]}"\n\n${formatRealtimeVoiceList(currentVoice)}`,
		);
		return;
	}

	settings.realtimeVoice = nextVoice;
	writeSettingsJson(workingDir, settings);
	log.logInfo(`Realtime voice switched to ${nextVoice} via /voice command`);
	logSystemAction(workingDir, "system", `/voice -> ${nextVoice}`);

	const description = realtimeVoiceDescription(nextVoice);
	await platform.postMessage(
		channelId,
		`Switched Realtime voice to *${nextVoice}*${description ? ` - ${description}` : ""}\n_(takes effect on the next Realtime voice session)_`,
	);
}

function currentRealtimeVoice(settings: Record<string, unknown>): string {
	return normalizeRealtimeVoiceName(settings.realtimeVoice) || DEFAULT_REALTIME_VOICE;
}

function readSettingsJson(workingDir: string): Record<string, unknown> {
	const settingsPath = join(workingDir, "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function writeSettingsJson(workingDir: string, settings: Record<string, unknown>): void {
	const settingsPath = join(workingDir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

async function handleContextCommand(
	channelId: string,
	platform: PlatformAdapter,
	runner?: AgentRunner,
): Promise<void> {
	if (!runner) {
		await platform.postMessage(channelId, "_No runner available_");
		return;
	}

	const info = runner.getContextInfo();

	const lines = [
		`*Context*`,
		`Model: ${info.provider}/${info.model}`,
		`Window: ${formatTokens(info.contextTokens)} / ${formatTokens(info.contextWindow)} (${info.contextPercent.toFixed(1)}%)`,
		`Messages: ${info.messageCount}`,
	];

	if (info.usage) {
		lines.push("");
		lines.push(formatUsageSummary(info.usage, info.contextTokens, info.contextWindow));
	}

	await platform.postMessage(channelId, lines.join("\n"));
}

async function handleCompactCommand(
	args: string[],
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
	runner?: AgentRunner,
): Promise<void> {
	if (!runner) {
		await platform.postMessage(channelId, "_No runner available_");
		return;
	}

	await platform.postMessage(channelId, "_Compacting context..._");

	try {
		const instructions = args.length > 0 ? args.join(" ") : undefined;
		const result = await runner.compact(instructions);

		logSystemAction(workingDir, "system", `/compact ${result.messagesBefore} → ${result.messagesAfter} messages (${formatTokens(result.tokensBefore)} tokens summarized)`);
		await platform.postMessage(
			channelId,
			`_Compacted: ${result.messagesBefore} → ${result.messagesAfter} messages (${formatTokens(result.tokensBefore)} tokens summarized)_`,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await platform.postMessage(channelId, `_Compact failed: ${msg}_`);
	}
}

async function handleClearCommand(
	channelId: string,
	platform: PlatformAdapter,
	runner?: AgentRunner,
): Promise<void> {
	if (!runner) {
		await platform.postMessage(channelId, "_No runner available_");
		return;
	}

	try {
		const result = await runner.clear();
		await platform.postMessage(
			channelId,
			`_Context cleared (${result.messagesCleared} messages archived)_`,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await platform.postMessage(channelId, `_Clear failed: ${msg}_`);
	}
}


interface PlatformCredentialPersistenceOptions {
	credential?: Credential;
	providerId: string;
	secretKey: string;
	toolsToken: string;
	authPath?: string;
	fetchImpl?: typeof fetch;
}

type PlatformCredentialPersistenceResult =
	| { ok: true; status: number }
	| { ok: false; reason: "missing_credential" | "http_error"; status?: number };

function isAuthData(value: unknown): value is Record<string, Credential> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function readExistingAuthData(authPath: string): Record<string, Credential> {
	if (!existsSync(authPath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as unknown;
		return isAuthData(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function stripCredentialType(credential: Credential): Record<string, unknown> {
	const { type: _type, ...rawCredential } = credential;
	return rawCredential as Record<string, unknown>;
}

/**
 * Rewrites auth.json from the credential returned by ModelRuntime.login().
 * This also repairs a malformed auth file that would otherwise block future
 * credential hydration.
 */
export function normalizeLoginCredentialFile(
	credential: Credential | undefined,
	providerId: string,
	authPath = join(getAgentDir(), "auth.json"),
): Credential | undefined {
	if (!credential) return undefined;

	const authData = readExistingAuthData(authPath);
	authData[providerId] = credential;

	mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
	writeFileSync(authPath, `${JSON.stringify(authData, null, 2)}\n`, "utf-8");
	chmodSync(authPath, 0o600);

	return credential;
}

export async function persistLoginCredentialToPlatform({
	credential,
	providerId,
	secretKey,
	toolsToken,
	authPath,
	fetchImpl = fetch,
}: PlatformCredentialPersistenceOptions): Promise<PlatformCredentialPersistenceResult> {
	const normalizedCredential = normalizeLoginCredentialFile(credential, providerId, authPath);
	if (!normalizedCredential) {
		return { ok: false, reason: "missing_credential" };
	}

	const rawCredential = stripCredentialType(normalizedCredential);
	const resp = await fetchImpl("https://tinyfat.com/api/agent/secrets", {
		method: "PATCH",
		headers: {
			"Authorization": `Bearer ${toolsToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ [secretKey]: JSON.stringify(rawCredential) }),
	});

	if (!resp.ok) {
		return { ok: false, reason: "http_error", status: resp.status };
	}

	return { ok: true, status: resp.status };
}

async function handleLoginCommand(
	args: string[],
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
): Promise<SlashCommandResult> {
	const migratedHostdOpenAi = process.env.TROUBLEMAKER_HOSTD_OPENAI_MIGRATED === "1";
	const requestedProvider = args[0]?.toLowerCase();
	if (migratedHostdOpenAi && requestedProvider === "openai-codex") {
		await platform.postMessage(
			channelId,
			"OpenAI subscription login is disabled for this organization-billed relationship.",
		);
		return handled();
	}
	const authPath = join(getAgentDir(), "auth.json");
	const modelRuntime = await ModelRuntime.create({ authPath, allowModelNetwork: false });
	const providers = modelRuntime.getProviders()
		.filter((provider) => (
			provider.auth.oauth !== undefined
			&& (!migratedHostdOpenAi || provider.id !== "openai-codex")
		))
		.map((provider) => ({
			id: provider.id,
			name: provider.auth.oauth?.name || provider.name,
		}));

	if (hasPendingInput(channelId)) {
		await platform.postMessage(channelId, "_Input is already pending. Paste the callback URL, or send `/cancel`._");
		return handled();
	}

	if (args.length === 0) {
		// List available providers and their auth status
		let response = "*Available login providers:*\n\n";
		for (const p of providers) {
			const hasAuth = modelRuntime.getProviderAuthStatus(p.id).configured;
			const status = hasAuth ? "✓ logged in" : "✗ not logged in";
			response += `  \`${p.id}\` — ${p.name} (${status})\n`;
		}
		response += await googleLoginProviderLine();
		response += migratedHostdOpenAi
			? `\nUse \`/login <provider>\` to log in. Example: \`/login google you@example.com\``
			: `\nUse \`/login <provider>\` to log in. Examples: \`/login openai-codex\`, \`/login google you@example.com\``;
		await platform.postMessage(channelId, response);
		return handled();
	}

	const providerId = args[0].toLowerCase();
	if (GOOGLE_LOGIN_ALIASES.has(providerId)) return handleGoogleLoginCommand(args.slice(1), channelId, workingDir, platform);
	const provider = providers.find((p) => p.id === providerId);

	if (!provider) {
		const available = [...providers.map((p) => `\`${p.id}\``), "`google`"].join(", ");
		await platform.postMessage(
			channelId,
			`Unknown provider: "${providerId}"\n\nAvailable: ${available}`,
		);
		return handled();
	}

	await platform.postMessage(channelId, `_Starting ${provider.name} login..._`);

	// Most adapters treat this as fire-and-forget so their inbound queues stay
	// open. The web adapter can keep its SSE writer attached by awaiting the
	// returned pending promise.
	const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
	const pending = (async () => {
		try {
			let notificationQueue = Promise.resolve();
			const queueNotification = (event: AuthEvent): void => {
				notificationQueue = notificationQueue.then(async () => {
					if (event.type === "auth_url") {
						let msg = `*Open this URL in your browser:*\n\n${event.url}\n\n`;
						if (event.instructions) msg += `${event.instructions}\n\n`;
						msg += "After authorizing, copy the full callback URL from your browser and paste it here if prompted.";
						await platform.postMessage(channelId, msg);
						return;
					}
					if (event.type === "device_code") {
						let msg = `*Device code login:*\n\nOpen this URL in your browser:\n${event.verificationUri}\n\nEnter code: \`${event.userCode}\``;
						if (event.expiresInSeconds) msg += `\n\nCode expires in ${Math.round(event.expiresInSeconds / 60)} minutes.`;
						await platform.postMessage(channelId, msg);
						return;
					}
					let msg = event.type === "progress" ? `_${event.message}_` : event.message;
					if (event.type === "info" && event.links?.length) {
						msg += `\n${event.links.map((link) => link.label ? `${link.label}: ${link.url}` : link.url).join("\n")}`;
					}
					await platform.postMessage(channelId, msg);
				});
			};
			const promptForAuth = async (prompt: AuthPrompt): Promise<string> => {
				await notificationQueue;
				if (prompt.signal?.aborted) throw new Error("Login prompt was cancelled");
				if (prompt.type === "secret") {
					throw new Error("Secret entry is disabled in chat. Configure API credentials through the protected secret flow.");
				}
				if (prompt.type === "select") {
					const options = prompt.options
						.map((option, index) => `${index + 1}. \`${option.id}\` — ${option.label}`)
						.join("\n");
					await platform.postMessage(channelId, `${prompt.message}\n\n${options}\n\nReply with an option id or number.`);
					const input = (await waitForInput(channelId)).trim();
					const numeric = Number(input);
					if (Number.isInteger(numeric) && numeric >= 1 && numeric <= prompt.options.length) {
						return prompt.options[numeric - 1].id;
					}
					const selected = prompt.options.find((option) => option.id.toLowerCase() === input.toLowerCase());
					if (selected) return selected.id;
					throw new Error(`Unknown login selection: ${input || "(empty)"}`);
				}
				await platform.postMessage(channelId, prompt.message);
				return waitForInput(channelId);
			};

			const abortController = new AbortController();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					abortController.abort();
					reject(new Error("Login timed out (5 min). Try /login again."));
				}, LOGIN_TIMEOUT_MS);
			});
			const loginPromise = modelRuntime.login(providerId, "oauth", {
				signal: abortController.signal,
				prompt: promptForAuth,
				notify: queueNotification,
			});
			const credential = await Promise.race([loginPromise, timeoutPromise]).finally(() => {
				if (timeout) clearTimeout(timeout);
			});
			await notificationQueue;

			// Login succeeded and ModelRuntime updated auth.json.
			// Now persist to platform secrets so it survives container restart.
			// Maps provider IDs to the platform hydrator's protected file rules.
			const secretKeyMap: Record<string, string> = {
				"openai-codex": "codex_credentials",
			};
			const secretKey = secretKeyMap[providerId];
			const toolsToken = process.env.FAT_TOOLS_TOKEN;
			if (toolsToken && secretKey) {
				try {
					const result = await persistLoginCredentialToPlatform({
						credential,
						providerId,
						secretKey,
						toolsToken,
					});
					if (result.ok) {
						log.logInfo(`[/login] Credentials for ${providerId} persisted to platform`);
					} else if (result.reason === "http_error") {
						log.logWarning(`[/login] Failed to persist credentials: ${result.status}`);
						await platform.postMessage(
							channelId,
							`⚠ Logged in but failed to persist credentials (${result.status}). They may be lost on container restart.`,
						);
					} else {
						log.logWarning(`[/login] No credentials found for ${providerId} after login`);
					}
				} catch (persistErr) {
					const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
					log.logWarning(`[/login] Credential persistence failed: ${msg}`);
					await platform.postMessage(
						channelId,
						`⚠ Logged in but failed to persist credentials. They may be lost on container restart.`,
					);
				}
			} else {
				log.logInfo(`[/login] No FAT_TOOLS_TOKEN — skipping platform persistence`);
			}

			logSystemAction(workingDir, "system", `/login ${providerId} — success`);
			await platform.postMessage(channelId, `✓ Logged in to *${provider.name}*`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[/login] Login failed for ${providerId}: ${msg}`);
			pendingInput.delete(channelId); // Clean up any dangling resolver
			await platform.postMessage(channelId, `_Login failed: ${msg}_`);
		}
	})();
	return handled(pending);
}


async function googleLoginProviderLine(): Promise<string> {
	const result = await runGog(["--version"], 5_000);
	const status = result.code === 0 ? "available" : "not installed";
	return `  \`google\` — Google Workspace via gog (${status})\n`;
}

function normalizeGoogleServices(raw?: string): string {
	const services = (raw || "").trim().replace(/\s+/g, "");
	return services || GOG_DEFAULT_SERVICES;
}

function looksLikeEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function looksLikeRedirectUrl(value: string): boolean {
	return /^https?:\/\//i.test(value) && /[?&]code=/.test(value);
}

async function handleGoogleLoginCommand(
	args: string[],
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
): Promise<SlashCommandResult> {
	const pending = (async () => {
		try {
			let email = (args[0] || "").trim();
			const services = normalizeGoogleServices(args[1]);

			if (!email) {
				await platform.postMessage(channelId, "*Google Workspace login*\n\nReply with the Google email address to authorize, or send `/cancel`.");
				email = (await waitForInputWithTimeout(channelId, GOG_LOGIN_TIMEOUT_MS)).trim().split(/\s+/)[0] || "";
			}

			if (!looksLikeEmail(email)) {
				throw new Error(`Invalid Google email address: ${email || "(empty)"}`);
			}

			await platform.postMessage(channelId, `_Starting Google Workspace login for ${email}..._`);

			const credentialsResult = await runGog(["--json", "--no-input", "auth", "credentials", "list"]);
			if (credentialsResult.code !== 0) {
				throw new Error(gogFailureMessage("Could not inspect Google OAuth client credentials", credentialsResult));
			}

			const credentialsJson = parseJsonObject(credentialsResult.stdout, "Could not inspect Google OAuth client credentials");
			const clients = credentialsJson.clients;
			if (!Array.isArray(clients) || clients.length === 0) {
				await platform.postMessage(
					channelId,
					[
						"*Google OAuth client credentials are not configured yet.*",
						"",
						"Store a Desktop OAuth client JSON at `/data/.config/gogcli/credentials.json`, or run:",
						"`gog auth credentials set /path/to/client_secret.json`",
						"",
						"Then retry `/login google you@example.com`.",
					].join("\n"),
				);
				return;
			}

			const step1 = await runGog([
				"--json",
				"--no-input",
				"auth",
				"add",
				email,
				"--services",
				services,
				"--remote",
				"--step",
				"1",
				"--force-consent",
			]);
			if (step1.code !== 0) throw new Error(gogFailureMessage("Could not start Google login", step1));

			const step1Json = parseJsonObject(step1.stdout, "Could not start Google login");
			const authUrl = typeof step1Json.auth_url === "string" ? step1Json.auth_url.trim() : "";
			if (!authUrl) throw new Error("Could not start Google login: gog did not return an auth_url");

			await platform.postMessage(
				channelId,
				`*Open this Google authorization URL:*\n\n${authUrl}\n\nRequested services: \`${services}\`\n\nAfter authorizing, your browser will redirect to a \`localhost\` URL that may not load. Copy the *full URL* from your browser's address bar and paste it here.`,
			);

			const callbackUrl = (await waitForInputWithTimeout(channelId, GOG_LOGIN_TIMEOUT_MS)).trim();
			if (!looksLikeRedirectUrl(callbackUrl)) {
				throw new Error("Expected the full Google redirect URL with a code parameter.");
			}

			await platform.postMessage(channelId, "_Finishing Google Workspace login..._");
			const step2 = await runGog([
				"--json",
				"--no-input",
				"auth",
				"add",
				email,
				"--services",
				services,
				"--remote",
				"--step",
				"2",
				"--force-consent",
				"--auth-url",
				callbackUrl,
			], GOG_LOGIN_TIMEOUT_MS);
			if (step2.code !== 0) throw new Error(gogFailureMessage("Could not finish Google login", step2));

			logSystemAction(workingDir, "system", `/login google ${email} — success`);
			await platform.postMessage(channelId, `✓ Logged in to *Google Workspace* as ${email}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[/login google] Login failed: ${redactOAuthDetails(msg)}`);
			pendingInput.delete(channelId);
			await platform.postMessage(channelId, `_Google login failed: ${redactOAuthDetails(msg)}_`);
		}
	})();
	return handled(pending);
}

async function handleCancelCommand(channelId: string, platform: PlatformAdapter): Promise<void> {
	if (cancelPendingInput(channelId)) {
		await platform.postMessage(channelId, "_Cancelled pending input_");
	} else {
		await platform.postMessage(channelId, "_Nothing to cancel_");
	}
}
