import { markAmbientMessagesIncluded, selectUnseenAmbientMessages } from "../src/engagement/ambient-context.js";
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
