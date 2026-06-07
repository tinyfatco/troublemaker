import { EventEmitter } from "events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WebAdapter } from "../src/adapters/web.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

interface MockResponse {
	statusCode?: number;
	headers?: Record<string, string>;
	body: string;
	ended: boolean;
	flushHeaders?: () => void;
	writeHead(statusCode: number, headers?: Record<string, string>): void;
	write(chunk: string): void;
	end(chunk?: string): void;
}

function createMockResponse(onEnd: () => void): MockResponse {
	return {
		body: "",
		ended: false,
		flushHeaders() {},
		writeHead(statusCode, headers) {
			this.statusCode = statusCode;
			this.headers = headers;
		},
		write(chunk) {
			this.body += chunk;
		},
		end(chunk) {
			if (chunk) this.body += chunk;
			this.ended = true;
			onEnd();
		},
	};
}

function dispatch(adapter: WebAdapter, payload: Record<string, unknown>): Promise<MockResponse> {
	return new Promise((resolve) => {
		const req = new EventEmitter() as any;
		const res = createMockResponse(() => resolve(res));
		adapter.dispatch(req, res as any);
		req.emit("data", Buffer.from(JSON.stringify(payload)));
		req.emit("end");
	});
}

async function run() {
	const workspaceRoot = mkdtempSync(join(tmpdir(), "tf-project-chat-"));
	const workingDir = join(workspaceRoot, "agent");
	const projectWorkspace = join(workspaceRoot, "projects", "demo-site");
	try {
		mkdirSync(workingDir, { recursive: true });
		let lastEvent: MomEvent | undefined;
		const adapter = new WebAdapter({ workingDir });
		const handler: MomHandler = {
			isRunning: () => false,
			handleSlashCommand: async () => false,
			handleSteer: () => {},
			handleStop: async () => {},
			resolvePendingInput: () => false,
			handleEvent: async (event, platform) => {
				lastEvent = event;
				const ctx = platform.createContext(event, {} as any);
				ctx.emitContentBlock?.({ type: "text", text: "I updated the preview." });
			},
		};
		adapter.setHandler(handler);

		await dispatch(adapter, {
			message: "Make the hero friendlier",
			channelId: "project:demo-site:default",
			source: "project",
			sourceEventType: "tinyfat_project_chat",
			sessionId: "project:demo-site:default",
			project: {
				slug: "demo-site",
				siteId: "site-123",
				displayName: "Demo Site",
				previewUrl: "https://demo-site.preview.tinyfat.dev/",
				state: "preview",
				workspacePath: projectWorkspace,
				threadId: "default",
				latestDeploymentUrl: "https://demo-site.preview.tinyfat.dev/",
				initialBrief: "Build a warm neighborhood bakery website.",
				latestDeploymentState: "live",
			},
		});

		assert(lastEvent?.sourceEventType === "tinyfat_project_chat", "project source event type reaches handler");
		assert(lastEvent?.sessionId === "project:demo-site:default", "project session id reaches handler without fresh-context reset");
		assert(lastEvent?.freshContext === false, "project chat does not clear continuous awareness by default");
		assert(lastEvent?.project?.slug === "demo-site", "project slug reaches MomEvent");
		assert(lastEvent?.project?.threadId === "default", "project thread id reaches MomEvent");
		assert(lastEvent?.project?.workspacePath === projectWorkspace, "project workspace path reaches MomEvent");
		assert(lastEvent?.project?.initialBrief === "Build a warm neighborhood bakery website.", "project initial brief reaches MomEvent");

		const transcriptPath = join(projectWorkspace, "threads", "default.jsonl");
		const summaryPath = join(projectWorkspace, "threads", "default.summary.md");
		assert(existsSync(transcriptPath), "project transcript file is created");
		assert(existsSync(summaryPath), "project summary file is created");

		const transcript = readFileSync(transcriptPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert(transcript.length === 2, "project transcript records user and assistant turns");
		assert(transcript[0]?.role === "user", "first transcript entry is user");
		assert(transcript[0]?.text === "Make the hero friendlier", "user transcript preserves text");
		assert(transcript[1]?.role === "assistant", "second transcript entry is assistant");
		assert(transcript[1]?.text === "I updated the preview.", "assistant transcript records final text block");

		const summary = readFileSync(summaryPath, "utf-8");
		assert(summary.includes("Demo Site Project Thread"), "summary includes project title");
		assert(summary.includes("Make the hero friendlier"), "summary includes recent user turn");

		let secondEvent: MomEvent | undefined;
		handler.handleEvent = async (event) => {
			secondEvent = event;
		};
		await dispatch(adapter, {
			message: "What did we just change?",
			channelId: "project:demo-site:default",
			source: "project",
			sourceEventType: "tinyfat_project_chat",
			project: {
				slug: "demo-site",
				workspacePath: projectWorkspace,
				threadId: "default",
			},
		});
		assert((secondEvent?.project?.recentTranscript || []).length === 2, "next project turn carries recent transcript");
		assert(secondEvent?.project?.recentTranscript?.[0]?.text === "Make the hero friendlier", "recent transcript is ordered");
	} finally {
		rmSync(workspaceRoot, { recursive: true, force: true });
	}
}

await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
