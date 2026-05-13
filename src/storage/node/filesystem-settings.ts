import type { MomSettings } from "../../context.js";
import type { SettingsStore } from "../settings.js";
import type { WorkspaceStore } from "../workspace.js";

export class FilesystemSettingsStore implements SettingsStore {
	constructor(private readonly workspace: WorkspaceStore) {}

	read(): MomSettings {
		const raw = this.workspace.readText("settings.json");
		if (!raw) return {};
		try {
			return JSON.parse(raw) as MomSettings;
		} catch {
			return {};
		}
	}

	write(settings: MomSettings): void {
		this.workspace.writeText("settings.json", `${JSON.stringify(settings, null, 2)}\n`);
	}

	reload(): MomSettings {
		return this.read();
	}
}
