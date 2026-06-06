export interface RealtimeVoiceOption {
	name: string;
	description: string;
}

export const DEFAULT_REALTIME_VOICE = "marin";

export const REALTIME_VOICE_OPTIONS: RealtimeVoiceOption[] = [
	{ name: "marin", description: "Recommended default; natural, clear, and conversational." },
	{ name: "cedar", description: "Recommended alternative; warm, grounded, and steady." },
	{ name: "alloy", description: "Balanced and neutral." },
	{ name: "ash", description: "Smooth and lower-pitched." },
	{ name: "ballad", description: "Measured and expressive." },
	{ name: "coral", description: "Bright and upbeat." },
	{ name: "echo", description: "Crisp and articulate." },
	{ name: "sage", description: "Calm and even." },
	{ name: "shimmer", description: "Light and energetic." },
	{ name: "verse", description: "Expressive and dynamic." },
];

const REALTIME_VOICE_NAMES = new Set(REALTIME_VOICE_OPTIONS.map((voice) => voice.name));

export function normalizeRealtimeVoiceName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return REALTIME_VOICE_NAMES.has(normalized) ? normalized : null;
}

export function realtimeVoiceDescription(name: string): string {
	return REALTIME_VOICE_OPTIONS.find((voice) => voice.name === name)?.description || "";
}

export function formatRealtimeVoiceList(currentVoice = DEFAULT_REALTIME_VOICE): string {
	const current = normalizeRealtimeVoiceName(currentVoice) || DEFAULT_REALTIME_VOICE;
	const lines = ["*Realtime voices:*", ""];
	for (const voice of REALTIME_VOICE_OPTIONS) {
		const marker = voice.name === current ? "current" : "       ";
		lines.push(`  ${marker}  \`${voice.name}\` - ${voice.description}`);
	}
	lines.push("");
	lines.push("Use `/voice <name>` to switch. Example: `/voice cedar`");
	lines.push("Changes apply to the next Realtime voice session.");
	return lines.join("\n");
}
