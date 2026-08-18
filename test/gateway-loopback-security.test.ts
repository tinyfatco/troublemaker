import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	isTrustedGatewayBrowserRequest,
	isTrustedStandaloneWebSocketRequest,
	resolveGatewayListenHost,
} from "../src/gateway.js";

assert.equal(resolveGatewayListenHost(), "127.0.0.1");
assert.equal(resolveGatewayListenHost("localhost"), "localhost");
assert.equal(resolveGatewayListenHost("::1"), "::1");
assert.equal(resolveGatewayListenHost("0.0.0.0", true), "0.0.0.0");
assert.throws(() => resolveGatewayListenHost("0.0.0.0"), /loopback-only/);
assert.throws(() => resolveGatewayListenHost("::"), /loopback-only/);
assert.throws(() => resolveGatewayListenHost("192.0.2.1"), /loopback-only/);

const browserRequest = (headers: Record<string, string>) => ({ headers }) as any;
assert.equal(isTrustedGatewayBrowserRequest(browserRequest({})), true, "native callers may omit browser headers");
assert.equal(isTrustedGatewayBrowserRequest(browserRequest({ origin: "http://127.0.0.1:3002" })), true);
assert.equal(isTrustedGatewayBrowserRequest(browserRequest({ origin: "http://localhost:4321" })), true);
assert.equal(isTrustedGatewayBrowserRequest(browserRequest({
	origin: "https://attacker.example",
	"sec-fetch-site": "cross-site",
})), false, "unrelated webpages cannot drive the loopback gateway");
assert.equal(isTrustedGatewayBrowserRequest(browserRequest({ origin: "null" })), false);

assert.equal(
	isTrustedStandaloneWebSocketRequest(browserRequest({ host: "127.0.0.1:8766" })),
	true,
	"native clients may omit browser origin headers",
);
assert.equal(isTrustedStandaloneWebSocketRequest(browserRequest({
	host: "127.0.0.1:8766",
	origin: "http://localhost:4321",
	"sec-fetch-site": "same-site",
})), true, "loopback spellings are treated as one local trust boundary");
assert.equal(isTrustedStandaloneWebSocketRequest(browserRequest({
	host: "voice.tinyfat.dev",
	origin: "https://voice.tinyfat.dev",
	"sec-fetch-site": "same-origin",
})), true, "same-host browser voice is accepted behind a proxy");
assert.equal(isTrustedStandaloneWebSocketRequest(browserRequest({
	host: "127.0.0.1:8766",
	origin: "https://attacker.example",
})), false, "an unrelated origin cannot connect to a local voice socket");
assert.equal(isTrustedStandaloneWebSocketRequest(browserRequest({
	host: "127.0.0.1:8766",
	origin: "https://attacker.example",
	"x-forwarded-host": "attacker.example",
	"sec-fetch-site": "cross-site",
})), false, "Fetch Metadata rejection cannot be bypassed with forwarded headers");

const gatewaySource = readFileSync(new URL("../src/gateway.ts", import.meta.url), "utf8");
const uiIndex = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
assert.match(gatewaySource, /script-src 'self'/, "the local operator UI forbids inline and third-party script");
assert.match(gatewaySource, /Content-Security-Policy/, "the local operator UI serves a CSP header");
assert.doesNotMatch(uiIndex, /<script>(?!\s*<\/script>)/, "the operator UI does not require inline script");

console.log("gateway loopback security ok");
