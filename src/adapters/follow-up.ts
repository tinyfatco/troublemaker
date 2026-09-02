/**
 * FollowUpAdapter — headless adapter for agent-global idle evaluations.
 *
 * Checkpoints carry no conversation or reply target. Their finite schedule,
 * durable generation claim, and restart reconciliation remain in follow-ups.ts;
 * this adapter shares only the generic headless execution boundary.
 */

import { HeadlessCheckpointAdapter } from "./checkpoint.js";

const FOLLOW_UP_FORMAT_INSTRUCTIONS = `## Natural Follow-up Evaluation (Internal)
This is an agent-global headless checkpoint, not a direct user message and not part of any assumed conversation. Review open loops across the agent with list_channels and read_thread when useful. If one concise follow-up is warranted, call send_message exactly once with the appropriate explicit target. Otherwise call yield_no_action. Ordinary assistant text, working output, typing indicators, and harness errors are not delivered.`;

export class FollowUpAdapter extends HeadlessCheckpointAdapter {
	constructor(config: { workingDir: string }) {
		super({
			name: "follow-up",
			channelName: "follow-up",
			workingDir: config.workingDir,
			formatInstructions: FOLLOW_UP_FORMAT_INSTRUCTIONS,
			queueLimit: 24,
			acceptsEvent: (event) => Boolean(event.followUp) && event.sourceEventType === "follow_up",
			createMessage: (event) => ({
				text: event.text,
				rawText: event.rawText ?? event.text,
				user: event.user,
				userName: "follow-up",
				channel: event.channel,
				ts: event.ts,
				eventType: event.type,
				sourceEventType: event.sourceEventType,
				directlyAddressed: false,
				threadTs: event.threadTs,
				replyTarget: event.replyTarget,
				replyTargetDescription: event.replyTargetDescription,
				attachments: [],
			}),
			startLog: "Follow-up adapter ready",
			queueFullLog: (event) => `[follow-ups] Headless queue full, discarding wake ${event.followUp!.key}`,
			runFailedLog: "[follow-ups] Headless run failed",
		});
	}
}
