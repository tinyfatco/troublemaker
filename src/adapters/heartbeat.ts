/**
 * HeartbeatAdapter — headless adapter for spontaneous agent wake-ups.
 *
 * Always created implicitly (not via --adapter flag). Scheduling remains in
 * the attention queue; the shared checkpoint primitive only owns bounded,
 * sequential, headless execution.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";
import { HeadlessCheckpointAdapter } from "./checkpoint.js";
import type { MomEvent } from "./types.js";

export const HEARTBEAT_CHANNEL_ID = "heartbeat";

const HEARTBEAT_FORMAT_INSTRUCTIONS = `## Heartbeat (Internal Reflection)
You are waking up for a spontaneous reflection. This is your internal channel — no one sees this directly unless they check the awareness stream.

Review your recent context and decide what to do:

1. **Incomplete work:** Did anything crash or fail to deliver? If so, pick it up and finish it. Use \`send_message\` with an explicit target to deliver on the right channel (email, Telegram, Slack, Discord).
2. **Proactive outreach:** Is there anything worth reaching out to your owner about? A follow-up, a reminder, something you noticed? Use \`send_message\` with an explicit target to send it on the appropriate channel.
3. **Observations:** Note anything interesting in your context — patterns, pending items, things to watch. Even if you don't act, a brief observation is valuable.

If nothing needs attention, note a brief thought and go back to sleep. Avoid saying "nothing to do" — find something worth noticing, even if small.`;

/**
 * Check if HEARTBEAT.md content is effectively empty — only whitespace,
 * markdown headers, or empty list items. Means the agent/owner has
 * deliberately cleared the checklist → skip the heartbeat run.
 */
function isEffectivelyEmpty(content: string): boolean {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (/^#+(\s|$)/.test(trimmed)) continue;
		if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) continue;
		return false;
	}
	return true;
}

function readHeartbeatFile(workingDir: string): { exists: boolean; content: string } {
	const filePath = join(workingDir, "HEARTBEAT.md");
	try {
		if (existsSync(filePath)) {
			return { exists: true, content: readFileSync(filePath, "utf-8") };
		}
	} catch {}
	return { exists: false, content: "" };
}

function prepareHeartbeatEvent(workingDir: string, event: MomEvent): MomEvent | null {
	const heartbeat = readHeartbeatFile(workingDir);
	if (heartbeat.exists && isEffectivelyEmpty(heartbeat.content)) {
		log.logInfo("Heartbeat skipped (HEARTBEAT.md empty)");
		return null;
	}
	if (heartbeat.exists && heartbeat.content.trim()) {
		event.text += `\n\n## Heartbeat Checklist\n${heartbeat.content.trim()}`;
		log.logInfo("Heartbeat: injected HEARTBEAT.md content");
	}
	return event;
}

export class HeartbeatAdapter extends HeadlessCheckpointAdapter {
	constructor(config: { workingDir: string }) {
		super({
			name: "heartbeat",
			channelName: "heartbeat",
			workingDir: config.workingDir,
			formatInstructions: HEARTBEAT_FORMAT_INSTRUCTIONS,
			queueLimit: 3,
			channels: [{ id: HEARTBEAT_CHANNEL_ID, name: "heartbeat" }],
			acceptsEvent: (event) => event.channel === HEARTBEAT_CHANNEL_ID,
			prepareEvent: (event) => prepareHeartbeatEvent(config.workingDir, event),
			createMessage: (event) => ({
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: "heartbeat",
				channel: event.channel,
				ts: event.ts,
				attachments: [],
			}),
			startLog: "Heartbeat adapter ready",
			queueFullLog: (event) => `Heartbeat queue full, discarding: ${event.text.substring(0, 50)}`,
			eventEnqueuedLog: (event) => `Heartbeat event enqueued: ${event.text.substring(0, 80)}`,
			runFailedLog: "Heartbeat run failed",
			botResponseEntry: (channel, text, ts) => ({
				date: new Date().toISOString(),
				ts,
				channel: `heartbeat:${channel}`,
				channelId: channel,
				user: "bot",
				text,
				attachments: [],
				isBot: true,
			}),
		});
	}

	async runScheduledEvent(event: MomEvent): Promise<void> {
		await this.runCheckpoint(event);
	}
}
