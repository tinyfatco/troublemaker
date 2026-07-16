import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordGatewayAdapter } from "../src/adapters/discord-gateway.js";
import type { MomEvent } from "../src/adapters/types.js";

const BOT_ID = "100000000000000001";
const CHANNEL_ID = "200000000000000002";
const MESSAGE_ID = "300000000000000003";

async function runCase(
	toolStreaming: "off" | "important" | "all",
	show?: boolean,
): Promise<{ calls: Array<{ method: string; body: string }>; presentation: string | undefined }> {
	const workingDir = mkdtempSync(join(tmpdir(), "tm-discord-tool-streaming-"));
	try {
		writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
			verbose: { discord: "messages-only" },
			discord: {
				toolStreaming,
				toolStreamPresentation: "condensed",
				toolStreamWindowMinutes: 7,
			},
		}));

		const calls: Array<{ method: string; body: string }> = [];
		const adapter = new DiscordGatewayAdapter({
			botToken: "test-bot-token",
			applicationId: BOT_ID,
			workingDir,
			rest: {
				fetch: (async (_input, init) => {
					calls.push({
						method: String(init?.method || "GET"),
						body: String(init?.body || ""),
					});
					return new Response(JSON.stringify({ id: MESSAGE_ID }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}) as typeof fetch,
			},
		});
		const event: MomEvent = {
			type: "mention",
			channel: CHANNEL_ID,
			ts: MESSAGE_ID,
			user: "400000000000000004",
			text: "test",
			sourceEventType: "discord_mention",
			directlyAddressed: true,
		};
		const context = adapter.createContext(event, null as never);
		await context.respond("_→ Safe tool label_", false, { show });
		return { calls, presentation: context.workingStreamPresentation };
	} finally {
		rmSync(workingDir, { recursive: true, force: true });
	}
}

const off = await runCase("off", true);
assert.equal(off.calls.length, 0, "off hides every Discord tool label");

const unselected = await runCase("important", false);
assert.equal(unselected.calls.length, 0, "important hides Discord labels without show:true");

const selected = await runCase("important", true);
assert.equal(selected.calls.length, 1, "important surfaces Discord labels marked show:true");
assert.match(selected.calls[0]?.body || "", /Safe tool label/);
assert.equal(selected.presentation, "condensed", "Discord applies its configured tool-stream presentation");

const all = await runCase("all", false);
assert.equal(all.calls.length, 1, "all surfaces every safe Discord tool label");
assert.match(all.calls[0]?.body || "", /Safe tool label/);

console.log("discord-tool-streaming ok");
