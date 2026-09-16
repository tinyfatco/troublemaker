import { inferenceProgressURL } from "../inference-progress.js";
import type { ContextInfo } from "../agent.js";

/** Allowlisted metadata only: never relay raw health responses or runtime state. */
export interface RuntimeDiagnostics {
    phase: "idle" | "running" | "compacting";
    queuedInputs: number;
    context?: ContextInfo;
    inference: InferenceHealth;
}
export interface InferenceHealth {
    state: "not_configured" | "reachable" | "unavailable";
    phase?: string;
    resident?: string;
    queuedRequests?: number;
    activeKind?: string;
    availableMemoryGiB?: number;
    checkpointSavedEntries?: number;
    checkpointElapsedSeconds?: number;
    faulted?: boolean;
}
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const choice = (v: unknown, values: string[]): string | undefined => typeof v === "string" && values.includes(v) ? v : undefined;
export function projectInferenceHealth(value: unknown): InferenceHealth {
    const root = record(value), work = record(root.work), resources = record(root.resources), checkpoint = record(root.last_checkpoint);
    return {
        state: "reachable",
        phase: choice(root.phase, ["idle", "text", "image", "loading", "unloading", "checkpointing", "restoring", "blocked", "fault"]),
        resident: choice(root.resident, ["text", "image", "none"]),
        queuedRequests: Array.isArray(work.queue) ? work.queue.length : undefined,
        activeKind: choice(record(work.active).kind, ["text", "image"]),
        availableMemoryGiB: number(resources.available_gib_estimate),
        checkpointSavedEntries: number(checkpoint.saved_entries),
        checkpointElapsedSeconds: number(checkpoint.elapsed_seconds),
        faulted: root.fault === undefined ? undefined : root.fault !== null,
    };
}

/** Opt-in loopback probe, cached and single-flight; never runs inference. */
export function createInferenceHealthReader(rawURL?: string): () => Promise<InferenceHealth> {
    const url = inferenceProgressURL(rawURL);
    let cached: InferenceHealth = { state: "not_configured" }, expires = 0;
    let pending: Promise<InferenceHealth> | undefined;
    return () => {
        if (!url) return Promise.resolve(cached);
        if (pending) return pending;
        if (Date.now() < expires) return Promise.resolve(cached);
        pending = (async () => {
            try {
                const response = await fetch(url, { signal: AbortSignal.timeout(1200), redirect: "error" });
                if (!response.ok) throw new Error("Unavailable");
                // Bound telemetry size before parsing, including chunked bodies.
                const reader = response.body?.getReader();
                if (!reader) throw new Error("No health body");
                const chunks: Uint8Array[] = []; let length = 0;
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        length += value.byteLength;
                        if (length > 65536) throw new Error("Health body too large");
                        chunks.push(value);
                    }
                } finally { await reader.cancel(); }
                cached = projectInferenceHealth(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch { cached = { state: "unavailable" }; }
            finally { expires = Date.now() + 5000; pending = undefined; }
            return cached;
        })();
        return pending;
    };
}
