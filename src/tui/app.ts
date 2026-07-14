import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	DynamicBorder,
	UserMessageComponent,
	getMarkdownTheme,
	getSelectListTheme,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	CombinedAutocompleteProvider,
	Container,
	Editor,
	Key,
	Loader,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
	matchesKey,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { RuntimeAssistantSnapshotContent, RuntimeAssistantSnapshotEntry, RuntimeStreamEvent } from "../core/runtime-contract.js";
import { TroublemakerTuiClient, type TuiAgentStatus } from "./client.js";
import type { TuiAgentProfile } from "./config.js";
import { assistantContentDelta, parseContextLine, safeToolLabel, toAssistantSnapshot, type TuiHistoryEntry } from "./protocol.js";

const HISTORY_LIMIT = 60;
const HISTORY_RENDER_LIMIT = 30;
const SEEN_AWARENESS_LIMIT = 5_000;
const LOCAL_ECHO_TTL_MS = 30_000;
const ASSISTANT_ECHO_TTL_MS = 30_000;

type AwarenessState = "connecting" | "live" | "reconnecting";
type TranscriptContentKind = "user" | "text" | "tool";

export async function runTroublemakerTui(profile: TuiAgentProfile): Promise<void> {
	const client = new TroublemakerTuiClient(profile);
	const status = await client.getStatus();
	const backlog = await client.getBacklog(HISTORY_LIMIT).catch(() => ({ lines: [], total: 0, offset: 0 }));
	const app = new TroublemakerTuiApp(profile, client, status);
	await app.run(backlog.lines);
}

class TroublemakerTuiApp {
	private readonly terminal = new ProcessTerminal();
	private readonly ui: TUI;
	private readonly header = new Container();
	private readonly chat = new Container();
	private readonly statusContainer = new Container();
	private readonly inputMargin = new Spacer(1);
	private readonly editorContainer = new Container();
	private readonly footer = new Container();
	private readonly editor: Editor;
	private status: TuiAgentStatus;
	private activeAbort: AbortController | null = null;
	private activeTurn: Container | null = null;
	private latestAssistantSnapshot: RuntimeAssistantSnapshotEntry | null = null;
	private activeSegmentBaseline: RuntimeAssistantSnapshotContent[] = [];
	private activeSegmentPrecedingContent: TranscriptContentKind | null = null;
	private lastTranscriptContent: TranscriptContentKind | null = null;
	private activeLoader: Loader | null = null;
	private stopRequested = false;
	private stopped = false;
	private resolveDone: (() => void) | null = null;
	private readonly signalHandlers: Array<() => void> = [];
	private readonly awarenessAbort = new AbortController();
	private awarenessTask: Promise<void> | null = null;
	private awarenessState: AwarenessState = "connecting";
	private readonly seenAwarenessIds = new Set<string>();
	private readonly seenAwarenessOrder: string[] = [];
	private readonly pendingLocalEchoes: Array<{ channel: string; text: string; expiresAt: number }> = [];
	private readonly pendingAssistantEchoes: Array<{ fingerprint: string; expiresAt: number }> = [];
	private readonly steeringAborts = new Set<AbortController>();

	constructor(
		private readonly profile: TuiAgentProfile,
		private readonly client: TroublemakerTuiClient,
		status: TuiAgentStatus,
	) {
		initTheme(undefined, false);
		this.status = status;
		this.ui = new TUI(this.terminal);
		this.editor = new Editor(this.ui, {
			borderColor: (text) => chalk.cyan(text),
			selectList: getSelectListTheme(),
		}, { paddingX: 1, autocompleteMaxVisible: 8 });
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
			{ name: "help", description: "Show terminal commands" },
			{ name: "clear", description: "Clear the terminal transcript" },
			{ name: "reload", description: "Reload recent agent awareness" },
			{ name: "status", description: "Refresh agent status" },
			{ name: "stop", description: "Stop the active turn" },
			{ name: "quit", description: "Exit the terminal UI" },
		], process.cwd()));
		this.editor.onSubmit = (text) => {
			void this.handleSubmit(text);
		};
	}

	async run(historyLines: string[]): Promise<void> {
		this.rebuildHeader();
		this.renderHistory(historyLines);
		this.editorContainer.addChild(this.editor);
		this.rebuildFooter();

		this.ui.addChild(this.header);
		this.ui.addChild(this.chat);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.inputMargin);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);
		this.ui.addInputListener((data) => this.handleGlobalInput(data));
		this.terminal.setTitle(`${this.status.agentName} · Troublemaker`);
		this.registerSignals();
		this.ui.start();
		this.ui.requestRender(true);

		const done = new Promise<void>((resolve) => {
			this.resolveDone = resolve;
		});
		this.awarenessTask = this.runAwarenessLoop(this.awarenessAbort.signal);
		await done;
	}

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.activeAbort) void this.requestStop();
			else void this.shutdown();
			return { consume: true };
		}
		if (matchesKey(data, Key.escape) && this.activeAbort) {
			void this.requestStop();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("d")) && !this.activeAbort && !this.editor.getText()) {
			void this.shutdown();
			return { consume: true };
		}
		return undefined;
	}

	private async handleSubmit(rawText: string): Promise<void> {
		const text = rawText.trim();
		if (!text || this.stopRequested) return;
		this.editor.addToHistory(text);
		this.editor.setText("");

		if (text.startsWith("/") && await this.handleLocalCommand(text)) return;
		if (this.activeAbort) {
			void this.submitSteer(text);
			return;
		}

		this.rememberLocalEcho(this.profile.channelId, text);
		this.addUserMessage(this.profile.channelId, "you", text);
		this.activeTurn = new Container();
		this.chat.addChild(this.activeTurn);
		this.latestAssistantSnapshot = null;
		this.activeSegmentBaseline = [];
		this.activeSegmentPrecedingContent = this.lastTranscriptContent;
		this.activeAbort = new AbortController();
		this.stopRequested = false;
		this.editor.borderColor = (value) => chalk.yellow(value);
		this.showLoader("Thinking...");
		this.ui.requestRender();

		try {
			await this.client.streamMessage(text, (event) => this.handleStreamEvent(event), this.activeAbort.signal);
		} catch (error) {
			if (!this.stopRequested && !isAbortError(error)) {
				this.addError(error instanceof Error ? error.message : String(error), this.activeTurn);
			}
		} finally {
			this.clearLoader();
			this.activeAbort = null;
			this.activeTurn = null;
			this.latestAssistantSnapshot = null;
			this.activeSegmentBaseline = [];
			this.activeSegmentPrecedingContent = null;
			this.editor.borderColor = (value) => this.stopRequested ? chalk.yellow(value) : chalk.cyan(value);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	private async handleLocalCommand(text: string): Promise<boolean> {
		const command = text.split(/\s+/, 1)[0]?.toLowerCase();
		if (command === "/quit" || command === "/exit") {
			await this.shutdown();
			return true;
		}
		if (command === "/clear") {
			this.chat.clear();
			this.lastTranscriptContent = null;
			this.ui.requestRender(true);
			return true;
		}
		if (command === "/help") {
			this.addNotice("/clear  clear this transcript\n/reload  reload recent awareness\n/status  refresh the agent connection\n/stop  stop the active turn\n/quit  exit\n\nOther slash commands are sent to the agent.");
			return true;
		}
		if (command === "/reload") {
			await this.reloadHistory();
			return true;
		}
		if (command === "/status") {
			await this.refreshStatus();
			return true;
		}
		if (command === "/stop") {
			if (this.activeAbort) await this.requestStop();
			else this.addNotice("Nothing is running.");
			return true;
		}
		return false;
	}

	private handleStreamEvent(event: RuntimeStreamEvent): void {
		if (event.type === "status") {
			if (event.status === "steering") this.showLoader("Steering...");
			else if (event.status !== "accepted") this.showLoader(event.message || "Working...");
			return;
		}
		const snapshot = toAssistantSnapshot(event);
		if (snapshot && this.activeTurn) {
			this.latestAssistantSnapshot = { ...snapshot, content: [...snapshot.content] };
			const renderedKind = this.renderAssistant(this.activeTurn, {
				...snapshot,
				content: assistantContentDelta(snapshot.content, this.activeSegmentBaseline),
			}, false, this.activeSegmentPrecedingContent);
			if (renderedKind) this.lastTranscriptContent = renderedKind;
			if (snapshot.isStreaming === false) this.rememberAssistantEcho(snapshot.content);
			const pendingTool = this.pendingToolLabel(snapshot);
			if (snapshot.isStreaming === false && !pendingTool && !isToolUseStopReason(snapshot.stopReason)) {
				this.clearLoader();
			} else {
				this.showLoader(pendingTool || "Thinking...");
			}
			this.ui.requestRender();
			return;
		}
		if (event.type === "error") {
			this.addError(event.message, this.activeTurn || this.chat);
			this.clearLoader();
		} else if (event.type === "run_complete") {
			this.clearLoader();
		}
	}

	private async submitSteer(text: string): Promise<void> {
		this.activeSegmentBaseline = [...(this.latestAssistantSnapshot?.content || [])];
		this.rememberLocalEcho(this.profile.channelId, text);
		this.addUserMessage(this.profile.channelId, "you", text);
		this.activeTurn = new Container();
		this.chat.addChild(this.activeTurn);
		this.activeSegmentPrecedingContent = this.lastTranscriptContent;
		this.showLoader("Steering...");
		const controller = new AbortController();
		this.steeringAborts.add(controller);
		try {
			await this.client.streamMessage(text, (event) => {
				if (event.type === "status" && event.status === "steering") {
					this.showLoader(event.message || "Steering...");
				} else if (event.type === "error") {
					this.addError(event.message, this.activeTurn || this.chat);
				}
			}, controller.signal);
		} catch (error) {
			if (!isAbortError(error)) this.addError(error instanceof Error ? error.message : String(error), this.activeTurn || this.chat);
		} finally {
			this.steeringAborts.delete(controller);
		}
	}

	private renderHistory(lines: string[]): void {
		const entries = lines
			.map((line) => parseContextLine(line))
			.filter((entry): entry is TuiHistoryEntry => entry !== null);
		const newIds = new Set(entries
			.filter((entry) => this.rememberAwarenessId(entry.id))
			.map((entry) => entry.id));
		for (const entry of entries.filter((entry) => entry.role !== "toolResult").slice(-HISTORY_RENDER_LIMIT)) {
			if (!newIds.has(entry.id)) continue;
			this.renderAwarenessEntry(entry, true);
		}
	}

	private renderLiveAwarenessLine(line: string): void {
		const entry = parseContextLine(line);
		if (!entry || !this.rememberAwarenessId(entry.id)) return;
		if (entry.role === "user" && entry.text && this.consumeLocalEcho(entry.channel || "awareness", entry.text)) return;
		if (entry.role === "assistant") {
			const fingerprint = assistantFingerprint(entry.content);
			if (this.consumeAssistantEcho(fingerprint) || this.activeAbort) return;
		}
		this.renderAwarenessEntry(entry, true);
	}

	private renderAwarenessEntry(entry: TuiHistoryEntry, complete: boolean): void {
		if (entry.role === "user" && entry.text) {
			this.addUserMessage(entry.channel || "awareness", entry.userName || "user", entry.text);
			return;
		}
		if (entry.role !== "assistant") return;
		const target = new Container();
		this.chat.addChild(target);
		const renderedKind = this.renderAssistant(target, {
			id: entry.id,
			type: "message",
			timestamp: entry.timestamp,
			role: "assistant",
			content: entry.content,
			model: entry.model,
			stopReason: entry.stopReason,
			isStreaming: !complete,
		}, complete, this.lastTranscriptContent);
		if (renderedKind) this.lastTranscriptContent = renderedKind;
	}

	private renderAssistant(
		target: Container,
		snapshot: RuntimeAssistantSnapshotEntry,
		historical: boolean,
		precedingContent: TranscriptContentKind | null = null,
	): TranscriptContentKind | null {
		target.clear();
		const results = new Map(snapshot.content
			.filter((block) => block.type === "toolResult")
			.map((block) => block.type === "toolResult" ? [block.toolCallId, block] as const : ["", null] as const));
		let textGroup: TextContent[] = [];
		let previousKind = precedingContent;
		let renderedKind: TranscriptContentKind | null = null;
		const flushText = () => {
			if (textGroup.length === 0) return;
			target.addChild(new AssistantMessageComponent(
				toPiAssistantMessage(snapshot, textGroup),
				true,
				getMarkdownTheme(),
				"Thinking...",
				1,
			));
			textGroup = [];
			previousKind = "text";
			renderedKind = "text";
		};

		for (const block of snapshot.content) {
			if (block.type === "text" && block.text.trim()) {
				textGroup.push({ type: "text", text: block.text });
				continue;
			}
			if (block.type !== "toolCall") continue;
			flushText();
			const label = safeToolLabel(block);
			if (!label) continue;
			if (previousKind !== "tool") target.addChild(new Spacer(1));
			const result = results.get(block.id);
			const state = result ? (result.isError ? "error" : "success") : historical ? "success" : "pending";
			target.addChild(createToolLabel(label, state));
			previousKind = "tool";
			renderedKind = "tool";
		}
		flushText();
		return renderedKind;
	}

	private addUserMessage(channel: string, user: string, text: string): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(chalk.dim(`[${channel}] ${user}`), 1, 0));
		this.chat.addChild(new UserMessageComponent(text, getMarkdownTheme(), 1));
		this.lastTranscriptContent = "user";
		this.ui.requestRender();
	}

	private addNotice(message: string): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(chalk.dim(message), 1, 0));
		this.lastTranscriptContent = "text";
		this.ui.requestRender();
	}

	private addError(message: string, target: Container): void {
		target.addChild(new Spacer(1));
		target.addChild(new Text(chalk.red(`Error: ${message}`), 1, 0));
		this.ui.requestRender();
	}

	private pendingToolLabel(snapshot: RuntimeAssistantSnapshotEntry): string | undefined {
		const completed = new Set(snapshot.content
			.filter((block) => block.type === "toolResult")
			.map((block) => block.type === "toolResult" ? block.toolCallId : ""));
		for (let index = snapshot.content.length - 1; index >= 0; index--) {
			const block = snapshot.content[index];
			if (block?.type === "toolCall" && !completed.has(block.id)) return safeToolLabel(block);
		}
		return undefined;
	}

	private async runAwarenessLoop(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			this.setAwarenessState(this.awarenessState === "connecting" ? "connecting" : "reconnecting");
			try {
				await this.client.streamAwareness(
					(line) => this.renderLiveAwarenessLine(line),
					signal,
					() => {
						this.setAwarenessState("live");
						void this.catchUpAwareness();
					},
				);
			} catch (error) {
				if (signal.aborted || isAbortError(error)) return;
			}
			if (signal.aborted) return;
			this.setAwarenessState("reconnecting");
			await abortableDelay(1_000, signal).catch(() => {});
		}
	}

	private async catchUpAwareness(): Promise<void> {
		try {
			const backlog = await this.client.getBacklog(HISTORY_LIMIT, this.awarenessAbort.signal);
			for (const line of backlog.lines) this.renderLiveAwarenessLine(line);
		} catch {
			// The SSE stream remains authoritative; the catch-up read only closes races.
		}
	}

	private setAwarenessState(state: AwarenessState): void {
		if (this.awarenessState === state) return;
		this.awarenessState = state;
		this.rebuildHeader();
	}

	private rememberAwarenessId(id: string): boolean {
		if (this.seenAwarenessIds.has(id)) return false;
		this.seenAwarenessIds.add(id);
		this.seenAwarenessOrder.push(id);
		while (this.seenAwarenessOrder.length > SEEN_AWARENESS_LIMIT) {
			const oldest = this.seenAwarenessOrder.shift();
			if (oldest) this.seenAwarenessIds.delete(oldest);
		}
		return true;
	}

	private rememberLocalEcho(channel: string, text: string): void {
		this.prunePendingEchoes();
		this.pendingLocalEchoes.push({ channel, text, expiresAt: Date.now() + LOCAL_ECHO_TTL_MS });
	}

	private consumeLocalEcho(channel: string, text: string): boolean {
		this.prunePendingEchoes();
		const index = this.pendingLocalEchoes.findIndex((entry) => entry.channel === channel && entry.text === text);
		if (index < 0) return false;
		this.pendingLocalEchoes.splice(index, 1);
		return true;
	}

	private rememberAssistantEcho(content: RuntimeAssistantSnapshotContent[]): void {
		const fingerprint = assistantFingerprint(content);
		if (!fingerprint) return;
		this.prunePendingEchoes();
		this.pendingAssistantEchoes.push({ fingerprint, expiresAt: Date.now() + ASSISTANT_ECHO_TTL_MS });
	}

	private consumeAssistantEcho(fingerprint: string): boolean {
		if (!fingerprint) return false;
		this.prunePendingEchoes();
		const index = this.pendingAssistantEchoes.findIndex((entry) => entry.fingerprint === fingerprint);
		if (index < 0) return false;
		this.pendingAssistantEchoes.splice(index, 1);
		return true;
	}

	private prunePendingEchoes(): void {
		const now = Date.now();
		for (let index = this.pendingLocalEchoes.length - 1; index >= 0; index--) {
			if (this.pendingLocalEchoes[index]!.expiresAt <= now) this.pendingLocalEchoes.splice(index, 1);
		}
		for (let index = this.pendingAssistantEchoes.length - 1; index >= 0; index--) {
			if (this.pendingAssistantEchoes[index]!.expiresAt <= now) this.pendingAssistantEchoes.splice(index, 1);
		}
	}

	private showLoader(message: string): void {
		if (this.activeLoader) {
			this.activeLoader.setMessage(message);
			return;
		}
		this.statusContainer.clear();
		this.activeLoader = new Loader(this.ui, (value) => chalk.cyan(value), (value) => chalk.dim(value), message);
		this.statusContainer.addChild(this.activeLoader);
		this.activeLoader.start();
	}

	private clearLoader(): void {
		this.activeLoader?.stop();
		this.activeLoader = null;
		this.statusContainer.clear();
		this.ui.requestRender();
	}

	private async requestStop(): Promise<void> {
		if (!this.activeAbort || this.stopRequested) return;
		const activeAbort = this.activeAbort;
		this.stopRequested = true;
		this.showLoader("Stopping...");
		activeAbort.abort();
		try {
			await this.client.stop();
		} catch (error) {
			this.addError(error instanceof Error ? error.message : String(error), this.activeTurn || this.chat);
		} finally {
			this.stopRequested = false;
			if (!this.activeAbort) {
				this.editor.borderColor = (value) => chalk.cyan(value);
				this.ui.setFocus(this.editor);
				this.ui.requestRender();
			}
		}
	}

	private async reloadHistory(): Promise<void> {
		this.showLoader("Reloading awareness...");
		try {
			const backlog = await this.client.getBacklog(HISTORY_LIMIT);
			this.chat.clear();
			this.lastTranscriptContent = null;
			this.seenAwarenessIds.clear();
			this.seenAwarenessOrder.length = 0;
			this.renderHistory(backlog.lines);
		} catch (error) {
			this.addError(error instanceof Error ? error.message : String(error), this.chat);
		} finally {
			this.clearLoader();
		}
	}

	private async refreshStatus(): Promise<void> {
		this.showLoader("Checking agent...");
		try {
			this.status = await this.client.getStatus();
			this.rebuildHeader();
			this.addNotice(`${this.status.agentName} is connected (${this.status.runtime}, ${this.status.mode}).`);
		} catch (error) {
			this.addError(error instanceof Error ? error.message : String(error), this.chat);
		} finally {
			this.clearLoader();
		}
	}

	private rebuildHeader(): void {
		this.header.clear();
		this.header.addChild(new Spacer(1));
		this.header.addChild(new Text(`${chalk.bold(this.status.agentName)}  ${chalk.dim("Troublemaker")}`, 1, 0));
		const awareness = this.awarenessState === "live" ? chalk.green("awareness live") : chalk.yellow(`awareness ${this.awarenessState}`);
		this.header.addChild(new Text(chalk.dim(`${this.profile.channelId} · ${this.status.runtime} · ${this.status.mode} · ${awareness}`), 1, 0));
		this.header.addChild(new DynamicBorder((value) => chalk.dim(value)));
		this.ui.requestRender();
	}

	private rebuildFooter(): void {
		this.footer.clear();
		this.footer.addChild(new Text(chalk.dim("enter send · esc stop · ctrl-c exit · /help"), 1, 0));
	}

	private registerSignals(): void {
		const bind = (signal: NodeJS.Signals) => {
			const handler = () => { void this.shutdown(); };
			process.on(signal, handler);
			this.signalHandlers.push(() => process.off(signal, handler));
		};
		bind("SIGTERM");
		bind("SIGHUP");
	}

	private async shutdown(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.awarenessAbort.abort();
		for (const controller of this.steeringAborts) controller.abort();
		this.steeringAborts.clear();
		if (this.activeAbort) {
			await this.requestStop();
		}
		this.clearLoader();
		for (const cleanup of this.signalHandlers.splice(0)) cleanup();
		this.ui.stop();
		await this.terminal.drainInput(250, 25).catch(() => {});
		void this.awarenessTask?.catch(() => {});
		this.resolveDone?.();
		this.resolveDone = null;
	}
}

function createToolLabel(label: string, state: "pending" | "success" | "error"): Box {
	const color = state === "error" ? chalk.red : state === "success" ? chalk.green : chalk.yellow;
	const icon = state === "error" ? "×" : state === "success" ? "✓" : "→";
	const box = new Box(1, 0);
	box.addChild(new Text(`${color(icon)} ${chalk.bold(label)}`, 0, 0));
	return box;
}

function toPiAssistantMessage(snapshot: RuntimeAssistantSnapshotEntry, content: TextContent[]): AssistantMessage {
	const stopReason = snapshot.stopReason === "length" || snapshot.stopReason === "error" || snapshot.stopReason === "aborted"
		? snapshot.stopReason
		: "stop";
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "troublemaker",
		model: snapshot.model || "resident-agent",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.parse(snapshot.timestamp) || Date.now(),
	};
}

function assistantFingerprint(content: RuntimeAssistantSnapshotContent[]): string {
	return content
		.map((block) => {
			if (block.type === "text") return `text:${block.text.trim()}`;
			if (block.type === "toolCall") return `tool:${safeToolLabel(block) || ""}`;
			return "";
		})
		.filter(Boolean)
		.join("\u0000");
}

function isToolUseStopReason(stopReason: string | undefined): boolean {
	return typeof stopReason === "string" && stopReason.replace(/[-_\s]/g, "").toLowerCase() === "tooluse";
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError());
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function abortError(): Error {
	const error = new Error("Aborted");
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}
