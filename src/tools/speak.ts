import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import * as log from "../log.js";

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";

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
}

let activeSpeech: ChildProcess | null = null;

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
	if (["macos-say", "command", "http", "elevenlabs", "noop", "disabled"].includes(normalized)) {
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
	const speak = isRecord(settings.speak) ? settings.speak : {};

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
		elevenlabs: resolveElevenLabsConfig(speak, env),
	};
}

function stopActiveSpeech(): void {
	const child = activeSpeech;
	if (!child) return;
	activeSpeech = null;
	try {
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 750).unref();
	} catch {
		// Best effort only.
	}
}

function startManagedSpeechProcess(
	command: string,
	args: string[],
	stdin?: string,
): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		child.once("spawn", () => {
			activeSpeech = child;
			if (stdin !== undefined) {
				child.stdin?.end(stdin);
			} else {
				child.stdin?.end();
			}
			settle(() => resolve(child));
		});

		child.once("error", (err) => {
			if (activeSpeech === child) activeSpeech = null;
			settle(() => reject(err));
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
			if (stderr.length > 4000) stderr = stderr.slice(-4000);
		});

		child.once("close", (code) => {
			if (activeSpeech === child) activeSpeech = null;
			if (code && code !== 0) {
				log.logWarning(`[speak] process exited with code ${code}`, stderr.trim().slice(0, 500));
			}
		});
	});
}

async function runMacSay(text: string, config: ResolvedSpeakConfig): Promise<string> {
	const args: string[] = [];
	if (config.macosSay.voice) args.push("-v", config.macosSay.voice);
	if (config.macosSay.rate) args.push("-r", String(Math.round(config.macosSay.rate)));
	const speechId = beginAssistantSpeech(text);
	try {
		const child = await startManagedSpeechProcess("/usr/bin/say", args, text);
		child.once("close", () => finishAssistantSpeech(speechId));
	} catch (err) {
		finishAssistantSpeech(speechId);
		throw err;
	}
	return "Speaking via macOS say.";
}

async function runCommandBackend(text: string, config: ResolvedSpeakConfig): Promise<string> {
	if (!config.command) {
		throw new Error("speak command backend requires settings.speak.command or MOM_SPEAK_COMMAND.");
	}
	const shell = process.env.SHELL || "/bin/sh";
	const speechId = beginAssistantSpeech(text);
	try {
		const child = await startManagedSpeechProcess(shell, ["-lc", config.command], text);
		child.once("close", () => finishAssistantSpeech(speechId));
	} catch (err) {
		finishAssistantSpeech(speechId);
		throw err;
	}
	return "Speaking via command backend.";
}

async function runHttpBackend(text: string, interrupt: boolean, config: ResolvedSpeakConfig, signal?: AbortSignal): Promise<string> {
	if (!config.http) {
		throw new Error("speak http backend requires settings.speak.url or MOM_SPEAK_URL.");
	}
	holdAssistantSpeech(text, estimateSpeechActiveMs(text));
	const response = await fetch(config.http.url, {
		method: "POST",
		headers: config.http.headers,
		body: JSON.stringify({ text, interrupt }),
		signal,
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`speak HTTP backend failed: ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`);
	}
	return `Speaking via HTTP backend (${response.status}).`;
}

function elevenLabsExtension(outputFormat: string): string {
	if (outputFormat.startsWith("mp3_")) return "mp3";
	if (outputFormat.startsWith("pcm_")) return "pcm";
	if (outputFormat.startsWith("ulaw_")) return "ulaw";
	return "audio";
}

async function runElevenLabsBackend(text: string, config: ResolvedSpeakConfig): Promise<string> {
	const elevenlabs = config.elevenlabs;
	if (!elevenlabs?.apiKey) {
		throw new Error("speak elevenlabs backend requires MOM_ELEVENLABS_API_KEY, MOM_SPEAK_ELEVENLABS_API_KEY, or settings.speak.elevenlabs.apiKey.");
	}
	if (!elevenlabs.outputFormat.startsWith("mp3_")) {
		throw new Error("speak elevenlabs local playback requires an mp3_* outputFormat.");
	}

	const result = await textToSpeech(text, {
		apiKey: elevenlabs.apiKey,
		voiceId: elevenlabs.voiceId,
		modelId: elevenlabs.modelId,
		outputFormat: elevenlabs.outputFormat,
	});
	const audio = Buffer.concat(result.audioChunks.map((chunk) => Buffer.from(chunk, "base64")));
	if (audio.length === 0) {
		throw new Error("ElevenLabs returned no audio.");
	}

	const dir = await mkdtemp(join(tmpdir(), "troublemaker-speak-"));
	const audioPath = join(dir, `speech.${elevenLabsExtension(elevenlabs.outputFormat)}`);
	await writeFile(audioPath, audio);
	const speechId = beginAssistantSpeech(text);
	let child: ChildProcess;
	try {
		child = await startManagedSpeechProcess(elevenlabs.playerCommand, [audioPath]);
	} catch (err) {
		finishAssistantSpeech(speechId);
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw err;
	}
	child.once("close", () => {
		finishAssistantSpeech(speechId);
		rm(dir, { recursive: true, force: true }).catch(() => {});
	});
	return "Speaking via ElevenLabs.";
}

export function createSpeakTool(workspaceDir: string, options: SpeakToolOptions = {}): AgentTool<typeof speakToolSchema> {
	return {
		name: "speak",
		label: "speak",
		description:
			"Speak a short phrase aloud through Noodle's configured local TTS backend. " +
			"Use this when the user asks you to say something out loud or when a local Mac demo needs audible narration. " +
			"Do not use this for ordinary voice/phone/web-voice replies; those adapters speak normal responses themselves. " +
			"Config comes from settings.json `speak` or env vars. Backends: macos-say, command, http, elevenlabs, noop/disabled.",
		parameters: speakToolSchema,
		execute: async (
			_toolCallId: string,
			{ text, interrupt }: { label: string; text: string; interrupt?: boolean },
			signal?: AbortSignal,
		) => {
			const cleanText = text.trim();
			if (!cleanText) throw new Error("speak requires non-empty text.");

			const config = resolveSpeakConfig(workspaceDir, options);
			if (!config.enabled) {
				return {
					content: [{ type: "text" as const, text: `Speech is disabled (${config.backend}).` }],
					details: { backend: config.backend, enabled: false },
				};
			}

			if (cleanText.length > config.maxChars) {
				throw new Error(`speak text is ${cleanText.length} characters; limit is ${config.maxChars}. Speak a shorter phrase.`);
			}

			if (activeSpeech) {
				if (!interrupt) {
					throw new Error("Speech is already in progress. Call speak with interrupt=true to replace it.");
				}
				stopActiveSpeech();
			}

			let message: string;
			if (config.backend === "macos-say") {
				message = await runMacSay(cleanText, config);
			} else if (config.backend === "command") {
				message = await runCommandBackend(cleanText, config);
			} else if (config.backend === "http") {
				message = await runHttpBackend(cleanText, interrupt === true, config, signal);
			} else if (config.backend === "elevenlabs") {
				message = await runElevenLabsBackend(cleanText, config);
			} else {
				return {
					content: [{ type: "text" as const, text: `Speech is disabled (${config.backend}).` }],
					details: { backend: config.backend, enabled: false },
				};
			}

			log.logInfo(`[speak] ${config.backend}: ${cleanText.slice(0, 120)}`);
			return {
				content: [{ type: "text" as const, text: message }],
				details: { backend: config.backend, enabled: true },
			};
		},
	};
}
