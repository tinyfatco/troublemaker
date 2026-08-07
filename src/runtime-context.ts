import { createHash } from "crypto";
import { join } from "path";
import type { MomEvent } from "./adapters/types.js";

export const UNIFIED_RUNTIME_CONTEXT_KEY = "unified";

export interface RuntimeContextIdentity {
	key: string;
	awarenessDir: string;
	kind: "unified" | "zulip-topic";
	label: string;
	channelId?: string;
	topic?: string;
}

export function normalizeZulipTopic(topic: string | undefined): string {
	return (topic ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

/**
 * Map each Zulip stream topic to its own durable Pi context while preserving
 * the shared workspace, tools, settings, and memory files. Direct messages and
 * non-Zulip transports keep the existing unified context.
 */
export function resolveRuntimeContextIdentity(
	workingDir: string,
	event: Pick<MomEvent, "channel" | "threadTs">,
	adapterName: string,
): RuntimeContextIdentity {
	if (adapterName !== "zulip" || !/^[1-9]\d*$/.test(event.channel)) {
		return {
			key: UNIFIED_RUNTIME_CONTEXT_KEY,
			awarenessDir: join(workingDir, "awareness"),
			kind: "unified",
			label: "unified",
		};
	}

	const topic = normalizeZulipTopic(event.threadTs);
	const digest = createHash("sha256")
		.update(`${event.channel}\0${topic}`)
		.digest("hex")
		.slice(0, 24);
	const key = `zulip:${event.channel}:topic:${digest}`;
	return {
		key,
		awarenessDir: join(workingDir, "awareness", "threads", "zulip", `stream-${event.channel}`, digest),
		kind: "zulip-topic",
		label: topic ? `zulip:${event.channel}/${topic}` : `zulip:${event.channel}/(no topic)`,
		channelId: event.channel,
		topic,
	};
}

export function sameRuntimeContext(
	workingDir: string,
	left: Pick<MomEvent, "channel" | "threadTs">,
	leftAdapterName: string,
	right: Pick<MomEvent, "channel" | "threadTs">,
	rightAdapterName: string,
): boolean {
	return resolveRuntimeContextIdentity(workingDir, left, leftAdapterName).key
		=== resolveRuntimeContextIdentity(workingDir, right, rightAdapterName).key;
}
