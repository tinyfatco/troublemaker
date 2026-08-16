import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleService } from "../src/console/service.js";
import { FilesystemWorkspaceStore } from "../src/storage/node/filesystem-workspace.js";

const dir = await mkdtemp(join(tmpdir(), "troublemaker-tenant-console-"));
try {
	const workspace = new FilesystemWorkspaceStore(dir);
	workspace.writeText("settings.json", JSON.stringify({
		name: "Revenue Agent",
		display_mode: "desktop",
		localAgentProfile: "desktop-agent",
		localAgentId: "local-agent-123",
		cloudAgentId: "cloud-agent-456",
		tenantId: "tenant-789",
		cloudBaseUrl: "https://api.example.com",
		appOwnedRuntime: true,
		speak: { auto: false },
	}, null, 2));

	const service = new ConsoleService(workspace, {});
	const session = service.getSession();
	assert.equal(session.mode, "local-desktop");
	assert.equal(session.agent_id, "local-agent-123");
	assert.equal(session.local_agent_id, "local-agent-123");
	assert.equal(session.cloud_agent_id, "cloud-agent-456");
	assert.equal(session.tenant_id, "tenant-789");
	assert.equal(session.capabilities.desktop, true);
	assert.equal(session.capabilities.fleet, true);

	const agents = service.getAgents();
	assert.equal(agents.count, 1);
	assert.equal(agents.agents[0]?.id, "local-agent-123");
	assert.equal(agents.agents[0]?.name, "Revenue Agent");
	assert.equal(agents.agents[0]?.cloud_agent_id, "cloud-agent-456");
	assert.equal(agents.agents[0]?.tenant_id, "tenant-789");
	assert.equal(agents.agents[0]?.provider, "local-desktop");

	const status = service.getStatus();
	assert.equal(status.mode, "local-desktop");
	assert.equal(status.agent_id, "local-agent-123");
	assert.equal(status.agent_name, "Revenue Agent");
	assert.equal(status.cloud_agent_id, "cloud-agent-456");
	assert.equal(status.display_mode, "desktop");
	assert.equal(status.capabilities.desktop, true);
	assert.deepEqual(status.client_preferences, {
		macos_computer_auto_speech: true,
	}, "selected-agent status defaults macOS Computer auto speech on and ignores removed speak.auto state");

	workspace.writeText("settings.json", JSON.stringify({
		name: "Revenue Agent",
		display_mode: "desktop",
		computer: { macosAutoSpeech: false, privateNote: "must-not-project" },
		speak: { enabled: true, token: "must-not-project" },
		unrelatedPrivateSetting: "must-not-project",
	}, null, 2));
	const disabledStatus = service.getStatus();
	assert.deepEqual(disabledStatus.client_preferences, {
		macos_computer_auto_speech: false,
	}, "selected-agent status projects only the disabled bounded boolean");
	assert.deepEqual(
		Object.keys(disabledStatus.client_preferences),
		["macos_computer_auto_speech"],
		"selected-agent preferences never expose raw Computer or speech settings",
	);
	assert.equal(JSON.stringify(disabledStatus).includes("must-not-project"), false);

	workspace.writeText("settings.json", JSON.stringify({
		name: "Revenue Agent",
		display_mode: "desktop",
		computer: { macosAutoSpeech: "false" },
	}, null, 2));
	assert.equal(
		service.getStatus().client_preferences.macos_computer_auto_speech,
		true,
		"invalid persisted values cannot escape the bounded boolean contract",
	);

	console.log("tenant console identity: ok");
} finally {
	await rm(dir, { recursive: true, force: true });
}
