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
	type TUI,
	TuiMainScreen,
	matchesKey,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type {
	RuntimeAssistantSnapshotContent,
	RuntimeAssistantSnapshotEntry,
	RuntimeLiveEvent,
	RuntimeLiveRunEvent,
	RuntimeStreamEvent,
	RuntimeUserInputEntry,
} from "../core/runtime-contract.js";
import { TroublemakerTuiClient, type TuiAgentStatus, type TuiRunStatus } from "./client.js";
import type { TuiAgentProfile } from "./config.js";
import {
	assistantContentDelta,
	isAssistantContentCoveredBySnapshot,
	normalizeChannelLabel,
	parseContextLine,
	safeToolLabel,
	toAssistantSnapshot,
	type TuiHistoryEntry,
} from "./protocol.js";

const HISTORY_LIMIT = 60;
const HISTORY_RENDER_LIMIT = 30;
const SEEN_AWARENESS_LIMIT = 5_000;
// Compaction and hard-interrupt restart can delay persistence for several
// minutes. Keep a bounded local-echo ledger long enough to meet that delayed
// awareness record instead of repainting the user's input as a second entry.
const LOCAL_ECHO_TTL_MS = 30 * 60_000;
const MAX_PENDING_LOCAL_ECHOES = 100;
const ASSISTANT_ECHO_TTL_MS = 30_000;
const INPUT_RECONCILIATION_TTL_MS = 30_000;
const RUN_STATUS_POLL_MS = 500;

type AwarenessState = "connecting" | "live" | "reconnecting";
type TranscriptContentKind = "user" | "text" | "tool";

interface LiveRunView {
	channelId: string;
	channelLabel: string;
	target: Container;
	latestSnapshot: RuntimeAssistantSnapshotEntry | null;
	segmentBaseline: RuntimeAssistantSnapshotContent[];
	precedingContent: TranscriptContentKind | null;
	inputSegments: number;
}

interface PendingInputEcho {
	channel: string;
	text: string;
	expiresAt: number;
	target?: Container;
	precedingContent?: TranscriptContentKind | null;
	adoptedRunId?: string;
}

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
	private runStatusTask: Promise<void> | null = null;
	private externalLoaderVisible = false;
	private awarenessState: AwarenessState = "connecting";
	private readonly seenAwarenessIds = new Set<string>();
	private readonly seenAwarenessOrder: string[] = [];
	private readonly awarenessChannelsById = new Map<string, string>();
	private readonly pendingLocalEchoes: PendingInputEcho[] = [];
	private readonly pendingRuntimeInputEchoes: PendingInputEcho[] = [];
	private readonly recentAwarenessInputs: PendingInputEcho[] = [];
	private readonly pendingAssistantEchoes: Array<{
		content: RuntimeAssistantSnapshotContent[];
		expiresAt: number;
	}> = [];
	private readonly deferredAwarenessAssistantLines = new Map<string, string>();
	private readonly liveRuns = new Map<string, LiveRunView>();
	private readonly runtimeEchoGraceByChannel = new Map<string, number>();
	private liveSequence = 0;
	private liveStreamId = "";
	private latestLiveRunId: string | null = null;
	private terminalEchoGraceUntil = 0;
	private readonly steeringAborts = new Set<AbortController>();

	constructor(
		private readonly profile: TuiAgentProfile,
		private readonly client: TroublemakerTuiClient,
		status: TuiAgentStatus,
	) {
		initTheme(undefined, false);
		this.status = status;
		this.ui = new TuiMainScreen(this.terminal);
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
		this.runStatusTask = this.runStatusLoop(this.awarenessAbort.signal);
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

		this.addUserMessage(this.profile.channelId, "you", text);
		this.activeTurn = new Container();
		this.chat.addChild(this.activeTurn);
		this.latestAssistantSnapshot = null;
		this.activeSegmentBaseline = [];
		this.activeSegmentPrecedingContent = this.lastTranscriptContent;
		this.rememberLocalEcho(this.profile.channelId, text, this.activeTurn, this.activeSegmentPrecedingContent);
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
			this.terminalEchoGraceUntil = Date.now() + 2_000;
			this.flushDeferredAwarenessAssistantLines();
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
		if (command === "/help") {
			this.addNotice("/clear  archive and reset agent context\n/reload  reload recent awareness\n/status  refresh the agent connection\n/stop  stop the active turn\n/quit  exit\n\nOther slash commands are sent to the agent.");
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
		// Assistant snapshots are rendered exclusively from the unified live
		// feed. The POST response remains the control/compatibility channel.
		if (toAssistantSnapshot(event)) return;
		if (event.type === "error") {
			this.addError(event.message, this.activeTurn || this.chat);
			this.clearLoader();
		} else if (event.type === "run_complete") {
			this.clearLoader();
		}
	}

	private async submitSteer(text: string): Promise<void> {
		const liveView = this.findLiveRunForChannel(this.profile.channelId);
		const baseline = liveView?.latestSnapshot?.content || this.latestAssistantSnapshot?.content || [];
		this.activeSegmentBaseline = [...baseline];
		this.addUserMessage(this.profile.channelId, "you", text);
		this.activeTurn = new Container();
		this.chat.addChild(this.activeTurn);
		this.activeSegmentPrecedingContent = this.lastTranscriptContent;
		this.rememberLocalEcho(this.profile.channelId, text, this.activeTurn, this.activeSegmentPrecedingContent);
		if (liveView) {
			liveView.target = this.activeTurn;
			liveView.segmentBaseline = [...baseline];
			liveView.precedingContent = this.activeSegmentPrecedingContent;
		}
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

	private handleLiveEvent(event: RuntimeLiveEvent): void {
		if (this.liveStreamId !== event.streamId) {
			this.liveStreamId = event.streamId;
			this.liveSequence = 0;
			this.liveRuns.clear();
			this.latestLiveRunId = null;
			void this.catchUpAwareness();
		}
		if (event.kind === "reset") {
			this.liveSequence = Math.max(this.liveSequence, event.sequence);
			void this.catchUpAwareness();
			return;
		}
		if (event.sequence <= this.liveSequence) return;
		this.liveSequence = event.sequence;
		if (event.kind === "awareness") {
			this.renderLiveAwarenessLine(event.line);
			return;
		}
		this.handleLiveRuntimeEvent(event);
	}

	private handleLiveRuntimeEvent(envelope: RuntimeLiveRunEvent): void {
		const event = envelope.event;
		if (event.type !== "run_complete") this.latestLiveRunId = envelope.runId;
		if (event.type === "user_input") {
			this.handleLiveUserInput(envelope, event.entries);
			return;
		}
		if (event.type === "status") {
			if (event.status === "accepted") return;
			const message = event.status === "steering" ? "Steering..." : event.message || "Working...";
			if (this.activeAbort) this.showLoader(message);
			else this.showExternalLoader(message);
			return;
		}

		const snapshot = toAssistantSnapshot(event);
		if (snapshot) {
			const view = this.getOrCreateLiveRunView(envelope);
			view.latestSnapshot = { ...snapshot, content: [...snapshot.content] };
			const renderedKind = this.renderAssistant(view.target, {
				...snapshot,
				content: assistantContentDelta(snapshot.content, view.segmentBaseline),
			}, false, view.precedingContent);
			if (renderedKind) this.lastTranscriptContent = renderedKind;
			if (envelope.channelId === this.profile.channelId) {
				this.latestAssistantSnapshot = view.latestSnapshot;
			}
			if (snapshot.isStreaming === false) {
				this.rememberAssistantEcho(snapshot.content);
				this.rememberRuntimeEcho(envelope.channelId);
			}
			const pendingTool = this.pendingToolLabel(snapshot);
			if (snapshot.isStreaming === false && !pendingTool && !isToolUseStopReason(snapshot.stopReason)) {
				this.clearLoader();
			} else if (this.activeAbort) {
				this.showLoader(pendingTool || "Thinking...");
			} else {
				this.showExternalLoader(pendingTool || "Working...");
			}
			this.ui.requestRender();
			return;
		}

		if (event.type === "error") {
			const view = this.liveRuns.get(envelope.runId);
			this.addError(event.message, view?.target || this.activeTurn || this.chat);
			this.clearLoader();
			return;
		}
		if (event.type === "run_complete") {
			const view = this.liveRuns.get(envelope.runId);
			if (view?.latestSnapshot) this.rememberAssistantEcho(view.latestSnapshot.content);
			this.rememberRuntimeEcho(envelope.channelId);
			this.liveRuns.delete(envelope.runId);
			if (this.latestLiveRunId === envelope.runId) this.latestLiveRunId = null;
			this.clearLoader();
			this.flushDeferredAwarenessAssistantLines();
		}
	}

	private handleLiveUserInput(envelope: RuntimeLiveRunEvent, rawEntries: RuntimeUserInputEntry[]): void {
		const entries = rawEntries.map((entry) => ({
			...entry,
			channel: normalizeChannelLabel(entry.channel),
		}));
		const visible: RuntimeUserInputEntry[] = [];
		let matchedLocalEcho: PendingInputEcho | null = null;
		for (const entry of entries) {
			const awarenessEcho = this.consumeAwarenessInputEntry(entry.channel, entry.text);
			if (awarenessEcho) {
				if (awarenessEcho.target) matchedLocalEcho ||= awarenessEcho;
				continue;
			}
			const localEcho = this.consumeLocalEchoEntry(entry.channel, entry.text);
			matchedLocalEcho ||= localEcho;
			this.rememberRuntimeInputEcho(entry.channel, entry.text);
			if (!localEcho) visible.push(entry);
		}

		if (visible.length > 0) {
			this.beginLiveInputSegment(envelope, visible);
		} else if (matchedLocalEcho) {
			this.adoptLocalInputSegment(envelope, matchedLocalEcho);
		}
	}

	private beginLiveInputSegment(envelope: RuntimeLiveRunEvent, entries: RuntimeUserInputEntry[]): void {
		this.beginInputSegment(
			envelope.runId,
			envelope.channelId,
			envelope.channelLabel || envelope.channelId,
			entries,
		);
	}

	private beginInputSegment(
		runId: string,
		channelId: string,
		channelLabel: string,
		entries: RuntimeUserInputEntry[],
	): void {
		const existing = this.liveRuns.get(runId);
		if (existing?.inputSegments === 0) this.chat.removeChild(existing.target);

		const baseline = existing?.latestSnapshot?.content || [];
		for (const entry of entries) this.addUserMessage(entry.channel, entry.userName, entry.text);

		if (!existing) {
			const target = new Container();
			this.chat.addChild(target);
			this.liveRuns.set(runId, {
				channelId,
				channelLabel,
				target,
				latestSnapshot: null,
				segmentBaseline: [],
				precedingContent: this.lastTranscriptContent,
				inputSegments: 1,
			});
			return;
		}

		if (existing.inputSegments === 0) {
			this.chat.addChild(existing.target);
			existing.precedingContent = this.lastTranscriptContent;
			existing.inputSegments = 1;
			if (existing.latestSnapshot) {
				const renderedKind = this.renderAssistant(existing.target, {
					...existing.latestSnapshot,
					content: assistantContentDelta(existing.latestSnapshot.content, existing.segmentBaseline),
				}, false, existing.precedingContent);
				if (renderedKind) this.lastTranscriptContent = renderedKind;
			}
			this.ui.requestRender();
			return;
		}

		const target = new Container();
		this.chat.addChild(target);
		existing.target = target;
		existing.segmentBaseline = [...baseline];
		existing.precedingContent = this.lastTranscriptContent;
		existing.inputSegments++;
		this.ui.requestRender();
	}

	private adoptLocalInputSegment(envelope: RuntimeLiveRunEvent, localEcho: PendingInputEcho): void {
		this.adoptLocalInputSegmentForRun(envelope.runId, localEcho);
	}

	private adoptLocalInputSegmentForRun(runId: string, localEcho: PendingInputEcho): void {
		if (localEcho.adoptedRunId === runId) return;
		const view = this.liveRuns.get(runId);
		if (!view) return;
		const target = localEcho.target || this.activeTurn;
		if (target && view.target !== target) {
			view.target = target;
			view.segmentBaseline = [...(view.latestSnapshot?.content || [])];
			view.precedingContent = localEcho.precedingContent ?? this.activeSegmentPrecedingContent;
		}
		view.inputSegments++;
		localEcho.adoptedRunId = runId;
	}

	private getOrCreateLiveRunView(envelope: RuntimeLiveRunEvent): LiveRunView {
		const existing = this.liveRuns.get(envelope.runId);
		if (existing) return existing;
		const terminalTarget = envelope.channelId === this.profile.channelId ? this.activeTurn : null;
		const target = terminalTarget || new Container();
		if (!terminalTarget) this.chat.addChild(target);
		const view: LiveRunView = {
			channelId: envelope.channelId,
			channelLabel: envelope.channelLabel || envelope.channelId,
			target,
			latestSnapshot: null,
			segmentBaseline: terminalTarget ? [...this.activeSegmentBaseline] : [],
			precedingContent: terminalTarget ? this.activeSegmentPrecedingContent : this.lastTranscriptContent,
			inputSegments: terminalTarget ? 1 : 0,
		};
		this.liveRuns.set(envelope.runId, view);
		return view;
	}

	private findLiveRunForChannel(channelId: string): LiveRunView | undefined {
		return this.findLiveRunEntryForChannel(channelId)?.[1];
	}

	private findLiveRunEntryForChannel(channelId: string): [string, LiveRunView] | undefined {
		const normalized = normalizeChannelLabel(channelId);
		return [...this.liveRuns.entries()].reverse().find(([, view]) =>
			view.channelId === channelId || normalizeChannelLabel(view.channelLabel) === normalized
		);
	}

	private findLiveRunEntryForLocalEcho(channelId: string): [string, LiveRunView] | undefined {
		const exact = this.findLiveRunEntryForChannel(channelId);
		if (exact) return exact;
		if (!this.latestLiveRunId) return undefined;
		const latest = this.liveRuns.get(this.latestLiveRunId);
		return latest ? [this.latestLiveRunId, latest] : undefined;
	}

	private renderHistory(lines: string[]): void {
		const entries = lines
			.map((line) => parseContextLine(line))
			.filter((entry): entry is TuiHistoryEntry => entry !== null);
		const newIds = new Set<string>();
		for (const entry of entries) {
			this.resolveAwarenessChannel(entry);
			if (this.rememberAwarenessId(entry.id)) newIds.add(entry.id);
		}
		for (const entry of entries.filter((entry) => entry.role !== "toolResult").slice(-HISTORY_RENDER_LIMIT)) {
			if (!newIds.has(entry.id)) continue;
			if (entry.role === "user") {
				const inputs = entry.batchedUserEntries || (entry.text ? [{
					channel: entry.channel || "awareness",
					userName: entry.userName || "user",
					text: entry.text,
				}] : []);
				for (const input of inputs) this.rememberAwarenessInput(normalizeChannelLabel(input.channel), input.text);
			}
			this.renderAwarenessEntry(entry, true);
		}
	}

	private renderLiveAwarenessLine(line: string): void {
		const entry = parseContextLine(line);
		if (!entry || this.seenAwarenessIds.has(entry.id)) return;
		const channel = this.resolveAwarenessChannel(entry);
		if (entry.role === "user") {
			const rawInputs: RuntimeUserInputEntry[] = entry.batchedUserEntries
				? entry.batchedUserEntries
				: entry.text
					? [{
						channel: entry.channel || "awareness",
						userName: entry.userName || "user",
						text: entry.text,
					}]
					: [];
			const visible: RuntimeUserInputEntry[] = [];
			for (const rawInput of rawInputs) {
				const input = { ...rawInput, channel: normalizeChannelLabel(rawInput.channel) };
				if (this.consumeRuntimeInputEcho(input.channel, input.text)) continue;
				const localEcho = this.consumeLocalEchoEntry(input.channel, input.text);
				if (localEcho?.target) {
					const live = this.findLiveRunEntryForLocalEcho(input.channel);
					if (live && live[1].target !== localEcho.target) {
						this.adoptLocalInputSegmentForRun(live[0], localEcho);
					}
				}
				this.rememberAwarenessInput(input.channel, input.text, localEcho);
				if (!localEcho) visible.push(input);
			}
			if (rawInputs.length > 0) {
				this.deferredAwarenessAssistantLines.delete(entry.id);
				this.rememberAwarenessId(entry.id);
				if (visible.length > 0) {
					const live = this.findLiveRunEntryForChannel(visible[0]!.channel);
					if (live) this.beginInputSegment(live[0], live[1].channelId, live[1].channelLabel, visible);
					else for (const input of visible) this.addUserMessage(input.channel, input.userName, input.text);
				}
				return;
			}
		}
		if (entry.role === "assistant") {
			if (channel && this.hasRuntimeEchoGrace(channel)) {
				this.deferredAwarenessAssistantLines.delete(entry.id);
				this.rememberAwarenessId(entry.id);
				return;
			}
			if (channel === this.profile.channelId && (this.activeAbort || Date.now() < this.terminalEchoGraceUntil)) {
				this.deferredAwarenessAssistantLines.delete(entry.id);
				this.rememberAwarenessId(entry.id);
				return;
			}
			if (this.consumeAssistantEcho(entry.content)) {
				this.deferredAwarenessAssistantLines.delete(entry.id);
				this.rememberAwarenessId(entry.id);
				return;
			}
			if (this.activeAbort) {
				this.deferredAwarenessAssistantLines.set(entry.id, line);
				return;
			}
		}
		this.deferredAwarenessAssistantLines.delete(entry.id);
		this.rememberAwarenessId(entry.id);
		this.renderAwarenessEntry(entry, true);
	}

	private flushDeferredAwarenessAssistantLines(): void {
		const lines = [...this.deferredAwarenessAssistantLines.values()];
		this.deferredAwarenessAssistantLines.clear();
		for (const line of lines) this.renderLiveAwarenessLine(line);
	}

	private renderAwarenessEntry(entry: TuiHistoryEntry, complete: boolean): void {
		if (entry.role === "user" && entry.batchedUserEntries) {
			for (const message of entry.batchedUserEntries) {
				this.addUserMessage(message.channel, message.userName, message.text);
			}
			return;
		}
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
		this.ui.requestRender();
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
				await this.client.streamLive(
					(event) => this.handleLiveEvent(event),
					signal,
					() => {
						this.setAwarenessState("live");
						void this.catchUpAwareness();
					},
					this.liveSequence,
				);
			} catch (error) {
				if (signal.aborted || isAbortError(error)) return;
			}
			if (signal.aborted) return;
			this.setAwarenessState("reconnecting");
			await abortableDelay(1_000, signal).catch(() => {});
		}
	}

	private async runStatusLoop(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				const status = await this.client.getRunStatus(signal);
				this.syncExternalWorking(status);
			} catch (error) {
				if (signal.aborted || isAbortError(error)) return;
			}
			await abortableDelay(RUN_STATUS_POLL_MS, signal).catch(() => {});
		}
	}

	private syncExternalWorking(status: TuiRunStatus): void {
		const queued = status.queuedInputCount || status.queuedRuns;
		const queuedSuffix = queued > 0 ? ` · ${queued} input${queued === 1 ? "" : "s"} queued` : "";
		const message = status.phase === "compacting"
			? `${status.compactionAbortRequested ? "Stopping stalled compaction" : "Compacting context"} · ${formatElapsed(status.phaseElapsedMs)}${queuedSuffix}`
			: `Working${queuedSuffix}...`;

		if (this.activeAbort) {
			if (status.phase === "compacting") this.showLoader(message);
			return;
		}
		if (!status.idle) {
			this.showExternalLoader(message);
		} else if (this.externalLoaderVisible) {
			this.clearLoader();
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
			if (oldest) {
				this.seenAwarenessIds.delete(oldest);
				this.awarenessChannelsById.delete(oldest);
			}
		}
		return true;
	}

	private resolveAwarenessChannel(entry: TuiHistoryEntry): string | undefined {
		const channel = entry.channel || (entry.parentId ? this.awarenessChannelsById.get(entry.parentId) : undefined);
		if (channel) this.awarenessChannelsById.set(entry.id, channel);
		return channel;
	}

	private rememberLocalEcho(
		channel: string,
		text: string,
		target?: Container,
		precedingContent?: TranscriptContentKind | null,
	): void {
		this.prunePendingEchoes();
		this.pendingLocalEchoes.push({
			channel,
			text,
			target,
			precedingContent,
			expiresAt: Date.now() + LOCAL_ECHO_TTL_MS,
		});
		if (this.pendingLocalEchoes.length > MAX_PENDING_LOCAL_ECHOES) {
			this.pendingLocalEchoes.splice(0, this.pendingLocalEchoes.length - MAX_PENDING_LOCAL_ECHOES);
		}
	}

	private consumeLocalEcho(channel: string, text: string): boolean {
		return this.consumeLocalEchoEntry(channel, text) !== null;
	}

	private consumeLocalEchoEntry(channel: string, text: string): PendingInputEcho | null {
		this.prunePendingEchoes();
		const index = this.pendingLocalEchoes.findIndex((entry) => entry.channel === channel && entry.text === text);
		if (index < 0) return null;
		return this.pendingLocalEchoes.splice(index, 1)[0] || null;
	}

	private rememberRuntimeInputEcho(channel: string, text: string): void {
		this.rememberInputEcho(this.pendingRuntimeInputEchoes, channel, text);
	}

	private consumeRuntimeInputEcho(channel: string, text: string): boolean {
		return this.consumeInputEcho(this.pendingRuntimeInputEchoes, channel, text);
	}

	private rememberAwarenessInput(channel: string, text: string, localEcho?: PendingInputEcho | null): void {
		this.prunePendingEchoes();
		this.recentAwarenessInputs.push({
			channel,
			text,
			target: localEcho?.target,
			precedingContent: localEcho?.precedingContent,
			adoptedRunId: localEcho?.adoptedRunId,
			expiresAt: Date.now() + INPUT_RECONCILIATION_TTL_MS,
		});
		if (this.recentAwarenessInputs.length > MAX_PENDING_LOCAL_ECHOES) {
			this.recentAwarenessInputs.splice(0, this.recentAwarenessInputs.length - MAX_PENDING_LOCAL_ECHOES);
		}
	}

	private consumeAwarenessInputEntry(channel: string, text: string): PendingInputEcho | null {
		return this.consumeInputEchoEntry(this.recentAwarenessInputs, channel, text);
	}

	private rememberInputEcho(ledger: PendingInputEcho[], channel: string, text: string): void {
		this.prunePendingEchoes();
		ledger.push({ channel, text, expiresAt: Date.now() + INPUT_RECONCILIATION_TTL_MS });
		if (ledger.length > MAX_PENDING_LOCAL_ECHOES) {
			ledger.splice(0, ledger.length - MAX_PENDING_LOCAL_ECHOES);
		}
	}

	private consumeInputEcho(ledger: PendingInputEcho[], channel: string, text: string): boolean {
		return this.consumeInputEchoEntry(ledger, channel, text) !== null;
	}

	private consumeInputEchoEntry(ledger: PendingInputEcho[], channel: string, text: string): PendingInputEcho | null {
		this.prunePendingEchoes();
		const index = ledger.findIndex((entry) => entry.channel === channel && entry.text === text);
		if (index < 0) return null;
		return ledger.splice(index, 1)[0] || null;
	}

	private rememberAssistantEcho(content: RuntimeAssistantSnapshotContent[]): void {
		if (!content.some((block) =>
			(block.type === "toolCall" && Boolean(block.id)) ||
			(block.type === "text" && Boolean(block.text.trim()))
		)) return;
		this.prunePendingEchoes();
		this.pendingAssistantEchoes.push({
			content: content.map((block) => ({ ...block })),
			expiresAt: Date.now() + ASSISTANT_ECHO_TTL_MS,
		});
	}

	private consumeAssistantEcho(content: RuntimeAssistantSnapshotContent[]): boolean {
		this.prunePendingEchoes();
		const index = this.pendingAssistantEchoes.findIndex((entry) =>
			isAssistantContentCoveredBySnapshot(content, entry.content)
		);
		if (index < 0) return false;
		this.pendingAssistantEchoes.splice(index, 1);
		return true;
	}

	private prunePendingEchoes(): void {
		const now = Date.now();
		for (const ledger of [this.pendingLocalEchoes, this.pendingRuntimeInputEchoes, this.recentAwarenessInputs]) {
			for (let index = ledger.length - 1; index >= 0; index--) {
				if (ledger[index]!.expiresAt <= now) ledger.splice(index, 1);
			}
		}
		for (let index = this.pendingAssistantEchoes.length - 1; index >= 0; index--) {
			if (this.pendingAssistantEchoes[index]!.expiresAt <= now) this.pendingAssistantEchoes.splice(index, 1);
		}
		for (const [channel, expiresAt] of this.runtimeEchoGraceByChannel) {
			if (expiresAt <= now) this.runtimeEchoGraceByChannel.delete(channel);
		}
	}

	private rememberRuntimeEcho(channel: string): void {
		if (!channel) return;
		this.prunePendingEchoes();
		this.runtimeEchoGraceByChannel.set(channel, Date.now() + ASSISTANT_ECHO_TTL_MS);
	}

	private hasRuntimeEchoGrace(channel: string): boolean {
		this.prunePendingEchoes();
		return (this.runtimeEchoGraceByChannel.get(channel) || 0) > Date.now();
	}

	private showLoader(message: string): void {
		this.externalLoaderVisible = false;
		this.setLoader(message);
	}

	private showExternalLoader(message: string): void {
		this.setLoader(message);
		this.externalLoaderVisible = true;
	}

	private setLoader(message: string): void {
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
		this.externalLoaderVisible = false;
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
			this.deferredAwarenessAssistantLines.clear();
			this.seenAwarenessIds.clear();
			this.seenAwarenessOrder.length = 0;
			this.awarenessChannelsById.clear();
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
		void this.runStatusTask?.catch(() => {});
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

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function abortError(): Error {
	const error = new Error("Aborted");
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}
