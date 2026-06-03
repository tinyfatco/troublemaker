import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const DEFAULT_BRIEFING_RECENT_LIMIT = 10;
const DEFAULT_BRIEFING_MAX_CHARS = 4_000;
const DEFAULT_SEARCH_LIMIT = 12;
const DEFAULT_SNIPPET_CHARS = 360;

const briefingSchema = Type.Object({
	recentLimit: Type.Optional(Type.Number({ description: "Maximum recent context entries to include. Default 10, max 24." })),
	maxChars: Type.Optional(Type.Number({ description: "Maximum briefing characters. Default 4000, max 8000." })),
});

const searchSchema = Type.Object({
	query: Type.String({ description: "Case-insensitive text to search for in Zip's persisted context and chat logs." }),
	source: Type.Optional(Type.String({ description: "Optional source: all, awareness, log, or memory. Defaults to all." })),
	limit: Type.Optional(Type.Number({ description: "Maximum matching entries to return. Default 12, max 30." })),
});

export interface ContextSearchMatch {
	source: string;
	path: string;
	line: number;
	timestamp?: string;
	label?: string;
	text: string;
}

export function createRealtimeContextTools(workingDir: string): AgentTool<any>[] {
	return [
		{
			name: "get_context_briefing",
			label: "get_context_briefing",
			description:
				"Return a compact briefing of Zip's identity, memory files, and recent persisted activity. Use this before answering questions that depend on Zip/Troublemaker context. This is intentionally small; use search_context for specific past-chat lookup.",
			parameters: briefingSchema,
			execute: async (_toolCallId, params) => {
				const args = objectParams(params);
				const recentLimit = clampInt(args.recentLimit, DEFAULT_BRIEFING_RECENT_LIMIT, 1, 24);
				const maxChars = clampInt(args.maxChars, DEFAULT_BRIEFING_MAX_CHARS, 1_000, 8_000);
				const text = buildContextBriefing(workingDir, { recentLimit, maxChars });
				return {
					content: [{ type: "text" as const, text }],
					details: { recentLimit, maxChars },
				};
			},
		},
		{
			name: "search_context",
			label: "search_context",
			description:
				"Search Zip's persisted awareness, adapter log, and memory files for a string. Use this when the user asks about prior chats, names, projects, decisions, or any specific term from past context.",
			parameters: searchSchema,
			execute: async (_toolCallId, params) => {
				const args = objectParams(params);
				const query = String(args.query || "").trim();
				if (!query) throw new Error("search_context requires a non-empty query.");
				const source = normalizeSource(args.source);
				const limit = clampInt(args.limit, DEFAULT_SEARCH_LIMIT, 1, 30);
				const matches = searchContext(workingDir, query, { source, limit });
				return {
					content: [{ type: "text" as const, text: formatSearchResults(query, matches, source) }],
					details: { query, source, count: matches.length, matches },
				};
			},
		},
	];
}

export function buildContextBriefing(
	workingDir: string,
	options: { recentLimit?: number; maxChars?: number } = {},
): string {
	const recentLimit = clampInt(options.recentLimit, DEFAULT_BRIEFING_RECENT_LIMIT, 1, 24);
	const maxChars = clampInt(options.maxChars, DEFAULT_BRIEFING_MAX_CHARS, 1_000, 8_000);
	const settings = readJsonFile(join(workingDir, "settings.json"));
	const name = stringValue(settings?.name) || stringValue(settings?.localAgentProfile) || "Zip";

	const sections: string[] = [
		`Context briefing for ${name}`,
		"Use search_context(query) for exact prior-chat lookup instead of loading full awareness unless necessary.",
	];

	const identity = summarizeWorkspaceFiles(workingDir);
	if (identity.length > 0) {
		sections.push(["Identity and memory:", ...identity.map((line) => `- ${line}`)].join("\n"));
	}

	const recent = recentContextEntries(workingDir, recentLimit);
	if (recent.length > 0) {
		sections.push(["Recent persisted activity:", ...recent.map((entry) => `- ${entry}`)].join("\n"));
	}

	return truncateText(sections.join("\n\n"), maxChars);
}

export function searchContext(
	workingDir: string,
	query: string,
	options: { source?: "all" | "awareness" | "log" | "memory"; limit?: number } = {},
): ContextSearchMatch[] {
	const source = options.source || "all";
	const limit = clampInt(options.limit, DEFAULT_SEARCH_LIMIT, 1, 30);
	const files = contextFiles(workingDir, source);
	const matches: ContextSearchMatch[] = [];

	for (const file of files) {
		if (matches.length >= limit) break;
		for (const match of searchFile(file, query, limit - matches.length)) {
			matches.push(match);
			if (matches.length >= limit) break;
		}
	}

	return matches;
}

function summarizeWorkspaceFiles(workingDir: string): string[] {
	const fileNames = ["IDENTITY.md", "USER.md", "MEMORY.md", "SOUL.md"];
	const summaries: string[] = [];
	for (const fileName of fileNames) {
		const path = join(workingDir, fileName);
		const content = readTextFile(path);
		if (!content) continue;
		const summary = summarizeMarkdown(content);
		if (summary) summaries.push(`${fileName}: ${summary}`);
	}
	return summaries;
}

function recentContextEntries(workingDir: string, limit: number): string[] {
	const candidates: string[] = [];
	for (const file of [join(workingDir, "log.jsonl"), join(workingDir, "awareness", "context.jsonl")]) {
		for (const entry of tailLines(file, limit * 8)) {
			const rendered = renderContextLine(entry);
			if (rendered && !isLowSignalContext(rendered)) candidates.push(rendered);
		}
	}
	return candidates.slice(-limit);
}

function contextFiles(workingDir: string, source: "all" | "awareness" | "log" | "memory"): SearchFile[] {
	const files: SearchFile[] = [];
	if (source === "all" || source === "awareness") {
		files.push({ source: "awareness", path: join(workingDir, "awareness", "context.jsonl"), jsonl: true });
	}
	if (source === "all" || source === "log") {
		files.push({ source: "log", path: join(workingDir, "log.jsonl"), jsonl: true });
	}
	if (source === "all" || source === "memory") {
		for (const path of memoryFilePaths(workingDir)) {
			files.push({ source: "memory", path, jsonl: false });
		}
	}
	return files.filter((file) => existsSync(file.path));
}

interface SearchFile {
	source: string;
	path: string;
	jsonl: boolean;
}

function searchFile(file: SearchFile, query: string, limit: number): ContextSearchMatch[] {
	const lines = readLines(file.path);
	const matches: ContextSearchMatch[] = [];
	for (let index = lines.length - 1; index >= 0 && matches.length < limit; index--) {
		const line = lines[index] ?? "";
		const rendered = file.jsonl ? renderContextLine(line) : line;
		if (!matchesQuery(rendered, query)) continue;
		matches.push({
			source: file.source,
			path: relativeDisplayPath(file.path),
			line: index + 1,
			...metadataForLine(line),
			text: truncateText(compactWhitespace(rendered), DEFAULT_SNIPPET_CHARS),
		});
	}
	return matches;
}

function renderContextLine(line: string): string {
	const object = parseJson(line);
	if (!object) return line;

	const logText = stringValue(object.text);
	if (logText) {
		const text = normalizeAgentText(logText);
		const channel = stringValue(object.channel) || stringValue(object.channelId);
		const timestamp = stringValue(object.date) || stringValue(object.timestamp);
		return compactWhitespace([timestamp, channel, text].filter(Boolean).join(" | "));
	}

	const message = object.message && typeof object.message === "object" ? object.message as Record<string, unknown> : undefined;
	if (message) {
		const role = stringValue(message.role) || stringValue(object.role) || "message";
		const timestamp = stringValue(object.timestamp) || stringValue(message.timestamp);
		const text = normalizeAgentText(extractContentText(message.content));
		return compactWhitespace([timestamp, role, text].filter(Boolean).join(" | "));
	}

	return compactWhitespace(normalizeAgentText(JSON.stringify(object)));
}

function metadataForLine(line: string): Pick<ContextSearchMatch, "timestamp" | "label"> {
	const object = parseJson(line);
	if (!object) return {};
	const message = object.message && typeof object.message === "object" ? object.message as Record<string, unknown> : undefined;
	const label =
		stringValue(object.channel)
		|| stringValue(object.channelId)
		|| stringValue(message?.role)
		|| stringValue(object.type);
	return {
		timestamp: stringValue(object.date) || stringValue(object.timestamp) || stringValue(message?.timestamp),
		label,
	};
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((item) => {
			if (typeof item === "string") return item;
			if (!item || typeof item !== "object") return "";
			const block = item as Record<string, unknown>;
			return stringValue(block.text)
				|| stringValue(block.content)
				|| stringValue(block.input)
				|| stringValue(block.name)
				|| "";
		}).filter(Boolean).join("\n");
	}
	if (content && typeof content === "object") {
		const block = content as Record<string, unknown>;
		return stringValue(block.text) || stringValue(block.content) || JSON.stringify(block);
	}
	return "";
}

function normalizeAgentText(text: string): string {
	let normalized = text.replace(/<session_context>[\s\S]*?<\/session_context>/g, "");
	const userRequestMarker = "\n\nUser request:\n";
	const markerIndex = normalized.lastIndexOf(userRequestMarker);
	if (normalized.startsWith("Cloud awareness primer ") && markerIndex >= 0) {
		normalized = normalized.slice(markerIndex + userRequestMarker.length);
	}
	return compactWhitespace(normalized);
}

function isLowSignalContext(text: string): boolean {
	const lower = text.toLowerCase();
	return lower.includes("yield_no_action")
		|| lower.includes("heartbeat only")
		|| lower.includes("reply with exactly ok")
		|| lower.length < 12;
}

function formatSearchResults(
	query: string,
	matches: ContextSearchMatch[],
	source: "all" | "awareness" | "log" | "memory",
): string {
	if (matches.length === 0) {
		return `No ${source === "all" ? "" : `${source} `}context matches for "${query}".`;
	}
	return [
		`Found ${matches.length} context match${matches.length === 1 ? "" : "es"} for "${query}":`,
		...matches.map((match, index) => {
			const label = match.label ? ` ${match.label}` : "";
			const timestamp = match.timestamp ? ` ${match.timestamp}` : "";
			return `${index + 1}. ${match.path}:${match.line}${label}${timestamp}\n   ${match.text}`;
		}),
	].join("\n");
}

function matchesQuery(text: string, query: string): boolean {
	const haystack = text.toLowerCase();
	const needle = query.trim().toLowerCase();
	if (!needle) return false;
	if (haystack.includes(needle)) return true;
	const terms = needle.split(/\s+/).filter((term) => term.length >= 2);
	return terms.length > 1 && terms.every((term) => haystack.includes(term));
}

function memoryFilePaths(workingDir: string): string[] {
	const paths = ["IDENTITY.md", "USER.md", "MEMORY.md", "SOUL.md", "AGENTS.md"].map((file) => join(workingDir, file));
	const memoryDir = join(workingDir, "memory");
	if (existsSync(memoryDir)) {
		for (const entry of readdirSync(memoryDir)) {
			if (/^\d{4}-\d{2}-\d{2}\.md$/.test(entry)) paths.push(join(memoryDir, entry));
		}
	}
	return paths.filter((path) => existsSync(path) && statSync(path).isFile());
}

function summarizeMarkdown(content: string): string {
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.replace(/^#{1,6}\s*/, "").trim())
		.filter((line) => line && !line.startsWith("---") && !line.startsWith("_"));
	return truncateText(compactWhitespace(lines.slice(0, 6).join(" ")), 420);
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	const text = readTextFile(path);
	if (!text) return undefined;
	const value = parseJson(text);
	return value || undefined;
}

function readTextFile(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

function readLines(path: string): string[] {
	return readTextFile(path).split(/\r?\n/).filter((line) => line.length > 0);
}

function tailLines(path: string, limit: number): string[] {
	const lines = readLines(path);
	return lines.slice(Math.max(0, lines.length - limit));
}

function parseJson(text: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compactWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n[truncated to ${maxChars} chars]`;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const numeric = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
	return Math.min(max, Math.max(min, numeric));
}

function normalizeSource(value: unknown): "all" | "awareness" | "log" | "memory" {
	if (value === "awareness" || value === "log" || value === "memory") return value;
	return "all";
}

function objectParams(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function relativeDisplayPath(path: string): string {
	const awarenessIndex = path.lastIndexOf("/awareness/");
	if (awarenessIndex >= 0) return path.slice(awarenessIndex + 1);
	if (basename(path) === "log.jsonl") return "log.jsonl";
	const memoryIndex = path.lastIndexOf("/memory/");
	if (memoryIndex >= 0) return path.slice(memoryIndex + 1);
	return basename(path);
}
