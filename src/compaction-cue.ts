import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const DEFAULT_COMPACTION_CUE_PATH = "/System/Library/Sounds/Purr.aiff";
export const DEFAULT_COMPACTION_CUE_PLAYER = "/usr/bin/afplay";
export const DEFAULT_COMPACTION_CUE_VOLUME = 0.12;

interface CueProcess {
	once(event: "error", listener: () => void): unknown;
	unref(): void;
}

type SpawnCue = (
	command: string,
	args: string[],
	options: { stdio: "ignore" },
) => CueProcess;

export interface CompactionCueOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
	spawn?: SpawnCue;
}

export interface CompactionCueConfig {
	player: string;
	sound: string;
	volume: number;
}

const DISABLED_VALUES = new Set(["0", "false", "off", "none", "disabled"]);
const DEFAULT_VALUES = new Set(["", "1", "true", "on", "auto", "default"]);

function boundedVolume(raw: string | undefined): number {
	if (!raw?.trim()) return DEFAULT_COMPACTION_CUE_VOLUME;
	const value = Number(raw);
	if (!Number.isFinite(value)) return DEFAULT_COMPACTION_CUE_VOLUME;
	return Math.max(0, Math.min(1, value));
}

export function resolveCompactionCue(options: CompactionCueOptions = {}): CompactionCueConfig | null {
	const platform = options.platform ?? process.platform;
	if (platform !== "darwin") return null;

	const env = options.env ?? process.env;
	const setting = env.MOM_COMPACTION_SOUND?.trim() ?? "";
	if (DISABLED_VALUES.has(setting.toLowerCase())) return null;

	const sound = DEFAULT_VALUES.has(setting.toLowerCase())
		? DEFAULT_COMPACTION_CUE_PATH
		: setting;
	const player = env.MOM_COMPACTION_SOUND_PLAYER?.trim() || DEFAULT_COMPACTION_CUE_PLAYER;
	const exists = options.exists ?? existsSync;
	if (!exists(player) || !exists(sound)) return null;

	return {
		player,
		sound,
		volume: boundedVolume(env.MOM_COMPACTION_SOUND_VOLUME),
	};
}

/** Play a non-blocking, best-effort local cue when context compaction begins. */
export function playCompactionCue(options: CompactionCueOptions = {}): boolean {
	const config = resolveCompactionCue(options);
	if (!config) return false;

	const spawnCue = options.spawn ?? (spawn as unknown as SpawnCue);
	try {
		const child = spawnCue(
			config.player,
			["-v", String(config.volume), config.sound],
			{ stdio: "ignore" },
		);
		child.once("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
