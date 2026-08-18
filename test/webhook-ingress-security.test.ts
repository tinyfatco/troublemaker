import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { SlackWebhookAdapter } from "../src/adapters/slack-webhook.js";
import { TelegramWebhookAdapter } from "../src/adapters/telegram-webhook.js";
import { DiscordWebhookAdapter } from "../src/adapters/discord-webhook.js";

function request(headers: Record<string, string> = {}, url = "/") {
	const value = new EventEmitter() as EventEmitter & {
		headers: Record<string, string>;
		url: string;
	};
	value.headers = headers;
	value.url = url;
	return value;
}

function response() {
	return {
		status: 0,
		body: "",
		writeHead(status: number) { this.status = status; return this; },
		end(body = "") { this.body = String(body); return this; },
	};
}

function dispatchBody(adapter: { dispatch(req: any, res: any): void }, headers: Record<string, string>, body: string, url = "/") {
	const req = request(headers, url);
	const res = response();
	adapter.dispatch(req as any, res as any);
	req.emit("data", Buffer.from(body));
	req.emit("end");
	return res;
}

const slack = new SlackWebhookAdapter({
	botToken: "xoxb-test",
	signingSecret: "",
	workingDir: process.cwd(),
	store: {} as any,
});
const forgedSlack = dispatchBody(
	slack,
	{ "x-crawdad-dev-verified": "true" },
	JSON.stringify({ type: "url_verification", challenge: "forged" }),
);
assert.equal(forgedSlack.status, 401, "a boolean proxy header cannot bypass Slack authentication");

const slackCapability = "slack-upstream-capability-at-least-32-bytes";
const scopedSlack = new SlackWebhookAdapter({
	botToken: "xoxb-test",
	signingSecret: "",
	upstreamToken: slackCapability,
	workingDir: process.cwd(),
	store: {} as any,
});
const authorizedSlack = dispatchBody(
	scopedSlack,
	{ authorization: `Bearer ${slackCapability}` },
	JSON.stringify({ type: "url_verification", challenge: "accepted" }),
);
assert.equal(authorizedSlack.status, 200);
assert.match(authorizedSlack.body, /accepted/);
const rawSlackCapability = dispatchBody(
	scopedSlack,
	{ authorization: slackCapability },
	JSON.stringify({ type: "url_verification", challenge: "rejected" }),
);
assert.equal(rawSlackCapability.status, 401, "upstream capabilities require the exact Bearer scheme");

const telegram = new TelegramWebhookAdapter({
	botToken: "123456:test",
	webhookSecret: "",
	skipRegistration: true,
	workingDir: process.cwd(),
});
const forgedTelegram = dispatchBody(
	telegram,
	{ "x-crawdad-dev-verified": "true" },
	JSON.stringify({ update_id: 1 }),
);
assert.equal(forgedTelegram.status, 401, "a boolean proxy header cannot bypass Telegram authentication");

const discord = new DiscordWebhookAdapter({
	botToken: "discord-test-token",
	applicationId: "1504644609433800876",
	publicKey: "00".repeat(32),
	workingDir: process.cwd(),
});
const forgedDiscordRelay = dispatchBody(
	discord,
	{ "content-type": "application/json", "x-crawdad-dev-verified": "true" },
	JSON.stringify({ type: "message" }),
	"/discord/messages",
);
assert.equal(forgedDiscordRelay.status, 401, "Discord relay requires a scoped bearer capability");

const discordCapability = "discord-upstream-capability-at-least-32-bytes";
const scopedDiscord = new DiscordWebhookAdapter({
	botToken: "discord-test-token",
	applicationId: "1504644609433800876",
	publicKey: "00".repeat(32),
	upstreamToken: discordCapability,
	workingDir: process.cwd(),
});
const lookalikeDiscordRelay = dispatchBody(
	scopedDiscord,
	{ "content-type": "application/json", authorization: `Bearer ${discordCapability}` },
	JSON.stringify({ type: "message" }),
	"/untrusted/discord/messages",
);
assert.equal(lookalikeDiscordRelay.status, 401, "only the exact Discord relay path accepts the scoped capability");

const exactDiscordRelay = dispatchBody(
	scopedDiscord,
	{ "content-type": "application/json", authorization: `Bearer ${discordCapability}` },
	JSON.stringify({ type: "message" }),
	"/discord/messages?source=gateway",
);
assert.equal(exactDiscordRelay.status, 200);

const cliSource = readFileSync(new URL("../src/host/node/cli.ts", import.meta.url), "utf8");
assert.match(
	cliSource,
	/TROUBLEMAKER_HOSTD_CONTAINER === "1" && allowUnauthenticatedWebhook/,
	"Hostd runtimes reject the standalone unauthenticated-webhook escape hatch",
);

console.log("webhook ingress security ok");
