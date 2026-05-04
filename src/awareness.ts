import { randomUUID } from "crypto";
import { appendFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

/**
 * Append a system line to the agent's awareness context.jsonl.
 *
 * This is intentionally generic infrastructure, not live-presence state. It is
 * used for out-of-band system facts that should be visible to the agent on its
 * next run without enqueueing a new run.
 */
export function appendAwarenessLine(awarenessDir: string, line: string): void {
	const contextFile = join(awarenessDir, "context.jsonl");
	try {
		const timestamp = new Date().toISOString();
		const entry = {
			type: "message",
			id: randomUUID().substring(0, 8),
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text: `[${timestamp}] [awareness] [system]: ${line}` }],
			},
		};
		appendFileSync(contextFile, `${JSON.stringify(entry)}\n`);
	} catch (err) {
		log.logWarning("Failed to append awareness line", String(err));
	}
}
