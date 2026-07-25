#!/usr/bin/env node

import { ZulipResidentBridge } from "./zulip-resident-bridge.mjs";

function required(name) {
	const value = process.env[name];
	if (!value?.trim()) throw new Error(`Missing env: ${name}`);
	return value.trim();
}

function optionalList(name) {
	const value = process.env[name];
	return value === undefined
		? undefined
		: value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

const allowedChannelIds = optionalList("ZULIP_ALLOWED_CHANNELS")
	?? (process.env.ZULIP_CHANNEL_ID?.trim() ? [process.env.ZULIP_CHANNEL_ID.trim()] : undefined);

const bridge = new ZulipResidentBridge({
	zulipUrl: required("ZULIP_NATIVE_URL"),
	zulipEmail: required("ZULIP_NATIVE_EMAIL"),
	zulipApiKey: required("ZULIP_NATIVE_API_KEY"),
	allowedChannelIds,
	allowedDmUserIds: optionalList("ZULIP_ALLOWED_DM_USERS"),
	proxyToken: required("ZULIP_PROXY_TOKEN"),
	inboundUrl: required("ZULIP_INBOUND_URL"),
	inboundToken: required("ZULIP_INBOUND_TOKEN"),
	receiptToken: required("ZULIP_RECEIPT_TOKEN"),
	statePath: required("ZULIP_BRIDGE_STATE"),
	listenHost: process.env.ZULIP_BRIDGE_HOST || "127.0.0.1",
	listenPort: Number(process.env.ZULIP_BRIDGE_PORT || "0"),
});

await bridge.start();
console.log(`zulip-resident-bridge: ready at ${bridge.proxyUrl()}`);

let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	await bridge.stop();
	process.exit(0);
}

process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
