import { join } from "path";

export const ATTENTION_DIR = "attention";
export const ATTENTION_QUEUE_DIR = "attention/queue";
export const ATTENTION_HISTORY_DIR = "attention/history";
export const LEGACY_EVENTS_DIR = "events";

export function attentionQueueDir(workspaceDir: string): string {
	return join(workspaceDir, ATTENTION_QUEUE_DIR);
}

export function attentionHistoryDir(workspaceDir: string): string {
	return join(workspaceDir, ATTENTION_HISTORY_DIR);
}

export function legacyEventsDir(workspaceDir: string): string {
	return join(workspaceDir, LEGACY_EVENTS_DIR);
}
