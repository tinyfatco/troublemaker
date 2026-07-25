import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import * as log from "../log.js";

export interface McpServerConfig {
	alias: string;
	scopes: string[];
}

export interface ResolvedHttpMcpServer extends McpServerConfig {
	transport: "http";
	url: string;
	token: string;
}

export interface ResolvedStdioMcpServer extends McpServerConfig {
	transport: "stdio";
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export type ResolvedMcpServer = ResolvedHttpMcpServer | ResolvedStdioMcpServer;

interface SettingsJson {
	mcpServers?: Array<{
		alias: string;
		transport?: "http" | "stdio";
		url?: string;
		command?: string;
		args?: string[];
		cwd?: string;
		env?: Record<string, string>;
		secretKey?: string;
		token?: string;
		tokenEnv?: string;
		tokenFile?: string;
		scopes?: string[];
	}>;
}

function expandPath(filePath: string, workspaceDir: string): string {
	if (filePath === "~") return homedir();
	if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
	return isAbsolute(filePath) ? filePath : resolve(workspaceDir, filePath);
}

function readTokenFile(tokenPath: string): string | undefined {
	if (!existsSync(tokenPath)) return undefined;

	const raw = readFileSync(tokenPath, "utf-8").trim();
	if (!raw) return undefined;

	try {
		const parsed = JSON.parse(raw) as { token?: unknown };
		if (typeof parsed.token === "string" && parsed.token.trim()) {
			return parsed.token.trim();
		}
	} catch {
		// Plain token files are supported for local-only HTTP MCP tools.
	}

	return raw;
}

function resolveToken(
	entry: NonNullable<SettingsJson["mcpServers"]>[number],
	workspaceDir: string,
): string | undefined {
	if (entry.token?.trim()) {
		return entry.token.trim();
	}

	if (entry.tokenEnv) {
		const value = process.env[entry.tokenEnv]?.trim();
		if (value) return value;
		log.logWarning(`[mcp-client] Env var not set for "${entry.alias}"`, entry.tokenEnv);
		return undefined;
	}

	if (entry.tokenFile) {
		const tokenPath = expandPath(entry.tokenFile, workspaceDir);
		const token = readTokenFile(tokenPath);
		if (token) return token;
		log.logWarning(`[mcp-client] Token file not found or empty for "${entry.alias}"`, tokenPath);
		return undefined;
	}

	if (entry.secretKey) {
		const tokenPath = join("/data/.config/mcp", `${entry.alias}.json`);
		const token = readTokenFile(tokenPath);
		if (token) return token;
		log.logWarning(`[mcp-client] Token file not found for "${entry.alias}"`, tokenPath);
		return undefined;
	}

	log.logWarning(`[mcp-client] No token source configured for "${entry.alias}"`);
	return undefined;
}

export function loadMcpConfigs(workspaceDir: string): ResolvedMcpServer[] {
	const settingsPath = join(workspaceDir, "settings.json");
	if (!existsSync(settingsPath)) return [];

	let settings: SettingsJson;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return [];
	}

	if (!settings.mcpServers || !Array.isArray(settings.mcpServers)) return [];

	const resolved: ResolvedMcpServer[] = [];
	for (const entry of settings.mcpServers) {
		if (!entry.alias) {
			log.logWarning(`[mcp-client] Skipping malformed mcpServers entry`, JSON.stringify(entry));
			continue;
		}

		const transport = entry.transport || (entry.command ? "stdio" : "http");
		if (transport === "stdio") {
			if (!entry.command) {
				log.logWarning(`[mcp-client] Skipping stdio MCP "${entry.alias}" without command`);
				continue;
			}

			resolved.push({
				alias: entry.alias,
				transport: "stdio",
				command: entry.command,
				args: entry.args || [],
				cwd: entry.cwd ? expandPath(entry.cwd, workspaceDir) : undefined,
				env: entry.env,
				scopes: entry.scopes || [],
			});
			continue;
		}

		if (!entry.url) {
			log.logWarning(`[mcp-client] Skipping HTTP MCP "${entry.alias}" without url`);
			continue;
		}

		const token = resolveToken(entry, workspaceDir);
		if (!token) {
			log.logWarning(`[mcp-client] Empty token for "${entry.alias}"`);
			continue;
		}

		resolved.push({
			alias: entry.alias,
			transport: "http",
			url: entry.url,
			scopes: entry.scopes || [],
			token,
		});
	}

	return resolved;
}
