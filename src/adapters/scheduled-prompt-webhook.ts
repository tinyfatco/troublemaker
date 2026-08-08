import { appendFileSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import * as log from "../log.js";
import { withHostReceipt, type HostDeliveryReceipt } from "./host-receipt.js";
import type { FollowUpWakeMetadata, MomEvent, MomHandler, PlatformAdapter, RunResult } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024;
const DELIVERY_ID = /^scheduled:[a-f0-9]{64}$/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

interface ScheduledEventPayload {
	type: "one-shot" | "periodic";
	text: string;
	at?: string;
	schedule?: string;
	timezone?: string;
	channelId?: string;
	sourceEventType?: string;
	replyTarget?: string;
	replyTargetDescription?: string;
	threadTs?: string;
	followUp?: FollowUpWakeMetadata;
	action?: "compact" | "noop";
}

interface ScheduledPromptPayload {
	deliveryId: string;
	hostContextId: string;
	schedule: {
		filename: string;
		generation: number;
		canonicalSlotAt: string;
		fireAt: string;
	};
	event: ScheduledEventPayload;
	hostReceipt?: HostDeliveryReceipt;
}

export interface ScheduledPromptWebhookConfig {
	workingDir: string;
	inboundToken: string;
	hostContextId: string;
	adapters: PlatformAdapter[];
	onCompact?: () => Promise<void>;
}

function boundedString(value: unknown, label: string, maximum: number, fallback?: string): string {
	const candidate = value === undefined ? fallback : value;
	if (typeof candidate !== "string" || !candidate.trim() || candidate.length > maximum) {
		throw new Error(`${label} is invalid`);
	}
	return candidate;
}

function matchesBearer(header: string | undefined, expected: string): boolean {
	const actual = Buffer.from(header?.replace(/^Bearer\s+/iu, "") || "");
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function validateFollowUp(value: unknown): FollowUpWakeMetadata | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("followUp is invalid");
	const followUp = value as Partial<FollowUpWakeMetadata>;
	const key = boundedString(followUp.key, "followUp.key", 256);
	const generation = boundedString(followUp.generation, "followUp.generation", 128);
	if (!Number.isInteger(followUp.ordinal) || Number(followUp.ordinal) < 1 || Number(followUp.ordinal) > 100) {
		throw new Error("followUp.ordinal is invalid");
	}
	return { key, generation, ordinal: Number(followUp.ordinal) };
}

function validatePayload(value: unknown, expectedContextId: string): ScheduledPromptPayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("payload is invalid");
	const input = value as Partial<ScheduledPromptPayload>;
	const deliveryId = boundedString(input.deliveryId, "deliveryId", 128);
	if (!DELIVERY_ID.test(deliveryId)) throw new Error("deliveryId is invalid");
	if (input.hostContextId !== expectedContextId) throw new Error("hostContextId is invalid");
	if (!input.schedule || typeof input.schedule !== "object" || Array.isArray(input.schedule)) {
		throw new Error("schedule is invalid");
	}
	const filename = boundedString(input.schedule.filename, "schedule.filename", 132);
	if (!SAFE_FILENAME.test(filename)) throw new Error("schedule.filename is invalid");
	const generation = input.schedule.generation;
	if (!Number.isInteger(generation) || generation < 1 || generation > 1_000_000) {
		throw new Error("schedule.generation is invalid");
	}
	const canonicalSlotAt = boundedString(input.schedule.canonicalSlotAt, "schedule.canonicalSlotAt", 64);
	const fireAt = boundedString(input.schedule.fireAt, "schedule.fireAt", 64);
	if (!RFC3339.test(canonicalSlotAt) || !RFC3339.test(fireAt)) throw new Error("schedule timestamps are invalid");
	if (!input.event || typeof input.event !== "object" || Array.isArray(input.event)) {
		throw new Error("event is invalid");
	}
	if (!["one-shot", "periodic"].includes(input.event.type || "")) throw new Error("event.type is invalid");
	const type = input.event.type as ScheduledEventPayload["type"];
	const text = boundedString(input.event.text, "event.text", 32 * 1024);
	const action = input.event.action;
	if (action !== undefined && !["compact", "noop"].includes(action)) throw new Error("event.action is invalid");
	if (action === "compact" && type !== "periodic") throw new Error("event.action is invalid");
	const at = type === "one-shot" ? boundedString(input.event.at, "event.at", 64) : undefined;
	if (at && Number.isNaN(Date.parse(at))) throw new Error("event.at is invalid");
	const periodicSchedule = type === "periodic"
		? boundedString(input.event.schedule, "event.schedule", 256)
		: undefined;
	const timezone = type === "periodic"
		? boundedString(input.event.timezone, "event.timezone", 128)
		: undefined;
	const optional = (candidate: unknown, label: string, maximum: number) => candidate === undefined
		? undefined
		: boundedString(candidate, label, maximum);
	return {
		deliveryId,
		hostContextId: expectedContextId,
		schedule: { filename, generation, canonicalSlotAt, fireAt },
		event: {
			type,
			text,
			...(at ? { at } : {}),
			...(periodicSchedule ? { schedule: periodicSchedule } : {}),
			...(timezone ? { timezone } : {}),
			channelId: optional(input.event.channelId, "event.channelId", 256) || "heartbeat",
			sourceEventType: optional(input.event.sourceEventType, "event.sourceEventType", 128),
			replyTarget: optional(input.event.replyTarget, "event.replyTarget", 512),
			replyTargetDescription: optional(
				input.event.replyTargetDescription,
				"event.replyTargetDescription",
				512,
			),
			threadTs: optional(input.event.threadTs, "event.threadTs", 256),
			followUp: validateFollowUp(input.event.followUp),
			...(action ? { action } : {}),
		},
		hostReceipt: input.hostReceipt,
	};
}

function syntheticEvent(payload: ScheduledPromptPayload): MomEvent {
	const event = payload.event;
	const scheduleInfo = event.type === "one-shot" ? event.at : event.schedule;
	return {
		type: "mention",
		channel: event.channelId || "heartbeat",
		user: "EVENT",
		text: `[ATTENTION:${payload.schedule.filename}:${event.type}:${scheduleInfo}] ${event.text}`,
		ts: Date.now().toString(),
		sourceEventType: event.sourceEventType,
		...(event.followUp ? { directlyAddressed: false } : {}),
		threadTs: event.threadTs,
		replyTarget: event.replyTarget,
		replyTargetDescription: event.replyTargetDescription,
		followUp: event.followUp,
	};
}

export class ScheduledPromptWebhookIngress {
	private readonly completed = new Set<string>();
	private handler?: MomHandler;

	constructor(private readonly config: ScheduledPromptWebhookConfig) {
		if (!config.inboundToken || !config.hostContextId) {
			throw new Error("scheduled prompt ingress requires an exact token and context");
		}
		this.loadCompleted();
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		if (!matchesBearer(req.headers.authorization, this.config.inboundToken)) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let rejected = false;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				rejected = true;
				res.writeHead(413, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "payload_too_large" }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (rejected) return;
			let payload: ScheduledPromptPayload;
			try {
				payload = validatePayload(JSON.parse(Buffer.concat(chunks).toString("utf8")), this.config.hostContextId);
			} catch (error) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
				return;
			}
			res.writeHead(202, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, accepted: true }));
			void this.process(payload).catch((error) => {
				log.logWarning(
					"Scheduled prompt processing failed",
					error instanceof Error ? error.message : String(error),
				);
			});
		});
	}

	private async process(payload: ScheduledPromptPayload): Promise<{ duplicate: boolean }> {
		return withHostReceipt(payload.hostReceipt, async () => {
			if (this.completed.has(payload.deliveryId)) return { duplicate: true };
			if (payload.event.action === "noop") {
				// A no-op occurrence exercises cold start, authentication, durable
				// delivery, and receipts without invoking a model or external side effect.
			} else if (payload.event.action === "compact") {
				if (!this.config.onCompact) throw new Error("scheduled compaction is unavailable");
				await this.config.onCompact();
			} else {
				const event = syntheticEvent(payload);
				const adapter = this.resolveAdapter(event);
				const specialized = adapter as PlatformAdapter & {
					runScheduledEvent?: (event: MomEvent) => Promise<RunResult | void>;
				};
				if (specialized.runScheduledEvent) await specialized.runScheduledEvent(event);
				else {
					if (!this.handler) throw new Error("scheduled prompt handler is unavailable");
					await this.handler.handleEvent(event, adapter, true);
				}
			}
			this.markCompleted(payload.deliveryId);
			return { duplicate: false };
		});
	}

	private resolveAdapter(event: MomEvent): PlatformAdapter {
		if (event.followUp) {
			const followUp = this.config.adapters.find((adapter) => adapter.name === "follow-up");
			if (followUp) return followUp;
		}
		const matches = this.config.adapters.filter((adapter) => adapter.getChannel(event.channel));
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) throw new Error(`scheduled channel ${event.channel} is ambiguous`);
		throw new Error(`scheduled channel ${event.channel} is unavailable`);
	}

	private ledgerPath(): string {
		return join(this.config.workingDir, "scheduled-inbound-deliveries.jsonl");
	}

	private loadCompleted(): void {
		try {
			for (const line of readFileSync(this.ledgerPath(), "utf8").split("\n")) {
				if (!line.trim()) continue;
				const record = JSON.parse(line) as { deliveryId?: unknown };
				if (typeof record.deliveryId === "string" && DELIVERY_ID.test(record.deliveryId)) {
					this.completed.add(record.deliveryId);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error("scheduled delivery ledger is unreadable");
			}
		}
	}

	private markCompleted(deliveryId: string): void {
		if (this.completed.has(deliveryId)) return;
		appendFileSync(
			this.ledgerPath(),
			`${JSON.stringify({ deliveryId, completedAt: new Date().toISOString() })}\n`,
			{ mode: 0o600 },
		);
		this.completed.add(deliveryId);
	}
}
