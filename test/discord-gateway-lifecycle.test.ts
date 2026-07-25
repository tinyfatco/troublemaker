import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DiscordGatewayAdapter,
	type DiscordGatewayTimerApi,
} from "../src/adapters/discord-gateway.js";
import type { MomHandler } from "../src/adapters/types.js";

// Synthetic Discord-shaped fixtures; none identify a real account or deployment.
const BOT_ID = "100000000000000001";
const GUILD_ID = "200000000000000002";
const CHANNEL_ID = "300000000000000003";
const USER_ID = "400000000000000004";
const MESSAGE_ID = "500000000000000005";

interface ScheduledTask {
	id: number;
	at: number;
	callback: () => void;
}

class FakeClock implements DiscordGatewayTimerApi {
	private current = 0;
	private nextId = 1;
	private tasks = new Map<number, ScheduledTask>();

	now(): number {
		return this.current;
	}

	setTimeout(callback: () => void, delayMs: number): number {
		const id = this.nextId++;
		this.tasks.set(id, { id, at: this.current + Math.max(0, delayMs), callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.tasks.delete(handle as number);
	}

	runDue(): void {
		this.advance(0);
	}

	advance(delayMs: number): void {
		const target = this.current + delayMs;
		for (;;) {
			const next = Array.from(this.tasks.values())
				.filter((task) => task.at <= target)
				.sort((a, b) => a.at - b.at || a.id - b.id)[0];
			if (!next) break;
			this.current = next.at;
			this.tasks.delete(next.id);
			next.callback();
		}
		this.current = target;
	}
}

class FakeSocket extends EventEmitter {
	readyState = 0;
	readonly sent: string[] = [];
	closedWith: number | undefined;
	terminated = false;

	constructor(readonly url: string) {
		super();
	}

	open(): void {
		this.readyState = 1;
		this.emit("open");
	}

	serverFrame(frame: unknown): void {
		this.emit("message", typeof frame === "string" ? frame : JSON.stringify(frame));
	}

	send(data: string): void {
		if (this.readyState !== 1) throw new Error("fake socket is not open");
		this.sent.push(data);
	}

	close(code = 1000): void {
		if (this.readyState === 3) return;
		this.closedWith = code;
		this.readyState = 3;
		this.emit("close", code, Buffer.alloc(0));
	}

	terminate(): void {
		if (this.readyState === 3) return;
		this.terminated = true;
		this.readyState = 3;
		this.emit("close", 1006, Buffer.alloc(0));
	}
}

function handler(): MomHandler {
	return {
		isRunning: () => false,
		handleEvent: async () => {},
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};
}

function frames(socket: FakeSocket): Array<{ op: number; d: any }> {
	return socket.sent.map((frame) => JSON.parse(frame));
}

async function flushAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 1000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function makeHarness(
	workingDir: string,
	discoveryOverrides: Record<string, unknown> = {},
	shard: { shardId?: number; shardCount?: number } = {},
) {
	const clock = new FakeClock();
	const sockets: FakeSocket[] = [];
	let discoveryCalls = 0;
	const adapter = new DiscordGatewayAdapter({
		botToken: "test-bot-token",
		applicationId: BOT_ID,
		workingDir,
		startupTimeoutMs: 20_000,
		helloTimeoutMs: 5000,
		reconnectBaseDelayMs: 1000,
		reconnectMaxDelayMs: 8000,
		...shard,
		rest: {
			fetch: (async (input) => {
				discoveryCalls++;
				assert.equal(String(input), "https://discord.com/api/v10/gateway/bot");
				return new Response(JSON.stringify({
					url: "wss://gateway.discord.gg",
					shards: 1,
					session_start_limit: {
						total: 100,
						remaining: 100,
						reset_after: 60_000,
						max_concurrency: 1,
					},
					...discoveryOverrides,
				}), { status: 200, headers: { "content-type": "application/json" } });
			}) as typeof fetch,
		},
		dependencies: {
			random: () => 0.5,
			timers: clock,
			createWebSocket: (url) => {
				const socket = new FakeSocket(url);
				sockets.push(socket);
				return socket;
			},
		},
	});
	adapter.setHandler(handler());
	return { adapter, clock, sockets, discoveryCalls: () => discoveryCalls };
}

async function startReady(harness: ReturnType<typeof makeHarness>, sequence = 42): Promise<FakeSocket> {
	const starting = harness.adapter.start();
	await flushAsync();
	assert.equal(harness.sockets.length, 1);
	const socket = harness.sockets[0];
	assert.match(socket.url, /^wss:\/\/gateway\.discord\.gg\/?\?/);
	assert.match(socket.url, /v=10/);
	assert.match(socket.url, /encoding=json/);
	socket.open();
	socket.serverFrame({ op: 10, d: { heartbeat_interval: 1000 } });
	harness.clock.runDue();
	const identify = frames(socket).find((frame) => frame.op === 2);
	assert.ok(identify, "Hello schedules Identify");
	assert.equal(identify.d.token, "test-bot-token");
	assert.equal(identify.d.intents, 37377);
	assert.deepEqual(identify.d.properties, {
		os: process.platform,
		browser: "troublemaker",
		device: "troublemaker",
	});
	socket.serverFrame({
		op: 0,
		t: "READY",
		s: sequence,
		d: {
			session_id: "00000000-0000-4000-8000-000000000001",
			resume_gateway_url: "wss://gateway-us-east1-b.discord.gg",
			user: { id: BOT_ID, username: "sample-bot", bot: true },
			guilds: [],
		},
	});
	await withTimeout(starting, "initial Gateway READY");
	return socket;
}

const heartbeatDir = mkdtempSync(join(tmpdir(), "tm-discord-gateway-heartbeat-"));
const zeroResetDir = mkdtempSync(join(tmpdir(), "tm-discord-gateway-zero-reset-"));
const invalidSessionDir = mkdtempSync(join(tmpdir(), "tm-discord-gateway-invalid-"));
const exhaustedDir = mkdtempSync(join(tmpdir(), "tm-discord-gateway-exhausted-"));
const fatalDir = mkdtempSync(join(tmpdir(), "tm-discord-gateway-fatal-"));
const resumableCloseDir = mkdtempSync(join(tmpdir(), "tm-discord-gateway-resumable-close-"));
const nonResumableCloseDir = mkdtempSync(join(tmpdir(), "tm-discord-gateway-nonresumable-close-"));
const shardedDir = mkdtempSync(join(tmpdir(), "tm-discord-gateway-sharded-"));
const missingShardDir = mkdtempSync(join(tmpdir(), "tm-discord-gateway-missing-shard-"));
const undershardedDir = mkdtempSync(join(tmpdir(), "tm-discord-gateway-undersharded-"));
try {
	{
		const harness = makeHarness(zeroResetDir, {
			session_start_limit: {
				total: 100,
				remaining: 100,
				reset_after: 0,
				max_concurrency: 1,
			},
		});
		await startReady(harness);
		assert.equal(harness.discoveryCalls(), 1, "a positive Identify budget is usable even when Discord reports reset_after=0");
		await harness.adapter.stop();
	}

	{
		const harness = makeHarness(heartbeatDir);
		const first = await startReady(harness);
		assert.equal(harness.discoveryCalls(), 1);

		harness.clock.advance(500);
		const firstHeartbeat = frames(first).find((frame) => frame.op === 1);
		assert.deepEqual(firstHeartbeat, { op: 1, d: 42 }, "heartbeat carries the latest sequence");
		first.serverFrame({ op: 11, d: null });
		harness.clock.advance(1000);
		assert.equal(frames(first).filter((frame) => frame.op === 1).length, 2);
		harness.clock.advance(1000);
		assert.equal(first.terminated, true, "a missing ACK before the next heartbeat terminates the zombie socket");
		assert.equal(harness.sockets.length, 1);
		harness.clock.advance(749);
		assert.equal(harness.sockets.length, 1, "reconnect uses jittered backoff");
		harness.clock.advance(1);
		assert.equal(harness.sockets.length, 2);

		const resumed = harness.sockets[1];
		assert.match(resumed.url, /^wss:\/\/gateway-us-east1-b\.discord\.gg\/?\?/);
		resumed.open();
		resumed.serverFrame({ op: 10, d: { heartbeat_interval: 1000 } });
		const resume = frames(resumed).find((frame) => frame.op === 6);
		assert.deepEqual(resume, {
			op: 6,
			d: {
				token: "test-bot-token",
				session_id: "00000000-0000-4000-8000-000000000001",
				seq: 42,
			},
		});
		resumed.serverFrame({ op: 0, t: "RESUMED", s: 43, d: {} });
		resumed.serverFrame({ op: 9, d: true });
		harness.clock.advance(3000);
		const invalidSessionResume = harness.sockets[2];
		invalidSessionResume.open();
		invalidSessionResume.serverFrame({ op: 10, d: { heartbeat_interval: 1000 } });
		assert.equal(frames(invalidSessionResume).find((frame) => frame.op === 6)?.d.seq, 43, "a resumable invalid session keeps its session and sequence");
		invalidSessionResume.serverFrame({ op: 0, t: "RESUMED", s: 44, d: {} });
		await flushAsync();
		await harness.adapter.stop();
		assert.equal(invalidSessionResume.closedWith, 1000, "clean stop sends a normal close");
		harness.clock.advance(60_000);
		assert.equal(harness.sockets.length, 3, "clean stop cannot reconnect");
	}

	{
		const harness = makeHarness(invalidSessionDir);
		const first = await startReady(harness, 10);
		first.serverFrame("{not-json");
		first.serverFrame({ unexpected: true });
		assert.equal(first.readyState, 1, "malformed frames are ignored without taking down the socket");

		first.serverFrame({ op: 0, t: "MESSAGE_CREATE", s: 11, d: {
			id: MESSAGE_ID,
			channel_id: CHANNEL_ID,
			guild_id: GUILD_ID,
			content: `<@${BOT_ID}> hello`,
			author: { id: USER_ID, username: "sample-user" },
			mentions: [{ id: BOT_ID }],
		} });
		first.serverFrame({ op: 7, d: null });
		harness.clock.runDue();
		assert.equal(harness.sockets.length, 2, "Reconnect opcode opens a resumable connection immediately");
		const resumed = harness.sockets[1];
		resumed.open();
		resumed.serverFrame({ op: 10, d: { heartbeat_interval: 1000 } });
		assert.equal(frames(resumed).find((frame) => frame.op === 6)?.d.seq, 11, "Reconnect opcode resumes from the latest dispatch sequence");
		resumed.serverFrame({ op: 0, t: "RESUMED", s: 12, d: {} });
		resumed.serverFrame({ op: 9, d: false });
		harness.clock.advance(3000);
		assert.equal(harness.sockets.length, 3);
		const reidentified = harness.sockets[2];
		reidentified.open();
		reidentified.serverFrame({ op: 10, d: { heartbeat_interval: 10_000 } });
		harness.clock.advance(1999);
		assert.equal(frames(reidentified).some((frame) => frame.op === 2), false, "Identify concurrency window is respected");
		harness.clock.advance(1);
		assert.equal(frames(reidentified).some((frame) => frame.op === 2), true, "non-resumable invalid sessions re-identify after the concurrency window");
		await harness.adapter.stop();
	}

	{
		const harness = makeHarness(resumableCloseDir);
		const first = await startReady(harness, 20);
		first.close(4000);
		harness.clock.advance(750);
		const resumed = harness.sockets[1];
		resumed.open();
		resumed.serverFrame({ op: 10, d: { heartbeat_interval: 1000 } });
		assert.equal(frames(resumed).find((frame) => frame.op === 6)?.d.seq, 20, "an unknown recoverable close resumes the active session");
		await harness.adapter.stop();
	}

	{
		const harness = makeHarness(nonResumableCloseDir);
		const first = await startReady(harness, 30);
		first.close(4007);
		harness.clock.advance(750);
		const reidentified = harness.sockets[1];
		reidentified.open();
		reidentified.serverFrame({ op: 10, d: { heartbeat_interval: 10_000 } });
		assert.equal(frames(reidentified).some((frame) => frame.op === 6), false, "an invalid-sequence close never attempts Resume");
		harness.clock.advance(4250);
		assert.equal(frames(reidentified).some((frame) => frame.op === 2), true, "an invalid-sequence close starts a new identified session");
		await harness.adapter.stop();
	}

	{
		const harness = makeHarness(exhaustedDir, {
			session_start_limit: {
				total: 100,
				remaining: 0,
				reset_after: 60_000,
				max_concurrency: 1,
			},
		});
		await assert.rejects(() => harness.adapter.start(), /session start limit is exhausted/);
		assert.equal(harness.sockets.length, 0, "an exhausted Identify budget never opens a socket");
	}

	{
		const harness = makeHarness(shardedDir, { shards: 2 }, { shardId: 1, shardCount: 2 });
		const socket = await startReady(harness);
		assert.deepEqual(frames(socket).find((frame) => frame.op === 2)?.d.shard, [1, 2], "configured shard identity is included in Identify");
		await harness.adapter.stop();
	}

	{
		const harness = makeHarness(missingShardDir, { shards: 2 });
		await assert.rejects(() => harness.adapter.start(), /recommends 2 shards/);
		assert.equal(harness.sockets.length, 0, "recommended sharding cannot silently start partial coverage");
	}

	{
		const harness = makeHarness(undershardedDir, { shards: 2 }, { shardId: 0, shardCount: 1 });
		await assert.rejects(() => harness.adapter.start(), /below the recommended count/);
		assert.equal(harness.sockets.length, 0, "a configured shard count below discovery guidance is rejected");
	}

	{
		const harness = makeHarness(fatalDir);
		const socket = await startReady(harness);
		socket.close(4014);
		harness.clock.advance(60_000);
		assert.equal(harness.sockets.length, 1, "a disallowed-intents close code does not reconnect-loop");
		await harness.adapter.stop();
	}
} finally {
	for (const dir of [
		heartbeatDir,
		zeroResetDir,
		invalidSessionDir,
		exhaustedDir,
		fatalDir,
		resumableCloseDir,
		nonResumableCloseDir,
		shardedDir,
		missingShardDir,
		undershardedDir,
	]) {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("discord-gateway-lifecycle ok");
