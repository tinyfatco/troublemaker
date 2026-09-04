import type {
	RuntimeToolArtifactReference,
	RuntimeToolDetailContent,
	RuntimeToolDetailFormat,
	RuntimeToolExecutionDetails,
} from "../core/runtime-contract.js";

export type ConversationToolDetailFormat = RuntimeToolDetailFormat;
export type ConversationToolDetailContent = RuntimeToolDetailContent;
export type ConversationToolArtifactReference = RuntimeToolArtifactReference;
export type ConversationToolExecutionDetails = RuntimeToolExecutionDetails;

const REDACTED = "[REDACTED]";
const STRUCTURAL_TRUNCATION = "[TRUNCATED]";
const MAXIMUM_DETAIL_CHARACTERS = 32_000;
const MAXIMUM_SOURCE_STRING_CHARACTERS = 64_000;
const MAXIMUM_VALUE_CHARACTERS = 8_000;
const MAXIMUM_DEPTH = 8;
const MAXIMUM_NODES = 2_048;
const MAXIMUM_COLLECTION_ITEMS = 64;
const MAXIMUM_TOOL_NAME_CHARACTERS = 160;
const MAXIMUM_ARTIFACTS = 12;
const MAXIMUM_ARTIFACT_LABEL_CHARACTERS = 512;
const MAXIMUM_ARTIFACT_REFERENCE_CHARACTERS = 2_048;

const SENSITIVE_KEYS = new Set([
	"apikey", "accesstoken", "refreshtoken", "authorization", "password", "passwd",
	"secret", "clientsecret", "credential", "credentials", "cookie", "cookies",
	"private", "privatekey", "thinking", "reasoning", "rawreasoning", "hiddenpayload",
	"sessioncontext", "deliverycontext", "customerdata", "host", "hostname", "internalhost",
	"internalurl", "internaltopology",
]);

interface SanitizationBudget {
	remainingNodes: number;
	truncated: boolean;
	seen: WeakSet<object>;
}

interface SanitizedValue {
	value: unknown;
	truncated: boolean;
}

export function projectToolInvocationDetails(tool: Record<string, unknown>): ConversationToolExecutionDetails | undefined {
	const toolName = safeToolName(firstString(tool.name, tool.toolName, tool.tool_name));
	const invocation = projectInvocation(
		firstDefined(tool.arguments, tool.args, tool.input),
		toolName,
	);
	return nonemptyDetails({
		...(toolName ? { toolName } : {}),
		...(invocation ? { invocation } : {}),
		...projectTiming(tool),
		artifacts: projectArtifacts(tool.artifacts),
	});
}

export function projectToolResultDetails(
	tool: Record<string, unknown>,
	toolNameHint?: string,
): ConversationToolExecutionDetails | undefined {
	const isError = tool.isError === true || tool.is_error === true;
	const toolName = safeToolName(firstString(tool.toolName, tool.tool_name, tool.name, toolNameHint));
	const rawResult = toolResultPayload(firstDefined(tool.result, tool.output, tool.content, tool.text));
	const result = projectResult(
		rawResult,
		toolName,
		isError,
		tool.isTruncated === true || tool.is_truncated === true || tool.truncated === true,
	);
	return nonemptyDetails({
		...(toolName ? { toolName } : {}),
		...(result ? { result } : {}),
		...projectTiming(tool),
		artifacts: projectArtifacts([
		...arrayValue(tool.artifacts),
		...artifactContentBlocks(tool.content),
		]),
	});
}

export function mergeToolExecutionDetails(
	current: ConversationToolExecutionDetails | undefined,
	newer: ConversationToolExecutionDetails | undefined,
): ConversationToolExecutionDetails | undefined {
	if (!current) return newer;
	if (!newer) return current;
	const artifacts = [...current.artifacts, ...newer.artifacts];
	const seen = new Set<string>();
	const toolName = newer.toolName ?? current.toolName;
	const invocation = newer.invocation ?? current.invocation;
	const result = newer.result ?? current.result;
	const exitStatus = newer.exitStatus ?? current.exitStatus;
	const durationMilliseconds = newer.durationMilliseconds ?? current.durationMilliseconds;
	return nonemptyDetails({
		...(toolName ? { toolName } : {}),
		...(invocation ? { invocation } : {}),
		...(result ? { result } : {}),
		...(exitStatus !== undefined ? { exitStatus } : {}),
		...(durationMilliseconds !== undefined ? { durationMilliseconds } : {}),
		artifacts: artifacts.filter((artifact) => {
			if (seen.has(artifact.id)) return false;
			seen.add(artifact.id);
			return true;
		}),
	});
}

function projectInvocation(raw: unknown, toolName?: string): ConversationToolDetailContent | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw) && !isRecord(raw)) return projectResult(raw, toolName, false, false);
	const sanitized = sanitizedValue(raw);
	let text: string;
	try {
		text = JSON.stringify(sanitized.value, null, 2);
	} catch {
		return undefined;
	}
	if (!text.trim()) return undefined;
	const bounded = boundedDetailText(text, sanitized.truncated);
	return {
		text: bounded.text,
		format: "json",
		language: "json",
		isTruncated: bounded.isTruncated,
	};
}

function projectResult(
	raw: unknown,
	toolName: string | undefined,
	isError: boolean,
	alreadyTruncated: boolean,
): ConversationToolDetailContent | undefined {
	if (raw === undefined || raw === null) return undefined;
	let text: string;
	let format: ConversationToolDetailFormat;
	let language: string | undefined;
	let structurallyTruncated = false;

	if (typeof raw === "string") {
		const source = boundedSourceString(raw);
		structurallyTruncated = source.isTruncated;
		const parsed = parseJSONContainer(source.text);
		if (parsed !== undefined) {
			const sanitized = sanitizedValue(parsed);
			text = JSON.stringify(sanitized.value, null, 2);
			structurallyTruncated ||= sanitized.truncated;
			format = "json";
			language = "json";
		} else {
			text = sanitizePlainText(source.text);
			if (!text.trim()) return undefined;
			const detected = detectedFormat(text, toolName, isError);
			format = detected.format;
			language = detected.language;
		}
	} else {
		const sanitized = sanitizedValue(raw);
		try {
			text = JSON.stringify(sanitized.value, null, 2);
		} catch {
			return undefined;
		}
		if (!text.trim()) return undefined;
		structurallyTruncated = sanitized.truncated;
		format = isError ? "error" : "json";
		language = isError ? undefined : "json";
	}

	const bounded = boundedDetailText(text, alreadyTruncated || structurallyTruncated);
	return {
		text: bounded.text,
		format,
		...(language ? { language } : {}),
		isTruncated: bounded.isTruncated,
	};
}

function sanitizedValue(raw: unknown): SanitizedValue {
	const budget: SanitizationBudget = {
		remainingNodes: MAXIMUM_NODES,
		truncated: false,
		seen: new WeakSet<object>(),
	};
	return {
		value: sanitizeJSONValue(raw, undefined, 0, budget),
		truncated: budget.truncated,
	};
}

function sanitizeJSONValue(
	raw: unknown,
	key: string | undefined,
	depth: number,
	budget: SanitizationBudget,
): unknown {
	if (key && SENSITIVE_KEYS.has(normalizedKey(key))) return REDACTED;
	if (budget.remainingNodes <= 0 || depth > MAXIMUM_DEPTH) {
		budget.truncated = true;
		return STRUCTURAL_TRUNCATION;
	}
	budget.remainingNodes -= 1;

	if (typeof raw === "string") {
		const bounded = boundedText(sanitizePlainText(raw), MAXIMUM_VALUE_CHARACTERS);
		budget.truncated ||= bounded.isTruncated;
		return bounded.text;
	}
	if (raw === null || typeof raw === "boolean") return raw;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : String(raw);
	if (typeof raw === "bigint") return raw.toString();
	if (raw === undefined) return null;
	if (typeof raw !== "object") return sanitizePlainText(String(raw));

	if (budget.seen.has(raw)) {
		budget.truncated = true;
		return STRUCTURAL_TRUNCATION;
	}
	budget.seen.add(raw);
	try {
		if (Array.isArray(raw)) {
			if (raw.length > MAXIMUM_COLLECTION_ITEMS) budget.truncated = true;
			return raw.slice(0, MAXIMUM_COLLECTION_ITEMS)
				.map((value) => sanitizeJSONValue(value, key, depth + 1, budget));
		}
		const entries = Object.entries(raw).sort(([left], [right]) => left.localeCompare(right));
		if (entries.length > MAXIMUM_COLLECTION_ITEMS) budget.truncated = true;
		const projected: Record<string, unknown> = {};
		for (const [entryKey, value] of entries.slice(0, MAXIMUM_COLLECTION_ITEMS)) {
			const safeKey = boundedText(entryKey, 128);
			budget.truncated ||= safeKey.isTruncated;
			projected[safeKey.text] = sanitizeJSONValue(value, entryKey, depth + 1, budget);
		}
		return projected;
	} finally {
		budget.seen.delete(raw);
	}
}

function sanitizePlainText(source: string): string {
	let text = source;
	const replacements: Array<[RegExp, string]> = [
		[/<(?:thinking|reasoning|session_context|delivery_context|hidden_payload)[^>]*>[\s\S]*?<\/(?:thinking|reasoning|session_context|delivery_context|hidden_payload)>/gi, "[REDACTED HIDDEN PAYLOAD]"],
		[/^.*\bprivate (?:tool )?(?:output|result|payload|reasoning)\b.*$/gim, "[REDACTED PRIVATE PAYLOAD]"],
		[/(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]"],
		[/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]"],
		[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]"],
		[/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|cookie)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]"],
		[/\b(?:sk|rk|pk)-(?:live|test|proj)-[A-Za-z0-9_-]{8,}\b|\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{8,}\b|\bAKIA[A-Z0-9]{12,}\b/g, "[REDACTED CREDENTIAL]"],
		[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
		[/\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})\b/g, "[REDACTED PRIVATE ADDRESS]"],
		[/\bhttps?:\/\/(?:localhost|[^/\s.:]+\.(?:local|internal|lan))(?::\d+)?/gi, "[REDACTED PRIVATE ORIGIN]"],
		[/\/(?:Users|home)\/[^/\s]+/g, "/Users/[REDACTED]"],
		[/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]"],
	];
	for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
	return text;
}

function detectedFormat(
	text: string,
	toolName: string | undefined,
	isError: boolean,
): { format: ConversationToolDetailFormat; language?: string } {
	if (isError) return { format: "error" };
	const trimmed = text.trim();
	if (trimmed.startsWith("diff --git")
		|| (trimmed.includes("\n+++") && trimmed.includes("\n---"))
		|| trimmed.startsWith("@@")) {
		return { format: "diff", language: "diff" };
	}
	const leaf = (toolName?.split("__").at(-1) ?? "").toLowerCase();
	if (["bash", "shell", "terminal", "exec", "run_command"].some((part) => leaf.includes(part))) {
		return { format: "shell", language: "shell" };
	}
	if (["read", "write", "edit", "patch"].some((part) => leaf.includes(part))) {
		const language = inferredLanguage(trimmed);
		if (language) return { format: "code", language };
	}
	return { format: "text" };
}

function inferredLanguage(text: string): string | undefined {
	if (text.includes("import SwiftUI") || text.includes("import Foundation")) return "swift";
	if (text.includes("function ") || text.includes("const ") || text.includes("=>")) return "javascript";
	if (text.includes("def ") && text.includes(":")) return "python";
	if (text.includes("<html") || text.includes("<!DOCTYPE html")) return "html";
	return undefined;
}

function safeToolName(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const leaf = raw.split("__").at(-1)?.trim() ?? "";
	if (!leaf) return undefined;
	const words = leaf.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	if (words.some((word) => ["private", "internal", "hostname", "topology", "credential"].includes(word))) {
		return undefined;
	}
	const sanitized = sanitizePlainText(leaf).replace(/\s+/g, " ").trim();
	if (!sanitized || sanitized.includes("[REDACTED")) return undefined;
	return boundedText(sanitized, MAXIMUM_TOOL_NAME_CHARACTERS).text;
}

function projectTiming(tool: Record<string, unknown>): {
	exitStatus?: number;
	durationMilliseconds?: number;
} {
	const exitStatus = firstInteger(tool.exitStatus, tool.exit_status, tool.exitCode, tool.exit_code);
	const durationMilliseconds = firstFiniteNumber(
		tool.durationMs,
		tool.duration_ms,
		tool.durationMilliseconds,
	);
	return {
		...(exitStatus !== undefined ? { exitStatus } : {}),
		...(durationMilliseconds !== undefined && durationMilliseconds >= 0 ? { durationMilliseconds } : {}),
	};
}

function projectArtifacts(raw: unknown): ConversationToolArtifactReference[] {
	const values = arrayValue(raw).slice(0, MAXIMUM_ARTIFACTS);
	return values.flatMap((value, index): ConversationToolArtifactReference[] => {
		if (!isRecord(value)) return [];
		const rawReference = firstString(value.reference, value.url, value.path, value.file);
		if (!rawReference) return [];
		const reference = boundedText(
			sanitizePlainText(rawReference),
			MAXIMUM_ARTIFACT_REFERENCE_CHARACTERS,
		).text;
		if (!reference || reference === REDACTED || reference.includes("[REDACTED CREDENTIAL]")) return [];
		const rawLabel = firstString(value.label, value.name) ?? reference.split("/").at(-1) ?? "Artifact";
		const label = boundedText(
			sanitizePlainText(rawLabel),
			MAXIMUM_ARTIFACT_LABEL_CHARACTERS,
		).text;
		const rawID = firstString(value.id) ?? `artifact-${index}`;
		const id = boundedText(sanitizePlainText(rawID), 256).text;
		const mediaType = firstString(value.mediaType, value.media_type, value.mimeType, value.mime_type);
		return [{
			id,
			label,
			reference,
			...(mediaType ? { mediaType: boundedText(sanitizePlainText(mediaType), 128).text } : {}),
		}];
	});
}

function artifactContentBlocks(raw: unknown): unknown[] {
	return arrayValue(raw).filter((block) =>
		isRecord(block) && ["image", "file", "artifact"].includes(String(block.type)));
}

function toolResultPayload(raw: unknown): unknown {
	if (!Array.isArray(raw)) return raw;
	const text = raw.flatMap((block): string[] => {
		if (!isRecord(block)) return [];
		return (block.type === "text" || block.type === "output_text") && typeof block.text === "string"
			? [block.text]
			: [];
	}).join("\n");
	return text || undefined;
}

function nonemptyDetails(
	details: ConversationToolExecutionDetails,
): ConversationToolExecutionDetails | undefined {
	return details.toolName
		|| details.invocation
		|| details.result
		|| details.exitStatus !== undefined
		|| details.durationMilliseconds !== undefined
		|| details.artifacts.length > 0
		? details
		: undefined;
}

function boundedDetailText(text: string, previouslyTruncated: boolean): { text: string; isTruncated: boolean } {
	const bounded = boundedText(text, MAXIMUM_DETAIL_CHARACTERS);
	const isTruncated = previouslyTruncated || bounded.isTruncated;
	return {
		text: bounded.isTruncated
			? `${bounded.text}\n\n[Tool detail truncated at ${MAXIMUM_DETAIL_CHARACTERS} characters]`
			: bounded.text,
		isTruncated,
	};
}

function boundedSourceString(text: string): { text: string; isTruncated: boolean } {
	return boundedText(text, MAXIMUM_SOURCE_STRING_CHARACTERS);
}

function boundedText(text: string, maximumCharacters: number): { text: string; isTruncated: boolean } {
	const characters = Array.from(text);
	return characters.length > maximumCharacters
		? { text: characters.slice(0, maximumCharacters).join(""), isTruncated: true }
		: { text, isTruncated: false };
}

function parseJSONContainer(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return Array.isArray(parsed) || isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function normalizedKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function firstDefined(...values: unknown[]): unknown {
	return values.find((value) => value !== undefined && value !== null);
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function firstInteger(...values: unknown[]): number | undefined {
	return values.find((value): value is number =>
		typeof value === "number" && Number.isSafeInteger(value));
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
	return values.find((value): value is number =>
		typeof value === "number" && Number.isFinite(value));
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
