import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FormWebhookAdapter, type FormInboundPayload } from "../src/adapters/form-webhook.js";
import type { MomEvent, MomHandler, SlashCommandResult } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

function makeHandler() {
	const handled: MomEvent[] = [];
	const steered: MomEvent[] = [];
	const handler: MomHandler = {
		isRunning: () => false,
		handleEvent: async (event) => {
			handled.push(event);
		},
		handleSlashCommand: async (): Promise<SlashCommandResult> => false,
		handleSteer: (event) => {
			steered.push(event);
		},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};
	return { handler, handled, steered };
}

const workingDir = mkdtempSync(join(tmpdir(), "tm-form-webhook-"));

try {
	const adapter = new FormWebhookAdapter({ workingDir });
	const { handler, handled, steered } = makeHandler();
	adapter.setHandler(handler);

	const payload: FormInboundPayload = {
		source: "website_form",
		submissionId: "sub_123",
		submittedAt: "2026-06-12T18:30:00.000Z",
		site: {
			id: "site-123",
			slug: "acme-roofing",
			displayName: "Acme Roofing",
			previewUrl: "https://acme-roofing.preview.tinyfat.dev/",
			hostname: "acme-roofing.preview.tinyfat.dev",
		},
		form: {
			id: "contact",
			pageUrl: "https://acme-roofing.preview.tinyfat.dev/contact",
		},
		visitor: {
			name: "Jordan Lee",
			email: "jordan@example.com",
			phone: "555-1212",
		},
		fields: {
			name: "Jordan Lee",
			email: "jordan@example.com",
			message: "Can you quote a roof repair this week?",
		},
		fieldOrder: ["name", "email", "message"],
		text: "New website form submission\n\nSite: Acme Roofing (acme-roofing)\n\nFields:\n- message: Can you quote a roof repair this week?",
		metadata: {
			ip: "203.0.113.10",
		},
	};

	await (adapter as unknown as {
		processInbound(payload: FormInboundPayload): Promise<void>;
	}).processInbound(payload);

	assert.equal(handled.length, 1, "form submission starts a run");
	assert.equal(steered.length, 0);
	assert.match(handled[0]!.channel, /^form-/);
	assert.equal(handled[0]!.sourceEventType, "form_submission");
	assert.equal(handled[0]!.user, "jordan@example.com");
	assert.match(handled[0]!.text, /Acme Roofing/);
	assert.match(handled[0]!.text, /roof repair/);

	const channel = adapter.getChannel(handled[0]!.channel);
	assert(channel, "form channel is discoverable");
	assert.equal(channel.name, "acme-roofing/Jordan Lee");

	const inboundLog = readFileSync(join(workingDir, "log.jsonl"), "utf-8");
	assert.match(inboundLog, /"sourceEventType":"form_submission"/);
	assert.match(inboundLog, /"submissionId":"sub_123"/);

	const ctx = adapter.createContext(handled[0]!, {} as ChannelStore);
	await ctx.respond("ordinary transcript that must not leak");
	await ctx.sendFinalResponse("ordinary final transcript that must not leak");
	await ctx.setWorking(false);
	const afterOrdinaryFinal = readFileSync(join(workingDir, "log.jsonl"), "utf-8");
	assert(!afterOrdinaryFinal.includes("ordinary final transcript"), "ordinary final response is not delivered on form ingress");

	await ctx.sendFinalResponse("_Sorry, something went wrong: test failure_", { force: true });
	await ctx.setWorking(false);
	const afterForcedFinal = readFileSync(join(workingDir, "log.jsonl"), "utf-8");
	assert(afterForcedFinal.includes("test failure"), "forced runtime errors are still logged");

	console.log("form-webhook happy path ok");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
