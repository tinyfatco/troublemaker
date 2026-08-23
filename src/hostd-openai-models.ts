export const HOSTD_OPENAI_PROVIDER = "openai";
export const HOSTD_OPENAI_DEFAULT_MODEL_ID = "gpt-5.6-sol";

export const HOSTD_OPENAI_MODEL_POLICIES = {
	"gpt-5.6-sol": { thinking: "xhigh" },
	"gpt-5.6-luna": { thinking: "max" },
} as const;

export type HostdOpenAiModelId = keyof typeof HOSTD_OPENAI_MODEL_POLICIES;

export function getHostdOpenAiModelPolicy(modelId: string | undefined) {
	if (!modelId || !(modelId in HOSTD_OPENAI_MODEL_POLICIES)) return undefined;
	return HOSTD_OPENAI_MODEL_POLICIES[modelId as HostdOpenAiModelId];
}
