import { AsyncLocalStorage } from "node:async_hooks";

export const RELATIONSHIP_CLOSE_STATES = [
	"inbound_received",
	"request_answered",
	"awaiting_customer_detail",
	"preview_in_progress",
	"awaiting_preview_review",
	"approval_received",
	"checkout_sent",
	"awaiting_payment_confirmation",
	"awaiting_domain_intake",
	"domain_intake_received",
	"awaiting_live_acceptance",
	"live_accepted",
] as const;

export const RELATIONSHIP_NEXT_STEPS = [
	"reply_to_customer",
	"await_customer_choice",
	"share_missing_detail",
	"prepare_preview",
	"review_preview",
	"send_checkout",
	"complete_checkout",
	"confirm_payment",
	"share_domain_choice",
	"connect_domain",
	"review_live_site",
	"none",
] as const;

export const RELATIONSHIP_CLOSE_STATE_STEPS = Object.freeze({
	inbound_received: "reply_to_customer",
	request_answered: "await_customer_choice",
	awaiting_customer_detail: "share_missing_detail",
	preview_in_progress: "prepare_preview",
	awaiting_preview_review: "review_preview",
	approval_received: "send_checkout",
	checkout_sent: "complete_checkout",
	awaiting_payment_confirmation: "confirm_payment",
	awaiting_domain_intake: "share_domain_choice",
	domain_intake_received: "connect_domain",
	awaiting_live_acceptance: "review_live_site",
	live_accepted: "none",
} as const satisfies Record<typeof RELATIONSHIP_CLOSE_STATES[number], typeof RELATIONSHIP_NEXT_STEPS[number]>);

export const RELATIONSHIP_RUNTIME_MILESTONES = [
	"preview",
	"approval",
	"checkout",
	"domain_intake",
	"live_acceptance",
] as const;

export type RelationshipCloseState = typeof RELATIONSHIP_CLOSE_STATES[number];
export type RelationshipNextStep = typeof RELATIONSHIP_NEXT_STEPS[number];
export type RelationshipRuntimeMilestone = typeof RELATIONSHIP_RUNTIME_MILESTONES[number];

export interface RelationshipProgressRequest {
	close_state: RelationshipCloseState;
	next_step: RelationshipNextStep;
	milestone?: RelationshipRuntimeMilestone;
}

const CLOSE_STATE_SET = new Set<string>(RELATIONSHIP_CLOSE_STATES);
const NEXT_STEP_SET = new Set<string>(RELATIONSHIP_NEXT_STEPS);
const MILESTONE_SET = new Set<string>(RELATIONSHIP_RUNTIME_MILESTONES);
const KEYS = new Set(["close_state", "next_step", "milestone"]);
const storage = new AsyncLocalStorage<RelationshipProgressRequest>();

export function normalizeRelationshipProgress(value: unknown): RelationshipProgressRequest | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("relationship_progress must be an object");
	}
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).some((key) => !KEYS.has(key))) {
		throw new Error("relationship_progress contains unsupported fields");
	}
	if (typeof raw.close_state !== "string" || !CLOSE_STATE_SET.has(raw.close_state)) {
		throw new Error("relationship_progress has an invalid close_state");
	}
	if (typeof raw.next_step !== "string" || !NEXT_STEP_SET.has(raw.next_step)) {
		throw new Error("relationship_progress has an invalid next_step");
	}
	if (RELATIONSHIP_CLOSE_STATE_STEPS[raw.close_state as RelationshipCloseState] !== raw.next_step) {
		throw new Error("relationship_progress has an invalid close_state and next_step pair");
	}
	if (raw.milestone !== undefined && (typeof raw.milestone !== "string" || !MILESTONE_SET.has(raw.milestone))) {
		throw new Error("relationship_progress has an invalid milestone");
	}
	return Object.freeze({
		close_state: raw.close_state as RelationshipCloseState,
		next_step: raw.next_step as RelationshipNextStep,
		...(raw.milestone === undefined ? {} : { milestone: raw.milestone as RelationshipRuntimeMilestone }),
	});
}

export async function withRelationshipProgressRequest<T>(
	progress: RelationshipProgressRequest | undefined,
	work: () => Promise<T>,
): Promise<T> {
	if (!progress) return await work();
	return await storage.run(progress, work);
}

export function currentRelationshipProgressRequest(): RelationshipProgressRequest | undefined {
	return storage.getStore();
}
