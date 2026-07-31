import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WebAdapter } from "../src/adapters/web.js";
import { runWithModelCredentialGate } from "../src/model-auth-gate.js";
import { ModelCredentialUnavailableError } from "../src/model-config.js";

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

const runnerSource = readFileSync("src/agent.ts", "utf8");
assert.match(
	runnerSource,
	/runState\.modelCredentialUnavailable[\s\S]+no user-visible runtime error posted/,
	"the runtime must not turn credential failures into provider messages",
);

console.log("model auth gate ok");
