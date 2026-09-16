#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GogGmail } from "./gmail.mjs";
import { GmailHistoryWatcher, HostdGmailHistoryClient } from "./gmail-history-watcher.mjs";
import { createGmailResidentBridgeServer, runtimeEmailDeliverer } from "./gmail-resident-bridge-server.mjs";

function requiredText(value, label, maximum = 4096) {
	const normalized = typeof value === "string" ? value.trim() : "";
	if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid`);
	return normalized;
}

function absolutePath(value, label) {
	const path = requiredText(value, label);
	if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
	return resolve(path);
}

function loopbackUrl(value, path, label) {
	const parsed = new URL(requiredText(value, label));
	if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(parsed.hostname)) {
		throw new Error(`${label} must use guest loopback HTTP`);
	}
	if (parsed.pathname !== path || parsed.search || parsed.hash) throw new Error(`${label} path is invalid`);
	return parsed.toString();
}

async function assertPrivateFile(path, label) {
	const metadata = await stat(path);
	if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
	if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must not be group/world accessible`);
	if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
		throw new Error(`${label} must be owned by the current user`);
	}
}

async function readPrivateText(path, label) {
	await assertPrivateFile(path, label);
	const value = (await readFile(path, "utf8")).trim();
	if (!value || Buffer.byteLength(value) > 16 * 1024) throw new Error(`${label} is empty or too large`);
	return value;
}

export async function loadGmailResidentBridgeConfig(path) {
	await assertPrivateFile(path, "bridge config");
	const parsed = JSON.parse(await readFile(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bridge config must be an object");
	const listenHost = parsed.listenHost ?? "127.0.0.1";
	if (!["127.0.0.1", "::1"].includes(listenHost)) throw new Error("resident bridge must listen on guest loopback only");
	const listenPort = Number(parsed.listenPort);
	if (!Number.isSafeInteger(listenPort) || listenPort < 1024 || listenPort > 65535) throw new Error("listen port is invalid");
	const headscaleNodeId = Number(parsed.headscaleNodeId);
	if (!Number.isSafeInteger(headscaleNodeId) || headscaleNodeId < 1) throw new Error("Headscale node ID is invalid");
	const activeIntervalMs = Number(parsed.activeIntervalMs ?? 2_000);
	if (activeIntervalMs !== 2_000) throw new Error("active Gmail History cadence must be exactly 2000ms");
	return {
		listenHost,
		listenPort,
		headscaleNodeId,
		runtimeIdentity: requiredText(parsed.runtimeIdentity, "runtime identity", 256),
		account: requiredText(parsed.account, "account", 512),
		contextId: requiredText(parsed.contextId, "context ID", 256),
		gogPath: absolutePath(parsed.gogPath, "gog path"),
		statePath: absolutePath(parsed.statePath, "state path"),
		identityTokenFile: absolutePath(parsed.identityTokenFile, "identity token file"),
		inboundTokenFile: absolutePath(parsed.inboundTokenFile, "inbound token file"),
		hostdIngressTokenFile: absolutePath(parsed.hostdIngressTokenFile, "Hostd ingress token file"),
		runtimeTokenFile: absolutePath(parsed.runtimeTokenFile, "runtime token file"),
		hostdIngressUrl: loopbackUrl(parsed.hostdIngressUrl, "/v1/inbound/gmail-history", "Hostd ingress URL"),
		runtimeUrl: loopbackUrl(parsed.runtimeUrl, "/email/inbound", "runtime URL"),
		activeIntervalMs,
	};
}

export async function startGmailResidentBridge(configPath, { environment = process.env } = {}) {
	const config = await loadGmailResidentBridgeConfig(configPath);
	const [identityToken, inboundToken, hostdIngressToken, runtimeToken] = await Promise.all([
		readPrivateText(config.identityTokenFile, "identity token file"),
		readPrivateText(config.inboundTokenFile, "inbound token file"),
		readPrivateText(config.hostdIngressTokenFile, "Hostd ingress token file"),
		readPrivateText(config.runtimeTokenFile, "runtime token file"),
	]);
	const gmail = new GogGmail({ account: config.account, gogPath: config.gogPath }, environment);
	const watcher = await new GmailHistoryWatcher({
		account: config.account,
		contextId: config.contextId,
		statePath: config.statePath,
		gmail,
		hostd: new HostdGmailHistoryClient({
			endpoint: config.hostdIngressUrl,
			token: hostdIngressToken,
		}),
		activeIntervalMs: config.activeIntervalMs,
	}).initialize();
	const server = createGmailResidentBridgeServer({
		contextId: config.contextId,
		identity: {
			runtimeIdentity: config.runtimeIdentity,
			headscaleNodeId: config.headscaleNodeId,
		},
		identityToken,
		inboundToken,
		runtimeDeliver: runtimeEmailDeliverer({ url: config.runtimeUrl, token: runtimeToken }),
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(config.listenPort, config.listenHost, resolvePromise);
	});
	watcher.start();
	console.log(`gmail-resident-bridge: listening on ${config.listenHost}:${config.listenPort}`);
	return { server, watcher, config };
}

async function main() {
	const configPath = process.argv[2];
	if (!configPath) throw new Error("usage: gmail-resident-bridge-cli.mjs /absolute/path/to/config.json");
	const { server, watcher } = await startGmailResidentBridge(absolutePath(configPath, "config path"));
	const stop = async () => {
		await watcher.stop();
		await server.waitForActive();
		await new Promise((resolvePromise) => server.close(resolvePromise));
		process.exit(0);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(`gmail-resident-bridge: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
