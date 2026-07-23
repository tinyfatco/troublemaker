import { stablePrivateKey } from "./security.mjs";

export class ContextRouter {
	constructor(config, store, routingKey) {
		this.config = config;
		this.store = store;
		this.routingKey = routingKey;
	}

	resolve({ source, threadId, sender }) {
		const existing = this.store.getRoute(source, threadId);
		if (existing) {
			if (existing.nextContextId) return this.store.activatePendingRoute(source, threadId);
			this.store.touchRoute(source, threadId);
			return this.store.getRoute(source, threadId);
		}

		const normalizedSender = sender.toLowerCase();
		const targetId = this.config.routing.actorTarget;
		const target = this.config.targetsById.get(targetId);
		if (!target) throw new Error(`router selected unavailable target ${targetId}`);

		const principalHash = stablePrivateKey(this.routingKey, "email-principal", normalizedSender);
		this.store.ensurePrincipal(principalHash);
		const known = this.config.routing.knownPrincipals.find((principal) => principal.email === normalizedSender);
		for (const project of known?.projects ?? []) {
			this.store.ensureProject(principalHash, project.slug, project.name);
		}
		const projects = this.store.listProjects(principalHash).filter((project) => project.slug !== "intake");
		const projectSlug = projects.length === 1 ? projects[0].slug : "intake";
		this.store.ensureProject(
			principalHash,
			projectSlug,
			projectSlug === "intake" ? "Private intake" : projects[0].name,
		);
		const contextId = `${target.id}:${principalHash.slice(0, 24)}:${projectSlug}`;
		return this.store.bindRoute({
			source,
			providerThreadId: threadId,
			principalHash,
			targetId,
			contextId,
			projectSlug,
		});
	}

	bindProject({ source, threadId, principalHash, projectSlug, projectName }) {
		const route = this.store.getRoute(source, threadId);
		if (!route || route.principalHash !== principalHash) {
			throw new Error("conversation does not belong to this principal");
		}
		const normalizedSlug = projectSlug.trim().toLowerCase();
		if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(normalizedSlug) || normalizedSlug === "intake") {
			throw new Error("project slug is invalid or reserved");
		}
		this.store.ensureProject(principalHash, normalizedSlug, projectName || normalizedSlug);
		const contextId = `${route.targetId}:${principalHash.slice(0, 24)}:${normalizedSlug}`;
		return this.store.scheduleRouteProject(source, threadId, normalizedSlug, contextId);
	}
}
