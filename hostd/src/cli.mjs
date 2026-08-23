#!/usr/bin/env node
import { chmod, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ChannelControlNotifier } from "./channel-control-notifier.mjs";
import { loadConfig } from "./config.mjs";
import { InboxDaemon } from "./daemon.mjs";
import { GogGmail } from "./gmail.mjs";
import { importLegacyCheckpoint } from "./legacy.mjs";
import { MattermostProvisioner } from "./mattermost.mjs";
import { MattermostGateway } from "./mattermost-gateway.mjs";
import { HostMcp } from "./mcp.mjs";
import { createMcpEdgeServer } from "./mcp-edge-server.mjs";
import { HostMcpOutboundProxy } from "./mcp-outbound.mjs";
import { MetaContactExporter } from "./meta-contact.mjs";
import { HostOpenAi } from "./openai.mjs";
import { PhoneGateway } from "./phone.mjs";
import { RocketChatGateway } from "./rocket-chat-gateway.mjs";
import { RocketChatProvisioner } from "./rocket-chat.mjs";
import { ZulipGateway } from "./zulip-gateway.mjs";
import { ZulipProvisioner } from "./zulip.mjs";
import { ContextRouter } from "./router.mjs";
import { RuntimeManager } from "./runtime.mjs";
import { validateOpenAiContextModels } from "./runtime-model.mjs";
import { readRoutingKey, stablePrivateKey } from "./security.mjs";
import { EventScheduler } from "./scheduler.mjs";
import { ScheduledWakeManager } from "./scheduled-wakes.mjs";
import { createHostServer } from "./server.mjs";
import { HostSites } from "./sites.mjs";
import { HostStore } from "./store.mjs";
import { WebChatGateway } from "./web-chat.mjs";
import { createWebAppServer } from "./web-app-server.mjs";
import { HostWorkersAi } from "./workers-ai.mjs";

function usage() {
	console.error(`Usage:
  troublemaker-hostd serve --config <path>
  troublemaker-hostd poll-once --config <path>
  troublemaker-hostd baseline --config <path>
  troublemaker-hostd provision-mattermost --config <path>
  troublemaker-hostd provision-rocketchat --config <path>
  troublemaker-hostd provision-zulip --config <path>
  troublemaker-hostd import-legacy-checkpoint --config <path> --checkpoint <path> --key-file <path>
  troublemaker-hostd mcp-rehome-context --config <path> --context <id>
  troublemaker-hostd mcp-handoff --config <path> --context <id> --direction <inbound|outbound|bidirectional> --name <name> [--server-url <https-url>]
  troublemaker-hostd mcp-list --config <path> --context <id>
  troublemaker-hostd mcp-revoke --config <path> --context <id> --direction <handoff|inbound|outbound> --id <id>
  troublemaker-hostd status --config <path>`);
	process.exit(2);
}

function option(name) {
	const index = process.argv.indexOf(name);
	if (index === -1 || !process.argv[index + 1]) return undefined;
	return process.argv[index + 1];
}

async function components(configPath) {
	const config = await loadConfig(configPath);
	const store = new HostStore(config.state.database);
	try {
		validateOpenAiContextModels(config, store);
	} catch (error) {
		store.close();
		throw error;
	}
	const routingKey = await readRoutingKey(config.state.routingKeyFile);
	const gmail = config.gmail ? new GogGmail(config.gmail) : undefined;
	const router = new ContextRouter(config, store, routingKey);
	const knownEmailsByPrincipalHash = new Map(
		config.routing.knownPrincipals.map((principal) => [
			stablePrivateKey(routingKey, "email-principal", principal.email).slice(0, 24),
			principal.email,
		]),
	);
	const knownLabelsByPrincipalHash = new Map(
		config.routing.knownPrincipals
			.filter((principal) => principal.name)
			.map((principal) => [
				stablePrivateKey(routingKey, "email-principal", principal.email).slice(0, 24),
				principal.name,
			]),
	);
	const mattermost = config.mattermost
		? new MattermostProvisioner(config.mattermost, store, { knownEmailsByPrincipalHash })
		: undefined;
	const rocketChat = config.rocketChat
		? new RocketChatProvisioner(config.rocketChat, store, { knownEmailsByPrincipalHash })
		: undefined;
	const zulip = config.zulip
		? new ZulipProvisioner(config.zulip, store, {
			knownEmailsByPrincipalHash,
			knownLabelsByPrincipalHash,
		})
		: undefined;
	const channelControl = zulip ?? rocketChat ?? mattermost;
	const controlNotifier = channelControl
		? new ChannelControlNotifier({
			store,
			projection: channelControl,
			tickSeconds: config.scheduler.tickSeconds,
			label: zulip ? "Zulip" : rocketChat ? "Rocket.Chat" : "Mattermost",
		})
		: undefined;
	const sites = config.sites ? new HostSites({ config, store, routingKey }) : undefined;
	const workersAiGateway = config.workersAi
		? new HostWorkersAi({ config, store, routingKey })
		: undefined;
	const openAiGateway = config.openAi
		? new HostOpenAi({ config, store })
		: undefined;
	const runtime = new RuntimeManager(config, store, {
		mattermost,
		rocketChat,
		zulip,
		routingKey,
		sites,
	});
	const mcp = config.mcp
		? new HostMcp({
			config,
			store,
			routingKey,
			runtime,
			onContextChanged: (contextId) => runtime.refreshMcpContext(contextId),
		})
		: undefined;
	const mcpOutbound = mcp
		? new HostMcpOutboundProxy({ config, store, mcp })
		: undefined;
	if (mcp) runtime.setMcp(mcp);
	const scheduler = new EventScheduler({ config, store, runtime });
	if (mcp) {
		mcp.setEventPump(() => {
			controlNotifier?.wake();
			return scheduler.pump();
		});
		controlNotifier?.setOnProjected(() => scheduler.pump());
	}
	const scheduledWakes = new ScheduledWakeManager({ config, store });
	const daemon = config.gmail
		? new InboxDaemon({
			config,
			store,
			gmail,
			router,
			scheduler,
			controlNotifier,
		})
		: { polling: false, controlNotifier };
	const mattermostGateway = mattermost
		? new MattermostGateway({ config, store, provisioner: mattermost, scheduler })
		: undefined;
	const rocketChatGateway = rocketChat
		? new RocketChatGateway({ config, store, provisioner: rocketChat, scheduler })
		: undefined;
	const webChatGateway = config.webChat
		? new WebChatGateway({
			config,
			store,
			router,
			scheduler,
			controlNotifier,
		})
		: undefined;
	const zulipGateway = zulip
		? new ZulipGateway({
			config,
			store,
			provisioner: zulip,
			scheduler,
			webChatGateway,
		})
		: undefined;
	const firstContact = config.metaContact
		? new MetaContactExporter(config.metaContact)
		: undefined;
	const phoneGateway = config.phone
		? new PhoneGateway({
			config,
			store,
			router,
			routingKey,
			scheduler,
			controlNotifier,
			firstContact,
		})
		: undefined;
	return {
		config,
		store,
		gmail,
		routingKey,
		router,
		runtime,
		mcp,
		mcpOutbound,
		mattermost,
		rocketChat,
		zulip,
		controlNotifier,
		scheduler,
		scheduledWakes,
		sitesGateway: sites,
		workersAiGateway,
		openAiGateway,
		mattermostGateway,
		rocketChatGateway,
		zulipGateway,
		webChatGateway,
		firstContact,
		phoneGateway,
		daemon,
	};
}

async function serve(configPath) {
	const state = await components(configPath);
	const server = createHostServer(state);
	const webAppServer = state.config.webApp ? createWebAppServer(state) : undefined;
	const mcpEdgeServer = state.config.mcp ? createMcpEdgeServer(state) : undefined;
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(state.config.server.port, state.config.server.host, resolvePromise);
	});
	console.log(
		`troublemaker-hostd: listening on ${state.config.server.host}:${state.config.server.port}`,
	);
	if (webAppServer) {
		try {
			await new Promise((resolvePromise, reject) => {
				webAppServer.once("error", reject);
				webAppServer.listen(
					state.config.webApp.port,
					state.config.webApp.host,
					resolvePromise,
				);
			});
			console.log(
				`troublemaker-hostd: web app gateway listening on ${state.config.webApp.host}:${state.config.webApp.port}`,
			);
		} catch (error) {
			await new Promise((resolvePromise) => server.close(resolvePromise));
			state.store.close();
			throw error;
		}
	}
	if (mcpEdgeServer) {
		try {
			await new Promise((resolvePromise, reject) => {
				mcpEdgeServer.once("error", reject);
				mcpEdgeServer.listen(
					state.config.mcp.edge.port,
					state.config.mcp.edge.host,
					resolvePromise,
				);
			});
			console.log(
				`troublemaker-hostd: MCP edge listening on ${state.config.mcp.edge.host}:${state.config.mcp.edge.port}`,
			);
		} catch (error) {
			if (webAppServer) {
				await new Promise((resolvePromise) => webAppServer.close(resolvePromise));
			}
			await new Promise((resolvePromise) => server.close(resolvePromise));
			state.store.close();
			throw error;
		}
	}
	await state.scheduler.start();
	await state.mattermostGateway?.start();
	await state.rocketChatGateway?.start();
	await state.zulipGateway?.start();
	await state.controlNotifier?.start();
	await state.phoneGateway?.start();
	await state.webChatGateway?.start();
	await state.workersAiGateway?.start();
	void state.runtime.reconcileSiteRelationships().catch((error) => {
		console.error(
			"troublemaker-hostd: relationship Sites startup reconciliation failed:",
			error instanceof Error ? error.message : String(error),
		);
	});
	const initialScheduledWake = await state.scheduledWakes.tick();
	if (initialScheduledWake.materialized > 0) state.scheduler.pump();

	let stopped = false;
	let pollTimer;
	let schedulerTimer;
	const stop = async (signal) => {
		if (stopped) return;
		stopped = true;
		if (pollTimer) clearInterval(pollTimer);
		if (schedulerTimer) clearInterval(schedulerTimer);
		console.log(`troublemaker-hostd: stopping after ${signal}`);
		await state.mattermostGateway?.stop();
		await state.rocketChatGateway?.stop();
		await state.webChatGateway?.stop();
		await state.zulipGateway?.stop();
		await state.phoneGateway?.stop();
		await state.workersAiGateway?.stop();
		await state.controlNotifier?.stop();
		if (webAppServer) {
			await new Promise((resolvePromise) => webAppServer.close(resolvePromise));
		}
		if (mcpEdgeServer) {
			await new Promise((resolvePromise) => mcpEdgeServer.close(resolvePromise));
		}
		await new Promise((resolvePromise) => server.close(resolvePromise));
		state.store.close();
	};
	process.once("SIGTERM", () => void stop("SIGTERM"));
	process.once("SIGINT", () => void stop("SIGINT"));

	const poll = async () => {
		try {
			await state.daemon.pollOnce();
			state.store.setMeta("gmail:last_poll_error", "");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			state.store.setMeta("gmail:last_poll_error", message.slice(0, 1000));
			console.error(
				"troublemaker-hostd: poll failed:",
				message,
			);
		}
	};
	if (state.config.gmail) {
		await poll();
	}
	if (!stopped && state.config.gmail) {
		pollTimer = setInterval(
			() => void poll(),
			state.config.gmail.pollIntervalSeconds * 1000,
		);
		pollTimer.unref();
	}
	if (!stopped) {
		schedulerTimer = setInterval(
			() => void (async () => {
				try {
					const scheduledWake = await state.scheduledWakes.tick();
					if (scheduledWake.materialized > 0) state.scheduler.pump();
				} catch (error) {
					console.error("troublemaker-hostd: scheduled wake tick failed:", error);
				}
				try {
					await state.scheduler.tick();
				} catch (error) {
					console.error("troublemaker-hostd: scheduler tick failed:", error);
				}
			})(),
			state.config.scheduler.tickSeconds * 1000,
		);
		schedulerTimer.unref();
	}
}

async function main() {
	const command = process.argv[2];
	const configPath = option("--config");
	if (!command || !configPath) usage();
	const resolvedConfig = resolve(configPath);

	if (command === "serve") {
		await serve(resolvedConfig);
		return;
	}

	const state = await components(resolvedConfig);
	try {
		if (command === "poll-once") {
			if (!state.config.gmail) throw new Error("Gmail is not configured");
			console.log(JSON.stringify(await state.daemon.pollOnce()));
			return;
		}
		if (command === "baseline") {
			if (!state.config.gmail) throw new Error("Gmail is not configured");
			console.log(JSON.stringify(await state.daemon.baseline()));
			return;
		}
		if (command === "provision-mattermost") {
			if (!state.mattermost) throw new Error("Mattermost is not configured");
			const bindings = await state.mattermost.provisionAll();
			console.log(JSON.stringify({
				provisioned: bindings.length,
				channels: bindings.map((binding) => binding.channelId),
			}));
			return;
		}
		if (command === "provision-rocketchat") {
			if (!state.rocketChat) throw new Error("Rocket.Chat is not configured");
			const bindings = await state.rocketChat.provisionAll();
			console.log(JSON.stringify({
				provisioned: bindings.length,
				rooms: bindings.map((binding) => binding.roomId),
			}));
			return;
		}
		if (command === "provision-zulip") {
			if (!state.zulip) throw new Error("Zulip is not configured");
			const target = state.config.targetsById.get(state.config.routing.actorTarget);
			for (const scope of state.router.ensureKnownPrincipalScopes()) {
				await state.runtime.provisionOciContext(target, scope.contextId);
			}
			const bindings = await state.zulip.provisionAll();
			console.log(JSON.stringify({
				provisioned: bindings.length,
				channels: bindings.map((binding) => binding.channelId),
			}));
			return;
		}
		if (command === "import-legacy-checkpoint") {
			if (!state.config.gmail) throw new Error("Gmail is not configured");
			const checkpointPath = option("--checkpoint");
			const keyPath = option("--key-file");
			if (!checkpointPath || !keyPath) usage();
			const result = await importLegacyCheckpoint({
				checkpointPath: resolve(checkpointPath),
				keyPath: resolve(keyPath),
				account: state.config.gmail.account,
				store: state.store,
			});
			await chmod(state.config.state.database, 0o600);
			console.log(JSON.stringify(result));
			return;
		}
		if (command === "status") {
			console.log(JSON.stringify({
				...state.store.status(
					state.config.scheduler.maxConcurrent,
					state.config.workersAi,
					state.config.openAi,
				),
				scheduledWakeMode: state.config.scheduledWakes.mode,
				scheduledWakeContextCount: state.config.scheduledWakes.contextIds.length,
			}, null, 2));
			return;
		}
		if (command === "mcp-rehome-context") {
			if (!state.mcp) throw new Error("MCP is not configured");
			let hostdListenerRunning = false;
			try {
				await fetch(`http://${state.config.server.host}:${state.config.server.port}/health`, {
					signal: AbortSignal.timeout(500),
				});
				hostdListenerRunning = true;
			} catch {
				// A stopped loopback listener is required for this maintenance command.
			}
			if (hostdListenerRunning) {
				throw new Error("mcp-rehome-context requires the Hostd listener to be stopped");
			}
			const databaseStat = await stat(state.config.state.database);
			if (typeof process.getuid === "function" && process.getuid() !== databaseStat.uid) {
				throw new Error("mcp-rehome-context must run as the Hostd state owner");
			}
			const contextId = option("--context");
			if (!contextId) usage();
			const context = state.store.getContext(contextId);
			const target = context ? state.config.targetsById.get(context.targetId) : undefined;
			if (!target) throw new Error("unknown MCP context");
			console.log(JSON.stringify(
				await state.mcp.rehomeRelationshipContext(target, contextId),
				null,
				2,
			));
			return;
		}
		if (command === "mcp-handoff") {
			if (!state.mcp) throw new Error("MCP is not configured");
			const contextId = option("--context");
			const direction = option("--direction") || "bidirectional";
			const name = option("--name") || "MCP connection";
			if (!contextId) usage();
			const context = state.store.getContext(contextId);
			const target = context ? state.config.targetsById.get(context.targetId) : undefined;
			if (!target) throw new Error("unknown MCP context");
			console.log(JSON.stringify(state.mcp.createHandoff(target, contextId, {
				direction,
				name,
				server_url: option("--server-url"),
			}), null, 2));
			return;
		}
		if (command === "mcp-list") {
			if (!state.mcp) throw new Error("MCP is not configured");
			const contextId = option("--context");
			if (!contextId) usage();
			console.log(JSON.stringify(state.mcp.list(contextId), null, 2));
			return;
		}
		if (command === "mcp-revoke") {
			if (!state.mcp) throw new Error("MCP is not configured");
			const contextId = option("--context");
			const direction = option("--direction");
			const id = option("--id");
			if (!contextId || !direction || !id) usage();
			console.log(JSON.stringify(await state.mcp.revoke(contextId, { direction, id }), null, 2));
			return;
		}
		usage();
	} finally {
		state.store.close();
	}
}

main().catch((error) => {
	console.error(`troublemaker-hostd: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
