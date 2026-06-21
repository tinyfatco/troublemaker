import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listModels } from "../src/model-config.js";

const curatedRegistry = {
	getAvailable: () => [],
	getAll: () => [
		{
			provider: "openai-codex",
			id: "gpt-5.5",
			name: "GPT 5.5",
			api: "responses",
		},
		{
			provider: "fireworks",
			id: "accounts/fireworks/models/minimax-m2p7",
			name: "MiniMax M2.7",
			api: "chat",
		},
		{
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			api: "messages",
		},
		{
			provider: "anthropic",
			id: "claude-very-old",
			name: "Claude Very Old",
			api: "messages",
		},
		{
			provider: "openrouter",
			id: "some-noisy-long-tail-model",
			name: "Long Tail Noise",
			api: "chat",
		},
	],
} as any;

const curated = listModels(undefined, curatedRegistry);
assert.ok(
	curated.some((model) => model.provider === "openai-codex" && model.id === "gpt-5.5"),
	"includes curated OpenAI Codex models even when getAvailable is empty",
);
assert.ok(
	curated.some(
		(model) => model.provider === "fireworks" && model.id === "accounts/fireworks/models/glm-5p2",
	),
	"includes curated Fireworks models even when getAvailable is empty",
);
assert.ok(
	curated.some((model) => model.provider === "anthropic" && model.id === "claude-sonnet-4-6"),
	"includes listed Anthropic models",
);
assert.ok(
	!curated.some((model) => model.id === "claude-very-old"),
	"keeps noisy Anthropic models out of the operator list",
);
assert.ok(
	!curated.some((model) => model.provider === "openrouter"),
	"does not expose arbitrary long-tail registry models unless they are available or selected",
);

const tempDir = mkdtempSync(join(tmpdir(), "model-list-current-"));
try {
	writeFileSync(
		join(tempDir, "settings.json"),
		JSON.stringify({ defaultProvider: "custom-provider", defaultModel: "custom-model" }),
	);

	const currentOnly = listModels(tempDir, { getAvailable: () => [], getAll: () => [] } as any);
	assert.deepEqual(
		currentOnly[0],
		{
			provider: "custom-provider",
			id: "custom-model",
			name: "custom-model",
			api: "custom-provider",
		},
		"current model remains selectable even when the registry cannot describe it",
	);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
