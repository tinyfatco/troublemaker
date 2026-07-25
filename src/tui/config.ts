import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";

export interface TuiAgentProfile {
	command: string;
	name: string;
	baseUrl: string;
	channelId: string;
}

interface TuiConfigFile {
	version: 1;
	agents: Record<string, TuiAgentProfile>;
}

export interface InstallTuiProfileOptions {
	command: string;
	name?: string;
	baseUrl: string;
	channelId?: string;
	executablePath: string;
	configPath?: string;
	binDir?: string;
}

export interface InstalledTuiProfile {
	profile: TuiAgentProfile;
	configPath: string;
	commandPath: string;
}

const EMPTY_CONFIG: TuiConfigFile = { version: 1, agents: {} };

export function defaultTuiConfigPath(): string {
	return process.env.TROUBLEMAKER_TUI_CONFIG || join(homedir(), ".config", "troublemaker", "tui.json");
}

export function defaultTuiBinDir(): string {
	return process.env.TROUBLEMAKER_TUI_BIN_DIR || join(homedir(), ".local", "bin");
}

export function normalizeTuiCommand(value: string): string {
	const command = value.trim().toLowerCase();
	if (!/^[a-z][a-z0-9-]*$/.test(command)) {
		throw new Error("Agent command must start with a letter and contain only lowercase letters, numbers, or hyphens");
	}
	if (["troublemaker", "troublemaker-tui"].includes(command)) {
		throw new Error(`Agent command is reserved: ${command}`);
	}
	return command;
}

export function normalizeTuiBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(`Invalid agent URL: ${value}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Agent URL must use http or https");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("Agent URL cannot contain credentials, query parameters, or a fragment");
	}
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	return url.toString().replace(/\/$/, "");
}

export function loadTuiProfiles(configPath = defaultTuiConfigPath()): Record<string, TuiAgentProfile> {
	if (!existsSync(configPath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		throw new Error(`Could not read TUI config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.agents)) {
		throw new Error(`Invalid TUI config: ${configPath}`);
	}

	const profiles: Record<string, TuiAgentProfile> = {};
	for (const [key, raw] of Object.entries(parsed.agents)) {
		if (!isRecord(raw)) continue;
		try {
			const command = normalizeTuiCommand(typeof raw.command === "string" ? raw.command : key);
			const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : titleCase(command);
			const baseUrl = normalizeTuiBaseUrl(String(raw.baseUrl || ""));
			const channelId = typeof raw.channelId === "string" && raw.channelId.trim()
				? raw.channelId.trim()
				: `terminal:${command}`;
			profiles[command] = { command, name, baseUrl, channelId };
		} catch {
			// One stale profile should not make every installed agent unusable.
		}
	}
	return profiles;
}

export function installTuiProfile(options: InstallTuiProfileOptions): InstalledTuiProfile {
	const command = normalizeTuiCommand(options.command);
	const profile: TuiAgentProfile = {
		command,
		name: options.name?.trim() || titleCase(command),
		baseUrl: normalizeTuiBaseUrl(options.baseUrl),
		channelId: options.channelId?.trim() || `terminal:${command}`,
	};
	const configPath = options.configPath || defaultTuiConfigPath();
	const binDir = options.binDir || defaultTuiBinDir();
	const commandPath = join(binDir, command);
	const executablePath = preflightCommandSymlink(commandPath, options.executablePath);
	const current = loadConfigFile(configPath);
	current.agents[command] = profile;
	writeConfigFile(configPath, current);

	mkdirSync(binDir, { recursive: true, mode: 0o755 });
	installCommandSymlink(commandPath, executablePath);
	return { profile, configPath, commandPath };
}

export function resolveInvokedAgent(argv1: string | undefined): string | undefined {
	if (!argv1) return undefined;
	const invoked = basename(argv1).toLowerCase();
	if (["tui.js", "tui.ts", "troublemaker-tui"].includes(invoked)) return undefined;
	try {
		return normalizeTuiCommand(invoked);
	} catch {
		return undefined;
	}
}

function loadConfigFile(configPath: string): TuiConfigFile {
	if (!existsSync(configPath)) return structuredClone(EMPTY_CONFIG);
	const profiles = loadTuiProfiles(configPath);
	return { version: 1, agents: profiles };
}

function writeConfigFile(configPath: string, config: TuiConfigFile): void {
	const configDir = dirname(configPath);
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	const tempPath = `${configPath}.${process.pid}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tempPath, 0o600);
	renameSync(tempPath, configPath);
	chmodSync(configPath, 0o600);
}

function preflightCommandSymlink(commandPath: string, executablePath: string): string {
	const target = resolve(executablePath);
	if (!existsSync(target)) throw new Error(`TUI executable does not exist: ${target}`);
	if (existsSync(commandPath) || isDanglingSymlink(commandPath)) {
		const stat = lstatSync(commandPath);
		if (!stat.isSymbolicLink()) {
			throw new Error(`Refusing to replace existing command: ${commandPath}`);
		}
		const existingTarget = resolve(dirname(commandPath), readlinkSync(commandPath));
		if (existingTarget !== target) {
			throw new Error(`Refusing to replace symlink owned by another command: ${commandPath}`);
		}
	}
	return target;
}

function installCommandSymlink(commandPath: string, target: string): void {
	if (existsSync(commandPath) || isDanglingSymlink(commandPath)) unlinkSync(commandPath);
	symlinkSync(target, commandPath);
}

function isDanglingSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function titleCase(command: string): string {
	return command
		.split("-")
		.filter(Boolean)
		.map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`)
		.join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
