import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	genericContextConflict,
	readLocalTenantProfile,
} from "../src/local/tenant-profile.js";
import { FilesystemWorkspaceStore } from "../src/storage/node/filesystem-workspace.js";

const dir = await mkdtemp(join(tmpdir(), "troublemaker-tenant-boundary-"));
try {
	const workspace = new FilesystemWorkspaceStore(dir);
	workspace.writeText("settings.json", JSON.stringify({
		name: "Desktop Agent",
		localAgentProfile: "desktop-agent",
		localAgentId: "desktop-agent-local",
		appOwnedRuntime: true,
	}, null, 2));

	const profile = readLocalTenantProfile(workspace, {});
	assert.equal(profile.profileActive, true);
	assert.equal(profile.mode, "local-desktop");
	assert.equal(profile.localAgentId, "desktop-agent-local");

	const genericWorkspace = `${process.env.HOME}/Library/Application Support/Troublemaker/Workspace`;
	const generic = genericContextConflict(profile, genericWorkspace, 3002);
	assert.equal(generic.conflict, true);
	assert.deepEqual(generic.reasons, [
		"port_3002_is_reserved_for_generic_localhost_context",
		"workspace_is_generic_troublemaker_workspace",
	]);

	const isolated = genericContextConflict(
		profile,
		`${process.env.HOME}/Library/Application Support/Troublemaker/Agents/desktop-agent-local/Workspace`,
		3017,
	);
	assert.equal(isolated.conflict, false);

	console.log("tenant context boundary: ok");
} finally {
	await rm(dir, { recursive: true, force: true });
}
