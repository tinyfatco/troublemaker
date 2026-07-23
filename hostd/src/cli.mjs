#!/usr/bin/env node
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.mjs";
import { InboxDaemon } from "./daemon.mjs";
import { GogGmail } from "./gmail.mjs";
import { importLegacyCheckpoint } from "./legacy.mjs";
import { ContextRouter } from "./router.mjs";
import { RuntimeManager } from "./runtime.mjs";
import { readRoutingKey } from "./security.mjs";
import { createHostServer } from "./server.mjs";
import { HostStore } from "./store.mjs";

function usage() {
	console.error(`Usage:
  troublemaker-hostd serve --config <path>
  troublemaker-hostd poll-once --config <path>
  troublemaker-hostd baseline --config <path>
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
	const gmail = new GogGmail(config.gmail);
	const router = new ContextRouter(config, store, routingKey);
	const runtime = new RuntimeManager(config, store);
	const daemon = new InboxDaemon({ config, store, gmail, router, runtime });
	return { config, store, gmail, router, runtime, daemon };
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

	let stopped = false;
	let timer;
	const stop = async (signal) => {
		if (stopped) return;
		stopped = true;
		if (timer) clearInterval(timer);
		console.log(`troublemaker-hostd: stopping after ${signal}`);
		await new Promise((resolvePromise) => server.close(resolvePromise));
		state.store.close();
	};
	process.once("SIGTERM", () => void stop("SIGTERM"));
	process.once("SIGINT", () => void stop("SIGINT"));

	const poll = async () => {
		try {
			await state.daemon.pollOnce();
		} catch (error) {
			console.error(
				"troublemaker-hostd: poll failed:",
				error instanceof Error ? error.message : String(error),
			);
			await stop("poll failure");
			process.exitCode = 1;
		}
	};
	await poll();
	if (!stopped) {
		timer = setInterval(
			() => void poll(),
			state.config.gmail.pollIntervalSeconds * 1000,
		);
		timer.unref();
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
			console.log(JSON.stringify(await state.daemon.pollOnce()));
			return;
		}
		if (command === "baseline") {
			console.log(JSON.stringify(await state.daemon.baseline()));
			return;
		}
		if (command === "import-legacy-checkpoint") {
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
			console.log(JSON.stringify(state.store.status(), null, 2));
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
