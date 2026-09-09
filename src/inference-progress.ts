/** Portable, content-free telemetry. No prompts, tool arguments, or provider identifiers. */
export interface InferenceProgress {
	phase: "prefill";
	processedTokens: number;
	totalTokens: number;
	cachedTokens: number;
	elapsedSeconds: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function parseInferenceProgress(value: unknown): InferenceProgress | undefined {
	const p = record(value);
	if (!p || p.phase !== "prefill") return;
	const done = count(p.processedTokens), total = count(p.totalTokens), cached = count(p.cachedTokens);
	if (done === undefined || !total || cached === undefined || done > total || cached > total) return;
	if (typeof p.elapsedSeconds !== "number" || !Number.isFinite(p.elapsedSeconds) || p.elapsedSeconds < 0) return;
	return { phase: "prefill", processedTokens: done, totalTokens: total, cachedTokens: cached, elapsedSeconds: p.elapsedSeconds };
}

export function progressFromSnapshot(value: unknown, requestId: string): InferenceProgress | undefined {
	const requests = record(value)?.in_flight;
	if (!Array.isArray(requests)) return;
	for (const item of requests) {
		const request = record(item), p = record(request?.prefill_state);
		if (!p || (p.request_id ?? request?.request_id) !== requestId) continue;
		if (p.phase !== "started" && p.phase !== "chunk") continue;
		return parseInferenceProgress({ phase: "prefill", processedTokens: p.tokens_done, totalTokens: p.tokens_total,
			cachedTokens: p.cached_tokens, elapsedSeconds: p.elapsed_s });
	}
}

export function inferenceProgressURL(value: string | undefined): URL | undefined {
	if (!value) return;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) return;
		return url;
	} catch { return; }
}

/** Read-only, opt-in local telemetry; failures must never fail or delay inference. */
export function watchInferenceProgress(url: URL, requestId: string, emit: (progress: InferenceProgress) => void): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: AbortController | undefined;
	let last = "";
	const poll = async () => {
		pending = new AbortController();
		const timeout = setTimeout(() => pending?.abort(), 1500);
		try {
			const response = await fetch(url, { signal: pending.signal, redirect: "error" });
			if (response.ok) {
				const progress = progressFromSnapshot(await response.json(), requestId);
				const key = JSON.stringify(progress);
				if (!stopped && progress && key !== last) { last = key; emit(progress); }
			}
		} catch { /* Telemetry is best effort. */ }
		finally { clearTimeout(timeout); }
		if (!stopped) { timer = setTimeout(() => { void poll(); }, 1000); timer.unref(); }
	};
	void poll();
	return () => { stopped = true; clearTimeout(timer); pending?.abort(); };
}
