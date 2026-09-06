import type {
	RuntimeEventSink,
	RuntimeSteeringInputEvent,
	RuntimeUserInputEntry,
} from "../core/runtime-contract.js";
import { parseVisibleUserInputs } from "../user-input-display.js";
import type { VerifiedSenderIdentity } from "../sender-identity.js";
import { projectVerifiedUserInputs } from "./user-input-provenance.js";

export interface SteeringProjectionRequest {
	id: string;
	deliveryId?: string;
	senderIdentity?: VerifiedSenderIdentity;
	prompt: string;
	enqueue: () => Promise<void>;
	onAccepted?: () => void | Promise<void>;
	waitForIdle: () => Promise<void>;
}

interface TrackedSteeringProjection {
	id: string;
	deliveryId?: string;
	prompt: string;
	entries: RuntimeUserInputEntry[];
	acceptedAt: string;
	accepted: boolean;
	consumed: boolean;
	settlement: Promise<void>;
}

/**
 * Tracks the server-confirmed interval between Pi accepting a steering message
 * and the model consuming it at a user-message boundary.
 */
export class SteeringProjectionTracker {
	private readonly projections = new Map<string, TrackedSteeringProjection>();

	constructor(private readonly emit: RuntimeEventSink) {}

	track(request: SteeringProjectionRequest): Promise<void> {
		const existing = this.projections.get(request.id);
		if (existing) return existing.settlement;

		const projection: TrackedSteeringProjection = {
			id: request.id,
			deliveryId: request.deliveryId,
			prompt: request.prompt,
			entries: projectVerifiedUserInputs(request.prompt, request.senderIdentity),
			acceptedAt: "",
			accepted: false,
			consumed: false,
			settlement: Promise.resolve(),
		};
		this.projections.set(request.id, projection);

		let acceptance: Promise<void>;
		try {
			acceptance = request.enqueue();
		} catch (error) {
			this.projections.delete(request.id);
			throw error;
		}

		projection.settlement = acceptance
			.then(async () => {
				if (this.projections.get(request.id) !== projection) return;
				await request.onAccepted?.();
				projection.accepted = true;
				projection.acceptedAt = new Date().toISOString();
				if (projection.entries.length > 0) {
					this.emitProjection(projection, "accepted");
					if (projection.consumed) this.emitProjection(projection, "consumed");
				}
				await request.waitForIdle();
			})
			.catch((error) => {
				if (
					this.projections.get(request.id) === projection
					&& projection.accepted
					&& !projection.consumed
					&& projection.entries.length > 0
				) {
					this.emitProjection(projection, "dismissed");
				}
				this.projections.delete(request.id);
				throw error;
			});

		return projection.settlement;
	}

	consume(prompt: string): void {
		const direct = [...this.projections.values()].find((projection) => (
			!projection.consumed && projection.prompt === prompt
		));
		if (direct) {
			this.consumeProjection(direct);
			return;
		}

		const visible = parseVisibleUserInputs(prompt);
		if (visible.length === 0) return;
		const remaining = [...visible];
		for (const projection of this.projections.values()) {
			if (projection.consumed || projection.entries.length !== 1) continue;
			const index = remaining.findIndex((entry) => sameVisibleInput(entry, projection.entries[0]));
			if (index === -1) continue;
			remaining.splice(index, 1);
			this.consumeProjection(projection);
			if (remaining.length === 0) return;
		}
	}

	dismissAll(): void {
		for (const projection of this.projections.values()) {
			if (projection.accepted && !projection.consumed && projection.entries.length > 0) {
				this.emitProjection(projection, "dismissed");
			}
		}
		this.projections.clear();
	}

	private consumeProjection(projection: TrackedSteeringProjection): void {
		projection.consumed = true;
		if (projection.accepted && projection.entries.length > 0) {
			this.emitProjection(projection, "consumed");
		}
	}

	private emitProjection(
		projection: TrackedSteeringProjection,
		state: RuntimeSteeringInputEvent["state"],
	): void {
		void this.emit({
			type: "steering_input",
			id: projection.id,
			...(projection.deliveryId ? { deliveryId: projection.deliveryId } : {}),
			state,
			deliveryMode: "steered",
			acceptedAt: projection.acceptedAt,
			entries: projection.entries,
		});
	}
}

function sameVisibleInput(a: RuntimeUserInputEntry, b: RuntimeUserInputEntry): boolean {
	return a.channel === b.channel && a.userName === b.userName && a.text === b.text;
}
