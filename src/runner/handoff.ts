/**
 * Warm context handoff wiring: the `handoff_context` tool callback and the Pi
 * extension that requests a continuity checkpoint under context pressure.
 */
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MomSettingsManager } from "../context.js";
import {
	appendHandoffInstruction,
	estimateHandoffContextTokens,
	handoffToolInstruction,
	shouldRequestBoundedHandoff,
} from "../handoff-compaction.js";
import * as log from "../log.js";
import { createHandoffContextTool } from "../tools/handoff-context.js";
import { isCliHarnessProvider } from "./compaction.js";
import type { ContextTransitionTracker } from "./context-transitions.js";
import type { RunState } from "./run-state.js";

type HandoffSummary = Parameters<Parameters<typeof createHandoffContextTool>[0]>[0];

export interface HandoffToolDeps {
	getAgent: () => Agent;
	runState: RunState;
	getCompletedHandoffRotations: () => number;
	getRotationsAtRunStart: () => number;
	beginTransition: ContextTransitionTracker["beginTransition"];
}

/** The `handoff_context` tool: stage an agent-authored checkpoint for rotation. */
export function createRunnerHandoffTool(deps: HandoffToolDeps) {
	const { runState, beginTransition } = deps;
	return createHandoffContextTool((summary: HandoffSummary, resume: boolean) => {
		const agent = deps.getAgent();
		const completedHandoffRotations = deps.getCompletedHandoffRotations();
		const rotationsAtRunStart = deps.getRotationsAtRunStart();
		if (agent.state.messages.filter(m => m.role === "assistant").at(-1)?.content.filter(c => c.type === "toolCall").length !== 1) throw new Error("Call handoff_context alone, after other tools finish");
		if (runState.ctx?.message.sourceEventType === "handoff_continuation" && completedHandoffRotations > rotationsAtRunStart) return false;
		if (!runState.ctx) throw new Error("No conversation is active");
		const pressureCheckpoint = runState.handoffRequested && !runState.toolHandoff && !runState.capturedHandoff;
		if (runState.handoffRequested && !pressureCheckpoint) throw new Error("A handoff is already pending");
		if (completedHandoffRotations - rotationsAtRunStart >= 8) throw new Error("Too many handoffs in this run; return control to the user");
		summary.routing = { channel: runState.ctx.message.channel, replyTarget: runState.ctx.message.replyTarget || null };
		runState.handoffRequested = true;
		runState.toolHandoff = true;
		runState.handoffContinue = pressureCheckpoint ? true : resume;
		runState.capturedHandoff = {publicText: "", handoff: summary};
		if (!pressureCheckpoint) beginTransition("handoff", "agent");
	});
}

export interface HandoffContextExtensionDeps {
	settingsManager: MomSettingsManager;
	runState: RunState;
	getAgent: () => Agent;
	isForceHandoff: () => boolean;
	localPrefillLimit: number | undefined;
	transitions: Pick<ContextTransitionTracker, "beginTransition" | "finishTransition">;
}

/** Pi extension: request a warm checkpoint before a model call under context pressure. */
export function createHandoffContextExtension(deps: HandoffContextExtensionDeps) {
	const { settingsManager, runState, localPrefillLimit } = deps;
	const { beginTransition, finishTransition } = deps.transitions;
	return (pi: ExtensionAPI): void => {
		const requestHandoff = (messages: readonly AgentMessage[]) => {
			const agent = deps.getAgent();
			const forceHandoff = deps.isForceHandoff();
			const settings = settingsManager.getCompactionSettings();
			const ctx = runState.ctx;
			if (!ctx || (!settings.enabled && !forceHandoff) || settings.mode !== "handoff" || isCliHarnessProvider(agent.state.model?.provider)) return;
			// Telemetry-backed local models are intercepted transactionally before
			// AgentSession.prompt. Never stage their private checkpoint in the session.
			if (localPrefillLimit !== undefined && !forceHandoff) return;
			if (!runState.handoffRequested && (forceHandoff || shouldRequestBoundedHandoff(
				estimateHandoffContextTokens(messages), agent.state.model?.contextWindow || 200_000,
				settings.reserveTokens, settings.keepRecentTokens, localPrefillLimit,
			))) {
				runState.handoffRequested = true;
				beginTransition("handoff", forceHandoff ? "user" : "context_limit");
				log.logInfo("[handoff] Pressure threshold reached before model call; requesting a warm checkpoint");
			}
			return runState.handoffRequested ? ctx : undefined;
		};
		pi.on("before_agent_start", (event) => {
			// Pi 1.2+ also fires this for idle custom-message runs (`triggerTurn`); those carry `message`, not `prompt`.
			const startMessage = event.messageType === "user"
				? { role: "user" as const, content: event.prompt, timestamp: 0 }
				: event.message;
			requestHandoff([...deps.getAgent().state.messages, startMessage]);
		});
		pi.on("context", (event) => {
			// A tool checkpoint already contains its summary. Another model call
			// means steering/follow-up continued the segment before rotation.
			// That newer input supersedes the staged snapshot; preserve this context.
			if (runState.toolHandoff) {
				finishTransition("aborted");
				runState.handoffRequested = false;
				runState.toolHandoff = false;
				runState.capturedHandoff = null;
				runState.handoffContinue = false;
				return;
			}
			const ctx = requestHandoff(event.messages);
			if (!ctx) return;
			// Append a small control message without rewriting or duplicating the
			// runtime snapshot. The original messages remain an exact prefix.
			return { messages: appendHandoffInstruction(event.messages, handoffToolInstruction()) };
		});
		pi.on("tool_call", (event) => {
			if (runState.handoffRequested && !runState.toolHandoff && event.toolName !== "handoff_context") return {
				block: true,
				reason: "Continuity checkpoint required: call handoff_context now. Other tool work is paused until context rotation.",
			};
		});
	};
}
