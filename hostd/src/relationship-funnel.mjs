import { createHash } from "node:crypto";

export const RELATIONSHIP_FUNNEL_MILESTONES = Object.freeze([
	"first_inbound",
	"preview",
	"approval",
	"checkout",
	"payment",
	"domain_intake",
	"domain_connection",
	"live_acceptance",
]);

export const RELATIONSHIP_RUNTIME_MILESTONES = Object.freeze([
	"preview",
	"approval",
	"checkout",
	"domain_intake",
	"live_acceptance",
]);

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
});

const PROGRESS_KEYS = new Set(["close_state", "next_step", "milestone"]);
const RUNTIME_MILESTONE_SET = new Set(RELATIONSHIP_RUNTIME_MILESTONES);
const FUNNEL_MILESTONE_SET = new Set(RELATIONSHIP_FUNNEL_MILESTONES);

export function evidenceSha256(...parts) {
	const hash = createHash("sha256");
	for (const part of parts) {
		const value = String(part);
		hash.update(String(Buffer.byteLength(value, "utf8")));
		hash.update(":");
		hash.update(value, "utf8");
		hash.update("\n");
	}
	return hash.digest("hex");
}

export function normalizeRelationshipProgress(value) {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("relationship_progress_invalid");
	}
	if (Object.keys(value).some((key) => !PROGRESS_KEYS.has(key))) {
		throw new Error("relationship_progress_invalid");
	}
	const expectedStep = RELATIONSHIP_CLOSE_STATE_STEPS[value.close_state];
	if (!expectedStep || value.next_step !== expectedStep) {
		throw new Error("relationship_close_pair_invalid");
	}
	if (value.milestone !== undefined && !RUNTIME_MILESTONE_SET.has(value.milestone)) {
		throw new Error("relationship_milestone_authority_denied");
	}
	return Object.freeze({
		close_state: value.close_state,
		next_step: value.next_step,
		...(value.milestone === undefined ? {} : { milestone: value.milestone }),
	});
}

export function relationshipProgressSha256(progress) {
	if (!progress) return undefined;
	return evidenceSha256(
		"relationship-progress-v1",
		progress.close_state,
		progress.next_step,
		progress.milestone ?? "",
	);
}

export function requireFunnelMilestone(value) {
	if (!FUNNEL_MILESTONE_SET.has(value)) throw new Error("relationship_milestone_invalid");
	return value;
}

export function milestoneAuthority(milestone) {
	if (["preview", "checkout"].includes(milestone)) return "provider_outbound";
	if (["approval", "domain_intake", "live_acceptance"].includes(milestone)) return "customer_inbound";
	throw new Error("relationship_milestone_authority_denied");
}
