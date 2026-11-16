import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { join } from "path";
import { getWorkspaceSkillsMtime } from "../core/prompt.js";
import * as log from "../log.js";
import { FilesystemWorkspaceStore } from "../storage/node/filesystem-workspace.js";

// Skills cache — skills rarely change, no need to re-scan R2/FUSE on every message
const skillsCache = new Map<string, { skills: Skill[]; workspaceMtime: number }>();

export function loadMomSkills(awarenessDir: string, workspacePath: string, extraSkillsDirs: string[] = []): Skill[] {
	const hostWorkspacePath = join(awarenessDir, "..");
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	const workspaceStore = new FilesystemWorkspaceStore(hostWorkspacePath);

	// Check cache — invalidate only if workspace skills dir mtime changed
	const cached = skillsCache.get(awarenessDir);
	if (cached) {
		const currentMtime = getWorkspaceSkillsMtime(workspaceStore);
		if (currentMtime === cached.workspaceMtime) {
			return cached.skills;
		}
		log.logInfo(`[skills] Workspace skills changed, reloading`);
	}

	const skillMap = new Map<string, Skill>();

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load extra skills dirs first (lowest priority — e.g. platform skills via --skills)
	for (const dir of extraSkillsDirs) {
		for (const skill of loadSkillsFromDir({ dir, source: "system" }).skills) {
			skillMap.set(skill.name, skill);
		}
	}

	// Load workspace-level skills (global) — overrides system skills on collision
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	const skills = Array.from(skillMap.values());
	skillsCache.set(awarenessDir, { skills, workspaceMtime: getWorkspaceSkillsMtime(workspaceStore) });
	return skills;
}
