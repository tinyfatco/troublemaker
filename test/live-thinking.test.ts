import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { LiveThinkingBridge, liveThinkingPrompt, type LiveThinkingInput } from "../src/live-thinking-bridge.js";
import { LiveThinkingRouter } from "../src/live-thinking-router.js";
import { LiveThinkingIngress } from "../src/live-thinking-ingress.js";
import { createLiveVoiceUpdateTool } from "../src/tools/live-voice-update.js";
import { createLiveThinkingAdapter } from "../src/adapters/live-thinking.js";

const root = mkdtempSync(join(tmpdir(), "live-thinking-synthetic-"));
const input = (sequence: number, role: "room" | "assistant" = "room"): LiveThinkingInput => ({
	session_id: "synthetic", sequence, fragments: [{ id: `fragment-${sequence}`, role,
		text: sequence ? "Actually, do not send it yet" : "Could you prepare a draft", start_ms: sequence * 100, end_ms: sequence * 100 + 50 }],
});
try {
	const dispatched: LiveThinkingInput[] = [];
	const bridge = new LiveThinkingBridge(root, value => {
		// A receipt must reach stable storage BEFORE tools/steering could see it.
		const disk = JSON.parse(readFileSync(join(root, "synthetic.json"), "utf8"));
		assert.equal(disk.receipts.length, value.sequence + 1);
		dispatched.push(value);
	});
	bridge.open("synthetic"); bridge.open("synthetic");
	bridge.accept(input(0)); bridge.accept(input(1));
	assert.equal(dispatched.length, 2, "ongoing work must not serialize acceptance behind completion");
	bridge.accept(input(0)); assert.equal(dispatched.length, 2);
	assert.throws(() => bridge.accept({ ...input(0), fragments: input(1).fragments }), /Conflicting/);
	assert.throws(() => bridge.accept(input(3)), /order/);
	bridge.accept({ ...input(2), fragments: input(0).fragments });
	assert.equal(dispatched.length, 2, "stable fragment identity prevents cross-batch repeat dispatch");
	assert.throws(() => bridge.accept({ ...input(3), fragments: [{ ...input(0).fragments[0], text: "changed" }] }), /Conflicting/);
	assert.throws(() => bridge.accept({ ...input(3), fragments: [{ ...input(3).fragments[0], role: "Alex" as any }] }), /Invalid/);
	assert.throws(() => bridge.open("../outside"), /Invalid/);
	assert.equal(statSync(join(root, "synthetic.json")).mode & 0o777, 0o600);
	const updates: unknown[] = [];
	const unsubscribe = bridge.subscribe("synthetic", update => updates.push(update));
	assert.throws(() => bridge.subscribe("synthetic", () => {}), /already/);
	bridge.publish("synthetic", "Draft prepared; not sent."); bridge.publish("synthetic", "Draft prepared; not sent.");
	assert.deepEqual(updates, [{ id: 0, text: "Draft prepared; not sent." }]);
	assert.throws(() => bridge.publish("another-session", "Wrong recipient"), /unavailable/);
	const tool = createLiveVoiceUpdateTool((id, text) => bridge.publish(id, text));
	await tool.execute("synthetic-tool", { session_id: "synthetic", text: "Waiting for your decision." });
	assert.equal(updates.length, 2);
	unsubscribe();
	const recovered = new LiveThinkingBridge(root, () => assert.fail("must never replay uncertain work"));
	assert.throws(() => recovered.open("synthetic"), /replayed/);
	assert.throws(() => recovered.accept(input(0)), /unavailable/);
	bridge.close("synthetic"); bridge.close("synthetic");
	assert.throws(() => bridge.publish("synthetic", "Late result"), /unavailable/);
	assert.throws(() => bridge.accept(input(3)), /unavailable/);
	recovered.open("new-session"); recovered.close("new-session");

	// No assistant feedback loop; fallback input coalesces while a canonical
	// operation is unavailable. Corrections steer immediately once supported.
	let canSteer = false;
	const steered: string[] = []; const queued: Array<() => { prompt: string } | null> = [];
	const router = new LiveThinkingRouter({
		steer: prompt => { if (!canSteer) return false; steered.push(prompt); return true; },
		queue: (_id, take) => queued.push(take),
	});
	router.accept(input(0, "assistant")); assert.equal(queued.length, 0);
	router.accept(input(1)); router.accept(input(2)); assert.equal(queued.length, 1);
	const first = queued[0]()!;
	assert(first.prompt.includes("fragment-0") && first.prompt.includes("fragment-2"));
	assert(first.prompt.includes("UNVERIFIED") && first.prompt.includes("ONLY audible"));
	canSteer = true; router.accept(input(3)); assert.equal(steered.length, 1);
	assert(!steered[0].includes("fragment-1"), "new steering must not resubmit full prior requests");
	assert(steered[0].includes("live_voice_update"));
	router.accept(input(4, "assistant")); assert.equal(steered.length, 1);
	assert(liveThinkingPrompt(input(0)).includes("NOT completed thoughts"));

	// Session-scoped final delivery; never forward arbitrary awareness events.
	const finals: string[] = [];
	const adapter = createLiveThinkingAdapter(root, (id, text) => finals.push(`${id}:${text}`));
	const ctx = adapter.createContext({ type: "dm", channel: "duplex-thinking", user: "live", ts: "1", text: "synthetic", sessionId: "s" }, {} as any);
	await ctx.respond("not final"); assert.deepEqual(finals, []);
	await ctx.sendFinalResponse("verified result"); assert.deepEqual(finals, ["s:verified result"]);
	assert.equal(ctx.message.directlyAddressed, false);
	assert.equal(adapter.name, "live-thinking");

	// Real HTTP, synthetic payloads only; no agent/model calls.
	const ingressBridge = new LiveThinkingBridge(join(root, "http"), () => {});
	const ingress = new LiveThinkingIngress(ingressBridge);
	const server = createServer((req, res) => ingress.dispatch(req, res));
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}/live-thinking`;
	try {
		const post = (body: object) => fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await (await fetch(base)).json()).thinking_bridge, 1);
		assert.equal((await post({ type: "thinking.open", session_id: "http-synthetic" })).status, 200);
		const abort = new AbortController();
		const response = await fetch(`${base}?session_id=http-synthetic`, { signal: abort.signal });
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		const reader = response.body!.getReader(); await reader.read();
		ingressBridge.publish("http-synthetic", "Synthetic verified update");
		const chunk = await reader.read(); assert(new TextDecoder().decode(chunk.value).includes("Synthetic verified update"));
		assert.equal((await post({ type: "thinking.input", ...input(0), session_id: "http-synthetic" })).status, 200);
		assert.equal((await post({ type: "thinking.close", session_id: "http-synthetic" })).status, 200);
		abort.abort();
		assert.equal((await fetch(`${base}?session_id=http-synthetic`)).status, 409);
		assert.equal((await post({ type: "thinking.open", session_id: "../bad" })).status, 400);
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
	console.log("live thinking: continuous admission, dedupe, correction steering, quiet scoped return, restart/hangup boundaries OK");
} finally { await rm(root, { recursive: true, force: true }); }
