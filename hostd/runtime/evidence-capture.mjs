#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { inflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MAXIMUM_INPUT_BYTES = 32 * 1024;
const OUTPUT_DIRECTORY = "/data/.evidence";
const EVIDENCE_PORT = 43_119;

function fail(message) {
	throw new Error(message);
}

async function readInput() {
	const chunks = [];
	let length = 0;
	for await (const chunk of process.stdin) {
		length += chunk.length;
		if (length > MAXIMUM_INPUT_BYTES) fail("evidence input is too large");
		chunks.push(chunk);
	}
	let value;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		fail("evidence input is invalid");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("evidence input is invalid");
	const keys = Object.keys(value).sort();
	const expected = ["accountId", "artifactId", "exactQuote", "field", "grantId", "sourceSha256", "sourceUrl", "turnId", "userId"].sort();
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
		fail("evidence input is invalid");
	}
	for (const key of ["accountId", "artifactId", "grantId", "userId"]) {
		if (typeof value[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value[key])) fail("evidence input is invalid");
	}
	if (typeof value.turnId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.turnId)) fail("evidence input is invalid");
	if (typeof value.field !== "string" || value.field.length < 1 || value.field.length > 128) fail("evidence input is invalid");
	if (typeof value.exactQuote !== "string" || value.exactQuote.length < 1 || value.exactQuote.length > 4_000) fail("evidence input is invalid");
	if (typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) fail("evidence input is invalid");
	let source;
	try {
		source = new URL(value.sourceUrl);
	} catch {
		fail("evidence input is invalid");
	}
	if (source.protocol !== "https:" || source.username || source.password) fail("evidence input is invalid");
	return value;
}

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function evidencePage(input) {
	return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>Source evidence</title><style>
html{background:#f5f1e8;color:#181714;font:20px/1.5 system-ui,sans-serif}body{margin:0;padding:48px}main{max-width:1100px;margin:auto;background:#fffdf7;border:2px solid #181714;border-radius:18px;padding:42px;box-shadow:8px 8px 0 #181714}h1{font-size:24px;margin:0 0 28px}.label{font-size:14px;text-transform:uppercase;letter-spacing:.12em;color:#655f52;margin-top:24px}.value{overflow-wrap:anywhere}.quote{font:700 30px/1.35 Georgia,serif;margin:10px 0 28px}mark{background:#ffe45c;color:#181714;padding:4px 7px;border:2px solid #181714;border-radius:6px}.hash{font:14px/1.5 ui-monospace,monospace;color:#4b473e}</style></head>
<body><main><h1>Verified source quote</h1><div class="label">Source</div><div class="value">${escapeHtml(input.sourceUrl)}</div><div class="label">Field</div><div>${escapeHtml(input.field)}</div><div class="label">Exact quote</div><div class="quote"><mark id="verified-quote">${escapeHtml(input.exactQuote)}</mark></div><div class="label">Fetched source SHA-256</div><div class="hash">${input.sourceSha256}</div></main></body></html>`;
}

function chromiumWindow(value) {
	const candidates = [];
	(function collect(candidate, seen = new Set()) {
		if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
		seen.add(candidate);
		const pid = Number(candidate.pid);
		const windowId = Number(candidate.window_id ?? candidate.windowId ?? candidate.id);
		const title = [candidate.title, candidate.name, candidate.app, candidate.application]
			.filter((entry) => typeof entry === "string")
			.join(" ");
		if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(windowId) && windowId > 0 && /chromium/i.test(title)) {
			const width = Number(candidate.width ?? candidate.bounds?.width ?? 0);
			const height = Number(candidate.height ?? candidate.bounds?.height ?? 0);
			candidates.push({ pid, windowId, area: Math.max(0, width) * Math.max(0, height) });
		}
		for (const child of Array.isArray(candidate) ? candidate : Object.values(candidate)) collect(child, seen);
	})(value);
	return candidates.sort((left, right) => right.area - left.area)[0];
}

function paethPredictor(left, above, upperLeft) {
	const candidate = left + above - upperLeft;
	const leftDistance = Math.abs(candidate - left);
	const aboveDistance = Math.abs(candidate - above);
	const upperLeftDistance = Math.abs(candidate - upperLeft);
	if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
	if (aboveDistance <= upperLeftDistance) return above;
	return upperLeft;
}

function highlightedQuoteRect(bytes) {
	const { width, height } = pngDimensions(bytes);
	if (width < 1 || height < 1 || width * height > 20_000_000) fail("CUA screenshot dimensions were invalid");
	let offset = 8;
	let bitDepth;
	let colorType;
	let compression;
	let filter;
	let interlace;
	const compressed = [];
	while (offset + 12 <= bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const type = bytes.toString("ascii", offset + 4, offset + 8);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > bytes.length) fail("CUA screenshot PNG was truncated");
		if (type === "IHDR") {
			bitDepth = bytes[dataStart + 8];
			colorType = bytes[dataStart + 9];
			compression = bytes[dataStart + 10];
			filter = bytes[dataStart + 11];
			interlace = bytes[dataStart + 12];
		} else if (type === "IDAT") {
			compressed.push(bytes.subarray(dataStart, dataEnd));
		} else if (type === "IEND") {
			break;
		}
		offset = dataEnd + 4;
	}
	const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : undefined;
	if (bitDepth !== 8 || !channels || compression !== 0 || filter !== 0 || interlace !== 0 || compressed.length === 0) {
		fail("CUA screenshot PNG format was unsupported");
	}
	const rowLength = width * channels;
	const inflated = inflateSync(Buffer.concat(compressed));
	if (inflated.length !== (rowLength + 1) * height) fail("CUA screenshot PNG data length was invalid");
	let previous = Buffer.alloc(rowLength);
	let inputOffset = 0;
	let minimumX = width;
	let minimumY = height;
	let maximumX = -1;
	let maximumY = -1;
	let matchingPixels = 0;
	for (let y = 0; y < height; y += 1) {
		const filterType = inflated[inputOffset];
		inputOffset += 1;
		if (filterType > 4) fail("CUA screenshot PNG filter was invalid");
		const row = Buffer.allocUnsafe(rowLength);
		for (let index = 0; index < rowLength; index += 1) {
			const encoded = inflated[inputOffset + index];
			const left = index >= channels ? row[index - channels] : 0;
			const above = previous[index];
			const upperLeft = index >= channels ? previous[index - channels] : 0;
			let predictor = 0;
			if (filterType === 1) predictor = left;
			else if (filterType === 2) predictor = above;
			else if (filterType === 3) predictor = Math.floor((left + above) / 2);
			else if (filterType === 4) predictor = paethPredictor(left, above, upperLeft);
			row[index] = (encoded + predictor) & 255;
		}
		inputOffset += rowLength;
		for (let x = 0; x < width; x += 1) {
			const pixelOffset = x * channels;
			const red = row[pixelOffset];
			const green = row[pixelOffset + 1];
			const blue = row[pixelOffset + 2];
			const alpha = channels === 4 ? row[pixelOffset + 3] : 255;
			if (red >= 248 && green >= 220 && green <= 236 && blue >= 78 && blue <= 106 && alpha >= 248) {
				minimumX = Math.min(minimumX, x);
				minimumY = Math.min(minimumY, y);
				maximumX = Math.max(maximumX, x);
				maximumY = Math.max(maximumY, y);
				matchingPixels += 1;
			}
		}
		previous = row;
	}
	if (matchingPixels < 100 || maximumX < minimumX || maximumY < minimumY) fail("CUA screenshot omitted the quote highlight");
	const x = Math.max(0, minimumX - 2);
	const y = Math.max(0, minimumY - 2);
	const right = Math.min(width, maximumX + 3);
	const bottom = Math.min(height, maximumY + 3);
	if ((right - x) * (bottom - y) > width * height * 0.5) fail("CUA quote highlight was not bounded");
	return { x, y, width: right - x, height: bottom - y };
}

function pngDimensions(bytes) {
	if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		fail("CUA did not return a PNG screenshot");
	}
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function openCuaClient(manifestPath) {
	const client = new Client({ name: "troublemaker-evidence", version: "1" }, { capabilities: {} });
	const transport = new StdioClientTransport({
		command: "/usr/local/bin/cua-driver",
		args: ["mcp"],
		env: {
			...process.env,
			CUA_DRIVER_PERMISSION_MODE: "bounded",
			CUA_DRIVER_CAPABILITY_MANIFEST_FILE: manifestPath,
			CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "1",
		},
		stderr: "inherit",
	});
	await client.connect(transport);
	const call = async (name, args, timeout = 30_000) => await client.callTool(
		{ name, arguments: args },
		undefined,
		{
			signal: AbortSignal.timeout(timeout),
			timeout,
			maxTotalTimeout: timeout,
		},
	);
	return { client, call };
}

async function closeCuaClient(connection, session) {
	if (!connection) return;
	await connection.call("end_session", { session }, 10_000).catch(() => undefined);
	await connection.client.close().catch(() => undefined);
}

function actionManifest(window) {
	return `version: 3
expires_after: 15m
idle_timeout: 5m

allow:
  tools:
    - start_session
    - end_session
    - get_window_state
    - hotkey
    - type_text
    - press_key

resources:
  desktop:
    windows:
      - pid: ${window.pid}
        window_id: ${window.windowId}
    display: false
  files:
    write:
      - dir: /data/.evidence
        recursive: true
`;
}

async function main() {
	const input = await readInput();
	await mkdir(OUTPUT_DIRECTORY, { recursive: true, mode: 0o700 });
	const html = evidencePage(input);
	const server = createServer((request, response) => {
		if (request.method !== "GET" || request.url !== "/evidence") {
			response.writeHead(404, { "cache-control": "no-store" });
			response.end();
			return;
		}
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'",
			"x-content-type-options": "nosniff",
		});
		response.end(html);
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(EVIDENCE_PORT, "127.0.0.1", resolvePromise);
	});
	const discoverySession = `evidence-discovery-${input.artifactId}`.slice(0, 64);
	const actionSession = `evidence-action-${input.artifactId}`.slice(0, 64);
	const actionManifestPath = `${OUTPUT_DIRECTORY}/${input.artifactId}.manifest.yaml`;
	let discovery;
	let action;
	try {
		process.stderr.write("evidence_stage=connect\n");
		discovery = await openCuaClient("/etc/troublemaker/cua-evidence-capabilities.yaml");
		process.stderr.write("evidence_stage=session\n");
		await discovery.call("start_session", { session: discoverySession });
		process.stderr.write("evidence_stage=window\n");
		let window;
		for (let attempt = 0; attempt < 20 && !window; attempt += 1) {
			const windows = await discovery.call("list_windows", { on_screen_only: true });
			if (windows.isError) fail("CUA browser window discovery failed");
			window = chromiumWindow(windows.structuredContent ?? windows);
			if (!window) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
		}
		if (!window) fail("CUA browser window custody was unavailable");
		await closeCuaClient(discovery, discoverySession);
		discovery = undefined;
		await writeFile(actionManifestPath, actionManifest(window), { flag: "wx", mode: 0o400 });
		action = await openCuaClient(actionManifestPath);
		await action.call("start_session", { session: actionSession });
		const windowArgs = {
			session: actionSession,
			pid: window.pid,
			window_id: window.windowId,
			scope: "window",
			delivery_mode: "foreground",
		};
		process.stderr.write("evidence_stage=navigate\n");
		const address = await action.call("hotkey", { ...windowArgs, keys: ["ctrl", "l"] });
		if (address.isError) fail("CUA browser address focus failed");
		const typed = await action.call("type_text", {
			...windowArgs,
			text: `http://127.0.0.1:${EVIDENCE_PORT}/evidence`,
		});
		if (typed.isError) fail("CUA browser address entry failed");
		const submitted = await action.call("press_key", { ...windowArgs, key: "ENTER" });
		if (submitted.isError) fail("CUA browser navigation failed");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
		process.stderr.write("evidence_stage=capture\n");
		const screenshotPath = `${OUTPUT_DIRECTORY}/${input.artifactId}.png`;
		await unlink(screenshotPath).catch(() => undefined);
		const state = await action.call("get_window_state", {
			session: actionSession,
			pid: window.pid,
			window_id: window.windowId,
			include_screenshot: true,
			max_depth: 0,
			max_elements: 1,
			screenshot_out_file: screenshotPath,
		}, 60_000);
		if (state.isError) fail("CUA browser evidence capture failed");
		await chmod(screenshotPath, 0o600);
		const persisted = await readFile(screenshotPath);
		const viewport = pngDimensions(persisted);
		const rect = highlightedQuoteRect(persisted);
		const screenshotSha256 = createHash("sha256").update(persisted).digest("hex");
		const toolVersion = execFileSync("/usr/local/bin/cua-driver", ["--version"], { encoding: "utf8" }).trim();
		process.stderr.write("evidence_stage=complete\n");
		process.stdout.write(`${JSON.stringify({
			artifactId: input.artifactId,
			accountId: input.accountId,
			userId: input.userId,
			turnId: input.turnId,
			grantId: input.grantId,
			field: input.field,
			exactQuote: input.exactQuote,
			sourceUrl: input.sourceUrl,
			capturedAt: new Date().toISOString(),
			sourceSha256: input.sourceSha256,
			screenshotSha256,
			viewport: { ...viewport, deviceScaleFactor: 1 },
			highlight: { method: "selection", rects: [rect] },
			toolVersion,
			reviewState: "unreviewed",
			synthetic: false,
			screenshotPath,
		})}\n`);
	} finally {
		await closeCuaClient(action, actionSession);
		await closeCuaClient(discovery, discoverySession);
		await unlink(actionManifestPath).catch(() => undefined);
		await new Promise((resolvePromise) => server.close(resolvePromise));
	}
}

main().catch((error) => {
	process.stderr.write(`evidence capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
