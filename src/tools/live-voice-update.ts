import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const schema = Type.Object({
	session_id: Type.String({ description: "Exact active live session ID supplied by the duplex harness." }),
	text: Type.String({ minLength: 1, maxLength: 6000, description: "Concise relevant result, progress or clarification safe for the active voice. Never hidden reasoning, secrets or unrelated conversation content." }),
});
export function createLiveVoiceUpdateTool(publish: (session: string, text: string) => void): AgentTool<typeof schema> {
	return {
		name: "live_voice_update", label: "live_voice_update",
		description: "Send a quiet internal update to this agent's currently active duplex voice harness. Use for useful interim results and final guidance while the thinking/tool backend continues working. The voice decides whether and when to speak. Not a new request, not TTS, and not a general messaging channel. Requires the exact live session ID from current duplex input; closed/stale sessions fail. Only share content relevant and safe for that live conversation.",
		parameters: schema,
		execute: async (_id, params) => {
			publish(params.session_id, params.text);
			return { content: [{ type: "text", text: "Quiet guidance delivered to the active voice harness. Do not repeat it via speech/TTS." }], details: undefined };
		},
	};
}
