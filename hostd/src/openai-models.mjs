const MICROS_PER_DOLLAR = 1_000_000;

function rates({ input, cachedInput, output }) {
	return Object.freeze({
		input: input * MICROS_PER_DOLLAR,
		cachedInput: cachedInput * MICROS_PER_DOLLAR,
		cacheWrite: input * 1.25 * MICROS_PER_DOLLAR,
		output: output * MICROS_PER_DOLLAR,
	});
}

function policy({ id, thinking, input, cachedInput, output }) {
	return Object.freeze({
		provider: "openai",
		id,
		thinking,
		contextTokens: 1_050_000,
		maximumModelOutputTokens: 128_000,
		longContextThreshold: 272_000,
		standardRates: rates({ input, cachedInput, output }),
		longContextRates: rates({
			input: input * 2,
			cachedInput: cachedInput * 2,
			output: output * 1.5,
		}),
	});
}

export const HOSTD_OPENAI_DEFAULT_MODEL = "gpt-5.6-luna";

// Pricing is expressed in dollars per million tokens. GPT-5.6 cache writes
// cost 1.25x uncached input, while requests over 272K input tokens cost 2x
// input and 1.5x output for the full request.
export const HOSTD_OPENAI_MODELS = Object.freeze({
	"gpt-5.6-sol": policy({
		id: "gpt-5.6-sol",
		thinking: "xhigh",
		input: 4,
		cachedInput: 0.4,
		output: 20,
	}),
	"gpt-5.6-luna": policy({
		id: "gpt-5.6-luna",
		thinking: "max",
		input: 0.2,
		cachedInput: 0.02,
		output: 1.2,
	}),
});

export function getHostdOpenAiModel(modelId) {
	return HOSTD_OPENAI_MODELS[modelId];
}

export function requireHostdOpenAiModel(modelId, label = "OpenAI model") {
	const model = getHostdOpenAiModel(modelId);
	if (!model) throw new Error(`${label} is not an approved Hostd OpenAI model`);
	return model;
}

export const OPENAI_MODEL_ACCOUNTING = Object.freeze({
	microdollarsPerDollar: MICROS_PER_DOLLAR,
	models: HOSTD_OPENAI_MODELS,
});
