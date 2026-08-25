import { stablePrivateKey } from "./security.mjs";
import { relationshipOperatorContextId } from "./relationship-context.mjs";

export class RouteParticipantDeniedError extends Error {
	constructor(source, threadId) {
		super(`sender is not an authorized participant in ${source} thread ${threadId}`);
		this.name = "RouteParticipantDeniedError";
		this.code = "route_participant_denied";
	}
}

export class RelationshipContextMismatchError extends Error {
	constructor(source) {
		super(`verified ${source} relationship requires a custody migration`);
		this.name = "RelationshipContextMismatchError";
		this.code = "relationship_context_migration_required";
	}
}

export class ContextRouter {
	constructor(config, store, routingKey) {
		this.config = config;
		this.store = store;
		this.routingKey = routingKey;
	}

	ensurePrincipalScope(sender, { project, label, targetId: requestedTargetId } = {}) {
		const normalizedSender = sender.toLowerCase();
		const principalHash = stablePrivateKey(this.routingKey, "email-principal", normalizedSender);
		const known = this.config.routing.knownPrincipals.find((principal) => principal.email === normalizedSender);
		const targetId = requestedTargetId ?? known?.targetId ?? this.config.routing.actorTarget;
		const target = this.config.targetsById.get(targetId);
		if (!target) throw new Error(`router selected unavailable target ${targetId}`);

		this.store.ensurePrincipal(principalHash, normalizedSender, label);
		for (const project of known?.projects ?? []) {
			this.store.ensureProject(principalHash, project.slug, project.name);
		}
		if (project) this.store.ensureProject(principalHash, project.slug, project.name);
		const projects = this.store.listProjects(principalHash).filter((candidate) => candidate.slug !== "intake");
		const projectSlug = project?.slug ?? (projects.length === 1 ? projects[0].slug : "intake");
		this.store.ensureProject(
			principalHash,
			projectSlug,
			projectSlug === "intake"
				? "Private intake"
				: (project?.name ?? projects.find((candidate) => candidate.slug === projectSlug)?.name),
		);
		return {
			principalHash,
			targetId,
			contextId: `${target.id}:${principalHash.slice(0, 24)}:${projectSlug}`,
			projectSlug,
		};
	}

	ensureKnownPrincipalScopes() {
		return this.config.routing.knownPrincipals.map((principal) => ({
			email: principal.email,
			name: principal.name,
			...this.ensurePrincipalScope(principal.email, { targetId: principal.targetId }),
		}));
	}

	ensurePhoneScope(contactAddress, { providerThreadId, label } = {}) {
		const normalized = contactAddress.trim();
		const principalHash = stablePrivateKey(this.routingKey, "phone-principal", normalized);
		const known = this.config.routing.knownPhonePrincipals?.find((principal) => principal.phone === normalized);
		const targetId = known?.targetId ?? this.config.routing.actorTarget;
		const target = this.config.targetsById.get(targetId);
		if (!target) throw new Error(`router selected unavailable target ${targetId}`);
		this.store.ensurePrincipal(principalHash, undefined, label);
		this.store.ensureProject(principalHash, "intake", "Private intake");
		return {
			principalHash,
			targetId,
			contextId: relationshipOperatorContextId(this.routingKey, {
				targetId: target.id,
				source: "phone",
				providerThreadId,
				principalHash,
				projectSlug: "intake",
			}),
			projectSlug: "intake",
		};
	}

	ensureWebChatScope(sessionId, { label } = {}) {
		const normalized = sessionId.trim().toLowerCase();
		const principalHash = stablePrivateKey(this.routingKey, "web-chat-principal", normalized);
		const targetId = this.config.routing.actorTarget;
		const target = this.config.targetsById.get(targetId);
		if (!target) throw new Error(`router selected unavailable target ${targetId}`);
		this.store.ensurePrincipal(principalHash, undefined, label);
		this.store.ensureProject(principalHash, "website-chat", "Website chat");
		return {
			principalHash,
			targetId,
			contextId: `${target.id}:${principalHash.slice(0, 24)}:website-chat`,
			projectSlug: "website-chat",
		};
	}

	resolveWebChat({ sessionId, label }) {
		const providerThreadId = sessionId.trim().toLowerCase();
		const principalHash = stablePrivateKey(
			this.routingKey,
			"web-chat-principal",
			providerThreadId,
		);
		const existing = this.store.getRoute("web-chat", providerThreadId);
		if (existing) {
			if (!this.store.hasRouteParticipant("web-chat", providerThreadId, principalHash)) {
				throw new RouteParticipantDeniedError("web-chat", providerThreadId);
			}
			this.store.ensurePrincipal(principalHash, undefined, label);
			this.store.touchRoute("web-chat", providerThreadId);
			this.store.touchRouteParticipant("web-chat", providerThreadId, principalHash);
			return existing;
		}
		const scope = this.ensureWebChatScope(providerThreadId, { label });
		return this.store.bindRoute({
			source: "web-chat",
			providerThreadId,
			...scope,
		});
	}

	resolvePhone({ providerThreadId, contactAddress, label }) {
		const scope = this.ensurePhoneScope(contactAddress, { providerThreadId, label });
		const existing = this.store.getRoute("phone", providerThreadId);
		if (existing) {
			if (!this.store.hasRouteParticipant("phone", providerThreadId, scope.principalHash)) {
				throw new RouteParticipantDeniedError("phone", providerThreadId);
			}
			if (
				existing.principalHash !== scope.principalHash
				|| existing.projectSlug !== scope.projectSlug
				|| existing.targetId !== scope.targetId
				|| existing.contextId !== scope.contextId
			) throw new RelationshipContextMismatchError("phone");
			this.store.touchRoute("phone", providerThreadId);
			this.store.touchRouteParticipant("phone", providerThreadId, scope.principalHash);
			return existing;
		}
		return this.store.bindRoute({
			source: "phone",
			providerThreadId,
			...scope,
		});
	}

	resolve({ source, threadId, sender, project, label, targetId }) {
		const normalizedSender = sender.toLowerCase();
		const principalHash = stablePrivateKey(this.routingKey, "email-principal", normalizedSender);
		const existing = this.store.getRoute(source, threadId);
		if (existing) {
			if (!this.store.hasRouteParticipant(source, threadId, principalHash)) {
				throw new RouteParticipantDeniedError(source, threadId);
			}
			this.store.ensurePrincipal(principalHash, normalizedSender, label);
			if (targetId && existing.targetId !== targetId) {
				throw new RelationshipContextMismatchError(source);
			}
			this.store.touchRoute(source, threadId);
			this.store.touchRouteParticipant(source, threadId, principalHash);
			return this.store.getRoute(source, threadId);
		}

		const scope = this.ensurePrincipalScope(normalizedSender, { project, label, targetId });
		return this.store.bindRoute({
			source,
			providerThreadId: threadId,
			...scope,
		});
	}

}
