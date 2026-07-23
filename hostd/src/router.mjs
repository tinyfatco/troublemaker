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

}
