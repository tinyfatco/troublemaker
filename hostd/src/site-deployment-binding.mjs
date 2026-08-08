import { stablePrivateKey } from "./security.mjs";

export function resolveSiteDeploymentBindings(config, store, target, contextId, routingKey) {
	if (!config.sites) return [];
	const scope = store.getContextScope(contextId, target.id);
	if (!scope) return [];

	if (scope.emailAddress) {
		const principal = config.routing.knownPrincipals.find(
			(candidate) => candidate.email === scope.emailAddress,
		);
		const project = principal?.projects.find((candidate) => candidate.slug === scope.projectSlug);
		return project?.siteDeployments
			?? (project?.siteDeployment ? [project.siteDeployment] : []);
	}

	if (!routingKey || scope.projectSlug !== "intake") return [];
	const principal = (config.routing.knownPhonePrincipals || []).find((candidate) => (
		stablePrivateKey(routingKey, "phone-principal", candidate.phone) === scope.principalHash
	));
	return principal?.siteDeployments
		?? (principal?.siteDeployment ? [principal.siteDeployment] : []);
}

export function resolveSiteDeploymentBinding(
	config,
	store,
	target,
	contextId,
	routingKey,
	requestedSiteSlug,
) {
	const bindings = resolveSiteDeploymentBindings(config, store, target, contextId, routingKey);
	if (requestedSiteSlug) {
		return bindings.find((binding) => binding.siteSlug === requestedSiteSlug) || null;
	}
	return bindings.length === 1 ? bindings[0] : null;
}
