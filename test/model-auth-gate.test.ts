import assert from "node:assert/strict";
import { WebAdapter } from "../src/adapters/web.js";
import { isModelUsageLimitError, runWithModelCredentialGate } from "../src/model-auth-gate.js";
import { ModelCredentialUnavailableError } from "../src/model-config.js";
import { readRunnerSource } from "./support/runner-source.js";

let prompts = 0;
const unavailableBeforePrompt = await runWithModelCredentialGate({
	resolveCredential: async () => {
		throw new ModelCredentialUnavailableError("example-provider");
	},
	prompt: async () => {
		prompts++;
	},
});
assert.equal(unavailableBeforePrompt.status, "credential_unavailable");
assert.equal(prompts, 0, "an unavailable credential must prevent the model prompt");

const ready = await runWithModelCredentialGate({
	resolveCredential: async () => "ready",
	prompt: async () => {
		prompts++;
		return "done";
	},
});
assert.deepEqual(ready, { status: "prompted", value: "done" });
assert.equal(prompts, 1);

const expiredAtDispatch = await runWithModelCredentialGate({
	resolveCredential: async () => "ready",
	prompt: async () => {
		prompts++;
		throw new ModelCredentialUnavailableError("example-provider");
	},
});
assert.equal(expiredAtDispatch.status, "credential_unavailable");
assert.equal(prompts, 2);

await assert.rejects(
	runWithModelCredentialGate({
		resolveCredential: async () => "ready",
		prompt: async () => {
			throw new Error("ordinary model failure");
		},
	}),
	/ordinary model failure/,
);

const streamEvents: unknown[] = [];
const streamWriter = {
	errorSent: false,
	send(event: unknown) { streamEvents.push(event); },
};
const web = new WebAdapter({ workingDir: "/tmp/model-auth-gate-test" });
(web as any).surfaceRunError({
	stopReason: "error",
	errorMessage: "credential unavailable",
	failureKind: "model_credential_unavailable",
}, streamWriter);
assert.deepEqual(streamEvents, [], "web streams must fail quiet on model credential outages");
(web as any).surfaceRunError({
	stopReason: "error",
	errorMessage: "ordinary model failure",
}, streamWriter);
assert.deepEqual(streamEvents, [{ type: "error", message: "ordinary model failure" }]);

const runnerSource = readRunnerSource();
assert.match(
	runnerSource,
	/runState\.modelCredentialUnavailable[\s\S]+no user-visible runtime error posted/,
	"the runtime must not turn credential failures into provider messages",
);


assert.equal(isModelUsageLimitError("Codex error: The usage limit has been reached"), true);
assert.equal(isModelUsageLimitError("Summarization failed: Codex error: The usage limit has been reached"), true);
assert.equal(isModelUsageLimitError("usage_limit_reached: You've hit your usage limit."), true);
assert.equal(isModelUsageLimitError("429 insufficient_quota: You exceeded your current quota"), true);
assert.equal(isModelUsageLimitError("ordinary model failure"), false);
assert.equal(isModelUsageLimitError("Request was aborted"), false);
assert.equal(isModelUsageLimitError(undefined), false);

streamEvents.length = 0;
(web as any).surfaceRunError({
	stopReason: "error",
	errorMessage: "Codex error: The usage limit has been reached",
	failureKind: "model_usage_limit",
}, streamWriter);
assert.deepEqual(streamEvents, [], "web streams must fail quiet on model usage limits");

assert.match(
	runnerSource,
	/else if \(isModelUsageLimitError\(runState\.errorMessage\)\) \{\s+log\.logWarning\("Model usage limit reached; no user-visible runtime error posted"/,
	"the runtime must not post usage-limit failures as conversation content",
);

console.log("model auth gate ok");
