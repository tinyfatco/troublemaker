import type { MomSettings } from "../context.js";

export interface SettingsStore {
	read(): MomSettings;
	write(settings: MomSettings): void;
	reload(): MomSettings;
}
