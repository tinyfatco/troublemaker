import { createHash } from "node:crypto";

export function siteActorRefForContext(contextId) {
	if (typeof contextId !== "string" || contextId.length === 0) {
		throw new Error("site_actor_context_invalid");
	}
	return `hostd-context:${createHash("sha256").update(contextId).digest("hex")}`;
}
