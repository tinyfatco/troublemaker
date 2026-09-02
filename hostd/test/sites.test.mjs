import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify as verifyBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { ContextRouter } from "../src/router.mjs";
import { siteDeploymentBinding } from "../src/runtime.mjs";
import { createHostServer } from "../src/server.mjs";
import { contextCapability, stablePrivateKey } from "../src/security.mjs";
import {
	branchPreviewHostname,
	branchPreviewLabel,
	buildWorkspaceArtifact,
	HostSites,
	HostSitesError,
	inspectWorkspaceGitSource,
	normalizeGitBranch,
	scopedScriptName,
} from "../src/sites.mjs";
import { HostStore } from "../src/store.mjs";

const LIMITS = {
	maximumFiles: 20,
	maximumFileBytes: 1024 * 1024,
	maximumArtifactBytes: 2 * 1024 * 1024,
	maximumCompressedBytes: 1024 * 1024,
};

function decodeCapability(token) {
	const [header, payload, signature] = token.split(".");
	return {
		header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
		payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
		signed: Buffer.from(`${header}.${payload}`, "ascii"),
		signature: Buffer.from(signature, "base64url"),
	};
}

function git(workspace, ...args) {
	return execFileSync("git", ["-C", workspace, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	}).trim();
}

function commitWorkspace(workspace, branch) {
	git(workspace, "init", "-b", branch);
	git(workspace, "config", "user.name", "Hostd Test");
	git(workspace, "config", "user.email", "hostd@example.com");
	git(workspace, "add", "--all");
	git(workspace, "commit", "-m", "Test source");
	return git(workspace, "rev-parse", "HEAD");
}

function artifactPaths(body) {
	const archive = gunzipSync(body);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const paths = [];
	for (let offset = 0; offset + 512 <= archive.length;) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const readField = (start, length) => decoder.decode(header.subarray(start, start + length)).split("\0", 1)[0];
		const name = readField(0, 100);
		const prefix = readField(345, 155);
		paths.push(prefix ? `${prefix}/${name}` : name);
		const size = Number.parseInt(readField(124, 12).trim() || "0", 8);
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return paths;
}

test("Pages-style branch labels are readable, exact-branch collision safe, and bounded", () => {
	assert.equal(normalizeGitBranch("main"), "main");
	assert.equal(branchPreviewLabel("main"), "main");
	assert.match(branchPreviewLabel("feature/example"), /^feature-example-[0-9a-f]{12}$/);
	assert.notEqual(branchPreviewLabel("feature/example"), branchPreviewLabel("feature-example"));
	assert.equal(
		branchPreviewHostname("example-business", "feature/example"),
		`${branchPreviewLabel("feature/example")}.example-business.tinyfat.dev`,
	);
	assert(branchPreviewLabel(`feature/${"long-name-".repeat(20)}`).length <= 63);
	assert.throws(
		() => branchPreviewHostname("example-business", "main", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(40)}.dev`),
		(error) => error instanceof HostSitesError && error.code === "configured_preview_hostname_too_long",
	);
	for (const invalid of ["", "../main", "main..next", "main.lock", "bad branch", "bad@{branch", "/main"]) {
		assert.throws(() => normalizeGitBranch(invalid), (error) => error instanceof HostSitesError && error.code === "git_branch_invalid");
	}
});

test("Hostd derives Git provenance from one clean attached workspace repository", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-sites-git-"));
	const workspace = join(directory, "workspace");
	try {
		await mkdir(join(workspace, "dist"), { recursive: true });
		await writeFile(join(workspace, "dist", "index.html"), "<!doctype html><title>Git source</title>\n");
		const sourceSha = commitWorkspace(workspace, "feature/example");
		assert.deepEqual(await inspectWorkspaceGitSource(workspace, "feature/example"), {
			branch: "feature/example",
			sha: sourceSha,
			repository: await realpath(workspace),
		});
		await writeFile(join(workspace, "untracked.txt"), "dirty\n");
		await assert.rejects(
			inspectWorkspaceGitSource(workspace, "feature/example"),
			(error) => error instanceof HostSitesError && error.code === "source_repository_dirty",
		);
		await rm(join(workspace, "untracked.txt"));
		await assert.rejects(
			inspectWorkspaceGitSource(workspace, "main"),
			(error) => error instanceof HostSitesError && error.code === "source_branch_mismatch",
		);
		git(workspace, "checkout", "--detach", "HEAD");
		await assert.rejects(
			inspectWorkspaceGitSource(workspace, "feature/example"),
			(error) => error instanceof HostSitesError && error.code === "source_detached_head",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("workspace artifacts are deterministic and reject escaping links", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-sites-artifact-"));
	const workspace = join(directory, "workspace");
	try {
		await mkdir(join(workspace, "dist", "assets"), { recursive: true });
		await writeFile(join(workspace, "dist", "index.html"), "<!doctype html><title>Example</title>\n");
		await writeFile(join(workspace, "dist", "assets", "app.js"), "console.log('example')\n");
		await writeFile(join(workspace, "dist", "assets", "café.png"), "fake image\n");
		const first = await buildWorkspaceArtifact(workspace, "dist", LIMITS);
		const second = await buildWorkspaceArtifact(workspace, "dist", LIMITS);
		assert.equal(first.sha256, second.sha256);
		assert.equal(first.fileCount, 3);
		assert.deepEqual(artifactPaths(first.body), ["assets/app.js", "assets/café.png", "index.html"]);
		assert(first.compressedBytes > 0);

		const outside = join(directory, "outside.txt");
		const canonicalDist = await realpath(join(workspace, "dist"));
		const raced = join(canonicalDist, "race.txt");
		await writeFile(outside, "outside workspace");
		await writeFile(raced, "inside workspace");
		await assert.rejects(
			buildWorkspaceArtifact(workspace, "dist", LIMITS, {
				async afterLstat({ absolute }) {
					if (absolute !== raced) return;
					await rm(raced);
					await symlink(outside, raced);
				},
			}),
			(error) => error instanceof HostSitesError && ["artifact_links_forbidden", "artifact_file_outside_workspace"].includes(error.code),
		);
		await rm(raced, { force: true });

		const swapped = join(canonicalDist, "swapped.txt");
		const replacement = join(canonicalDist, "replacement.txt");
		await writeFile(swapped, "original");
		await writeFile(replacement, "replacement");
		await assert.rejects(
			buildWorkspaceArtifact(workspace, "dist", LIMITS, {
				async afterLstat({ absolute }) {
					if (absolute === swapped) await rename(replacement, swapped);
				},
			}),
			(error) => error instanceof HostSitesError && error.code === "artifact_changed_before_snapshot",
		);
		await rm(swapped, { force: true });

		const growing = join(canonicalDist, "growing.txt");
		await writeFile(growing, "small");
		await assert.rejects(
			buildWorkspaceArtifact(workspace, "dist", { ...LIMITS, maximumFileBytes: 8 }, {
				async afterLstat({ absolute }) {
					if (absolute === growing) await writeFile(growing, "this file grew beyond the checked limit");
				},
			}),
			(error) => error instanceof HostSitesError && error.code === "artifact_file_too_large",
		);
		await rm(growing, { force: true });

		await symlink("/etc/passwd", join(workspace, "dist", "escape"));
		await assert.rejects(
			buildWorkspaceArtifact(workspace, "dist", LIMITS),
			(error) => error instanceof HostSitesError && error.code === "artifact_links_forbidden",
		);
		await assert.rejects(
			buildWorkspaceArtifact(workspace, "../", LIMITS),
			(error) => error instanceof HostSitesError && error.code === "artifact_directory_invalid",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Hostd signs and proxies one exact project, branch, artifact, and idempotency key", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-sites-deploy-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const target = {
		id: "front-desk",
		driver: "oci",
		inboundToken: "fake-inbound-secret",
		outboundToken: "fake-outbound-secret",
		contextsDirectory: join(directory, "contexts"),
	};
	const binding = {
		grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		siteId: "11111111-1111-4111-8111-111111111111",
		siteSlug: "example-business",
		artifactKinds: ["static", "worker"],
		allowedBranches: ["*"],
	};
	const config = {
		sites: {
			publishUrl: "https://publish.example.com",
			previewApex: "tinyfat.dev",
			previewNamespace: "example-sites-preview",
			productionNamespace: "example-sites-production",
			capabilityPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			capabilityKeyId: "hostd-example-1",
			capabilityIssuer: "troublemaker-hostd",
			capabilityAudience: "tinyfat-sites-publish",
			capabilityTtlSeconds: 60,
			...LIMITS,
		},
		routing: {
			actorTarget: "front-desk",
			knownPrincipals: [{
				email: "owner@example.com",
				projects: [{ slug: "website", name: "Example website", siteDeployment: binding }],
			}],
		},
		targetsById: new Map([[target.id, target]]),
	};
	const router = new ContextRouter(config, store, Buffer.alloc(32, 8));
	const owner = router.resolve({ source: "gmail", threadId: "thread-owner", sender: "owner@example.com" });
	store.ensureProject(owner.principalHash, "website", "Example website");
	store.bindRoute({
		source: "gmail",
		providerThreadId: "thread-website",
		principalHash: owner.principalHash,
		projectSlug: "website",
		targetId: target.id,
		contextId: `${target.id}:${owner.principalHash}:website`,
	});
	const contextId = `${target.id}:${owner.principalHash}:website`;
	const workspace = join(target.contextsDirectory, contextId.replace(/[^a-z0-9_.-]/gi, "_"), "workspace");
	await mkdir(join(workspace, "dist"), { recursive: true });
	await writeFile(join(workspace, "dist", "index.html"), "<!doctype html><title>Scoped</title>\n");
	const sourceSha = commitWorkspace(workspace, "feature/example");
	let observed;
	let receiptOverrides = {};
	const service = new HostSites({
		config,
		store,
		now: () => 1_800_000_000_000,
		fetch: async (url, init) => {
			const token = new Headers(init.headers).get("authorization").replace(/^Bearer\s+/, "");
			const capability = decodeCapability(token);
			observed = { url, init, capability };
			assert.equal(capability.header.alg, "EdDSA");
			assert.equal(capability.header.kid, "hostd-example-1");
			assert.equal(verifyBytes(null, capability.signed, publicKey, capability.signature), true);
			assert.equal(capability.payload.deployment_grant_id, binding.grantId);
			assert.equal(capability.payload.customer_id, binding.customerId);
			assert.equal(capability.payload.project_id, binding.projectId);
			assert.equal(capability.payload.site_id, binding.siteId);
			assert.equal(capability.payload.git_branch, "feature/example");
			assert.equal(capability.payload.git_sha, sourceSha);
			assert.equal(capability.payload.hostname, `${branchPreviewLabel("feature/example")}.example-business.tinyfat.dev`);
			assert.equal(capability.payload.namespace, "example-sites-preview");
			assert.equal(capability.payload.environment, "preview");
			assert.equal(capability.payload.artifact_kind, "static");
			assert.equal(capability.payload.exp - capability.payload.iat, 60);
			assert.equal(new Headers(init.headers).get("x-artifact-sha256"), capability.payload.artifact_sha256);
			return new Response(JSON.stringify({
				ok: true,
				site: binding.siteSlug,
				site_id: binding.siteId,
				deployment_grant_id: binding.grantId,
				customer_id: binding.customerId,
				project_id: binding.projectId,
				environment: "preview",
				preview_slot: "branch:feature/example",
				git_branch: "feature/example",
				git_sha: sourceSha,
				branch_label: capability.payload.branch_label,
				hostname: capability.payload.hostname,
				namespace: "example-sites-preview",
				artifact_kind: "static",
				artifact_sha256: capability.payload.artifact_sha256,
				idempotency_key: capability.payload.idempotency_key,
				url: `https://${capability.payload.hostname}/`,
				scriptName: scopedScriptName(binding.siteId, "feature/example"),
				deploymentId: "22222222-2222-4222-8222-222222222222",
				...receiptOverrides,
			}), { status: 200, headers: { "content-type": "application/json" } });
		},
	});
	try {
		const result = await service.deploy(target, contextId, {
			branch: "feature/example",
			directory: "dist",
			artifact_kind: "static",
			idempotency_key: `site_deploy:${"a".repeat(64)}`,
			message: "Example preview",
		});
		assert.equal(result.ok, true);
		assert.equal(result.site_id, binding.siteId);
		assert.equal(result.git_branch, "feature/example");
		assert.match(result.hostname, /^feature-example-[0-9a-f]{12}\.example-business\.tinyfat\.dev$/);
		assert.equal(observed.url, "https://publish.example.com/v1/scoped-deploy");
		assert.equal(new Headers(observed.init.headers).has("x-site-id"), false, "site authority stays signed, not caller-selected");
		assert(Buffer.byteLength(observed.init.body) > 0);

		receiptOverrides = { namespace: "wrong-preview-namespace" };
		await assert.rejects(
			service.deploy(target, contextId, {
				branch: "feature/example",
				directory: "dist",
				artifact_kind: "static",
				idempotency_key: `site_deploy:${"c".repeat(64)}`,
				message: "Example preview",
			}),
			(error) => error instanceof HostSitesError && error.code === "sites_publish_receipt_scope_mismatch",
		);

		receiptOverrides = {
			namespace: "example-sites-preview",
			scriptName: scopedScriptName("22222222-2222-4222-8222-222222222222", "feature/example"),
		};
		await assert.rejects(
			service.deploy(target, contextId, {
				branch: "feature/example",
				directory: "dist",
				artifact_kind: "static",
				idempotency_key: `site_deploy:${"d".repeat(64)}`,
				message: "Example preview",
			}),
			(error) => error instanceof HostSitesError && error.code === "sites_publish_receipt_identity_invalid",
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});


test("the Hostd deploy endpoint accepts only its separate context capability", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-sites-server-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const target = {
		id: "front-desk",
		driver: "oci",
		outboundToken: "fake-outbound-secret",
	};
	const config = {
		server: {},
		sites: {},
		targetsById: new Map([[target.id, target]]),
	};
	const calls = [];
	const contextId = "front-desk:principal:website";
	const server = createHostServer({
		config,
		store,
		daemon: { polling: false },
		sitesGateway: {
			async deploy(selectedTarget, selectedContext, body) {
				calls.push({ selectedTarget, selectedContext, body });
				return { ok: true, environment: "preview" };
			},
		},
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const post = (token, selectedContext = contextId) => fetch(`${base}/v1/sites/deploy`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			context_id: selectedContext,
			directory: "dist",
			branch: "main",
			artifact_kind: "static",
			idempotency_key: `site_deploy:${"b".repeat(64)}`,
		}),
	});
	try {
		const broadOutbound = await post(contextCapability(target.outboundToken, "outbound", contextId));
		assert.equal(broadOutbound.status, 401);
		assert.equal(calls.length, 0);

		const siteToken = contextCapability(target.outboundToken, "site-deploy", contextId);
		const wrongContext = await post(siteToken, "front-desk:other:website");
		assert.equal(wrongContext.status, 401);
		assert.equal(calls.length, 0);

		const accepted = await post(siteToken);
		assert.equal(accepted.status, 200);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].selectedContext, contextId);
		assert.equal(calls[0].selectedTarget, target);
	} finally {
		await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});


test("only an exact bound principal/project receives the site deploy capability", () => {
	const binding = {
		grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		siteId: "11111111-1111-4111-8111-111111111111",
		siteSlug: "example-business",
	};
	const config = {
		sites: {},
		routing: {
			knownPrincipals: [{
				email: "owner@example.com",
				projects: [{ slug: "website", siteDeployment: binding }],
			}],
		},
	};
	const target = { id: "front-desk" };
	const scopes = new Map([
		["bound", { emailAddress: "owner@example.com", projectSlug: "website" }],
		["wrong-project", { emailAddress: "owner@example.com", projectSlug: "other" }],
		["wrong-customer", { emailAddress: "other@example.com", projectSlug: "website" }],
	]);
	const store = { getContextScope(contextId) { return scopes.get(contextId) } };
	assert.equal(siteDeploymentBinding(config, store, target, "bound"), binding);
	assert.equal(siteDeploymentBinding(config, store, target, "wrong-project"), null);
	assert.equal(siteDeploymentBinding(config, store, target, "wrong-customer"), null);
	assert.equal(siteDeploymentBinding({ ...config, sites: undefined }, store, target, "bound"), null);
});

test("only the exact configured phone intake context receives its site deploy capability", () => {
	const routingKey = Buffer.alloc(32, 9);
	const phone = "+15551234567";
	const binding = {
		grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		siteId: "11111111-1111-4111-8111-111111111111",
		siteSlug: "example-business",
	};
	const principalHash = stablePrivateKey(routingKey, "phone-principal", phone);
	const config = {
		sites: {},
		routing: {
			knownPrincipals: [],
			knownPhonePrincipals: [{ phone, siteDeployment: binding }],
		},
	};
	const target = { id: "front-desk" };
	const scopes = new Map([
		["bound", { principalHash, emailAddress: null, projectSlug: "intake" }],
		["wrong-phone", { principalHash: "f".repeat(64), emailAddress: null, projectSlug: "intake" }],
		["wrong-project", { principalHash, emailAddress: null, projectSlug: "website" }],
	]);
	const store = { getContextScope(contextId) { return scopes.get(contextId) } };
	assert.equal(siteDeploymentBinding(config, store, target, "bound", routingKey), binding);
	assert.equal(siteDeploymentBinding(config, store, target, "wrong-phone", routingKey), null);
	assert.equal(siteDeploymentBinding(config, store, target, "wrong-project", routingKey), null);
	assert.equal(siteDeploymentBinding(config, store, target, "bound"), null);
});
