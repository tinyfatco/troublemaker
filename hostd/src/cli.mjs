#!/usr/bin/env node
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { ChannelControlNotifier } from "./channel-control-notifier.mjs";
import { loadConfig } from "./config.mjs";
import { InboxDaemon } from "./daemon.mjs";
import { GogGmail } from "./gmail.mjs";
import { importLegacyCheckpoint } from "./legacy.mjs";
import { MattermostProvisioner } from "./mattermost.mjs";
import { MattermostGateway } from "./mattermost-gateway.mjs";
import { PhoneGateway } from "./phone.mjs";
import { RocketChatGateway } from "./rocket-chat-gateway.mjs";
import { RocketChatProvisioner } from "./rocket-chat.mjs";
import { ZulipGateway } from "./zulip-gateway.mjs";
import { ZulipProvisioner } from "./zulip.mjs";
import { ContextRouter } from "./router.mjs";
import { RuntimeManager } from "./runtime.mjs";
import { readRoutingKey, stablePrivateKey } from "./security.mjs";
import { EventScheduler } from "./scheduler.mjs";
import { ScheduledWakeManager } from "./scheduled-wakes.mjs";
import { createHostServer } from "./server.mjs";
import { HostStore } from "./store.mjs";

function usage() {
	console.error(`Usage:
  troublemaker-hostd serve --config <path>
  troublemaker-hostd poll-once --config <path>
  troublemaker-hostd baseline --config <path>
  troublemaker-hostd provision-mattermost --config <path>
  troublemaker-hostd provision-rocketchat --config <path>
  troublemaker-hostd provision-zulip --config <path>
  troublemaker-hostd import-legacy-checkpoint --config <path> --checkpoint <path> --key-file <path>
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
	const runtime = new RuntimeManager(config, store, { mattermost, rocketChat, zulip, routingKey });
	const scheduler = new EventScheduler({ config, store, runtime });
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
	const zulipGateway = zulip
		? new ZulipGateway({ config, store, provisioner: zulip, scheduler })
		: undefined;
	const phoneGateway = config.phone
		? new PhoneGateway({
			config,
			store,
			router,
			routingKey,
			scheduler,
			controlNotifier,
		})
		: undefined;
	return {
		config,
		store,
		gmail,
		routingKey,
		router,
		runtime,
		mattermost,
		rocketChat,
		zulip,
		controlNotifier,
		scheduler,
		scheduledWakes,
		mattermostGateway,
		rocketChatGateway,
		zulipGateway,
		phoneGateway,
		daemon,
	};
}

async function serve(configPath) {
	const state = await components(configPath);
	const server = createHostServer(state);
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(state.config.server.port, state.config.server.host, resolvePromise);
	});
	console.log(
		`troublemaker-hostd: listening on ${state.config.server.host}:${state.config.server.port}`,
	);
	await state.scheduler.start();
	await state.mattermostGateway?.start();
	await state.rocketChatGateway?.start();
	await state.zulipGateway?.start();
	await state.controlNotifier?.start();
	await state.phoneGateway?.start();
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
		await state.zulipGateway?.stop();
		await state.phoneGateway?.stop();
		await state.controlNotifier?.stop();
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
				...state.store.status(state.config.scheduler.maxConcurrent),
				scheduledWakeMode: state.config.scheduledWakes.mode,
				scheduledWakeContextCount: state.config.scheduledWakes.contextIds.length,
			}, null, 2));
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
