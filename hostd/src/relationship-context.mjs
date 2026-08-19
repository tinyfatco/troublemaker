import { stablePrivateKey } from "./security.mjs";

export const RELATIONSHIP_OPERATOR_CONTEXT_SUFFIX = "relationship-operator";

function requiredIdentity(value, label) {
	if (typeof value !== "string" || !value) {
		throw new Error(`relationship ${label} is required`);
	}
	return value;
}

/**
 * Resolve the durable context that owns one verified relationship.
 *
 * Email and web-chat scopes already use one principal/project context. Phone
 * custody is stricter: include the native thread in a keyed, non-reversible
 * identifier so two relationships for the same principal can never collapse
 * into one intake runtime.
 */
export function relationshipOperatorContextId(routingKey, {
	targetId,
	source,
	providerThreadId,
	principalHash,
	projectSlug,
}) {
	const target = requiredIdentity(targetId, "target");
	const relationshipSource = requiredIdentity(source, "source");
	const principal = requiredIdentity(principalHash, "principal");
	const project = requiredIdentity(projectSlug, "project");
	if (relationshipSource !== "phone") {
		return `${target}:${principal.slice(0, 24)}:${project}`;
	}
	const thread = requiredIdentity(providerThreadId, "provider thread");
	const custodyId = stablePrivateKey(
		routingKey,
		"relationship-operator-context",
		JSON.stringify([target, relationshipSource, thread, principal, project]),
	).slice(0, 24);
	return `${target}:${custodyId}:${RELATIONSHIP_OPERATOR_CONTEXT_SUFFIX}`;
}
