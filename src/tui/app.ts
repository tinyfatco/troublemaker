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
import { parseContextLine, safeToolLabel, toAssistantSnapshot, type TuiHistoryEntry } from "./protocol.js";

const HISTORY_LIMIT = 60;
const HISTORY_RENDER_LIMIT = 30;

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
	private readonly editorContainer = new Container();
	private readonly footer = new Container();
	private readonly editor: Editor;
	private status: TuiAgentStatus;
	private activeAbort: AbortController | null = null;
	private activeTurn: Container | null = null;
	private activeLoader: Loader | null = null;
	private stopRequested = false;
	private stopped = false;
	private resolveDone: (() => void) | null = null;
	private readonly signalHandlers: Array<() => void> = [];

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
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);
		this.ui.addInputListener((data) => this.handleGlobalInput(data));
		this.terminal.setTitle(`${this.status.agentName} · Troublemaker`);
		this.registerSignals();
		this.ui.start();
		this.ui.requestRender(true);

		await new Promise<void>((resolve) => {
			this.resolveDone = resolve;
		});
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
		if (!text || this.activeAbort) return;
		this.editor.addToHistory(text);
		this.editor.setText("");

		if (text.startsWith("/") && await this.handleLocalCommand(text)) return;

		this.addUserMessage(this.profile.channelId, "you", text);
		this.activeTurn = new Container();
		this.chat.addChild(this.activeTurn);
		this.activeAbort = new AbortController();
		this.stopRequested = false;
		this.editor.disableSubmit = true;
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
			this.editor.disableSubmit = this.stopRequested;
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
			this.addNotice("Nothing is running.");
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
			this.renderAssistant(this.activeTurn, snapshot, false);
			this.showLoader(this.pendingToolLabel(snapshot) || "Thinking...");
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

	private renderHistory(lines: string[]): void {
		const entries = lines
			.map((line) => parseContextLine(line))
			.filter((entry): entry is TuiHistoryEntry => entry !== null)
			.filter((entry) => entry.role !== "toolResult")
			.slice(-HISTORY_RENDER_LIMIT);
		for (const entry of entries) {
			if (entry.role === "user" && entry.text) {
				this.addUserMessage(entry.channel || "awareness", entry.userName || "user", entry.text);
			} else if (entry.role === "assistant") {
				const target = new Container();
				this.chat.addChild(target);
				this.renderAssistant(target, {
					id: entry.id,
					type: "message",
					timestamp: entry.timestamp,
					role: "assistant",
					content: entry.content,
					model: entry.model,
					stopReason: entry.stopReason,
					isStreaming: false,
				}, true);
			}
		}
	}

	private renderAssistant(target: Container, snapshot: RuntimeAssistantSnapshotEntry, historical: boolean): void {
		target.clear();
		const results = new Map(snapshot.content
			.filter((block) => block.type === "toolResult")
			.map((block) => block.type === "toolResult" ? [block.toolCallId, block] as const : ["", null] as const));
		let textGroup: TextContent[] = [];
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
			const result = results.get(block.id);
			const state = result ? (result.isError ? "error" : "success") : historical ? "success" : "pending";
			target.addChild(createToolLabel(label, state));
		}
		flushText();
	}

	private addUserMessage(channel: string, user: string, text: string): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(chalk.dim(`[${channel}] ${user}`), 1, 0));
		this.chat.addChild(new UserMessageComponent(text, getMarkdownTheme(), 1));
		this.ui.requestRender();
	}

	private addNotice(message: string): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(chalk.dim(message), 1, 0));
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
				this.editor.disableSubmit = false;
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
		this.header.addChild(new Text(chalk.dim(`${this.profile.channelId} · ${this.status.runtime} · ${this.status.mode}`), 1, 0));
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
		if (this.activeAbort) {
			await this.requestStop();
		}
		this.clearLoader();
		for (const cleanup of this.signalHandlers.splice(0)) cleanup();
		this.ui.stop();
		await this.terminal.drainInput(250, 25).catch(() => {});
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

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}
