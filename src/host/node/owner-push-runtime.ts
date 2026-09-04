import {
	ownerPushRouteFingerprint,
	parseOwnerPushAcknowledgment,
	parseOwnerPushAuthoritativeEvent,
	parseOwnerPushContext,
	parseOwnerPushEnvelope,
	parseOwnerPushRegistration,
	type OwnerPushAuthoritativeEventKind,
	type OwnerPushContext,
	type OwnerPushContextAuthorization,
	type OwnerPushContextVerifier,
	type OwnerPushTransport,
} from "../../console/owner-push.js";
import {
	OwnerPushStore,
	OwnerPushStoreError,
	type OwnerPushAcknowledgmentResult,
	type OwnerPushRegistrationResult,
} from "./owner-push-store.js";

export interface OwnerPushRuntimeOptions {
	store: OwnerPushStore;
	contextVerifier: OwnerPushContextVerifier;
	transport?: OwnerPushTransport;
}

export interface OwnerPushDispatchResult {
	disposition: "accepted" | "duplicate";
	planned: number;
	accepted: number;
	retryable: number;
	permanentlyRejected: number;
}

/**
 * One generic owner-push authority shared by every configured agent. It owns
 * registrations, notification identity, APNs retry custody, and read state;
 * adapters and agents remain data, never implementation selection.
 */
export class OwnerPushRuntime {
	private readonly inFlight = new Map<string, {
		fingerprint: string;
		promise: Promise<OwnerPushDispatchResult>;
	}>();

	constructor(private readonly options: OwnerPushRuntimeOptions) {}

	get available(): boolean {
		return this.options.transport !== undefined;
	}

	register(value: unknown, routeAgentId: string, subjectAgentId: string): OwnerPushRegistrationResult {
		if (!this.available) throw new OwnerPushRuntimeError(503, "owner_push_unavailable");
		const registration = parseOwnerPushRegistration(value);
		if (!registration) throw new OwnerPushRuntimeError(400, "invalid_owner_push_registration");
		if (registration.route_agent_id !== routeAgentId
			|| registration.subject_agent_id !== subjectAgentId) {
			throw new OwnerPushRuntimeError(403, "owner_push_agent_mismatch");
		}
		return this.options.store.register(registration);
	}

	revoke(routeAgentId: string, subjectAgentId: string, installationId: string): number {
		if (!this.available) throw new OwnerPushRuntimeError(503, "owner_push_unavailable");
		return this.options.store.revoke(routeAgentId, subjectAgentId, installationId);
	}

	async authorizeContext(
		value: unknown,
		routeAgentId: string,
		subjectAgentId: string,
		bindingId: string,
	): Promise<OwnerPushContext> {
		const context = parseOwnerPushContext(value);
		if (!context || context.relationship_id !== bindingId) {
			throw new OwnerPushRuntimeError(403, "owner_context_mismatch");
		}
		if (!this.options.store.hasAuthorizedRelationship(
			routeAgentId,
			subjectAgentId,
			bindingId,
			context.kind,
		)) {
			throw new OwnerPushRuntimeError(403, "owner_context_unauthorized");
		}
		const authorization: OwnerPushContextAuthorization = {
			routeAgentId,
			subjectAgentId,
			bindingId,
			context,
		};
		if (!await this.options.contextVerifier(authorization)) {
			throw new OwnerPushRuntimeError(409, "owner_context_stale_or_ambiguous");
		}
		return context;
	}

	async dispatchAuthoritative(value: unknown): Promise<OwnerPushDispatchResult> {
		const event = parseOwnerPushAuthoritativeEvent(value);
		if (!event) throw new OwnerPushRuntimeError(400, "invalid_owner_push_authoritative_event");
		return this.dispatchParsed(event.envelope, event.kind);
	}

	async dispatch(value: unknown): Promise<OwnerPushDispatchResult> {
		const envelope = parseOwnerPushEnvelope(value);
		if (!envelope) throw new OwnerPushRuntimeError(400, "invalid_owner_push_envelope");
		return this.dispatchParsed(envelope);
	}

	private async dispatchParsed(
		envelope: NonNullable<ReturnType<typeof parseOwnerPushEnvelope>>,
		authoritativeEventKind?: OwnerPushAuthoritativeEventKind,
	): Promise<OwnerPushDispatchResult> {
		if (!this.options.transport) throw new OwnerPushRuntimeError(503, "owner_push_unavailable");
		const notificationId = envelope.notification_id;
		const fingerprint = `${authoritativeEventKind ?? "unspecified"}|${ownerPushRouteFingerprint(envelope)}`;
		const active = this.inFlight.get(notificationId);
		if (active) {
			if (active.fingerprint !== fingerprint) {
				throw new OwnerPushRuntimeError(409, "owner_push_notification_conflict");
			}
			const coalesced = await active.promise;
			return { ...coalesced, disposition: "duplicate" };
		}

		const promise = this.dispatchEnvelope(envelope, authoritativeEventKind);
		this.inFlight.set(notificationId, { fingerprint, promise });
		try {
			return await promise;
		} finally {
			if (this.inFlight.get(notificationId)?.promise === promise) {
				this.inFlight.delete(notificationId);
			}
		}
	}

	acknowledge(
		value: unknown,
		pathNotificationId: string,
		routeAgentId: string,
		subjectAgentId: string,
	): OwnerPushAcknowledgmentResult {
		if (!this.available) throw new OwnerPushRuntimeError(503, "owner_push_unavailable");
		const acknowledgment = parseOwnerPushAcknowledgment(value);
		if (!acknowledgment || acknowledgment.notification_id !== pathNotificationId) {
			throw new OwnerPushRuntimeError(400, "invalid_owner_push_acknowledgment");
		}
		return this.options.store.acknowledge(acknowledgment, routeAgentId, subjectAgentId);
	}

	private async dispatchEnvelope(
		envelope: NonNullable<ReturnType<typeof parseOwnerPushEnvelope>>,
		authoritativeEventKind?: OwnerPushAuthoritativeEventKind,
	): Promise<OwnerPushDispatchResult> {
		await this.authorizeContext(
			envelope.context,
			envelope.route_agent_id,
			envelope.subject_agent_id,
			envelope.binding_id,
		);
		const admission = this.options.store.admitNotification(envelope, authoritativeEventKind);
		if (admission.disposition === "conflict") {
			throw new OwnerPushRuntimeError(409, "owner_push_notification_conflict");
		}
		const plans = this.options.store.planDispatches(envelope.notification_id);
		let accepted = 0;
		let retryable = 0;
		let permanentlyRejected = 0;
		for (const plan of plans) {
			try {
				const result = await this.options.transport!.send(plan.request);
				this.options.store.completeDispatch(
					envelope.notification_id,
					plan.registrationKey,
					result,
				);
				if (result.accepted) accepted += 1;
				else if (result.permanentTokenFailure) permanentlyRejected += 1;
				else retryable += 1;
			} catch {
				this.options.store.completeDispatch(
					envelope.notification_id,
					plan.registrationKey,
					{ accepted: false },
				);
				retryable += 1;
			}
		}
		return {
			disposition: admission.disposition,
			planned: plans.length,
			accepted,
			retryable,
			permanentlyRejected,
		};
	}

}

export class OwnerPushRuntimeError extends Error {
	constructor(readonly status: number, readonly code: string) { super(code); }
}

export function ownerPushError(error: unknown): OwnerPushRuntimeError | OwnerPushStoreError | null {
	return error instanceof OwnerPushRuntimeError || error instanceof OwnerPushStoreError ? error : null;
}
