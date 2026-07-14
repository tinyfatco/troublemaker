import { buildAmbientEvaluationText, cancelPendingAmbientEvaluations, markAmbientMessagesIncluded, partitionAmbientMessagesForThread, resolveAmbientDeliveryContext, selectUnseenAmbientMessages } from "../src/engagement/ambient-context.js";
import { ChannelPulse } from "../src/engagement/channel-pulse.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ok ${msg}`);
	} else {
		failed++;
		console.error(`  FAIL ${msg}`);
	}
}

const pulse = new ChannelPulse("pending");
pulse.setSelfId("UZIP");

const channelId = "C0AN1GL51K7";
const includedKeys = new Set<string>();

pulse.record(channelId, "UZIP", "zip echo".length, "zip echo", {
	messageId: "1779780000.000001",
	threadTs: "1779780000.000001",
	replyTarget: "slack:C0AN1GL51K7:1779780000.000001",
});
pulse.record(channelId, "UALEX", "direct mention".length, "direct mention", {
	messageId: "1779780001.000001",
	threadTs: "1779780001.000001",
	replyTarget: "slack:C0AN1GL51K7:1779780001.000001",
	directlyAddressed: true,
});
pulse.record(channelId, "UALEX", "passive first".length, "passive first", {
	messageId: "1779780002.000001",
	threadTs: "1779780002.000001",
	replyTarget: "slack:C0AN1GL51K7:1779780002.000001",
});
pulse.record(channelId, "UMIKE", "passive second".length, "passive second", {
	messageId: "1779780003.000001",
	threadTs: "1779780003.000001",
	replyTarget: "slack:C0AN1GL51K7:1779780003.000001",
});

const firstWake = selectUnseenAmbientMessages(pulse, channelId, includedKeys);
assert(firstWake.length === 2, "first ambient wake includes only passive inbound unseen messages");
assert(firstWake.every((entry) => !entry.directlyAddressed && entry.participantId !== "UZIP"), "first wake excludes direct mentions and Zip self echoes");
assert(firstWake.map((entry) => entry.text).join("|") === "passive first|passive second", "first wake preserves only passive message text in order");
assert(firstWake[0]?.replyTarget === "slack:C0AN1GL51K7:1779780002.000001", "first wake preserves exact Slack reply target");

markAmbientMessagesIncluded(firstWake, includedKeys);
const secondWake = selectUnseenAmbientMessages(pulse, channelId, includedKeys);
assert(secondWake.length === 0, "second ambient wake does not replay previously included messages");

pulse.record(channelId, "UALEX", "passive third".length, "passive third", {
	messageId: "1779780004.000001",
	threadTs: "1779780004.000001",
	replyTarget: "slack:C0AN1GL51K7:1779780004.000001",
});
pulse.record(channelId, "UZIP", "zip after wake".length, "zip after wake", {
	messageId: "1779780005.000001",
	threadTs: "1779780005.000001",
	replyTarget: "slack:C0AN1GL51K7:1779780005.000001",
});

const thirdWake = selectUnseenAmbientMessages(pulse, channelId, includedKeys);
assert(thirdWake.length === 1, "later ambient wake includes only newly unseen passive messages");
assert(thirdWake[0]?.text === "passive third", "later wake excludes old passive messages and fresh Zip self echo");

const singleThread = resolveAmbientDeliveryContext([firstWake[0]!]);
assert(singleThread?.threadTs === "1779780002.000001", "single-message ambient wake inherits its Slack thread");
assert(singleThread?.replyTarget === "slack:C0AN1GL51K7:1779780002.000001", "single-message ambient wake inherits its exact reply target");

const sharedThreadEntry = {
	...firstWake[0]!,
	messageId: "1779780002.000002",
	text: "passive follow-up",
};
const sharedThread = resolveAmbientDeliveryContext([firstWake[0]!, sharedThreadEntry]);
assert(sharedThread?.threadTs === "1779780002.000001", "multi-message ambient wake inherits one shared Slack thread");

const mixedThreadPartition = partitionAmbientMessagesForThread(
	[firstWake[0]!, firstWake[1]!, sharedThreadEntry],
	"1779780002.000001",
);
assert(mixedThreadPartition.sameThread.map((entry) => entry.text).join("|") === "passive first|passive follow-up", "same-thread ambient messages preserve order for soft steering");
assert(mixedThreadPartition.deferred.map((entry) => entry.text).join("|") === "passive second", "other-thread ambient messages remain deferred");
const missingThreadPartition = partitionAmbientMessagesForThread(firstWake, undefined);
assert(missingThreadPartition.sameThread.length === 0 && missingThreadPartition.deferred.length === firstWake.length, "missing active thread keeps the whole ambient batch deferred");

assert(resolveAmbientDeliveryContext(firstWake) === undefined, "ambient wake spanning multiple Slack threads has no delivery locus");
assert(resolveAmbientDeliveryContext([{ ...firstWake[0]!, threadTs: undefined }]) === undefined, "ambient wake with missing thread metadata has no delivery locus");

const completedAfterPause = buildAmbientEvaluationText(
	"slack:#biz",
	"Alex (UALEX): Here is the idea, gimme one sec. Shipping the resident agent offer is the next move.",
	{ temperature: 4, recentParticipants: 2, timeSinceMyLastMs: 12_000 },
);
assert(completedAfterPause.includes("<ambient_messages>"), "ambient prompt marks explicit complete-message boundaries");
assert(completedAfterPause.includes("gimme one sec. Shipping the resident agent offer"), "ambient prompt preserves substantive content after a pause phrase");
assert(completedAfterPause.includes("Do not yield merely because of an earlier pause phrase"), "ambient prompt forbids pause-phrase-only yields");
assert(completedAfterPause.includes("Only treat a request to wait as current when it concludes the final message"), "ambient prompt still permits a genuine final request to wait");

const stopPulse = new ChannelPulse("USTOPBOT");
stopPulse.record("CSTOP", "UALEX", "resume old work".length, "resume old work", { messageId: "1779781000.000001" });
const stopIncludedKeys = new Map<string, Set<string>>();
let cancelledTimerFired = false;
const pendingAmbient = new Map([
	["1:TSTOP:CSTOP", {
		channelId: "CSTOP",
		timer: setTimeout(() => { cancelledTimerFired = true; }, 10),
	}],
]);
const cancellation = cancelPendingAmbientEvaluations(pendingAmbient, stopIncludedKeys, stopPulse);
await new Promise((resolve) => setTimeout(resolve, 20));
assert(cancellation.cancelledTimers === 1, "stop cancellation reports the deferred ambient wake");
assert(cancellation.discardedMessages === 1, "stop cancellation consumes the deferred ambient backlog");
assert(pendingAmbient.size === 0 && !cancelledTimerFired, "stop cancellation prevents the ambient timer from firing");
assert(selectUnseenAmbientMessages(stopPulse, "CSTOP", stopIncludedKeys.get("1:TSTOP:CSTOP")!).length === 0, "discarded ambient work does not replay after stop");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
