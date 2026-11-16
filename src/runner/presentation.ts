/**
 * Live presentation of the active run: the runtime event sink and the
 * assistant-text boundaries tied to durable assistant message IDs.
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RuntimeStreamEvent } from "../core/runtime-contract.js";
import * as log from "../log.js";
import type { RunState } from "./run-state.js";

export function createRunPresentation(runState: RunState, getSessionManager: () => SessionManager) {
	const emitLiveEvent = (event: RuntimeStreamEvent): void => {
		const sink = runState.liveEventSink;
		if (!sink) return;
		try {
			const pending = sink(event);
			if (pending && typeof (pending as Promise<void>).catch === "function") {
				void (pending as Promise<void>).catch((error) => {
					log.logWarning("[live-events] Runtime event sink failed", error instanceof Error ? error.message : String(error));
				});
			}
		} catch (error) {
			log.logWarning("[live-events] Runtime event sink failed", error instanceof Error ? error.message : String(error));
		}
	};
	const assistantMessageIDsForRun = (): string[] => {
		try {
			const branch = getSessionManager().getBranch();
			const startIndex = runState.runStartLeafID
				? branch.findIndex((entry) => entry.id === runState.runStartLeafID) + 1
				: 0;
			const runEntries = startIndex > 0 || runState.runStartLeafID === null
				? branch.slice(startIndex)
				: [];
			return runEntries.flatMap((entry): string[] =>
				entry.type === "message" && entry.message.role === "assistant" ? [entry.id] : []);
		} catch (error) {
			log.logWarning(
				"[assistant-text] Could not reconcile durable assistant identity",
				error instanceof Error ? error.message : String(error),
			);
			return [];
		}
	};
	const claimNewAssistantMessageIDs = (): string[] => {
		const unclaimed = assistantMessageIDsForRun().filter(
			(id) => !runState.claimedAssistantMessageIDs.has(id),
		);
		for (const id of unclaimed) runState.claimedAssistantMessageIDs.add(id);
		return unclaimed;
	};
	const emitAssistantTextEvent = (event: RuntimeStreamEvent | null): void => {
		if (!event) return;
		emitLiveEvent(event);
		runState.ctx?.emitContentBlock?.({ ...event });
	};
	const closeAssistantPresentation = (): void => {
		emitAssistantTextEvent(runState.assistantText.boundary({
			durableMessageIds: claimNewAssistantMessageIDs(),
		}));
	};
	return {
		emitLiveEvent,
		assistantMessageIDsForRun,
		claimNewAssistantMessageIDs,
		emitAssistantTextEvent,
		closeAssistantPresentation,
	};
}

export type RunPresentation = ReturnType<typeof createRunPresentation>;
