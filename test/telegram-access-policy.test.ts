import assert from "node:assert/strict";
import {
	allowsTelegramIncoming,
	allowsTelegramOutbound,
	createTelegramAccessPolicy,
} from "../src/adapters/telegram-access-policy.js";

const unrestricted = createTelegramAccessPolicy({});
assert.equal(allowsTelegramIncoming(unrestricted, {
	chatId: "101",
	chatType: "private",
	userId: "101",
}), true);
assert.equal(allowsTelegramIncoming(unrestricted, {
	chatId: "-202",
	chatType: "group",
	userId: "101",
}), true);
assert.equal(allowsTelegramOutbound(unrestricted, "-202", new Set()), true);

const ownerOnly = createTelegramAccessPolicy({
	allowedUserIds: ["101"],
	privateOnly: true,
});
assert.equal(allowsTelegramIncoming(ownerOnly, {
	chatId: "101",
	chatType: "private",
	userId: "101",
}), true);
assert.equal(allowsTelegramIncoming(ownerOnly, {
	chatId: "202",
	chatType: "private",
	userId: "202",
}), false);
assert.equal(allowsTelegramIncoming(ownerOnly, {
	chatId: "-303",
	chatType: "group",
	userId: "101",
}), false);
assert.equal(allowsTelegramOutbound(ownerOnly, "101", new Set()), true);
assert.equal(allowsTelegramOutbound(ownerOnly, "202", new Set()), false);
assert.equal(allowsTelegramOutbound(ownerOnly, "-303", new Set(["-303"])), false);

const senderAllowlist = createTelegramAccessPolicy({ allowedUserIds: ["101"] });
assert.equal(allowsTelegramIncoming(senderAllowlist, {
	chatId: "-303",
	chatType: "group",
	userId: "101",
}), true);
assert.equal(allowsTelegramOutbound(senderAllowlist, "-303", new Set()), false);
assert.equal(allowsTelegramOutbound(senderAllowlist, "-303", new Set(["-303"])), true);
assert.equal(allowsTelegramOutbound(senderAllowlist, "101", new Set()), true);
assert.equal(allowsTelegramOutbound(senderAllowlist, "202", new Set(["202"])), true);

const denyAll = createTelegramAccessPolicy({ allowedUserIds: [] });
assert.equal(allowsTelegramIncoming(denyAll, {
	chatId: "101",
	chatType: "private",
	userId: "101",
}), false);
assert.equal(allowsTelegramOutbound(denyAll, "101", new Set()), false);

assert.throws(
	() => createTelegramAccessPolicy({ allowedUserIds: ["not-a-user"] }),
	/positive integers/,
);

console.log("telegram-access-policy ok");
