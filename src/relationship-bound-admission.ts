export interface RelationshipAdmissionRequest {
	relationshipId: string;
	pairedChannelId: string;
}

export interface RelationshipRunBinding {
	runId: string;
	relationshipId?: string;
	channelId?: string;
}

export interface StrictSteerAdmission {
	/** Resolves only when the active runner authoritatively accepts the steer. */
	accepted: Promise<void>;
	/** Resolves only after the corresponding steer has a durable execution outcome. */
	completed: Promise<void>;
}

export type RelationshipAdmissionRejection =
	| "missing_active_binding"
	| "relationship_mismatch"
	| "channel_mismatch"
	| "ambiguous_active_run"
	| "steer_unavailable"
	| "idle_admission_stale";

export type RelationshipAdmissionResult =
	| {
		disposition: "steered";
		run: RelationshipRunBinding;
		accepted: Promise<void>;
		completed: Promise<void>;
	}
	| {
		disposition: "new_turn";
		accepted: Promise<void>;
		completed: Promise<void>;
	}
	| {
		disposition: "rejected";
		reason: RelationshipAdmissionRejection;
	};

/**
 * Atomically chooses the only two valid routes for a relationship-bound input.
 * An exact active binding may be strictly steered; a truly idle runtime may
 * admit a fresh turn. Every other state fails closed and never queues fallback
 * work or substitutes another active recipient.
 */
export function admitRelationshipBoundMessage({
	request,
	activeRuns,
	strictSteer,
	admitIdle,
}: {
	request: RelationshipAdmissionRequest;
	activeRuns: readonly RelationshipRunBinding[];
	strictSteer: (run: RelationshipRunBinding) => StrictSteerAdmission | null;
	admitIdle: () => Promise<void> | null;
}): RelationshipAdmissionResult {
	if (activeRuns.length > 1) {
		return { disposition: "rejected", reason: "ambiguous_active_run" };
	}

	const active = activeRuns[0];
	if (!active) {
		const completed = admitIdle();
		if (!completed) return { disposition: "rejected", reason: "idle_admission_stale" };
		return {
			disposition: "new_turn",
			accepted: Promise.resolve(),
			completed,
		};
	}

	if (!active.relationshipId || !active.channelId) {
		return { disposition: "rejected", reason: "missing_active_binding" };
	}
	if (active.relationshipId !== request.relationshipId) {
		return { disposition: "rejected", reason: "relationship_mismatch" };
	}
	if (active.channelId !== request.pairedChannelId) {
		return { disposition: "rejected", reason: "channel_mismatch" };
	}

	const admission = strictSteer(active);
	if (!admission) return { disposition: "rejected", reason: "steer_unavailable" };
	return {
		disposition: "steered",
		run: active,
		accepted: admission.accepted,
		completed: admission.completed,
	};
}
