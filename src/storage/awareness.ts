export interface AwarenessBacklog {
	lines: string[];
	total: number;
	offset: number;
}

export interface AwarenessStore {
	appendLine(line: string): void;
	readBacklog(limit: number, before?: number): AwarenessBacklog;
	contextPath?: string;
}
