export type ExecutionHost = "worker" | "worker-shell" | "container";

export interface ToolRouteRequest {
	tool: string;
	args: Record<string, unknown>;
}

export interface ToolRouteDecision {
	host: ExecutionHost;
	reason: string;
}

export interface ToolRouter {
	routeTool(request: ToolRouteRequest): Promise<ToolRouteDecision> | ToolRouteDecision;
}
