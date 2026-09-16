import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInferenceHealthReader, projectInferenceHealth } from "../src/console/runtime-diagnostics.js";
import { Gateway } from "../src/gateway.js";

const health = projectInferenceHealth({ phase: "idle", resident: "text", fault: null,
    work: { active: { id: "private", kind: "text" }, queue: [{ prompt: "private" }] },
    resources: { available_gib_estimate: 12 }, last_checkpoint: { saved_entries: 2, elapsed_seconds: 3, path: "private" },
    prompt: "private", credential: "private" });
assert.equal(health.activeKind, "text");
assert.equal(health.queuedRequests, 1);
assert.equal(health.checkpointSavedEntries, 2);
assert.ok(!JSON.stringify(health).includes("private"));
assert.equal(projectInferenceHealth({ phase: "private", resources: { available_gib_estimate: -1 } }).phase, undefined);
assert.equal(projectInferenceHealth({ resources: { available_gib_estimate: Infinity } }).availableMemoryGiB, undefined);
for (const url of [undefined, "https://example.com", "http://example.com", "http://user:password@localhost"]) {
    assert.deepEqual(await createInferenceHealthReader(url)(), { state: "not_configured" });
}
let probes = 0;
const server = createServer((_req, res) => { probes++; res.end(JSON.stringify({ phase: "idle", resident: "text" })); });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const read = createInferenceHealthReader(`http://127.0.0.1:${address.port}/health`);
assert.equal((await Promise.all([read(), read(), read()]))[0].state, "reachable");
await read(); assert.equal(probes, 1, "concurrent and repeated polls share one probe");
await new Promise<void>(resolve => server.close(() => resolve()));
assert.equal((await createInferenceHealthReader(`http://127.0.0.1:${address.port}/health`)()).state, "unavailable");

const directory = await mkdtemp(join(tmpdir(), "example-diagnostics-"));
try {
    await writeFile(join(directory, "settings.json"), JSON.stringify({ name: "Example Agent" }));
    const gateway = new Gateway({ workspaceDir: directory });
    gateway.setDiagnosticsProvider(async () => ({ phase: "idle", queuedInputs: 0, inference: health }));
    // Exercise the real route handler without binding a deployed agent or reading a conversation.
    const response = { writeHead() {}, end(value: string) { this.body = JSON.parse(value); }, body: undefined as any };
    await (gateway as any).handleConsoleStatus({}, response);
    assert.equal(response.body.diagnostics.inference.queuedRequests, 1);
    gateway.setDiagnosticsProvider(async () => { throw new Error("private"); });
    await (gateway as any).handleConsoleStatus({}, response);
    assert.equal(response.body.workspace_ready, true);
    assert.equal(response.body.diagnostics, undefined, "telemetry failure does not fail normal status");
    assert.ok(!JSON.stringify(response.body).includes("private"));
} finally { await rm(directory, { recursive: true, force: true }); }
console.log("runtime diagnostics: ok");
