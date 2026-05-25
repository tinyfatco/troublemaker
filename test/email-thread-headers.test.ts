import assert from "node:assert/strict";
import {
	buildReplyThreadHeaders,
	compileReferences,
	normalizeMessageIdForHeader,
	parseReferencesHeader,
} from "../src/adapters/email/thread-headers.js";

assert.equal(normalizeMessageIdForHeader("<A@Example.com>"), "<A@Example.com>");
assert.equal(normalizeMessageIdForHeader("reply@tinyfat.com"), "<reply@tinyfat.com>");
assert.equal(normalizeMessageIdForHeader("8f336b12-573f-4dcf-bdd5-0b922d718c16"), undefined);
assert.equal(normalizeMessageIdForHeader('["<a@example.com>"]'), undefined);

assert.deepEqual(parseReferencesHeader("<a@example.com> <b@example.com>"), ["<a@example.com>", "<b@example.com>"]);
assert.deepEqual(parseReferencesHeader('["<a@example.com>","<b@example.com>"]'), []);
assert.deepEqual(parseReferencesHeader("<a@example.com> garbage <b@example.com>"), ["<a@example.com>", "<b@example.com>"]);

assert.equal(
	compileReferences("<a@example.com> <reply1@tinyfat.com>", "<b@example.com>"),
	"<a@example.com> <reply1@tinyfat.com> <b@example.com>",
);
assert.equal(compileReferences(undefined, "<b@example.com>"), "<b@example.com>");
assert.equal(compileReferences("<b@example.com>", "<b@example.com>"), "<b@example.com>");

assert.deepEqual(
	buildReplyThreadHeaders("<b@example.com>", "<a@example.com> <reply1@tinyfat.com>"),
	{
		in_reply_to: "<b@example.com>",
		references: "<a@example.com> <reply1@tinyfat.com> <b@example.com>",
	},
);
assert.deepEqual(buildReplyThreadHeaders("8f336b12-573f-4dcf-bdd5-0b922d718c16", "<a@example.com>"), {});

console.log("email-thread-headers ok");
