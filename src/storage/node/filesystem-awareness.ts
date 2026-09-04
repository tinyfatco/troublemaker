import { appendFileSync, existsSync, openSync, readFileSync, readSync, closeSync, statSync } from "fs";
import { resolve } from "path";
import type { AwarenessBacklog, AwarenessStore } from "../awareness.js";
import { sanitizePrivateHandoffSessionLine } from "../../handoff-compaction.js";
import { sanitizeGeneratedFollowUpSessionLine } from "../../user-input-display.js";

function sanitizePublicSessionLine(line: string): string {
	return sanitizeGeneratedFollowUpSessionLine(sanitizePrivateHandoffSessionLine(line));
}

export class FilesystemAwarenessStore implements AwarenessStore {
	readonly contextPath: string;

	constructor(workspaceDir: string) {
		this.contextPath = resolve(workspaceDir, "awareness/context.jsonl");
	}

	appendLine(line: string): void {
		appendFileSync(this.contextPath, line.endsWith("\n") ? line : `${line}\n`, "utf-8");
	}

	readBacklog(limit: number, before = 0): AwarenessBacklog {
		const safeLimit = Math.min(limit || 50, 200);
		if (!existsSync(this.contextPath)) {
			return { lines: [], total: 0, offset: 0 };
		}

		const fileSize = statSync(this.contextPath).size;
		if (fileSize === 0) {
			return { lines: [], total: 0, offset: 0 };
		}

		if (before <= 0) {
			return this.readTail(safeLimit, fileSize);
		}

		const content = readFileSync(this.contextPath, "utf-8");
		const allLines = content.split("\n").filter(Boolean);
		const total = allLines.length;
		const endIndex = Math.min(before, total);
		const startIndex = Math.max(0, endIndex - safeLimit);
		return { lines: allLines.slice(startIndex, endIndex).map(sanitizePublicSessionLine), total, offset: startIndex };
	}

	private readTail(limit: number, fileSize: number): AwarenessBacklog {
		const chunkSize = 64 * 1024;
		const fd = openSync(this.contextPath, "r");
		try {
			let position = fileSize;
			let buffer = Buffer.alloc(0);
			let lineCount = 0;

			while (position > 0 && lineCount <= limit) {
				const readSize = Math.min(chunkSize, position);
				position -= readSize;
				const chunk = Buffer.alloc(readSize);
				readSync(fd, chunk, 0, readSize, position);
				buffer = Buffer.concat([chunk, buffer]);
				lineCount = 0;
				for (let i = 0; i < buffer.length; i++) {
					if (buffer[i] === 0x0a) lineCount++;
				}
			}

			const allLines = buffer.toString("utf-8").split("\n").filter(Boolean);
			const slice = allLines.slice(-limit);
			const offset = position > 0
				? Math.max(1, allLines.length - slice.length)
				: Math.max(0, allLines.length - slice.length);
			return { lines: slice.map(sanitizePublicSessionLine), total: allLines.length, offset };
		} finally {
			closeSync(fd);
		}
	}
}
