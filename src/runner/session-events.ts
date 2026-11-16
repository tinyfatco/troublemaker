/**
 * Translate Pi AgentSession events into the runner's outputs: logs, live
 * snapshots and assistant-text events, platform tool progress, thread
 * transcripts, usage totals, and compaction/transition status.
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { isClaudeCliProvider } from "../claude-cli.js";
import type { ClaudeCliRuntimeToolEvent } from "../claude-cli-mcp.js";
import { projectToolInvocationDetails, projectToolResultDetails } from "../console/tool-detail-projection.js";
import * as log from "../log.js";
import { registerToolDisplayBarrier } from "../streaming/tool-delivery-barrier.js";
import { buildToolPresentation, TOOL_PRESENTATION_CUSTOM_TYPE } from "../streaming/tool-presentation.js";
import type { SteeringProjectionTracker } from "../streaming/steering-projection.js";
import type { UserInputProvenance } from "../streaming/user-input-provenance.js";
import { shouldRolloverWorkingAfterToolCompletion } from "../streaming/working-rollover.js";
import type { ToolOutputEvent } from "../tools/tool-output-stream.js";
import { readableToolName } from "../tools/tool-label.js";
import { isYieldNoActionToolName } from "../tools/yield-no-action.js";
import type { ContextTransitionTracker } from "./context-transitions.js";
import { cleanToolCallLabel, extractToolResultText, formatToolArgs, hasContent, sanitizeStreamingMessage, truncate } from "./event-format.js";
import type { RunPresentation } from "./presentation.js";
import type { RunState } from "./run-state.js";

export interface SessionEventHandlerDeps {
	runState: RunState;
	presentation: Pick<RunPresentation, "emitLiveEvent" | "emitAssistantTextEvent" | "closeAssistantPresentation">;
	beginCompaction: (reason: unknown) => void;
	finishCompaction: () => void;
	transitions: Pick<ContextTransitionTracker, "beginTransition" | "finishTransition">;
	userInputProvenance: UserInputProvenance;
	steeringProjections: SteeringProjectionTracker;
	getSessionManager: () => SessionManager;
	/** Activity callback for external watchdog (read on every event). */
	getOnActivity: () => (() => void) | undefined;
}

export function createSessionEventHandlers(deps: SessionEventHandlerDeps): {
	eventHandler: (event: any) => Promise<void>;
	toolEventHandler: (event: ClaudeCliRuntimeToolEvent) => Promise<void>;
	toolOutputHandler: (event: ToolOutputEvent) => void;
} {
	const { runState, beginCompaction, finishCompaction, userInputProvenance, steeringProjections, getSessionManager } = deps;
	const { emitLiveEvent, emitAssistantTextEvent, closeAssistantPresentation } = deps.presentation;
	const { beginTransition, finishTransition } = deps.transitions;

	let _eventSeq = 0;
	// Claude CLI runs tools over MCP, outside the agent loop, so its persisted
	// assistant message holds only text. Save a display-only record of the
	// turn's interleaved tool calls so reloaded transcripts keep them. Deferred
	// one tick so it lands after AgentSession persists the message itself.
	const persistToolPresentation = (message: any) => {
		if (runState.handoffRequested || !isClaudeCliProvider(message?.provider)) return;
		const presentation = buildToolPresentation(runState.liveSnapshot.current(false), Number(message?.timestamp));
		if (!presentation) return;
		setImmediate(() => {
			try {
				getSessionManager().appendCustomEntry(TOOL_PRESENTATION_CUSTOM_TYPE, presentation);
			} catch (error) {
				log.logWarning("Could not persist tool presentation", error instanceof Error ? error.message : String(error));
			}
		});
	};
	const eventHandler = async (event: any) => {
		if (event.type === "compaction_start") { beginCompaction(event.reason); beginTransition("compaction", "context_limit"); }
		else if (event.type === "compaction_end") { finishCompaction(); const e = event as any; finishTransition(e.result ? "completed" : e.aborted ? "aborted" : e.errorMessage ? "failed" : "skipped", e.result ? {tokensBefore: e.result.tokensBefore} : {}); }
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		_eventSeq++;
		if (event.type === "tool_execution_start" || event.type === "message_start" || event.type === "message_end") {
			log.logInfo(`[debug] eventHandler seq=${_eventSeq} type=${event.type} id=${event.toolCallId || event.message?.role || "?"}`);
		}

		// Signal activity on any substantive event
		deps.getOnActivity()?.();

		const { ctx, logCtx, queue, pendingTools } = runState;
		const emitSnapshot = (isStreaming = true) => {
			const entry = runState.liveSnapshot.current(isStreaming);
			if (!entry) return;
			const snapshot = { type: "assistant_snapshot" as const, entry };
			emitLiveEvent(snapshot);
			ctx.emitContentBlock?.(snapshot);
		};

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			closeAssistantPresentation();
			const privateCheckpointTool = runState.handoffRequested && agentEvent.toolName === "handoff_context";
			if (privateCheckpointTool) {
				runState.toolsUsed.push(agentEvent.toolName);
				return;
			}
			const silentChannelTool = isYieldNoActionToolName(agentEvent.toolName);
			const args = agentEvent.args && typeof agentEvent.args === "object"
				? agentEvent.args as Record<string, unknown>
				: {};
			const label = cleanToolCallLabel(args.label) || readableToolName(agentEvent.toolName);
			const show = args.show === true || agentEvent.toolName === "send_message";

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
				label,
				show,
			});
			runState.toolsUsed.push(agentEvent.toolName);

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			runState.liveSnapshot.upsertToolCall(
				agentEvent.toolCallId,
				agentEvent.toolName,
				args,
				label,
			);
			emitSnapshot(true);
			ctx.emitContentBlock?.({ type: "toolCall", id: agentEvent.toolCallId, name: agentEvent.toolName, label, arguments: args });
			if (!silentChannelTool) {
				const displayBarrier = queue.enqueue(
					() => ctx.updateToolProgress
						? ctx.updateToolProgress({
							id: agentEvent.toolCallId,
							label,
							status: "in_progress",
							show,
							details: projectToolInvocationDetails({ name: agentEvent.toolName, arguments: args }),
						})
						: ctx.respond(`_→ ${label}_`, false, { show }),
					"tool label",
				);
				registerToolDisplayBarrier(agentEvent.toolCallId, displayBarrier);
			}
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			if (runState.handoffRequested && agentEvent.toolName === "handoff_context") return;
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			const label = pending?.label;
			const argsFormatted = pending
				? formatToolArgs(agentEvent.toolName, pending.args as Record<string, unknown>)
				: "(args not found)";
			const duration = (durationMs / 1000).toFixed(1);
			let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
			if (label && label !== agentEvent.toolName) threadMessage += `: ${label}`;
			threadMessage += ` (${duration}s)\n`;
			if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
			threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

			runState.liveSnapshot.upsertToolResult(agentEvent.toolCallId, resultStr, agentEvent.isError || false);
			emitSnapshot(true);
			ctx.emitContentBlock?.({ type: "toolResult", toolCallId: agentEvent.toolCallId, result: resultStr, isError: agentEvent.isError || false });
			if (!isYieldNoActionToolName(agentEvent.toolName)) {
				if (ctx.updateToolProgress && pending) {
					queue.enqueue(
						() => ctx.updateToolProgress!({
							id: agentEvent.toolCallId,
							label: pending.label,
							status: agentEvent.isError ? "error" : "complete",
							show: pending.show,
							details: projectToolResultDetails({
								name: agentEvent.toolName,
								result: resultStr,
								isError: agentEvent.isError === true,
								durationMs,
							}),
						}),
						"tool progress completion",
					);
				}
				queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);
			}

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}

			if (shouldRolloverWorkingAfterToolCompletion({
				toolName: agentEvent.toolName,
				isError: agentEvent.isError || false,
				args: pending?.args,
				result: agentEvent.result,
				activeReplyTarget: ctx.workingReplyTarget === null
					? undefined
					: (ctx.workingReplyTarget ?? ctx.message.replyTarget),
				workingStreamPresentation: ctx.workingStreamPresentation,
			})) {
				queue.enqueue(() => ctx.restartWorking(), "restart working after inline send");
			}
		} else if (event.type === "message_update") {
			const agentEvent = event as AgentEvent & { type: "message_update" };
			const projectedMessage = runState.handoffRequested ? sanitizeStreamingMessage(agentEvent.message, false) : agentEvent.message;
			runState.liveSnapshot.updateAssistantMessage(projectedMessage);
			const assistantText = runState.assistantText.update(
				projectedMessage,
				agentEvent.assistantMessageEvent?.type,
			);
			if (assistantText) {
				emitAssistantTextEvent(assistantText);
			}
			emitSnapshot(true);
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				const projectedMessage = runState.handoffRequested ? sanitizeStreamingMessage(agentEvent.message, false) : agentEvent.message;
				closeAssistantPresentation();
				log.logResponseStart(logCtx);
				runState.liveSnapshot.beginAssistantMessage(projectedMessage);
				const assistantText = runState.assistantText.begin(projectedMessage);
				if (assistantText) {
					emitAssistantTextEvent(assistantText);
				}
				emitSnapshot(true);
			} else if (agentEvent.message.role === "user") {
				const messageContent = agentEvent.message.content;
				const promptText = typeof messageContent === "string"
					? messageContent
					: messageContent.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
				const entries = userInputProvenance.apply(agentEvent.message);
				steeringProjections.consume(promptText);
				if (entries.length > 0) {
					closeAssistantPresentation();
					emitLiveEvent({ type: "user_input", entries });
				}

				if (runState.initialPromptSent) {
					log.logInfo(`[awareness] Steered message detected, restarting working message`);
					queue.enqueue(async () => {
						await ctx.restartWorking();
					}, "restart working for steer");
				} else {
					runState.initialPromptSent = true;
				}
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const projectedMessage = runState.handoffRequested ? sanitizeStreamingMessage(agentEvent.message, true) : agentEvent.message;
				runState.liveSnapshot.endAssistantMessage(projectedMessage);
				const assistantText = runState.assistantText.end(projectedMessage);
				if (assistantText) {
					emitAssistantTextEvent(assistantText);
				}
				emitSnapshot(false);
				persistToolPresentation(agentEvent.message);
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				if (!hasContent(projectedMessage)) return;
				const content = projectedMessage.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "thinking") {
						// Only extract .thinking text — never .signature or other fields
						const thinkingText = (part as any).thinking;
						if (typeof thinkingText === "string" && thinkingText.trim()) {
							thinkingParts.push(thinkingText);
						}
					} else if (part.type === "text") {
						const t = (part as any).text;
						if (typeof t === "string") {
							textParts.push(t);
						}
					}
					// Silently skip unknown content block types (e.g. signature blocks)
				}

				const text = textParts.join("\n");

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					const lines = thinking.trim().split("\n").map((l: string) => l.trim()).filter(Boolean);
					const formatted = "💭 " + lines.map((l: string) => `_${l}_`).join("\n");
					queue.enqueueMessage(formatted, "main", "thinking main");
					queue.enqueueMessage(formatted, "thread", "thinking thread", false);
				}

				// Guard: skip text that looks like leaked debug output or serialized objects
				if (text.trim() && !text.trim().startsWith("(Empty response:") && !text.trim().startsWith("{'content':")) {
					log.logResponse(logCtx, text);
					queue.enqueueMessage(text, "main", "response main");
					queue.enqueueMessage(text, "thread", "response thread", false);
				} else if (text.trim()) {
					log.logWarning("Suppressed leaked debug output from response", text.substring(0, 100));
				}
			}
		} else if (event.type === "compaction_start") {
			log.logInfo(`Compaction started (reason: ${(event as any).reason})`);
			closeAssistantPresentation();
			const status = { type: "status" as const, status: "compacting" as const, message: "Compacting context..." };
			emitLiveEvent(status);
			ctx.emitContentBlock?.(status);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "compaction_end") {
			closeAssistantPresentation();
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.aborted) {
				log.logInfo("Compaction aborted");
			} else {
				// FAT-279 — surface silent no-ops so ping-pong cases are visible.
				// result: undefined with no abort means prepareCompaction returned null
				// (nothing to summarize) or model/apiKey was missing.
				log.logInfo(`Compaction no-op: ${compEvent.errorMessage || "nothing to compact or missing model/key"}`);
			}
			const message = compEvent.result
				? "Context compacted; resuming..."
				: compEvent.aborted
					? "Compaction stopped; resuming..."
					: "Compaction skipped; resuming...";
			const status = { type: "status" as const, status: "streaming" as const, message };
			emitLiveEvent(status);
			ctx.emitContentBlock?.(status);
		} else if (event.type === "auto_retry_start") {
			closeAssistantPresentation();
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		}
	};
	const toolOutputHandler = (event: ToolOutputEvent): void => {
		runState.liveSnapshot.appendToolOutput(event);
		const entry = runState.liveSnapshot.current(true);
		if (entry) {
			const snapshot = { type: "assistant_snapshot" as const, entry };
			emitLiveEvent(snapshot);
			runState.ctx?.emitContentBlock?.(snapshot);
		}
		deps.getOnActivity()?.();
	};
	return { eventHandler, toolEventHandler: eventHandler, toolOutputHandler };
}
