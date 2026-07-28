import assert from "node:assert/strict";
import {
	DISPATCH_PATHS,
	dispatchPathForAdapter,
	indexAdaptersByIdentity,
} from "../src/host/node/adapter-route-identity.js";

const expectedWebhookRoutes: Record<string, string> = {
	"slack:webhook": "/slack/events",
	"telegram:webhook": "/telegram/webhook",
	"discord:webhook": "/discord/interactions",
	"email:webhook": "/email/inbound",
	"mattermost:webhook": "/mattermost/inbound",
	"rocket-chat:webhook": "/rocketchat/inbound",
	"rocketchat:webhook": "/rocketchat/inbound",
	"zulip:webhook": "/zulip/inbound",
	"phone-messaging:webhook": "/phone-messaging/webhook",
	"phone:webhook": "/phone-messaging/webhook",
	"form:webhook": "/form/webhook",
};

const identities = Object.keys(expectedWebhookRoutes);
const configuredAdapters = identities.map((identity) => ({ kind: "configured", identity }));
const identityByAdapter = indexAdaptersByIdentity(identities, configuredAdapters);

const headlessAdapter = { kind: "headless" };
const implicitAdapter = { kind: "implicit" };
const runtimeAdapters = [headlessAdapter, ...configuredAdapters, implicitAdapter];

for (const adapter of runtimeAdapters) {
	const expected = adapter.kind === "configured"
		? expectedWebhookRoutes[adapter.identity!]
		: undefined;
	assert.equal(
		dispatchPathForAdapter(adapter, identityByAdapter),
		expected,
		`${adapter.identity ?? adapter.kind} retains its own route after implicit adapter insertion`,
	);
}

assert.deepEqual(
	Object.fromEntries(identities.map((identity) => [identity, DISPATCH_PATHS[identity]])),
	expectedWebhookRoutes,
	"every webhook adapter identity remains covered by the route map",
);
assert.throws(
	() => indexAdaptersByIdentity(["one"], []),
	/matching lengths/,
);
const repeatedAdapter = { kind: "configured", identity: "shared" };
assert.throws(
	() => indexAdaptersByIdentity(["one", "two"], [repeatedAdapter, repeatedAdapter]),
	/must be unique/,
);

console.log("adapter-route-identity ok");
