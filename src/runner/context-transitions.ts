/**
 * Durable, client-visible record of a context transition (handoff rotation or
 * compaction): persisted to the workspace and published as a status event.
 */
import { randomUUID } from "crypto";
import { saveContextTransition, type ContextTransition } from "../context-transition.js";
import type { RuntimeStreamEvent } from "../core/runtime-contract.js";
import type { MomContext } from "../adapters/types.js";

export function createContextTransitionTracker(
	workspaceDir: string,
	emitLiveEvent: (event: RuntimeStreamEvent) => void,
	getRunContext: () => MomContext | null,
) {
	let activeTransition: ContextTransition | null = null;
	const publishTransition = (value: ContextTransition) => {
		saveContextTransition(workspaceDir, value);
		const event = {type: "status" as const, status: value.state === "preparing" ? "compacting" as const : "streaming" as const, contextTransition: value};
		emitLiveEvent(event);
		getRunContext()?.emitContentBlock?.(event);
	};
	const beginTransition = (kind: ContextTransition["kind"], trigger: ContextTransition["trigger"]) => {
		if (activeTransition) return;
		const now = new Date().toISOString();
		activeTransition = {version: 1, id: randomUUID(), kind, trigger, state: "preparing", revision: 1, startedAt: now, updatedAt: now};
		publishTransition(activeTransition);
	};
	const finishTransition = (state: ContextTransition["state"], counts: Partial<Pick<ContextTransition, "tokensBefore" | "tokensAfter" | "retainedMessages">> = {}) => {
		if (!activeTransition) return;
		publishTransition({...activeTransition, ...counts, state, revision: 2, updatedAt: new Date().toISOString()});
		activeTransition = null;
	};
	return {
		beginTransition,
		finishTransition,
		getActiveTransition: (): ContextTransition | null => activeTransition,
	};
}

export type ContextTransitionTracker = ReturnType<typeof createContextTransitionTracker>;
