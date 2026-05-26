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
pulse.setSelfId("U0A06NNJV34");

const rawMarkdown = "Thread response received and routed correctly. I am replying *in this thread*.";
const slackMrkdwn = "Thread response received and routed correctly. I am replying _in this thread_.";

pulse.record("C0AN1GL51K7", "U0A06NNJV34", rawMarkdown.length, rawMarkdown, {
	messageId: "1779776969.882709",
	threadTs: "1779776757.953539",
	replyTarget: "slack:C0AN1GL51K7:1779776757.953539",
});
pulse.record("C0AN1GL51K7", "U0A06NNJV34", slackMrkdwn.length, slackMrkdwn, {
	messageId: "1779776969.882709",
	threadTs: "1779776757.953539",
	replyTarget: "slack:C0AN1GL51K7:1779776757.953539",
});

const recent = pulse.recentMessages("C0AN1GL51K7");
const summary = pulse.summary("C0AN1GL51K7");

assert(recent.length === 1, "same platform message id is represented once in ambient context");
assert(recent[0]?.text === rawMarkdown, "first recorded text is preserved for ambient context");
assert(recent[0]?.threadTs === "1779776757.953539", "thread timestamp is preserved for ambient context");
assert(recent[0]?.replyTarget === "slack:C0AN1GL51K7:1779776757.953539", "reply target is preserved for ambient context");
assert(summary.temperature === 1, "deduped self echo does not inflate ambient temperature");
assert(summary.recentParticipants === 1, "deduped self echo does not inflate participant accounting");
assert(summary.timeSinceMyLastMs < 1000, "deduped self echo still updates self timing");

pulse.record("C0AN1GL51K7", "U0A06NNJV34", "another reply".length, "another reply", {
	messageId: "1779777014.658729",
	threadTs: "1779777014.658729",
	replyTarget: "slack:C0AN1GL51K7:1779777014.658729",
});
assert(pulse.recentMessages("C0AN1GL51K7").length === 2, "distinct message ids remain separate messages");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
