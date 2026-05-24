export { createTroublemakerRuntime, type TroublemakerRuntime } from "./core/runtime.js";
export type { HostCapabilities, HostServices } from "./core/host.js";
export type { ExecutionHost, ToolRouteDecision, ToolRouteRequest, ToolRouter } from "./core/routing.js";
export type {
	RuntimeEventSink,
	RuntimeMode,
	RuntimeStreamEvent,
	WebTurnInput,
	WebTurnSettings,
} from "./core/runtime-contract.js";
export { runEdgeWebChat, type EdgeAgentMessage, type EdgeWebChatOptions, type EdgeWebChatResult } from "./modes/edge/index.js";
export type { EdgeHostBridge } from "./modes/edge/host-bridge.js";
export { createHostBashRoute } from "./modes/host/index.js";
export type { HostBashRequest, HostBashResponse, HostToolRequest, HostToolResponse } from "./modes/host/protocol.js";
