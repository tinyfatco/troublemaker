import { stablePrivateKey } from "./security.mjs";

function configuredScopeOwner(config, scope, routingKey) {
	if (scope.emailAddress) {
		const principal = config.routing.knownPrincipals.find(
			(candidate) => candidate.email === scope.emailAddress,
		);
		return principal?.projects.find((candidate) => candidate.slug === scope.projectSlug) || null;
	}
	if (!routingKey || scope.projectSlug !== "intake") return null;
	return (config.routing.knownPhonePrincipals || []).find((candidate) => (
		stablePrivateKey(routingKey, "phone-principal", candidate.phone) === scope.principalHash
	)) || null;
}

function relationshipFactoryOwner(factory) {
	if (!factory || factory.status !== "active" || !factory.userId) return null;
	return {
		customerId: factory.customerId,
		userId: factory.userId,
		projectId: factory.projectId,
		grantId: factory.grantId,
		maximumSites: factory.maximumSites,
		artifactKinds: factory.artifactKinds,
		allowedBranches: factory.allowedBranches,
		hostnameMode: factory.hostnameMode,
		relationshipId: factory.relationshipId,
		ownershipMode: "relationship",
	};
}

function contextScope(config, store, target, contextId, routingKey) {
	const scope = store.getContextScope(contextId, target.id);
	if (!scope) return null;
	const configuredOwner = configuredScopeOwner(config, scope, routingKey);
	const relationshipFactory = store.getSiteRelationshipFactory?.(contextId);
	if (
		relationshipFactory
		&& (
			relationshipFactory.principalHash !== scope.principalHash
			|| relationshipFactory.targetId !== target.id
		)
	) {
		throw new Error("site_relationship_factory_scope_mismatch");
	}
	return { scope, configuredOwner, relationshipFactory };
}

export function resolveSiteRelationshipScope(config, store, target, contextId, routingKey) {
	if (!config.sites?.relationshipFactory) return null;
	const resolved = contextScope(config, store, target, contextId, routingKey);
	if (
		!resolved
		|| resolved.configuredOwner?.siteFactory
		|| resolved.configuredOwner?.siteDeployment
		|| (resolved.configuredOwner?.siteDeployments?.length ?? 0) > 0
	) return null;
	return {
		scope: resolved.scope,
		policy: config.sites.relationshipFactory,
		existing: resolved.relationshipFactory || null,
	};
}

export function resolveSiteFactory(config, store, target, contextId, routingKey) {
	if (!config.sites) return null;
	const resolved = contextScope(config, store, target, contextId, routingKey);
	if (!resolved) return null;
	if (resolved.configuredOwner?.siteFactory) return resolved.configuredOwner.siteFactory;
	if (!config.sites.relationshipFactory) return null;
	return relationshipFactoryOwner(resolved.relationshipFactory);
}

export function resolveSiteDeploymentBindings(config, store, target, contextId, routingKey) {
	if (!config.sites) return [];
	const resolved = contextScope(config, store, target, contextId, routingKey);
	if (!resolved) return [];
	const configured = resolved.configuredOwner?.siteDeployments
		?? (resolved.configuredOwner?.siteDeployment ? [resolved.configuredOwner.siteDeployment] : []);
	const relationshipActive = relationshipFactoryOwner(resolved.relationshipFactory);
	if (!resolved.configuredOwner && !relationshipActive) return [];
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
