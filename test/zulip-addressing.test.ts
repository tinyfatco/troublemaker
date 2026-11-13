import assert from "node:assert/strict";
import { parseZulipAddressing } from "../src/adapters/zulip-webhook.js";

// Operator's view of a pedicab customer channel.
const isOperator = (name: string, userId?: string) => userId === "9" || name.toLowerCase() === "operator";

// @Text rider is for the relay bot, not the Operator.
{
	const a = parseZulipAddressing("@**Text rider** Hello, thanks for texting Pedicab Me. Ready to ride?", isOperator);
	assert.equal(a.self, false);
	assert.equal(a.wildcard, false);
	assert.deepEqual(a.others, ["Text rider"]);
}

// @Operator is for the Operator, including the id-qualified form Zulip inserts.
{
	const a = parseZulipAddressing("@**Operator|9** what do you see?", isOperator);
	assert.equal(a.self, true);
	assert.deepEqual(a.selfMentions, ["@**Operator|9**"]);
	assert.deepEqual(a.others, []);
}

// Pedro does not treat @Operator as addressed to Pedro.
{
	const isPedro = (name: string) => name.toLowerCase() === "pedro";
	const a = parseZulipAddressing("@**Operator** please check the booking", isPedro);
	assert.equal(a.self, false);
	assert.deepEqual(a.others, ["Operator"]);
}

// Addressing several participants including me still reaches me.
{
	const a = parseZulipAddressing("@**Operator** and @**Pedro|12** sync up", isOperator);
	assert.equal(a.self, true);
	assert.deepEqual(a.others, ["Pedro"]);
}

// Silent mentions refer to someone without addressing them.
{
	const a = parseZulipAddressing("as @_**Pedro** said, the rider is here", isOperator);
	assert.equal(a.self, false);
	assert.deepEqual(a.others, []);
}

// @all addresses everyone.
{
	const a = parseZulipAddressing("@**all** heads up", isOperator);
	assert.equal(a.wildcard, true);
}

// No mentions at all leaves the decision to channel policy.
{
	const a = parseZulipAddressing("Rider is running 5 min late", isOperator);
	assert.equal(a.self, false);
	assert.equal(a.wildcard, false);
	assert.deepEqual(a.others, []);
}

console.log("zulip addressing tests passed");
