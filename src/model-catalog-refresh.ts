import type { Api, Model, ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import * as log from "./log.js";

const LIVE_PROVIDER = "openai-codex";
export const LIVE_MODEL_CATALOG_INITIAL_DELAY_MS = 5 * 60_000;
export const LIVE_MODEL_CATALOG_REFRESH_INTERVAL_MS = 60 * 60_000;
export const LIVE_MODEL_CATALOG_REFRESH_TIMEOUT_MS = 10_000;

interface CatalogRegistry {
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
	getAvailable(): Model<Api>[];
	hasConfiguredAuth(model: Model<Api>): boolean;
}

export interface LiveModelCatalogRefreshOptions {
	offline?: boolean;
	schedule?: boolean;
	initialDelayMs?: number;
	intervalMs?: number;
	timeoutMs?: number;
	warn?: (message: string) => void;
}

export interface LiveModelCatalogRefreshHandle {
	refreshNow(): Promise<boolean>;
	stop(): void;
}

const cachedAvailableModels = new Map<string, Model<Api>[]>();
const activeRefreshers = new Map<string, LiveModelCatalogRefreshHandle>();

/** Public model metadata restored or refreshed by Pi, scoped to one workspace. */
export function getLiveModelCatalogSnapshot(workingDir: string): Model<Api>[] {
	return [...(cachedAvailableModels.get(cacheKey(workingDir)) || [])];
}

/** Trigger the workspace's registered refresher without changing model selection. */
export async function refreshLiveModelCatalog(workingDir: string): Promise<boolean> {
	return activeRefreshers.get(cacheKey(workingDir))?.refreshNow() ?? false;
}

/**
 * Keep Pi's cached OpenAI Codex catalog fresh for a long-running resident.
 * Startup consumes only the already-restored local snapshot. Network refreshes
 * are bounded, coalesced, provider-scoped, disabled by PI_OFFLINE, and never
 * mutate settings or the resident's selected model.
 */
export function startLiveModelCatalogRefresh(
	workingDir: string,
	modelRegistry: ModelRegistry | CatalogRegistry,
	options: LiveModelCatalogRefreshOptions = {},
): LiveModelCatalogRefreshHandle {
	const key = cacheKey(workingDir);
	const existing = activeRefreshers.get(key);
	if (existing) return existing;

	const registry = modelRegistry as CatalogRegistry;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let activeAbort: AbortController | undefined;
	let inFlight: Promise<boolean> | undefined;
	const offline = options.offline ?? process.env.PI_OFFLINE !== undefined;
	const scheduleEnabled = options.schedule !== false;
	const timeoutMs = boundedPositive(options.timeoutMs, LIVE_MODEL_CATALOG_REFRESH_TIMEOUT_MS);
	const intervalMs = boundedPositive(options.intervalMs, LIVE_MODEL_CATALOG_REFRESH_INTERVAL_MS);
	const initialDelayMs = boundedNonnegative(
		options.initialDelayMs,
		LIVE_MODEL_CATALOG_INITIAL_DELAY_MS + Math.floor(Math.random() * 60_000),
	);
	const warn = options.warn ?? ((message: string) => log.logWarning(message));

	const publishAvailableSnapshot = (): boolean => {
		let available: Model<Api>[];
		try {
			available = registry.getAvailable();
		} catch {
			return false;
		}
		const safe = available
			.filter((model) => registry.hasConfiguredAuth(model))
			.flatMap((model) => safeCatalogModel(model));
		cachedAvailableModels.set(key, safe);
		return true;
	};

	const scheduleNext = (delayMs: number): void => {
		if (stopped || offline || !scheduleEnabled) return;
		timer = setTimeout(async () => {
			timer = undefined;
			await handle.refreshNow();
			scheduleNext(intervalMs);
		}, delayMs);
		timer.unref?.();
	};

	const handle: LiveModelCatalogRefreshHandle = {
		refreshNow: async () => {
			if (stopped || offline) return false;
			if (inFlight) return inFlight;
			const controller = new AbortController();
			activeAbort = controller;
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			timeout.unref?.();
			const task = (async (): Promise<boolean> => {
				try {
					const result = await registry.refresh({
						allowNetwork: true,
						providers: [LIVE_PROVIDER],
						signal: controller.signal,
					});
					if (stopped || controller.signal.aborted || result.aborted) return false;
					const published = publishAvailableSnapshot();
					if (result.errors.size > 0) {
						warn(`Live model catalog refresh completed with ${result.errors.size} provider error(s)`);
					}
					return published;
				} catch {
					if (!stopped && !controller.signal.aborted) warn("Live model catalog refresh failed; keeping the last cached snapshot");
					return false;
				} finally {
					clearTimeout(timeout);
					if (activeAbort === controller) activeAbort = undefined;
				}
			})();
			inFlight = task;
			try {
				return await task;
			} finally {
				if (inFlight === task) inFlight = undefined;
			}
		},
		stop: () => {
			if (stopped) return;
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			activeAbort?.abort();
			activeAbort = undefined;
			if (activeRefreshers.get(key) === handle) activeRefreshers.delete(key);
		},
	};

	// ModelRuntime.create() has already restored the persisted catalog without
	// network access. Publish that authenticated snapshot immediately.
	publishAvailableSnapshot();
	activeRefreshers.set(key, handle);
	scheduleNext(initialDelayMs);
	return handle;
}

function safeCatalogModel(model: Model<Api>): Model<Api>[] {
	if (model.provider !== LIVE_PROVIDER) return [];
	if (!safeCatalogText(model.id, 256) || !safeCatalogText(model.name, 256) || !safeCatalogText(model.api, 128)) return [];
	if (!safeCatalogUrl(model.baseUrl)) return [];
	if (!Array.isArray(model.input) || !model.input.every((value) => value === "text" || value === "image")) return [];
	if (!finiteNonnegative(model.contextWindow) || !finiteNonnegative(model.maxTokens)) return [];
	if (!safeCost(model.cost)) return [];
	const clone: Model<Api> = {
		id: model.id,
		name: model.name,
		api: model.api,
		provider: LIVE_PROVIDER,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning === true,
		input: [...model.input],
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
			...(model.cost.tiers ? { tiers: model.cost.tiers.map((tier) => ({
				inputTokensAbove: tier.inputTokensAbove,
				input: tier.input,
				output: tier.output,
				cacheRead: tier.cacheRead,
				cacheWrite: tier.cacheWrite,
			})) } : {}),
		},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
	return [clone];
}

function safeCatalogText(value: unknown, maxLength: number): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= maxLength
		&& !/[\u0000-\u001f\u007f]/.test(value);
}

function safeCatalogUrl(value: unknown): value is string {
	if (!safeCatalogText(value, 2_048)) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password;
	} catch {
		return false;
	}
}

function safeCost(cost: Model<Api>["cost"]): boolean {
	if (!cost || ![cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(finiteNonnegative)) return false;
	return !cost.tiers || cost.tiers.every((tier) =>
		[tier.input, tier.output, tier.cacheRead, tier.cacheWrite, tier.inputTokensAbove].every(finiteNonnegative));
}

function finiteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cacheKey(workingDir: string): string {
	return resolve(workingDir);
}

function boundedPositive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function boundedNonnegative(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: fallback;
}
