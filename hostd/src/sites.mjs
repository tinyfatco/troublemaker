import { execFile } from "node:child_process";
import {
	createHash,
	createPrivateKey,
	sign as signBytes,
	timingSafeEqual,
} from "node:crypto";
import { gzipSync } from "node:zlib";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BRANCH_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\]/;
const SOURCE_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const IDEMPOTENCY_RE = /^site_deploy:[0-9a-f]{64}$/;

export class HostSitesError extends Error {
	constructor(status, code) {
		super(code);
		this.status = status;
		this.code = code;
	}
}

function base64urlJson(value) {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function normalizeGitBranch(value) {
	const branch = typeof value === "string" ? value.trim() : "";
	if (
		!branch
		|| branch.length > 240
		|| BRANCH_FORBIDDEN.test(branch)
		|| branch.startsWith("/")
		|| branch.endsWith("/")
		|| branch.startsWith(".")
		|| branch.endsWith(".")
		|| branch.includes("..")
		|| branch.includes("@{")
		|| branch.split("/").some((part) => !part || part.endsWith(".lock"))
	) {
		throw new HostSitesError(400, "git_branch_invalid");
	}
	return branch;
}

export function branchPreviewLabel(value) {
	const branch = normalizeGitBranch(value);
	const readable = branch
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "branch";
	if (branch === readable && readable.length <= 63) return readable;
	const digest = createHash("sha256").update(branch, "utf8").digest("hex").slice(0, 12);
	const head = readable.slice(0, 63 - digest.length - 1).replace(/-+$/g, "") || "branch";
	return `${head}-${digest}`;
}

export function branchPreviewHostname(siteSlug, branch, apex = "business.tinyfat.dev") {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,53}[a-z0-9])?$/.test(siteSlug)) {
		throw new HostSitesError(500, "configured_site_slug_invalid");
	}
	const hostname = `${branchPreviewLabel(branch)}.${siteSlug}.${String(apex).replace(/^\.+|\.+$/g, "")}`;
	if (hostname.length > 253) throw new HostSitesError(500, "configured_preview_hostname_too_long");
	return hostname;
}

export function scopedScriptName(siteId, branch) {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(siteId)) {
		throw new HostSitesError(500, "configured_site_id_invalid");
	}
	const branchDigest = createHash("sha256").update(normalizeGitBranch(branch), "utf8").digest("hex").slice(0, 20);
	return `s-${siteId.replace(/-/g, "").toLowerCase()}-${branchDigest}`;
}

async function gitOutput(repository, args, failureCode) {
	try {
		const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
			},
		});
		return stdout.trim();
	} catch {
		throw new HostSitesError(409, failureCode);
	}
}

export async function inspectWorkspaceGitSource(workspace, requestedBranch) {
	const workspaceReal = await realpath(workspace);
	const repository = await gitOutput(workspaceReal, ["rev-parse", "--show-toplevel"], "source_repository_required");
	let repositoryReal;
	try {
		repositoryReal = await realpath(repository);
	} catch {
		throw new HostSitesError(409, "source_repository_required");
	}
	if (repositoryReal !== workspaceReal) throw new HostSitesError(409, "source_repository_root_mismatch");
	const branch = await gitOutput(repositoryReal, ["symbolic-ref", "--quiet", "--short", "HEAD"], "source_detached_head");
	if (branch !== normalizeGitBranch(requestedBranch)) throw new HostSitesError(409, "source_branch_mismatch");
	const sha = (await gitOutput(repositoryReal, ["rev-parse", "--verify", "HEAD^{commit}"], "source_commit_required")).toLowerCase();
	if (!SOURCE_SHA_RE.test(sha)) throw new HostSitesError(409, "source_commit_invalid");
	const dirty = await gitOutput(repositoryReal, ["status", "--porcelain=v1", "--untracked-files=all", "--", "."], "source_status_unavailable");
	if (dirty) throw new HostSitesError(409, "source_repository_dirty");
	return { branch, sha, repository: repositoryReal };
}

export function signDeployCapability(config, claims, nowSeconds = Math.floor(Date.now() / 1000)) {
	const header = {
		alg: "EdDSA",
		typ: "JWT",
		kid: config.capabilityKeyId,
	};
	const payload = {
		iss: config.capabilityIssuer,
		aud: config.capabilityAudience,
		iat: nowSeconds,
		nbf: nowSeconds - 2,
		exp: nowSeconds + config.capabilityTtlSeconds,
		...claims,
	};
	const encoded = `${base64urlJson(header)}.${base64urlJson(payload)}`;
	const key = createPrivateKey(config.capabilityPrivateKey);
	const signature = signBytes(null, Buffer.from(encoded, "ascii"), key).toString("base64url");
	return `${encoded}.${signature}`;
}

function within(parent, child) {
	return child === parent || child.startsWith(`${parent}${sep}`);
}

function tarOctal(value, length) {
	const text = Math.max(0, value).toString(8);
	if (text.length > length - 1) throw new HostSitesError(400, "artifact_tar_value_too_large");
	return `${text.padStart(length - 1, "0")}\0`;
}

function writeAscii(buffer, offset, length, value) {
	const encoded = Buffer.from(value, "ascii");
	if (encoded.length > length) throw new HostSitesError(400, "artifact_path_too_long");
	encoded.copy(buffer, offset);
}

function tarPathParts(path) {
	const bytes = Buffer.byteLength(path, "utf8");
	if (bytes <= 100) return { name: path, prefix: "" };
	const parts = path.split("/");
	for (let split = parts.length - 1; split > 0; split--) {
		const prefix = parts.slice(0, split).join("/");
		const name = parts.slice(split).join("/");
		if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
			return { name, prefix };
		}
	}
	throw new HostSitesError(400, "artifact_path_too_long");
}

function tarHeader(path, size) {
	const header = Buffer.alloc(512);
	const { name, prefix } = tarPathParts(path);
	writeAscii(header, 0, 100, name);
	writeAscii(header, 100, 8, tarOctal(0o644, 8));
	writeAscii(header, 108, 8, tarOctal(0, 8));
	writeAscii(header, 116, 8, tarOctal(0, 8));
	writeAscii(header, 124, 12, tarOctal(size, 12));
	writeAscii(header, 136, 12, tarOctal(0, 12));
	header.fill(0x20, 148, 156);
	header[156] = "0".charCodeAt(0);
	writeAscii(header, 257, 6, "ustar\0");
	writeAscii(header, 263, 2, "00");
	writeAscii(header, 345, 155, prefix);
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
	return header;
}

async function collectArtifactFiles(root, limits, hooks = {}) {
	const files = [];
	let totalBytes = 0;
	async function walk(directory) {
		const directoryReal = await realpath(directory);
		if (!within(root, directoryReal)) throw new HostSitesError(400, "artifact_directory_outside_workspace");
		const entries = [];
		const handle = await opendir(directoryReal);
		for await (const entry of handle) entries.push(entry);
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const absolute = resolve(directoryReal, entry.name);
			const metadata = await lstat(absolute);
			await hooks.afterLstat?.({ absolute, metadata });
			if (metadata.isSymbolicLink()) throw new HostSitesError(400, "artifact_links_forbidden");
			if (metadata.isDirectory()) {
				await walk(absolute);
				continue;
			}
			if (!metadata.isFile()) throw new HostSitesError(400, "artifact_special_file_forbidden");
			if (files.length + 1 > limits.maximumFiles) throw new HostSitesError(413, "artifact_file_count_exceeded");
			const path = relative(root, absolute).split(sep).join("/");
			if (!path || path.startsWith("../") || path.includes("/../") || path.includes("\0")) {
				throw new HostSitesError(400, "artifact_path_invalid");
			}

			let descriptor;
			try {
				descriptor = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
			} catch (error) {
				if (error?.code === "ELOOP") throw new HostSitesError(400, "artifact_links_forbidden");
				throw error;
			}
			try {
				await hooks.afterOpen?.({ absolute, descriptor });
				const opened = await descriptor.stat();
				if (!opened.isFile()) throw new HostSitesError(400, "artifact_special_file_forbidden");
				if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
					throw new HostSitesError(409, "artifact_changed_before_snapshot");
				}
				const descriptorPath = await realpath(`/proc/self/fd/${descriptor.fd}`);
				if (!within(root, descriptorPath)) throw new HostSitesError(400, "artifact_file_outside_workspace");
				if (opened.size > limits.maximumFileBytes) throw new HostSitesError(413, "artifact_file_too_large");
				const content = await descriptor.readFile();
				const afterRead = await descriptor.stat();
				if (content.length !== afterRead.size || afterRead.size !== opened.size) {
					throw new HostSitesError(409, "artifact_changed_during_snapshot");
				}
				if (content.length > limits.maximumFileBytes) throw new HostSitesError(413, "artifact_file_too_large");
				totalBytes += content.length;
				if (totalBytes > limits.maximumArtifactBytes) throw new HostSitesError(413, "artifact_too_large");
				files.push({ path, content, size: content.length });
			} finally {
				await descriptor.close();
			}
		}
	}
	await walk(root);
	if (files.length === 0) throw new HostSitesError(400, "artifact_empty");
	return files;
}

export async function buildWorkspaceArtifact(workspace, requestedDirectory, limits, hooks = {}) {
	const rawDirectory = typeof requestedDirectory === "string" ? requestedDirectory.trim() : "";
	if (
		!rawDirectory
		|| rawDirectory.length > 240
		|| rawDirectory.includes("\0")
		|| rawDirectory.split(/[\\/]/).some((part) => part === "..")
	) {
		throw new HostSitesError(400, "artifact_directory_invalid");
	}
	const workspaceReal = await realpath(workspace);
	const candidate = resolve(workspaceReal, rawDirectory);
	if (!within(workspaceReal, candidate)) throw new HostSitesError(400, "artifact_directory_outside_workspace");
	let root;
	try {
		root = await realpath(candidate);
	} catch (error) {
		if (error?.code === "ENOENT") throw new HostSitesError(404, "artifact_directory_not_found");
		throw error;
	}
	if (!within(workspaceReal, root)) throw new HostSitesError(400, "artifact_directory_outside_workspace");
	const rootStat = await stat(root);
	if (!rootStat.isDirectory()) throw new HostSitesError(400, "artifact_directory_required");

	const files = await collectArtifactFiles(root, limits, hooks);
	const chunks = [];
	for (const file of files) {
		chunks.push(tarHeader(file.path, file.content.length), file.content);
		const padding = file.content.length % 512 === 0 ? 0 : 512 - (file.content.length % 512);
		if (padding) chunks.push(Buffer.alloc(padding));
	}
	chunks.push(Buffer.alloc(1024));
	const tarball = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
	if (tarball.length > limits.maximumCompressedBytes) {
		throw new HostSitesError(413, "artifact_compressed_too_large");
	}
	return {
		body: tarball,
		sha256: createHash("sha256").update(tarball).digest("hex"),
		fileCount: files.length,
		uncompressedBytes: files.reduce((sum, file) => sum + file.size, 0),
		compressedBytes: tarball.length,
	};
}

function findProjectBinding(config, scope) {
	const principal = config.routing.knownPrincipals.find((candidate) => candidate.email === scope.emailAddress);
	const project = principal?.projects.find((candidate) => candidate.slug === scope.projectSlug);
	return project?.siteDeployment;
}

function branchAllowed(binding, branch) {
	return binding.allowedBranches.includes("*") || binding.allowedBranches.includes(branch);
}

function safeContextDirectory(target, contextId) {
	return resolve(target.contextsDirectory, contextId.replace(/[^a-z0-9_.-]/gi, "_"));
}

export class HostSites {
	constructor({ config, store, fetch: request = fetch, now = () => Date.now() }) {
		this.config = config;
		this.store = store;
		this.request = request;
		this.now = now;
	}

	async deploy(target, contextId, body) {
		if (!this.config.sites) throw new HostSitesError(503, "sites_unavailable");
		const scope = this.store.getContextScope(contextId, target.id);
		if (!scope) throw new HostSitesError(403, "site_context_unbound");
		const binding = findProjectBinding(this.config, scope);
		if (!binding) throw new HostSitesError(403, "site_context_unbound");

		const branch = normalizeGitBranch(body.branch);
		if (!branchAllowed(binding, branch)) throw new HostSitesError(403, "site_branch_denied");
		const artifactKind = body.artifact_kind === "static" || body.artifact_kind === "worker"
			? body.artifact_kind
			: "";
		if (!artifactKind) throw new HostSitesError(400, "artifact_kind_invalid");
		if (!binding.artifactKinds.includes(artifactKind)) throw new HostSitesError(403, "artifact_kind_denied");
		const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
		if (!IDEMPOTENCY_RE.test(idempotencyKey)) throw new HostSitesError(400, "idempotency_key_invalid");
		const message = typeof body.message === "string" ? body.message.trim() : "";
		if (message.length > 500) throw new HostSitesError(400, "deploy_message_too_long");

		const workspace = resolve(safeContextDirectory(target, contextId), "workspace");
		const sourceBefore = await inspectWorkspaceGitSource(workspace, branch);
		const artifact = await buildWorkspaceArtifact(workspace, body.directory, this.config.sites);
		const sourceAfter = await inspectWorkspaceGitSource(workspace, branch);
		if (sourceAfter.sha !== sourceBefore.sha || sourceAfter.repository !== sourceBefore.repository) {
			throw new HostSitesError(409, "source_changed_during_snapshot");
		}
		const sourceSha = sourceBefore.sha;
		const branchLabel = branchPreviewLabel(branch);
		const hostname = branchPreviewHostname(binding.siteSlug, branch, this.config.sites.previewApex);
		const nowSeconds = Math.floor(this.now() / 1000);
		const jti = createHash("sha256")
			.update(idempotencyKey)
			.update("\0")
			.update(artifact.sha256)
			.update("\0")
			.update(binding.siteId)
			.digest("hex");
		const contextReference = createHash("sha256").update(contextId).digest("hex");
		const capability = signDeployCapability(this.config.sites, {
			sub: `site:${binding.siteId}`,
			jti,
			deployment_grant_id: binding.grantId,
			customer_id: binding.customerId,
			project_id: binding.projectId,
			site_id: binding.siteId,
			site_slug: binding.siteSlug,
			environment: "preview",
			preview_slot: `branch:${branch}`,
			git_branch: branch,
			git_sha: sourceSha,
			deploy_message: message,
			branch_label: branchLabel,
			hostname,
			preview_apex: this.config.sites.previewApex,
			namespace: this.config.sites.previewNamespace,
			artifact_kind: artifactKind,
			artifact_sha256: artifact.sha256,
			idempotency_key: idempotencyKey,
			actor_ref: `hostd-context:${contextReference}`,
		}, nowSeconds);

		const response = await this.request(`${this.config.sites.publishUrl}/v1/scoped-deploy`, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${capability}`,
				"content-type": "application/gzip",
				"x-artifact-sha256": artifact.sha256,
				"x-git-branch": branch,
				"x-idempotency-key": idempotencyKey,
				"x-git-sha": sourceSha,
				...(message ? { "x-deploy-message": message } : {}),
			},
			body: artifact.body,
			signal: AbortSignal.timeout(120_000),
		});
		const responseText = await response.text();
		let result;
		try {
			result = JSON.parse(responseText);
		} catch {
			throw new HostSitesError(502, "sites_publish_invalid_response");
		}
		if (!response.ok) {
			const code = typeof result?.error === "string" ? result.error : "sites_publish_rejected";
			throw new HostSitesError(response.status >= 400 && response.status < 500 ? response.status : 502, code);
		}
		const expectedReceipt = {
			site: binding.siteSlug,
			site_id: binding.siteId,
			deployment_grant_id: binding.grantId,
			customer_id: binding.customerId,
			project_id: binding.projectId,
			environment: "preview",
			preview_slot: `branch:${branch}`,
			git_branch: branch,
			git_sha: sourceSha,
			branch_label: branchLabel,
			hostname,
			namespace: this.config.sites.previewNamespace,
			artifact_kind: artifactKind,
			idempotency_key: idempotencyKey,
			url: `https://${hostname}/`,
		};
		for (const [key, expected] of Object.entries(expectedReceipt)) {
			if (result?.[key] !== expected) throw new HostSitesError(502, "sites_publish_receipt_scope_mismatch");
		}
		if (
			typeof result?.scriptName !== "string"
			|| result.scriptName !== scopedScriptName(binding.siteId, branch)
			|| typeof result?.deploymentId !== "string"
			|| !result.deploymentId
		) {
			throw new HostSitesError(502, "sites_publish_receipt_identity_invalid");
		}
		const receiptDigest = typeof result?.artifact_sha256 === "string"
			? Buffer.from(result.artifact_sha256)
			: Buffer.alloc(0);
		const expectedDigest = Buffer.from(artifact.sha256);
		if (
			receiptDigest.length !== expectedDigest.length
			|| !timingSafeEqual(receiptDigest, expectedDigest)
		) {
			throw new HostSitesError(502, "sites_publish_receipt_digest_mismatch");
		}
		return {
			ok: true,
			site: binding.siteSlug,
			site_id: binding.siteId,
			environment: "preview",
			git_branch: branch,
			branch_label: branchLabel,
			hostname,
			artifact_kind: artifactKind,
			artifact_sha256: artifact.sha256,
			files: artifact.fileCount,
			bytes: artifact.uncompressedBytes,
			deployment: result,
		};
	}
}
