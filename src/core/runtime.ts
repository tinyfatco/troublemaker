import type { PlatformAdapter } from "../adapters/types.js";
import type { ConsoleService } from "../console/service.js";
import type { AgentRunner } from "../agent.js";
import type { HostServices } from "./host.js";

export interface TroublemakerRuntime {
	readonly host: HostServices;
	readonly adapters: PlatformAdapter[];
	readonly runner: AgentRunner;
	readonly console?: ConsoleService;
}

export function createTroublemakerRuntime(config: TroublemakerRuntime): TroublemakerRuntime {
	return config;
}
