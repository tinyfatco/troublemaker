import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const OWNED_WORK_CANARY_HOLD_META = "owned-work-canary:phone-hold-attestation:v1";

export async function attestOwnedWorkCanaryPhoneHold(configPath, state) {
	if (!state.config.phone) return undefined;
	const resolvedConfigPath = resolve(configPath);
	const [configBytes, processStat] = await Promise.all([
		readFile(resolvedConfigPath),
		readFile("/proc/self/stat", "utf8"),
	]);
	const processStartTicks = processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19];
	if (!/^[1-9]\d*$/.test(processStartTicks || "")) {
		throw new Error("Hostd process start identity is unavailable");
	}
	const attestation = {
		version: 1,
		pid: process.pid,
		processStartTicks,
		startedAt: new Date().toISOString(),
		configPath: resolvedConfigPath,
		configSha256: createHash("sha256").update(configBytes).digest("hex"),
		deliveryHolds: [...state.config.phone.deliveryHolds],
	};
	state.store.setMeta(OWNED_WORK_CANARY_HOLD_META, JSON.stringify(attestation));
	return attestation;
}
