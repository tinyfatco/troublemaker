import type { HostCapabilities, HostServices } from "../../core/host.js";

export const WORKER_BASE_CAPABILITIES: HostCapabilities = {
	awareness: true,
	files: true,
	messages: true,
	terminal: false,
	desktop: false,
	voice: false,
	shell: false,
	fleet: true,
};

export type WorkerHostServices = HostServices;

export function describeWorkerHost(host: WorkerHostServices): HostCapabilities {
	return host.capabilities;
}
