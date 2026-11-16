import { randomUUID } from "crypto";
import { existsSync, renameSync, statSync, writeFileSync } from "fs";
import { copyFile, mkdir } from "fs/promises";
import { join } from "path";
import * as log from "../log.js";

/**
 * Archive context.jsonl to awareness/history/<date>/<uuid>.jsonl
 */
export async function archiveContext(contextFile: string): Promise<void> {
	if (!existsSync(contextFile)) return;
	const stat = statSync(contextFile);
	if (stat.size === 0) return;

	const now = new Date();
	const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
	const historyDir = join(contextFile, "..", "history", dateStr);
	await mkdir(historyDir, { recursive: true });

	const archivePath = join(historyDir, `${randomUUID()}.jsonl`);
	await copyFile(contextFile, archivePath);
	log.logInfo(`[awareness] Archived context to ${archivePath}`);
}

/**
 * Archive the context file (or quarantine it if archiving fails), then
 * truncate it. Returns the quarantine path when the file had to be moved aside.
 */
export async function archiveAndTruncateContextFile(contextFile: string, label: string): Promise<{ quarantined?: string }> {
	let quarantined: string | undefined;
	try {
		await archiveContext(contextFile);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.logWarning(`[awareness] ${label}: archive failed (${msg}) — quarantining broken file`);
		try {
			if (existsSync(contextFile)) {
				const ts = new Date().toISOString().replace(/[:.]/g, "-");
				const broken = `${contextFile}.broken-${ts}`;
				renameSync(contextFile, broken);
				quarantined = broken;
				log.logInfo(`[awareness] ${label}: quarantined corrupt context to ${broken}`);
			}
		} catch (qerr) {
			log.logWarning(`[awareness] ${label}: quarantine also failed (continuing): ${qerr instanceof Error ? qerr.message : String(qerr)}`);
		}
	}

	try {
		writeFileSync(contextFile, "", "utf-8");
	} catch (err) {
		log.logWarning(`[awareness] ${label}: truncate failed (${err instanceof Error ? err.message : String(err)})`);
		throw err;
	}
	return quarantined ? { quarantined } : {};
}

/**
 * Translate container path back to host path for file operations
 */
export function translateToHostPath(
	containerPath: string,
	awarenessDir: string,
	workspacePath: string,
): string {
	if (workspacePath === "/data" || workspacePath === "/workspace") {
		const prefixes = workspacePath === "/data" ? ["/data/", "/workspace/"] : ["/workspace/", "/data/"];
		for (const prefix of prefixes) {
			if (containerPath.startsWith(prefix)) {
				return join(awarenessDir, "..", containerPath.slice(prefix.length));
			}
		}
	}
	return containerPath;
}
