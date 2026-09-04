import assert from "node:assert/strict";
import { SlackNativeProgress, type SlackNativeProgressApi } from "../src/adapters/slack-native-progress.js";

function createHarness(options: { mode?: "off" | "important" | "all"; verbose?: boolean; failStart?: boolean } = {}) {
	const starts: unknown[] = [];
	const appends: unknown[] = [];
	const stops: unknown[] = [];
	const deletes: unknown[] = [];
	const fallbacks: Array<{ label: string; show: boolean }> = [];
	let nextTs = 1;

	const api: SlackNativeProgressApi = {
		async startStream(args) {
			starts.push(args);
			if (options.failStart) throw new Error("native unavailable");
			return { ts: `1700000000.00000${nextTs++}` };
		},
		async appendStream(args) { appends.push(args); },
		async stopStream(args) { stops.push(args); },
		async deleteMessage(args) { deletes.push(args); },
	};

	const progress = new SlackNativeProgress({
		api,
		channel: "C123",
		threadTs: "1700000000.000000",
		mode: options.mode ?? "important",
		verbose: options.verbose ?? false,
		recipientTeamId: "T123",
		recipientUserId: "U123",
		fallback: async (label, show) => { fallbacks.push({ label, show }); },
	});

	return { progress, starts, appends, stops, deletes, fallbacks };
}

{
	const h = createHarness();
	await h.progress.update({ id: "hidden", label: "Routine work", status: "in_progress" });
	assert.equal(h.starts.length, 0, "important mode fails closed without show:true");

	await h.progress.update({
		id: "visible",
		label: "Checking deployment health",
		status: "in_progress",
		show: true,
		details: {
			invocation: { text: "SAFE_DETAIL_MUST_NOT_ENTER_NATIVE_TASK", format: "text", isTruncated: false },
			artifacts: [],
		},
	});
	assert.deepEqual(h.starts, [{
		channel: "C123",
		thread_ts: "1700000000.000000",
		chunks: [{ type: "task_update", id: "visible", title: "Checking deployment health", status: "in_progress" }],
		task_display_mode: "timeline",
		recipient_team_id: "T123",
		recipient_user_id: "U123",
	}], "selected safe label opens a native timeline task");

	await h.progress.update({ id: "visible", label: "Checking deployment health", status: "complete", show: true });
	assert.deepEqual(h.appends, [{
		channel: "C123",
		ts: "1700000000.000001",
		chunks: [{ type: "task_update", id: "visible", title: "Checking deployment health", status: "complete" }],
	}], "completion updates the same task without result data");

	await h.progress.finalizeSegment();
	assert.deepEqual(h.stops, [{ channel: "C123", ts: "1700000000.000001" }]);

	await h.progress.update({ id: "later", label: "Verifying live health", status: "in_progress", show: true });
	assert.equal(h.starts.length, 2, "a chronology rollover opens a fresh native stream segment");
}

{
	const h = createHarness({ mode: "all" });
	await h.progress.update({ id: "routine", label: "Routine work", status: "in_progress" });
	assert.equal(h.starts.length, 1, "all mode surfaces safe labels without show:true");
}

{
	const h = createHarness({ mode: "off", verbose: false });
	await h.progress.update({ id: "selected", label: "Selected work", status: "in_progress", show: true });
	assert.equal(h.starts.length, 0, "off mode disables native task rendering");
}

{
	const h = createHarness({ mode: "off", verbose: true });
	await h.progress.update({ id: "verbose", label: "Verbose work", status: "in_progress" });
	assert.equal(h.starts.length, 1, "verbose mode preserves full progress visibility");
}

{
	const h = createHarness({ failStart: true });
	await h.progress.update({ id: "fallback", label: "Safe fallback label", status: "in_progress", show: true });
	await h.progress.update({ id: "fallback", label: "Safe fallback label", status: "error", show: true });
	assert.deepEqual(h.fallbacks, [{ label: "Safe fallback label", show: true }], "native API failure falls back to the existing label renderer once");
}

{
	const h = createHarness();
	await h.progress.update({ id: "delete", label: "Temporary work", status: "in_progress", show: true });
	await h.progress.finalizeSegment();
	await h.progress.deleteAll();
	assert.deepEqual(h.deletes, [{ channel: "C123", ts: "1700000000.000001" }], "quiet-run cleanup can remove finalized native progress messages");
}

console.log("slack-native-progress tests passed");
