import type { ScheduledEvent } from "../events.js";

export interface StoredEvent {
	file: string;
	event: ScheduledEvent;
}

export interface EventStore {
	list(): Promise<StoredEvent[]>;
	read(file: string): Promise<ScheduledEvent | null>;
	write(file: string, event: ScheduledEvent): Promise<void>;
	complete(file: string, outcome: "fired" | "expired"): Promise<void>;
	delete(file: string): Promise<void>;
}
