import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { textToSpeech } from "../adapters/voice-tts.js";
import {
	beginAssistantSpeech,
	estimateSpeechActiveMs,
	finishAssistantSpeech,
	holdAssistantSpeech,
} from "../audio-feedback-guard.js";
import type { MomSettings, MomSpeakBackend, MomSpeakSettings } from "../context.js";
import {
	SpeechOutputCoordinator,
	type SpeechOutputExecution,
	type SpeechOutputReceipt,
} from "../speech-output-coordinator.js";
import * as log from "../log.js";

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";
const DEFAULT_SAG_COMMAND = "/opt/homebrew/bin/sag";
const DEFAULT_SAG_MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_SAG_SHELL = "/bin/zsh";

const speakToolSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're saying" }),
	show: Type.Optional(Type.Boolean({ description: "Surface this safe label only when it is a meaningful progress milestone. Default false." })),
	text: Type.String({ description: "Short text to speak aloud through the configured local TTS backend" }),
	interrupt: Type.Optional(Type.Boolean({ description: "Stop any in-progress speech before speaking this text" })),
});

export interface ResolvedSpeakConfig {
	enabled: boolean;
	backend: MomSpeakBackend;
	maxChars: number;
	macosSay: {
		voice?: string;
		rate?: number;
	};
	command?: string;
	http?: {
		url: string;
		headers: Record<string, string>;
	};
	sag: {
		command: string;
		modelId: string;
		shell: string;
	};
	elevenlabs?: {
		apiKey?: string;
		voiceId: string;
		modelId?: string;
		outputFormat: string;
		playerCommand: string;
	};
}

export interface SpeakToolOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	laneId?: string;
}

const speechOutputCoordinators = new Map<string, SpeechOutputCoordinator>();

export function speechOutputLaneId(workspaceDir: string, options: SpeakToolOptions = {}): string {
	if (options.laneId?.trim()) return options.laneId.trim();
	const resolvedWorkspace = resolve(workspaceDir);
	let canonicalWorkspace = resolvedWorkspace;
	try {
		canonicalWorkspace = realpathSync.native(resolvedWorkspace);
	} catch {
		// A not-yet-created workspace still receives a stable absolute lane id.
	}
	return `${canonicalWorkspace}::speak`;
}

export function getSpeechOutputCoordinator(
	workspaceDir: string,
	options: SpeakToolOptions = {},
): SpeechOutputCoordinator {
	const laneId = speechOutputLaneId(workspaceDir, options);
	let coordinator = speechOutputCoordinators.get(laneId);
	if (!coordinator) {
		coordinator = new SpeechOutputCoordinator(laneId);
		speechOutputCoordinators.set(laneId, coordinator);
	}
	return coordinator;
}

export async function shutdownSpeechOutputCoordinators(reason = "runtime_shutdown"): Promise<void> {
	const coordinators = [...speechOutputCoordinators.values()];
	await Promise.allSettled(coordinators.map((coordinator) => coordinator.shutdown(reason)));
	for (const [laneId, coordinator] of speechOutputCoordinators) {
		if (coordinators.includes(coordinator)) speechOutputCoordinators.delete(laneId);
	}
}

export async function resetSpeechOutputCoordinatorsForTests(): Promise<void> {
	await shutdownSpeechOutputCoordinators("test_reset");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function readSettings(workspaceDir: string): MomSettings {
	const settingsPath = join(workspaceDir, "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		return JSON.parse(readFileSync(settingsPath, "utf-8")) as MomSettings;
	} catch {
		return {};
	}
}

function stringSetting(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberSetting(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function booleanSetting(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
	}
	return undefined;
}

function normalizeBackend(value: unknown): MomSpeakBackend | undefined {
	const normalized = stringSetting(value)?.toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "say") return "macos-say";
	if (normalized === "macos" || normalized === "macos_say") return "macos-say";
	if (normalized === "none" || normalized === "off") return "disabled";
	if (["macos-say", "command", "http", "elevenlabs", "sag", "noop", "disabled"].includes(normalized)) {
		return normalized as MomSpeakBackend;
	}
	return undefined;
}

function headerMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const headers: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		const header = stringSetting(raw);
		if (header) headers[key] = header;
	}
	return headers;
}

function resolveHttpHeaders(settings: MomSpeakSettings, env: NodeJS.ProcessEnv): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...headerMap(settings.headers),
	};

	const token = stringSetting(env.MOM_SPEAK_TOKEN)
		?? (settings.tokenEnv ? stringSetting(env[settings.tokenEnv]) : undefined)
		?? stringSetting(settings.token);
	if (!token) return headers;

	const tokenHeader = stringSetting(env.MOM_SPEAK_TOKEN_HEADER)
		?? stringSetting(settings.tokenHeader)
		?? "Authorization";
	const tokenPrefix = stringSetting(env.MOM_SPEAK_TOKEN_PREFIX)
		?? stringSetting(settings.tokenPrefix)
		?? (tokenHeader.toLowerCase() === "authorization" ? "Bearer " : "");
	headers[tokenHeader] = `${tokenPrefix}${token}`;
	return headers;
}

function resolveElevenLabsConfig(settings: MomSpeakSettings, env: NodeJS.ProcessEnv): ResolvedSpeakConfig["elevenlabs"] {
	const elevenlabs = isRecord(settings.elevenlabs) ? settings.elevenlabs : {};
	const apiKeyEnv = stringSetting(elevenlabs.apiKeyEnv) ?? "MOM_ELEVENLABS_API_KEY";
	const apiKey = stringSetting(env.MOM_SPEAK_ELEVENLABS_API_KEY)
		?? stringSetting(env[apiKeyEnv])
		?? stringSetting(elevenlabs.apiKey);

	return {
		apiKey,
		voiceId: stringSetting(env.MOM_SPEAK_ELEVENLABS_VOICE_ID)
			?? stringSetting(env.MOM_ELEVENLABS_VOICE_ID)
			?? stringSetting(elevenlabs.voiceId)
			?? DEFAULT_ELEVENLABS_VOICE_ID,
		modelId: stringSetting(env.MOM_SPEAK_ELEVENLABS_MODEL_ID)
			?? stringSetting(env.MOM_ELEVENLABS_MODEL_ID)
			?? stringSetting(elevenlabs.modelId),
		outputFormat: stringSetting(env.MOM_SPEAK_ELEVENLABS_OUTPUT_FORMAT)
			?? stringSetting(elevenlabs.outputFormat)
			?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
		playerCommand: stringSetting(env.MOM_SPEAK_PLAYER_COMMAND)
			?? stringSetting(elevenlabs.playerCommand)
			?? "/usr/bin/afplay",
	};
}

export function resolveSpeakConfig(
	workspaceDir: string,
	options: SpeakToolOptions = {},
): ResolvedSpeakConfig {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const settings = readSettings(workspaceDir);
	const speak = (isRecord(settings.speak) ? settings.speak : {}) as MomSpeakSettings;
	const sag = isRecord(speak.sag) ? speak.sag : {};

	const backend = normalizeBackend(env.MOM_SPEAK_BACKEND)
		?? normalizeBackend(speak.backend)
		?? (platform === "darwin" ? "macos-say" : "noop");
	const enabled = backend !== "disabled"
		&& backend !== "noop"
		&& booleanSetting(env.MOM_SPEAK_ENABLED) !== false
		&& speak.enabled !== false;

	const url = stringSetting(env.MOM_SPEAK_URL) ?? stringSetting(speak.url);

	return {
		enabled,
		backend,
		maxChars: numberSetting(env.MOM_SPEAK_MAX_CHARS)
			?? numberSetting(speak.maxChars)
			?? DEFAULT_MAX_CHARS,
		macosSay: {
			voice: stringSetting(env.MOM_SPEAK_VOICE) ?? stringSetting(speak.voice),
			rate: numberSetting(env.MOM_SPEAK_RATE) ?? numberSetting(speak.rate),
		},
		command: stringSetting(env.MOM_SPEAK_COMMAND) ?? stringSetting(speak.command),
		http: url ? { url, headers: resolveHttpHeaders(speak, env) } : undefined,
		sag: {
			command: stringSetting(env.MOM_SPEAK_SAG_COMMAND)
				?? stringSetting(sag.command)
				?? DEFAULT_SAG_COMMAND,
			modelId: stringSetting(env.MOM_SPEAK_SAG_MODEL_ID)
				?? stringSetting(sag.modelId)
				?? DEFAULT_SAG_MODEL_ID,
			shell: stringSetting(env.MOM_SPEAK_SAG_SHELL)
				?? stringSetting(sag.shell)
				?? DEFAULT_SAG_SHELL,
		},
		elevenlabs: resolveElevenLabsConfig(speak, env),
	};
}

interface ManagedSpeechProcess {
	child: ChildProcess;
	completed: Promise<void>;
	cancel: (reason: string) => Promise<void>;
}

function startManagedSpeechProcess(
	command: string,
	args: string[],
	stdin: string | undefined,
	signal: AbortSignal,
): Promise<ManagedSpeechProcess> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		let startSettled = false;
		let completionSettled = false;
		let cancelRequested = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let complete!: () => void;
		let fail!: (error: unknown) => void;
		const completed = new Promise<void>((resolveCompletion, rejectCompletion) => {
			complete = resolveCompletion;
			fail = rejectCompletion;
		});
		void completed.catch(() => {});

		const settleStart = (fn: () => void) => {
			if (startSettled) return;
			startSettled = true;
			fn();
		};
		const settleCompletion = (fn: () => void) => {
			if (completionSettled) return;
			completionSettled = true;
			if (killTimer) clearTimeout(killTimer);
			signal.removeEventListener("abort", onAbort);
			fn();
		};
		const cancel = async (_reason: string) => {
			if (!completionSettled && !cancelRequested) {
				cancelRequested = true;
				try {
					child.kill("SIGTERM");
					killTimer = setTimeout(() => {
						if (child.exitCode === null && child.signalCode === null) {
							try { child.kill("SIGKILL"); } catch { /* best effort */ }
						}
					}, 750);
					killTimer.unref();
				} catch {
					// The close/error event remains the inactivity proof.
				}
			}
			await completed.catch(() => {});
		};
		const onAbort = () => { void cancel("aborted"); };
		signal.addEventListener("abort", onAbort, { once: true });

		child.once("spawn", () => {
			if (stdin !== undefined && !cancelRequested) child.stdin?.end(stdin);
			else child.stdin?.end();
			settleStart(() => resolve({ child, completed, cancel }));
			if (signal.aborted) void cancel("aborted");
		});

		child.once("error", (error) => {
			settleStart(() => reject(error));
			settleCompletion(() => fail(error));
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
			if (stderr.length > 4000) stderr = stderr.slice(-4000);
		});

		child.once("close", (code) => {
			if (code && code !== 0 && !cancelRequested) {
				const detail = stderr.trim().slice(0, 500);
				log.logWarning(`[speak] process exited with code ${code}`, detail);
				settleCompletion(() => fail(new Error(`Speech process exited with code ${code}${detail ? `: ${detail}` : ""}`)));
				return;
			}
			settleCompletion(complete);
		});

		if (signal.aborted) void cancel("aborted");
	});
}

function withSpeechGuard(
	text: string,
	managed: ManagedSpeechProcess,
	message: string,
): SpeechOutputExecution<string> {
	const guardId = beginAssistantSpeech(text);
	const completed = managed.completed.finally(() => finishAssistantSpeech(guardId));
	return {
		value: message,
		completed,
		cancel: managed.cancel,
	};
}

async function runMacSay(
	text: string,
	config: ResolvedSpeakConfig,
	signal: AbortSignal,
): Promise<SpeechOutputExecution<string>> {
	const args: string[] = [];
	if (config.macosSay.voice) args.push("-v", config.macosSay.voice);
	if (config.macosSay.rate) args.push("-r", String(Math.round(config.macosSay.rate)));
	const managed = await startManagedSpeechProcess("/usr/bin/say", args, text, signal);
	return withSpeechGuard(text, managed, "Speaking via macOS say.");
}

async function runCommandBackend(
	text: string,
	config: ResolvedSpeakConfig,
	signal: AbortSignal,
): Promise<SpeechOutputExecution<string>> {
	if (!config.command) {
		throw new Error("speak command backend requires settings.speak.command or MOM_SPEAK_COMMAND.");
	}
	const shell = process.env.SHELL || "/bin/sh";
	const managed = await startManagedSpeechProcess(shell, ["-lc", config.command], text, signal);
	return withSpeechGuard(text, managed, "Speaking via command backend.");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runSagBackend(
	text: string,
	config: ResolvedSpeakConfig,
	signal: AbortSignal,
): Promise<SpeechOutputExecution<string>> {
	const { command, modelId, shell } = config.sag;
	const invocation = `exec ${shellQuote(command)} --model-id ${shellQuote(modelId)}`;
	// SAG reads the response from stdin. A login+interactive Zsh loads the
	// operator-approved ElevenLabs environment without copying secrets into
	// Troublemaker settings or command-line arguments.
	const managed = await startManagedSpeechProcess(shell, ["-lic", invocation], text, signal);
	return withSpeechGuard(text, managed, "Speaking via SAG.");
}

async function runHttpBackend(
	text: string,
	interrupt: boolean,
	config: ResolvedSpeakConfig,
	signal: AbortSignal,
): Promise<SpeechOutputExecution<string>> {
	if (!config.http) {
		throw new Error("speak http backend requires settings.speak.url or MOM_SPEAK_URL.");
	}
	const activeMs = estimateSpeechActiveMs(text);
	const guardId = holdAssistantSpeech(text, activeMs);
	let response: Response;
	try {
		response = await fetch(config.http.url, {
			method: "POST",
			headers: config.http.headers,
			body: JSON.stringify({ text, interrupt }),
			signal,
		});
	} catch (error) {
		finishAssistantSpeech(guardId);
		throw error;
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		finishAssistantSpeech(guardId);
		throw new Error(`speak HTTP backend failed: ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`);
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let finish!: () => void;
	const activeWindow = new Promise<void>((resolveCompletion) => {
		finish = resolveCompletion;
		timer = setTimeout(resolveCompletion, activeMs);
		timer.unref();
	});
	const completed = activeWindow.finally(() => finishAssistantSpeech(guardId));
	const cancel = async () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		finishAssistantSpeech(guardId);
		finish();
		await completed;
	};
	return {
		value: `Speaking via HTTP backend (${response.status}).`,
		completed,
		cancel,
	};
}

function elevenLabsExtension(outputFormat: string): string {
	if (outputFormat.startsWith("mp3_")) return "mp3";
	if (outputFormat.startsWith("pcm_")) return "pcm";
	if (outputFormat.startsWith("ulaw_")) return "ulaw";
	return "audio";
}

async function runElevenLabsBackend(
	text: string,
	config: ResolvedSpeakConfig,
	signal: AbortSignal,
): Promise<SpeechOutputExecution<string>> {
	const elevenlabs = config.elevenlabs;
	if (!elevenlabs?.apiKey) {
		throw new Error("speak elevenlabs backend requires MOM_ELEVENLABS_API_KEY, MOM_SPEAK_ELEVENLABS_API_KEY, or settings.speak.elevenlabs.apiKey.");
	}
	if (!elevenlabs.outputFormat.startsWith("mp3_")) {
		throw new Error("speak elevenlabs local playback requires an mp3_* outputFormat.");
	}
	if (signal.aborted) throw signal.reason;

	const result = await textToSpeech(text, {
		apiKey: elevenlabs.apiKey,
		voiceId: elevenlabs.voiceId,
		modelId: elevenlabs.modelId,
		outputFormat: elevenlabs.outputFormat,
	});
	if (signal.aborted) throw signal.reason;
	const audio = Buffer.concat(result.audioChunks.map((chunk) => Buffer.from(chunk, "base64")));
	if (audio.length === 0) {
		throw new Error("ElevenLabs returned no audio.");
	}

	const dir = await mkdtemp(join(tmpdir(), "troublemaker-speak-"));
	const audioPath = join(dir, `speech.${elevenLabsExtension(elevenlabs.outputFormat)}`);
	await writeFile(audioPath, audio);
	try {
		if (signal.aborted) throw signal.reason;
		const managed = await startManagedSpeechProcess(elevenlabs.playerCommand, [audioPath], undefined, signal);
		const guarded = withSpeechGuard(text, managed, "Speaking via ElevenLabs.");
		return {
			...guarded,
			completed: guarded.completed.finally(() => rm(dir, { recursive: true, force: true }).catch(() => {})),
		};
	} catch (error) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

async function dispatchSpeech(
	text: string,
	config: ResolvedSpeakConfig,
	interrupt: boolean,
	signal: AbortSignal,
): Promise<SpeechOutputExecution<string>> {
	if (config.backend === "macos-say") return runMacSay(text, config, signal);
	if (config.backend === "command") return runCommandBackend(text, config, signal);
	if (config.backend === "http") return runHttpBackend(text, interrupt, config, signal);
	if (config.backend === "elevenlabs") return runElevenLabsBackend(text, config, signal);
	if (config.backend === "sag") return runSagBackend(text, config, signal);
	return {
		value: `Speech is disabled (${config.backend}).`,
		completed: Promise.resolve(),
		cancel: async () => {},
	};
}

export interface SpeakConfiguredResult {
	backend: MomSpeakBackend;
	enabled: boolean;
	message: string;
	speechId?: string;
	laneId?: string;
	status?: SpeechOutputReceipt["status"];
	receiptSequence?: number;
	duplicate?: boolean;
}

function logSpeechReceipt(receipt: SpeechOutputReceipt): void {
	const detail = receipt.error ?? receipt.reason ?? "";
	const message = `[speech-output] lane=${receipt.laneId} speech=${receipt.speechId} sequence=${receipt.sequence} status=${receipt.status}`;
	if (receipt.status === "failed") log.logWarning(message, detail);
	else log.logInfo(detail ? `${message} detail=${detail}` : message);
}

export async function speakConfiguredText(
	workspaceDir: string,
	text: string,
	request: { interrupt?: boolean; signal?: AbortSignal; speechId?: string } = {},
	options: SpeakToolOptions = {},
): Promise<SpeakConfiguredResult> {
	const cleanText = text.trim();
	if (!cleanText) throw new Error("speak requires non-empty text.");

	const config = resolveSpeakConfig(workspaceDir, options);
	if (!config.enabled) {
		return { backend: config.backend, enabled: false, message: `Speech is disabled (${config.backend}).` };
	}
	if (cleanText.length > config.maxChars) {
		throw new Error(`speak text is ${cleanText.length} characters; limit is ${config.maxChars}. Speak a shorter phrase.`);
	}

	const speechId = request.speechId?.trim() || randomUUID();
	const coordinator = getSpeechOutputCoordinator(workspaceDir, options);
	const ticket = coordinator.enqueue({
		speechId,
		interrupt: request.interrupt === true,
		signal: request.signal,
		start: (signal) => dispatchSpeech(cleanText, config, request.interrupt === true, signal),
	});
	const started = await ticket.started;
	if (!ticket.duplicate) {
		logSpeechReceipt(started.receipt);
		void ticket.settled.then(logSpeechReceipt);
		log.logInfo(`[speak] ${config.backend}: ${cleanText.slice(0, 120)}`);
	}
	return {
		backend: config.backend,
		enabled: true,
		message: ticket.duplicate
			? `Duplicate speech request suppressed (${speechId}).`
			: started.value,
		speechId,
		laneId: ticket.laneId,
		status: started.receipt.status,
		receiptSequence: started.receipt.sequence,
		duplicate: ticket.duplicate,
	};
}

export function createSpeakTool(workspaceDir: string, options: SpeakToolOptions = {}): AgentTool<typeof speakToolSchema> {
	return {
		name: "speak",
		label: "speak",
		description:
			"Speak a short phrase aloud through Noodle's configured local TTS backend. Calls queue in order; interrupt=true explicitly cancels only the active utterance before this one starts. " +
			"Use this when the user asks you to say something out loud or when a local Mac demo needs audible narration. " +
			"Do not use this for ordinary voice/phone/web-voice replies; those sessions provide their own TTS. " +
			"Config comes from settings.json `speak` or env vars. Backends: macos-say, command, http, elevenlabs, sag, noop/disabled.",
		parameters: speakToolSchema,
		execute: async (
			toolCallId: string,
			{ text, interrupt }: { label: string; text: string; interrupt?: boolean },
			signal?: AbortSignal,
		) => {
			const result = await speakConfiguredText(workspaceDir, text, {
				interrupt,
				signal,
				speechId: toolCallId,
			}, options);
			return {
				content: [{ type: "text" as const, text: result.message }],
				details: {
					backend: result.backend,
					enabled: result.enabled,
					speechId: result.speechId,
					laneId: result.laneId,
					status: result.status,
					receiptSequence: result.receiptSequence,
					duplicate: result.duplicate,
				},
			};
		},
	};
}
