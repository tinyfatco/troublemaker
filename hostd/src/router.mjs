import { stablePrivateKey } from "./security.mjs";

export class ContextRouter {
	constructor(config, store, routingKey) {
		this.config = config;
		this.store = store;
		this.routingKey = routingKey;
	}

	resolve({ source, threadId, sender }) {
		const normalizedSender = sender.toLowerCase();
		const senderHash = stablePrivateKey(this.routingKey, "email-principal", normalizedSender);
		const existing = this.store.getRoute(source, threadId);
		if (existing) {
			if (existing.principalHash === senderHash) {
				this.store.ensurePrincipal(existing.principalHash, normalizedSender);
			}
			this.store.touchRoute(source, threadId);
			return this.store.getRoute(source, threadId);
		}

		const targetId = this.config.routing.actorTarget;
		const target = this.config.targetsById.get(targetId);
		if (!target) throw new Error(`router selected unavailable target ${targetId}`);

		const principalHash = senderHash;
		this.store.ensurePrincipal(principalHash, normalizedSender);
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
