import { stablePrivateKey } from "./security.mjs";

export function resolveSiteDeploymentBinding(config, store, target, contextId, routingKey) {
	if (!config.sites) return null;
	const scope = store.getContextScope(contextId, target.id);
	if (!scope) return null;

	if (scope.emailAddress) {
		const principal = config.routing.knownPrincipals.find(
			(candidate) => candidate.email === scope.emailAddress,
		);
		const project = principal?.projects.find((candidate) => candidate.slug === scope.projectSlug);
		return project?.siteDeployment || null;
	}

	if (!routingKey || scope.projectSlug !== "intake") return null;
	const principal = (config.routing.knownPhonePrincipals || []).find((candidate) => (
		stablePrivateKey(routingKey, "phone-principal", candidate.phone) === scope.principalHash
	));
	return principal?.siteDeployment || null;
}
