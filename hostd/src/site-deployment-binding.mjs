import { stablePrivateKey } from "./security.mjs";

function resolveScopeOwner(config, store, target, contextId, routingKey) {
	const scope = store.getContextScope(contextId, target.id);
	if (!scope) return null;
	if (scope.emailAddress) {
		const principal = config.routing.knownPrincipals.find(
			(candidate) => candidate.email === scope.emailAddress,
		);
		const project = principal?.projects.find((candidate) => candidate.slug === scope.projectSlug);
		return project ? { scope, owner: project } : null;
	}
	if (!routingKey || scope.projectSlug !== "intake") return null;
	const principal = (config.routing.knownPhonePrincipals || []).find((candidate) => (
		stablePrivateKey(routingKey, "phone-principal", candidate.phone) === scope.principalHash
	));
	return principal ? { scope, owner: principal } : null;
}

export function resolveSiteFactory(config, store, target, contextId, routingKey) {
	if (!config.sites) return null;
	return resolveScopeOwner(config, store, target, contextId, routingKey)?.owner.siteFactory || null;
}

export function resolveSiteDeploymentBindings(config, store, target, contextId, routingKey) {
	if (!config.sites) return [];
	const resolved = resolveScopeOwner(config, store, target, contextId, routingKey);
	if (!resolved) return [];
	const configured = resolved.owner.siteDeployments
		?? (resolved.owner.siteDeployment ? [resolved.owner.siteDeployment] : []);
	const durable = typeof store.listSiteDeploymentBindings === "function"
		? store.listSiteDeploymentBindings(contextId).filter((binding) => binding.status === "active")
		: [];
	const bySlug = new Map(configured.map((binding) => [binding.siteSlug, binding]));
	for (const binding of durable) {
		if (!bySlug.has(binding.siteSlug)) bySlug.set(binding.siteSlug, binding);
	}
	return [...bySlug.values()];
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
