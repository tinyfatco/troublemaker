import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	agentIdentityRuntimeVersionSuffix,
	computerControlPath,
	computerRuntimeVersionSuffix,
	initializeChannelWorkingOutput,
	contextWorkspacePath,
	hostOwnsScheduledWakes,
	initializeComputerUseSettings,
	initializeMattermostWorkingOutput,
	initializeNamedAgentIdentity,
	initializeNamedAgentInstructions,
	readComputerControlState,
	RuntimeManager,
	runtimeEngineRunFlags,
	scheduledWakeRuntimeVersion,
	serializeRuntimeEnvironment,
	writeComputerControlState,
} from "../src/runtime.mjs";
import { contextCapability } from "../src/security.mjs";
import { HostStore } from "../src/store.mjs";

const CHANNEL_ID = "cccccccccccccccccccccccccc";

test("runtime env-file serialization rejects line injection", () => {
	assert.equal(
		serializeRuntimeEnvironment({ MOM_MODEL_ID: "gpt-5.6-sol", MOM_THINKING: "high" }),
		"MOM_MODEL_ID=gpt-5.6-sol\nMOM_THINKING=high\n",
	);
	assert.throws(
		() => serializeRuntimeEnvironment({ "BAD\nINJECTED": "value" }),
		/invalid key/,
	);
	assert.throws(
		() => serializeRuntimeEnvironment({ MOM_MODEL_ID: "safe\rINJECTED=value" }),
		/control characters/,
	);
});

test("stopped context rehome preserves its durable workspace and port", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-runtime-rehome-"));
	const contextsDirectory = join(directory, "contexts");
	const store = new HostStore(join(directory, "state.sqlite"));
	const fromContextId = "front-desk:legacy:intake";
	const toContextId = "front-desk:relationship:relationship-operator";
	const target = {
		id: "front-desk",
		driver: "oci",
		engine: "/usr/bin/false",
		contextsDirectory,
	};
	try {
		store.createContext({
			id: fromContextId,
			targetId: target.id,
			driver: "oci",
			runtimeName: "legacy-runtime",
			port: 32001,
		});
		const oldWorkspace = contextWorkspacePath(target, fromContextId);
		await mkdir(oldWorkspace, { recursive: true });
		await writeFile(join(oldWorkspace, "continuity.txt"), "durable relationship state\n");
		const runtime = new RuntimeManager({ targetsById: new Map([[target.id, target]]) }, store);
		const migrated = await runtime.rehomeStoppedContext(target, fromContextId, toContextId, {
			relationshipId: "relationship-example",
		});

		assert.equal(migrated.workspaceMoved, true);
		assert.equal(migrated.retainedStoppedRuntime, "legacy-runtime");
		assert.equal(store.getContext(fromContextId), undefined);
		assert.equal(store.getContext(toContextId).port, 32001);
		assert.equal(
			await readFile(join(contextWorkspacePath(target, toContextId), "continuity.txt"), "utf8"),
			"durable relationship state\n",
		);
		await assert.rejects(readFile(join(oldWorkspace, "continuity.txt"), "utf8"), /ENOENT/);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("phone relationship rehome rewrites only its exact persisted channel custody", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-runtime-phone-rehome-"));
	const contextsDirectory = join(directory, "contexts");
	const store = new HostStore(join(directory, "state.sqlite"));
	const fromContextId = "front-desk:legacy:intake";
	const toContextId = "front-desk:relationship:relationship-operator";
	const threadTarget = "phone-0123456789abcdef0123";
	const target = {
		id: "front-desk",
		driver: "oci",
		engine: "/usr/bin/false",
		contextsDirectory,
	};
	try {
		store.createContext({
			id: fromContextId,
			targetId: target.id,
			driver: "oci",
			runtimeName: "legacy-runtime",
			port: 32001,
		});
		const oldWorkspace = contextWorkspacePath(target, fromContextId);
		await mkdir(oldWorkspace, { recursive: true });
		await writeFile(join(oldWorkspace, "phone-channels.json"), JSON.stringify({
			version: 1,
			channels: {
				[threadTarget]: {
					channelId: threadTarget,
					provider: "hostd",
					hostManaged: true,
					hostContextId: fromContextId,
				},
			},
		}));
		const runtime = new RuntimeManager({ targetsById: new Map([[target.id, target]]) }, store);
		await runtime.rehomeStoppedContext(target, fromContextId, toContextId, {
			relationshipId: "relationship-example",
			phoneThreadTarget: threadTarget,
		});

		const registry = JSON.parse(await readFile(
			join(contextWorkspacePath(target, toContextId), "phone-channels.json"),
			"utf8",
		));
		assert.equal(registry.channels[threadTarget].hostContextId, toContextId);
		assert.equal(store.getContext(fromContextId), undefined);
		assert.equal(store.getContext(toContextId).port, 32001);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("phone relationship rehome rejects stale cross-context channel custody", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-runtime-phone-rehome-denied-"));
	const contextsDirectory = join(directory, "contexts");
	const store = new HostStore(join(directory, "state.sqlite"));
	const fromContextId = "front-desk:legacy:intake";
	const toContextId = "front-desk:relationship:relationship-operator";
	const threadTarget = "phone-0123456789abcdef0123";
	const target = {
		id: "front-desk",
		driver: "oci",
		engine: "/usr/bin/false",
		contextsDirectory,
	};
	try {
		store.createContext({
			id: fromContextId,
			targetId: target.id,
			driver: "oci",
			runtimeName: "legacy-runtime",
			port: 32001,
		});
		const oldWorkspace = contextWorkspacePath(target, fromContextId);
		await mkdir(oldWorkspace, { recursive: true });
		await writeFile(join(oldWorkspace, "phone-channels.json"), JSON.stringify({
			version: 1,
			channels: {
				[threadTarget]: {
					channelId: threadTarget,
					provider: "hostd",
					hostManaged: true,
					hostContextId: "front-desk:other:intake",
				},
			},
		}));
		const runtime = new RuntimeManager({ targetsById: new Map([[target.id, target]]) }, store);
		await assert.rejects(
			runtime.rehomeStoppedContext(target, fromContextId, toContextId, {
				relationshipId: "relationship-example",
				phoneThreadTarget: threadTarget,
			}),
			/conflicts with source custody/,
		);
		assert.equal(store.getContext(fromContextId).port, 32001);
		assert.equal(store.getContext(toContextId), undefined);
		assert.equal(
			JSON.parse(await readFile(join(oldWorkspace, "phone-channels.json"), "utf8"))
				.channels[threadTarget].hostContextId,
			"front-desk:other:intake",
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("private Operator initializes fixed Mattermost working output without overriding self configuration", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "hostd-runtime-settings-"));
	try {
		assert.equal(await initializeMattermostWorkingOutput(workspace, CHANNEL_ID), true);
		const initialized = JSON.parse(await readFile(join(workspace, "settings.json"), "utf8"));
		assert.deepEqual(initialized.workingOutput, {
			mode: "fixed",
			target: { platform: "mattermost", channelId: CHANNEL_ID },
		});

		initialized.workingOutput = { mode: "off" };
		initialized.defaultThinkingLevel = "high";
		await writeFile(join(workspace, "settings.json"), JSON.stringify(initialized));
		assert.equal(await initializeMattermostWorkingOutput(workspace, CHANNEL_ID), false);
		const preserved = JSON.parse(await readFile(join(workspace, "settings.json"), "utf8"));
		assert.deepEqual(preserved.workingOutput, { mode: "off" });
		assert.equal(preserved.defaultThinkingLevel, "high");
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("private customer runtime initializes fixed Rocket.Chat working output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "troublemaker-runtime-settings-"));
	try {
		assert.equal(
			await initializeChannelWorkingOutput(directory, "rocket-chat", "roomCustomer123"),
			true,
		);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "settings.json"), "utf8")).workingOutput, {
			mode: "fixed",
			target: { platform: "rocket-chat", channelId: "roomCustomer123" },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("private customer runtime initializes fixed topic-free Zulip working output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "troublemaker-runtime-settings-"));
	try {
		assert.equal(
			await initializeChannelWorkingOutput(directory, "zulip", "4"),
			true,
		);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "settings.json"), "utf8")).workingOutput, {
			mode: "fixed",
			target: { platform: "zulip", channelId: "4" },
		});
		await assert.rejects(
			initializeChannelWorkingOutput(directory, "zulip", "not-a-channel"),
			/Zulip working-output channel ID is invalid/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("computer-enabled contexts receive one host-managed bounded CUA server", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "hostd-computer-settings-"));
	const target = {
		computer: { enabled: true, display: ":1", websocketPort: 6901 },
	};
	try {
		await writeFile(join(workspace, "settings.json"), JSON.stringify({
			defaultThinkingLevel: "high",
			mcpServers: [{ alias: "local-tools", transport: "stdio", command: "example-tool" }],
		}));
		assert.equal(await initializeComputerUseSettings(workspace, target), true);
		const settings = JSON.parse(await readFile(join(workspace, "settings.json"), "utf8"));
		assert.equal(settings.defaultThinkingLevel, "high");
		assert.equal(settings.display_mode, "desktop");
		assert.deepEqual(settings.mcpServers, [
			{ alias: "local-tools", transport: "stdio", command: "example-tool" },
			{
				managedBy: "hostd-computer",
				alias: "cua",
				transport: "stdio",
				command: "/usr/local/bin/cua-driver",
				args: ["mcp"],
				env: {
					HOME: "/data",
					DISPLAY: ":1",
					XDG_RUNTIME_DIR: "/tmp/cua-runtime",
					CUA_DRIVER_PERMISSION_MODE: "bounded",
					CUA_DRIVER_CAPABILITY_MANIFEST_FILE: "/etc/troublemaker/cua-capabilities.yaml",
					CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "1",
					TROUBLEMAKER_COMPUTER_CONTROL_FILE: "/run/troublemaker-hostd/computer-control/state.json",
				},
				scopes: ["computer:use"],
			},
		]);
		assert.equal(await initializeComputerUseSettings(workspace, target), false);
		assert.equal(computerRuntimeVersionSuffix(target), ":computer-v1");
		assert.equal(computerRuntimeVersionSuffix({ computer: { enabled: false } }), "");
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("computer control is a host-owned expiring lease outside the agent workspace", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-computer-control-"));
	const target = { contextsDirectory: join(directory, "contexts") };
	const contextId = "front-desk:relationship:intake";
	const now = Date.parse("2026-08-25T12:00:00Z");
	try {
		const workspace = contextWorkspacePath(target, contextId);
		const controlPath = computerControlPath(target, contextId);
		assert.equal(controlPath.startsWith(workspace), false);
		assert.deepEqual(await readComputerControlState(target, contextId, now), {
			version: 1,
			mode: "agent",
			expiresAt: null,
			updatedAt: null,
		});
		await writeComputerControlState(target, contextId, "human", { now, leaseSeconds: 90 });
		assert.deepEqual(await readComputerControlState(target, contextId, now + 89_000), {
			version: 1,
			mode: "human",
			expiresAt: "2026-08-25T12:01:30.000Z",
			updatedAt: "2026-08-25T12:00:00.000Z",
		});
		assert.equal((await readComputerControlState(target, contextId, now + 91_000)).mode, "agent");
		await assert.rejects(
			writeComputerControlState(target, contextId, "shared", { now }),
			/invalid computer control mode/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Hostd reconciles the canonical named agent without replacing personality or memory", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "hostd-agent-identity-"));
	const agent = {
		id: "scout",
		name: "Scout",
		slug: "scout",
		email: "scout@example.com",
	};
	try {
		await writeFile(join(workspace, "IDENTITY.md"), `# IDENTITY.md - Who Am I?

- **Name:** Previous Agent
- **Creature:** an enormous brown sasquatch
- **Vibe:** warm and practical
`);
		await writeFile(join(workspace, "MEMORY.md"), "Keep every durable memory.\n");
		await writeFile(join(workspace, "AGENTS.md"), `# Legacy relationship instructions

Operator is the old generic workspace label.
Keep this customer-specific safety rule.
`);
		assert.equal(await initializeNamedAgentIdentity(workspace, agent), true);
		assert.equal(await initializeNamedAgentInstructions(workspace, agent, true), true);
		const identity = await readFile(join(workspace, "IDENTITY.md"), "utf8");
		const instructions = await readFile(join(workspace, "AGENTS.md"), "utf8");
		assert.match(identity, /\*\*Name:\*\* Scout/);
		assert.match(identity, /\*\*Service mailbox:\*\* scout@example\.com/);
		assert.match(identity, /an enormous brown sasquatch/);
		assert.match(identity, /warm and practical/);
		assert.doesNotMatch(identity, /Previous Agent/);
		assert.match(instructions, /workspace belongs to \*\*Scout\*\*/);
		assert.match(instructions, /operator.*role|“Operator” describes work/i);
		assert.match(instructions, /persistent Chromium desktop/);
		assert.match(instructions, /Keep this customer-specific safety rule/);
		assert.equal(await readFile(join(workspace, "MEMORY.md"), "utf8"), "Keep every durable memory.\n");
		assert.equal(await initializeNamedAgentIdentity(workspace, agent), false);
		assert.equal(await initializeNamedAgentInstructions(workspace, agent, true), false);
		assert.match(agentIdentityRuntimeVersionSuffix({ agent }), /^:agent-[0-9a-f]{12}$/);
		assert.notEqual(
			agentIdentityRuntimeVersionSuffix({ agent }),
			agentIdentityRuntimeVersionSuffix({ agent: { ...agent, name: "Scout Two" } }),
		);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("Zulip cutover migrates only old fixed customer-channel working output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "troublemaker-runtime-settings-"));
	try {
		const settingsPath = join(directory, "settings.json");
		await writeFile(settingsPath, JSON.stringify({
			defaultThinkingLevel: "high",
			workingOutput: {
				mode: "fixed",
				target: { platform: "mattermost", channelId: CHANNEL_ID },
			},
		}));
		assert.equal(
			await initializeChannelWorkingOutput(
				directory,
				"zulip",
				"4",
				{ migrateFromPlatforms: ["mattermost", "rocket-chat"] },
			),
			true,
		);
		const migrated = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.deepEqual(migrated.workingOutput, {
			mode: "fixed",
			target: { platform: "zulip", channelId: "4" },
		});
		assert.equal(migrated.defaultThinkingLevel, "high");

		migrated.workingOutput = { mode: "off" };
		await writeFile(settingsPath, JSON.stringify(migrated));
		assert.equal(
			await initializeChannelWorkingOutput(
				directory,
				"zulip",
				"5",
				{ migrateFromPlatforms: ["mattermost", "rocket-chat"] },
			),
			false,
		);
		assert.deepEqual(
			JSON.parse(await readFile(settingsPath, "utf8")).workingOutput,
			{ mode: "off" },
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Hostd schedule ownership is exact-context and host-mode only", () => {
	const contextId = "front-desk:example:intake";
	assert.equal(hostOwnsScheduledWakes({ scheduledWakes: { mode: "off", contextIds: [contextId] } }, contextId), false);
	assert.equal(hostOwnsScheduledWakes({ scheduledWakes: { mode: "shadow", contextIds: [contextId] } }, contextId), false);
	assert.equal(hostOwnsScheduledWakes({ scheduledWakes: { mode: "host", contextIds: [contextId] } }, contextId), true);
	assert.equal(hostOwnsScheduledWakes({ scheduledWakes: { mode: "host", contextIds: [contextId] } }, "front-desk:other:intake"), false);
	const target = { runtimeVersion: "runtime-v1" };
	assert.equal(
		scheduledWakeRuntimeVersion({ scheduledWakes: { mode: "host", contextIds: [contextId] } }, target, contextId),
		"runtime-v1:scheduled-host-v1",
	);
	assert.equal(
		scheduledWakeRuntimeVersion({ scheduledWakes: { mode: "shadow", contextIds: [contextId] } }, target, contextId),
		"runtime-v1",
	);
});

test("schedule ownership startup stops dual-owner runtimes and restarts only local rollback owners", async () => {
	const contextId = "front-desk:example:intake";
	const target = { id: "front-desk", runtimeVersion: "runtime-v1" };
	const context = {
		id: contextId,
		targetId: target.id,
		status: "online",
		runtimeVersion: "runtime-v1",
		runtimeName: "runtime-example",
	};
	const store = { listContexts: () => [context] };
	const config = {
		scheduledWakes: { mode: "host", contextIds: [contextId] },
		targetsById: new Map([[target.id, target]]),
	};
	const manager = new RuntimeManager(config, store, {});
	const actions = [];
	manager.stopOciContext = async (_target, selected) => { actions.push(`stop:${selected.contextId}`); };
	manager.ensureOciContext = async (_target, selectedContextId) => { actions.push(`start:${selectedContextId}`); return {}; };
	await manager.reconcileScheduledWakeOwnership();
	assert.deepEqual(actions, [`stop:${contextId}`]);

	actions.length = 0;
	config.scheduledWakes.mode = "off";
	context.runtimeVersion = "runtime-v1:scheduled-host-v1";
	await manager.reconcileScheduledWakeOwnership();
	assert.deepEqual(actions, [`stop:${contextId}`, `start:${contextId}`]);
});

test("scheduled occurrences use only the exact context ingress capability", async () => {
	const contextId = "front-desk:example:intake";
	const target = {
		id: "front-desk",
		inboundToken: "synthetic-inbound-secret",
		hostGateway: "host.example",
	};
	const config = {
		server: { port: 3099 },
		scheduledWakes: { mode: "host", contextIds: [contextId] },
		targetsById: new Map([[target.id, target]]),
	};
	const manager = new RuntimeManager(config, {}, {});
	manager.ensureOciContext = async () => ({
		contextId,
		scheduledPromptEndpoint: "http://127.0.0.1:32000/scheduled-prompt/inbound",
	});
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (input, init) => {
		request = { input: String(input), init, body: JSON.parse(String(init?.body)) };
		return new Response(JSON.stringify({ ok: true }), { status: 202 });
	};
	try {
		await manager.acceptEvent({
			id: `scheduled:${"a".repeat(64)}`,
			source: "scheduled-prompt",
			targetId: target.id,
			contextId,
			leaseToken: "lease-example",
			deliveryMode: "turn",
			payloadJson: JSON.stringify({
				schedule: { filename: "example.json", generation: 1, canonicalSlotAt: "2026-06-01T00:00:00.000Z", fireAt: "2026-06-01T00:00:00.000Z" },
				event: { type: "one-shot", at: "2026-06-01T00:00:00.000Z", text: "wake" },
			}),
		});
		assert.equal(request.input, "http://127.0.0.1:32000/scheduled-prompt/inbound");
		assert.equal(
			new Headers(request.init.headers).get("authorization"),
			`Bearer ${contextCapability(target.inboundToken, "scheduled-prompt-inbound", contextId)}`,
		);
		assert.equal(request.body.hostContextId, contextId);
		assert.equal(request.body.deliveryId, `scheduled:${"a".repeat(64)}`);
		assert.equal(request.body.hostReceipt.leaseToken, "lease-example");

		config.scheduledWakes.contextIds = ["front-desk:other:intake"];
		await assert.rejects(
			manager.acceptEvent({
				id: `scheduled:${"b".repeat(64)}`,
				source: "scheduled-prompt",
				targetId: target.id,
				contextId,
				leaseToken: "lease-other",
				deliveryMode: "turn",
				payloadJson: JSON.stringify({ schedule: {}, event: {} }),
			}),
			/does not own schedules/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("MCP Operator delivery carries Hostd's exact relationship scope", async () => {
	const contextId = "front-desk:relationship:relationship-operator";
	const relationshipScope = {
		relationshipId: "00000000-0000-4000-8000-000000000010",
		generation: 3,
		source: "phone",
		recipientHint: "ending 0123",
		replyTarget: "phone-0123456789abcdef0123",
	};
	const target = {
		id: "front-desk",
		inboundToken: "synthetic-inbound-secret",
		hostGateway: "host.example",
	};
	const manager = new RuntimeManager({
		server: { port: 3099 },
		targetsById: new Map([[target.id, target]]),
	}, {}, {});
	manager.setMcp({
		authorizeInstructionEvent: () => ({
			grant: { displayName: "Example connection" },
			relationship: { id: relationshipScope.relationshipId },
		}),
		operatorRuntimeToken: () => "relationship-runtime-token",
		operatorRuntimeScope: () => relationshipScope,
	});
	manager.ensureOciContext = async () => ({
		contextId,
		relationshipOperatorEndpoint: "http://127.0.0.1:32000/operator/relationship-message",
	});
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (input, init) => {
		request = { input: String(input), init, body: JSON.parse(String(init?.body)) };
		return new Response(JSON.stringify({ accepted: true }), { status: 202 });
	};
	try {
		await manager.acceptEvent({
			id: "00000000-0000-4000-8000-000000000011",
			source: "mcp-operator",
			targetId: target.id,
			contextId,
			leaseToken: "00000000-0000-4000-8000-000000000012",
			deliveryMode: "turn",
			payloadJson: JSON.stringify({ message: "Do the bounded thing.", mcp: {} }),
		});
		assert.equal(request.input, "http://127.0.0.1:32000/operator/relationship-message");
		assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer relationship-runtime-token");
		assert.deepEqual(request.body.relationshipScope, relationshipScope);
		assert.equal(request.body.hostContextId, contextId);
		assert.equal(request.body.deliveryId, "00000000-0000-4000-8000-000000000011");
		assert.equal(request.body.text.includes("Do the bounded thing."), true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("runtime engine flags keep Docker and rootless Podman launchers distinct", () => {
	assert.deepEqual(runtimeEngineRunFlags("/usr/local/bin/docker"), [
		"--add-host",
		"host.docker.internal:host-gateway",
	]);
	assert.deepEqual(runtimeEngineRunFlags("/opt/troublemaker/hostd/bin/podman-user-session"), [
		"--replace",
		"--userns=keep-id",
		"--network=slirp4netns:allow_host_loopback=true",
	]);
});
