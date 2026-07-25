import { ChannelPulse } from "../src/engagement/channel-pulse.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

const pulse = new ChannelPulse("pending");
pulse.setSelfId("U0123456789");

const rawMarkdown = "Thread response received and routed correctly. I am replying *in this thread*.";
const slackMrkdwn = "Thread response received and routed correctly. I am replying _in this thread_.";

pulse.record("C0123456789", "U0123456789", rawMarkdown.length, rawMarkdown, {
	messageId: "1700000001.000100",
	threadTs: "1700000000.000100",
	replyTarget: "slack:C0123456789:1700000000.000100",
});
pulse.record("C0123456789", "U0123456789", slackMrkdwn.length, slackMrkdwn, {
	messageId: "1700000001.000100",
	threadTs: "1700000000.000100",
	replyTarget: "slack:C0123456789:1700000000.000100",
});

const recent = pulse.recentMessages("C0123456789");
const summary = pulse.summary("C0123456789");

assert(recent.length === 1, "same platform message id is represented once in ambient context");
assert(recent[0]?.text === rawMarkdown, "first recorded text is preserved for ambient context");
assert(recent[0]?.threadTs === "1700000000.000100", "thread timestamp is preserved for ambient context");
assert(recent[0]?.replyTarget === "slack:C0123456789:1700000000.000100", "reply target is preserved for ambient context");
assert(summary.temperature === 1, "deduped self echo does not inflate ambient temperature");
assert(summary.recentParticipants === 1, "deduped self echo does not inflate participant accounting");
assert(summary.timeSinceMyLastMs < 1000, "deduped self echo still updates self timing");
assert(pulse.isSelfParticipant("U0123456789"), "resolved self IDs are detectable by ambient filtering");

pulse.record("C0123456789", "U0123456789", "another reply".length, "another reply", {
	messageId: "1700000002.000100",
	threadTs: "1700000002.000100",
	replyTarget: "slack:C0123456789:1700000002.000100",
});
assert(pulse.recentMessages("C0123456789").length === 2, "distinct message ids remain separate messages");
assert(pulse.recentMessages("C0123456789").filter((entry) => !pulse.isSelfParticipant(entry.participantId)).length === 0, "self messages do not become inbound ambient candidates");

pulse.record("C0123456789", "U0987654321", "please reply here".length, "please reply here", {
	messageId: "1700000003.000100",
	threadTs: "1700000002.000100",
	replyTarget: "slack:C0123456789:1700000002.000100",
});
const inboundAmbient = pulse.recentMessages("C0123456789").filter((entry) => !pulse.isSelfParticipant(entry.participantId));
assert(inboundAmbient.length === 1, "only inbound messages remain ambient candidates");
assert(inboundAmbient[0]?.replyTarget === "slack:C0123456789:1700000002.000100", "inbound ambient candidate keeps the Slack thread reply target");


pulse.record("C0123456789", "U0987654321", "direct mention".length, "direct mention", {
	messageId: "1700000004.000100",
	threadTs: "1700000004.000100",
	replyTarget: "slack:C0123456789:1700000004.000100",
	directlyAddressed: true,
});
const ambientCandidates = pulse.recentMessages("C0123456789").filter((entry) => pulse.isAmbientCandidate(entry));
assert(ambientCandidates.length === 1, "directly addressed messages are not ambient candidates");
assert(ambientCandidates[0]?.messageId === "1700000003.000100", "only passive inbound messages stay ambient candidates");

pulse.record("C0123456789", "U0987654321", "duplicate starts ambient".length, "duplicate starts ambient", {
	messageId: "1700000005.000100",
});
pulse.record("C0123456789", "U0987654321", "duplicate starts ambient".length, "duplicate starts ambient", {
	messageId: "1700000005.000100",
	directlyAddressed: true,
});
assert(!pulse.isAmbientCandidate(pulse.recentMessages("C0123456789").find((entry) => entry.messageId === "1700000005.000100")!), "direct mention metadata wins across duplicate events");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
