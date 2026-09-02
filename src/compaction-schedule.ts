import { existsSync, unlinkSync } from "fs";
import { join } from "path";

export interface ScheduledCompactionCleanup {
	removed: string[];
	failures: Array<{ path: string; error: string }>;
}

/**
 * Remove legacy clock-driven semantic compaction jobs. Context compaction is
 * pressure-driven or explicitly requested; a healthy context should not be
 * summarized merely because the clock changed.
 */
export function removeUnconditionalCompactionSchedules(workingDir: string): ScheduledCompactionCleanup {
	const removed: string[] = [];
	const failures: Array<{ path: string; error: string }> = [];
	for (const path of [
		join(workingDir, "attention", "queue", "compaction.json"),
		join(workingDir, "events", "compaction.json"),
	]) {
		if (!existsSync(path)) continue;
		try {
			unlinkSync(path);
			removed.push(path);
		} catch (error) {
			failures.push({ path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { removed, failures };
}
