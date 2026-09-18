import { HeartbeatAdapter } from "./heartbeat.js";
import type { MomContext, MomEvent, PlatformAdapter } from "./types.js";
import type { ChannelStore } from "../store.js";
import { LIVE_THINKING_INSTRUCTIONS } from "../live-thinking-bridge.js";

/** Private, headless delivery surface. No generic awareness/output subscription:
 * only results deliberately authored for this session may return to its voice.
 */
export function createLiveThinkingAdapter(workingDir: string, publish: (id: string, text: string) => void): PlatformAdapter {
	const adapter = new HeartbeatAdapter({ workingDir });
	Object.defineProperty(adapter, "name", { value: "live-thinking" });
	Object.defineProperty(adapter, "formatInstructions", { value: `## Duplex thinking harness\n${LIVE_THINKING_INSTRUCTIONS}\nFinal text is quiet guidance for this session's voice; use live_voice_update for intermediate updates. Do not post a separate conversational answer on another channel.` });
	const baseContext = adapter.createContext.bind(adapter);
	adapter.createContext = (event: MomEvent, store: ChannelStore): MomContext => {
		const context = baseContext(event, store);
		return {
			...context,
			message: { ...context.message, userName: "live-voice-harness", sessionId: event.sessionId,
				sourceEventType: "computer_duplex_thinking", deliveryId: event.deliveryId, directlyAddressed: false },
			channelName: "duplex-thinking",
			sendFinalResponse: async text => { if (text.trim() && event.sessionId) publish(event.sessionId, text.slice(0, 6000)); },
		};
	};
	return adapter;
}
