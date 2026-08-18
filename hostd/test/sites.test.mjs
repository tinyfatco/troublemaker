import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify as verifyBytes } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { ContextRouter } from "../src/router.mjs";
import { resolveSiteFactory } from "../src/site-deployment-binding.mjs";
import { siteDeploymentBinding, siteDeploymentBindings } from "../src/runtime.mjs";
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
			repository: workspace,
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

test("Hostd binds provenance to one clean nested project repository", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-sites-nested-git-"));
	const workspace = join(directory, "workspace");
	const project = join(workspace, "projects", "example");
	const artifact = join(project, "site");
	try {
		await mkdir(artifact, { recursive: true });
		await writeFile(join(artifact, "index.html"), "<!doctype html><title>Nested source</title>\n");
		const sourceSha = commitWorkspace(project, "main");
		await writeFile(join(workspace, "private-runtime-log.jsonl"), "not project source\n");
		assert.deepEqual(await inspectWorkspaceGitSource(workspace, "main", "projects/example/site"), {
			branch: "main",
			sha: sourceSha,
			repository: project,
		});
		await writeFile(join(project, "untracked.txt"), "dirty\n");
		await assert.rejects(
			inspectWorkspaceGitSource(workspace, "main", "projects/example/site"),
			(error) => error instanceof HostSitesError && error.code === "source_repository_dirty",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("nested artifacts reject VCS metadata and ignored private files but allow ignored build output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-sites-private-artifact-"));
	const workspace = join(directory, "workspace");
	const project = join(workspace, "projects", "example");
	try {
		await mkdir(join(project, "site"), { recursive: true });
		await writeFile(join(project, ".gitignore"), "site/.env\nsite/ignored-note.txt\ndist/\ndist/private.txt\n");
		await writeFile(join(project, "site", "index.html"), "<!doctype html><title>Safe</title>\n");
		commitWorkspace(project, "main");
		const source = await inspectWorkspaceGitSource(workspace, "main", "projects/example/site");
		await assert.rejects(
			buildWorkspaceArtifact(workspace, "projects/example", LIMITS, { repository: source.repository }),
			(error) => error instanceof HostSitesError && error.code === "artifact_private_path_forbidden",
		);

		await writeFile(join(project, "site", ".env"), "SYNTHETIC_SECRET=not-for-an-artifact\n");
		assert.equal(git(project, "status", "--porcelain=v1"), "");
		await assert.rejects(
			buildWorkspaceArtifact(workspace, "projects/example/site", LIMITS, { repository: source.repository }),
			(error) => error instanceof HostSitesError && error.code === "artifact_private_path_forbidden",
		);
		await rm(join(project, "site", ".env"));
		await writeFile(join(project, "site", "ignored-note.txt"), "ignored private data\n");
		await assert.rejects(
			buildWorkspaceArtifact(workspace, "projects/example/site", LIMITS, { repository: source.repository }),
			(error) => error instanceof HostSitesError && error.code === "artifact_ignored_path_forbidden",
		);
		await rm(join(project, "site", "ignored-note.txt"));

		await mkdir(join(project, "dist"), { recursive: true });
		await writeFile(join(project, "dist", "index.html"), "<!doctype html><title>Ignored build</title>\n");
		await writeFile(join(project, "dist", "private.txt"), "private build data\n");
		assert.equal(git(project, "status", "--porcelain=v1"), "");
		await assert.rejects(
			buildWorkspaceArtifact(workspace, "projects/example/dist", LIMITS, { repository: source.repository }),
			(error) => error instanceof HostSitesError && error.code === "artifact_private_path_forbidden",
		);
		await rm(join(project, "dist", "private.txt"));
		for (const privatePath of [
			".npmrc",
			".yarnrc.yml",
			".pnpmrc",
			".netrc",
			".pypirc",
			".dockercfg",
			".docker/config.json",
			".aws/credentials",
			".ssh/id_ed25519",
			"service-account.json",
			"credentials.json",
		]) {
			const absolute = join(project, "dist", privatePath);
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, "synthetic credential material\n");
			await assert.rejects(
				buildWorkspaceArtifact(workspace, "projects/example/dist", LIMITS, { repository: source.repository }),
				(error) => error instanceof HostSitesError && error.code === "artifact_private_path_forbidden",
				privatePath,
			);
			await rm(absolute);
			const parent = dirname(absolute);
			if (parent !== join(project, "dist")) await rm(parent, { recursive: true, force: true });
		}
		await mkdir(join(project, "dist", ".well-known"), { recursive: true });
		await writeFile(join(project, "dist", ".well-known", "security.txt"), "Contact: mailto:security@example.com\n");
		const artifact = await buildWorkspaceArtifact(
			workspace,
			"projects/example/dist",
			LIMITS,
			{ repository: source.repository },
		);
		assert.deepEqual(artifactPaths(artifact.body), [".well-known/security.txt", "index.html"]);
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
		const raced = join(workspace, "dist", "race.txt");
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

		const swapped = join(workspace, "dist", "swapped.txt");
		const replacement = join(workspace, "dist", "replacement.txt");
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

		const growing = join(workspace, "dist", "growing.txt");
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
		previewHostname: "example-business.tinyfat.dev",
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


test("one context selects between two exact Sites grants and cannot use an implicit default", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-sites-multiple-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const { privateKey } = generateKeyPairSync("ed25519");
	const target = {
		id: "front-desk",
		driver: "oci",
		contextsDirectory: join(directory, "contexts"),
	};
	const first = {
		grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		siteId: "11111111-1111-4111-8111-111111111111",
		siteSlug: "example-business",
		artifactKinds: ["static"],
		allowedBranches: ["*"],
	};
	const second = {
		grantId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		customerId: first.customerId,
		projectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		siteId: "22222222-2222-4222-8222-222222222222",
		siteSlug: "second-example",
		previewHostname: "second-example.tinyfat.dev",
		artifactKinds: ["static"],
		allowedBranches: ["main"],
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
			actorTarget: target.id,
			knownPrincipals: [{
				email: "owner@example.com",
				projects: [{ slug: "website", name: "Example website", siteDeployments: [first, second] }],
			}],
		},
		targetsById: new Map([[target.id, target]]),
	};
	const router = new ContextRouter(config, store, Buffer.alloc(32, 5));
	const owner = router.resolve({ source: "gmail", threadId: "thread-owner", sender: "owner@example.com" });
	store.ensureProject(owner.principalHash, "website", "Example website");
	const contextId = `${target.id}:${owner.principalHash}:website`;
	store.bindRoute({
		source: "gmail",
		providerThreadId: "thread-website",
		principalHash: owner.principalHash,
		projectSlug: "website",
		targetId: target.id,
		contextId,
	});
	const workspace = join(target.contextsDirectory, contextId.replace(/[^a-z0-9_.-]/gi, "_"), "workspace");
	await mkdir(join(workspace, "dist"), { recursive: true });
	await writeFile(join(workspace, "dist", "index.html"), "<!doctype html><title>Second</title>\n");
	const sourceSha = commitWorkspace(workspace, "main");
	let calls = 0;
	let selectedCapability;
	const service = new HostSites({
		config,
		store,
		fetch: async (_url, init) => {
			calls++;
			selectedCapability = decodeCapability(new Headers(init.headers).get("authorization").replace(/^Bearer\s+/, ""));
			const binding = selectedCapability.payload.site_slug === second.siteSlug ? second : first;
			return new Response(JSON.stringify({
				ok: true,
				site: binding.siteSlug,
				site_id: binding.siteId,
				deployment_grant_id: binding.grantId,
				customer_id: binding.customerId,
				project_id: binding.projectId,
				environment: "preview",
				preview_slot: "branch:main",
				git_branch: "main",
				git_sha: sourceSha,
				branch_label: selectedCapability.payload.branch_label,
				hostname: selectedCapability.payload.hostname,
				namespace: "example-sites-preview",
				artifact_kind: "static",
				artifact_sha256: selectedCapability.payload.artifact_sha256,
				idempotency_key: selectedCapability.payload.idempotency_key,
				url: `https://${selectedCapability.payload.hostname}/`,
				scriptName: scopedScriptName(binding.siteId, "main"),
				deploymentId: "33333333-3333-4333-8333-333333333333",
			}), { status: 200 });
		},
	});
	const request = {
		branch: "main",
		directory: "dist",
		artifact_kind: "static",
		idempotency_key: `site_deploy:${"a".repeat(64)}`,
	};
	try {
		assert.equal(siteDeploymentBindings(config, store, target, contextId).length, 2);
		assert.equal(siteDeploymentBinding(config, store, target, contextId), null);
		assert.equal(siteDeploymentBinding(config, store, target, contextId, undefined, second.siteSlug), second);
		await assert.rejects(
			service.deploy(target, contextId, request),
			(error) => error instanceof HostSitesError && error.code === "site_slug_required",
		);
		await assert.rejects(
			service.deploy(target, contextId, { ...request, site_slug: "not-granted" }),
			(error) => error instanceof HostSitesError && error.code === "site_context_unbound",
		);
		assert.equal(calls, 0);
		const result = await service.deploy(target, contextId, { ...request, site_slug: second.siteSlug });
		assert.equal(result.site, second.siteSlug);
		assert.equal(selectedCapability.payload.site_id, second.siteId);
		assert.equal(selectedCapability.payload.deployment_grant_id, second.grantId);
		assert.equal(selectedCapability.payload.hostname_mode, "site-root-preview");
		assert.equal(result.hostname, "second-example.tinyfat.dev");
		assert.equal(calls, 1);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a verified user scope creates durable exact site grants without per-site config", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-site-factory-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const target = { id: "front-desk", driver: "oci" };
	const factory = {
		customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		userId: "99999999-9999-4999-8999-999999999999",
		maximumSites: 2,
		artifactKinds: ["static", "worker"],
		allowedBranches: ["main"],
		hostnameMode: "site-root-preview",
	};
	const config = {
		sites: {
			publishUrl: "https://publish.example.com",
			previewApex: "tinyfat.dev",
			capabilityPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			capabilityKeyId: "hostd-example-1",
			capabilityIssuer: "troublemaker-hostd",
			capabilityAudience: "tinyfat-sites-publish",
			capabilityTtlSeconds: 60,
		},
		routing: {
			actorTarget: target.id,
			knownPrincipals: [{
				email: "owner@example.com",
				projects: [{ slug: "website", name: "Example website", siteDeployments: [], siteFactory: factory }],
			}],
		},
		targetsById: new Map([[target.id, target]]),
	};
	const router = new ContextRouter(config, store, Buffer.alloc(32, 3));
	const owner = router.resolve({ source: "gmail", threadId: "thread-owner", sender: "owner@example.com" });
	store.ensureProject(owner.principalHash, "website", "Example website");
	const contextId = `${target.id}:${owner.principalHash}:website`;
	store.createContext({
		id: contextId,
		targetId: target.id,
		driver: "oci",
		runtimeName: "runtime-site-factory",
		port: 32000,
	});
	store.bindRoute({
		source: "gmail", providerThreadId: "thread-website", principalHash: owner.principalHash,
		projectSlug: "website", targetId: target.id, contextId,
	});
	let calls = 0;
	let signed;
	const service = new HostSites({
		config,
		store,
		now: () => 1_800_000_000_000,
		fetch: async (_url, init) => {
			calls++;
			signed = decodeCapability(new Headers(init.headers).get("authorization").replace(/^Bearer\s+/, ""));
			assert.equal(verifyBytes(null, signed.signed, publicKey, signed.signature), true);
			assert.equal(signed.payload.action, "site:create");
			assert.equal(signed.payload.user_id, factory.userId);
			assert.equal(signed.payload.customer_id, factory.customerId);
			assert.equal(signed.payload.site_slug, "new-example");
			assert.equal(signed.payload.hostname, "new-example.tinyfat.dev");
			return new Response(JSON.stringify({
				ok: true,
				created: true,
				site: signed.payload.site_slug,
				site_id: signed.payload.site_id,
				customer_id: signed.payload.customer_id,
				user_id: signed.payload.user_id,
				project_id: signed.payload.project_id,
				deployment_grant_id: signed.payload.deployment_grant_id,
				hostname: signed.payload.hostname,
			}), { status: 201 });
		},
	});
	try {
		const created = await service.create(target, contextId, {
			site_slug: "new-example",
			display_name: "New Example",
		});
		assert.equal(created.created, true);
		assert.equal(created.hostname, "new-example.tinyfat.dev");
		const durable = store.getSiteDeploymentBinding(contextId, "new-example");
		assert.equal(durable.status, "active");
		assert.equal(durable.userId, factory.userId);
		assert.equal(durable.siteId, signed.payload.site_id);

		const retry = await service.create(target, contextId, {
			site_slug: "new-example",
			display_name: "New Example",
		});
		assert.equal(retry.created, false);
		assert.equal(retry.site_id, durable.siteId);
		assert.equal(calls, 1, "durable active grants do not recreate provider state");
		store.createContext({
			id: "front-desk:other:website",
			targetId: target.id,
			driver: "oci",
			runtimeName: "runtime-other-site-factory",
			port: 32001,
		});
		assert.throws(() => store.beginSiteDeploymentBinding({
			contextId: "front-desk:other:website",
			siteSlug: "new-example",
			displayName: "Wrong Owner",
			siteId: "77777777-7777-4777-8777-777777777777",
			grantId: "88888888-8888-4888-8888-888888888888",
			customerId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			userId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
			projectId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
			previewHostname: "new-example.tinyfat.dev",
			artifactKinds: ["static"],
			allowedBranches: ["main"],
			maximumSites: 10,
		}), /site_slug_unavailable/);
		assert.throws(() => store.beginSiteDeploymentBinding({
			contextId,
			siteSlug: "over-limit",
			displayName: "Over Limit",
			siteId: "44444444-4444-4444-8444-444444444444",
			grantId: "55555555-5555-4555-8555-555555555555",
			customerId: factory.customerId,
			userId: factory.userId,
			projectId: "66666666-6666-4666-8666-666666666666",
			previewHostname: "over-limit.tinyfat.dev",
			artifactKinds: ["static"],
			allowedBranches: ["main"],
			maximumSites: 1,
		}), /site_factory_limit_reached/);

		await assert.rejects(
			service.create(target, "front-desk:other:website", {
				site_slug: "other-example",
				display_name: "Other Example",
			}),
			(error) => error instanceof HostSitesError && error.code === "site_factory_unbound",
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("relationship factories provision real custody once and isolate unrelated contexts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-relationship-sites-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const routingKey = Buffer.alloc(32, 9);
	const target = { id: "operator", driver: "oci" };
	const policy = {
		maximumSites: 1,
		artifactKinds: ["static"],
		allowedBranches: ["*"],
		hostnameMode: "pages-style-preview",
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
			relationshipFactory: policy,
		},
		routing: { actorTarget: target.id, knownPrincipals: [], knownPhonePrincipals: [] },
		targetsById: new Map([[target.id, target]]),
	};
	const router = new ContextRouter(config, store, routingKey);
	const makeContext = (providerThreadId, contactAddress) => {
		const route = router.resolvePhone({ providerThreadId, contactAddress, label: "Example customer" });
		store.createContext({
			id: route.contextId,
			targetId: route.targetId,
			driver: "oci",
			runtimeName: `runtime-${providerThreadId}`,
			port: providerThreadId === "thread-one" ? 32000 : 32001,
		});
		store.bindRoute({
			source: "phone",
			providerThreadId,
			principalHash: route.principalHash,
			projectSlug: route.projectSlug,
			targetId: route.targetId,
			contextId: route.contextId,
		});
		return route;
	};
	const one = makeContext("thread-one", "+15551230001");
	const two = makeContext("thread-two", "+15551230002");
	const users = new Map();
	const calls = [];
	const service = new HostSites({
		config,
		store,
		routingKey,
		now: () => 1_800_000_000_000,
		fetch: async (url, init) => {
			const signed = decodeCapability(new Headers(init.headers).get("authorization").replace(/^Bearer\s+/, ""));
			assert.equal(verifyBytes(null, signed.signed, publicKey, signed.signature), true);
			calls.push({ url, payload: signed.payload });
			if (url.endsWith("/v1/scoped-relationships")) {
				assert.equal(signed.payload.action, "relationship:ensure");
				assert.equal(signed.payload.maximum_sites, 1);
				assert.deepEqual(signed.payload.artifact_kinds, ["static"]);
				assert.deepEqual(signed.payload.allowed_branches, ["*"]);
				const userId = users.size === 0
					? "99999999-9999-4999-8999-999999999999"
					: "88888888-8888-4888-8888-888888888888";
				users.set(signed.payload.relationship_id, userId);
				return new Response(JSON.stringify({
					ok: true,
					created: true,
					relationship_id: signed.payload.relationship_id,
					customer_id: signed.payload.customer_id,
					user_id: userId,
					project_id: signed.payload.project_id,
					factory_grant_id: signed.payload.factory_grant_id,
					principal_ref: signed.payload.principal_ref,
					actor_ref: signed.payload.actor_ref,
					maximum_sites: signed.payload.maximum_sites,
					artifact_kinds: signed.payload.artifact_kinds,
					allowed_branches: signed.payload.allowed_branches,
					hostname_mode: signed.payload.hostname_mode,
					preview_apex: signed.payload.preview_apex,
				}), { status: 201 });
			}
			assert(url.endsWith("/v1/scoped-sites"));
			assert.equal(signed.payload.relationship_id, store.getSiteRelationshipFactory(one.contextId).relationshipId);
			return new Response(JSON.stringify({
				ok: true,
				created: true,
				site: signed.payload.site_slug,
				site_id: signed.payload.site_id,
				customer_id: signed.payload.customer_id,
				user_id: signed.payload.user_id,
				project_id: signed.payload.project_id,
				deployment_grant_id: signed.payload.deployment_grant_id,
				hostname: signed.payload.hostname,
			}), { status: 201 });
		},
	});
	try {
		const oneFactory = await service.ensureRelationshipFactory(target, one.contextId);
		const oneRetry = await service.ensureRelationshipFactory(target, one.contextId);
		assert.equal(oneFactory.userId, "99999999-9999-4999-8999-999999999999");
		assert.deepEqual(oneRetry, oneFactory);
		assert.equal(calls.filter((call) => call.url.endsWith("/v1/scoped-relationships")).length, 1);

		const twoFactory = await service.ensureRelationshipFactory(target, two.contextId);
		assert.equal(twoFactory.userId, "88888888-8888-4888-8888-888888888888");
		assert.notEqual(twoFactory.customerId, oneFactory.customerId);
		assert.notEqual(twoFactory.projectId, oneFactory.projectId);
		assert.notEqual(twoFactory.grantId, oneFactory.grantId);

		const created = await service.create(target, one.contextId, {
			site_slug: "first-example",
			display_name: "First Example",
		});
		assert.equal(created.created, true);
		assert.equal(store.getSiteDeploymentBinding(one.contextId, "first-example").status, "active");
		const repeated = await service.create(target, one.contextId, {
			site_slug: "first-example",
			display_name: "First Example",
		});
		assert.equal(repeated.created, false);
		assert.equal(repeated.customer_id, created.customer_id);
		assert.equal(repeated.user_id, created.user_id);
		assert.equal(repeated.site_id, created.site_id);
		assert.equal(repeated.project_id, created.project_id);
		assert.equal(repeated.deployment_grant_id, created.deployment_grant_id);
		await assert.rejects(
			service.create(target, two.contextId, {
				site_slug: "first-example",
				display_name: "Wrong Context",
			}),
			(error) => error instanceof HostSitesError && error.code === "site_slug_unavailable",
		);
		await assert.rejects(
			service.create(target, one.contextId, {
				site_slug: "second-example",
				display_name: "Over Quota",
			}),
			(error) => error instanceof HostSitesError && error.code === "site_factory_limit_reached",
		);
		assert.equal(resolveSiteFactory(config, store, target, one.contextId, routingKey).ownershipMode, "relationship");
		const rolledBackConfig = { ...config, sites: { ...config.sites, relationshipFactory: undefined } };
		assert.equal(resolveSiteFactory(rolledBackConfig, store, target, one.contextId, routingKey), null);
		assert.equal(
			siteDeploymentBinding(rolledBackConfig, store, target, one.contextId, routingKey, "first-example").siteSlug,
			"first-example",
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("relationship factories upgrade existing main-only custody without replacing identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-relationship-sites-upgrade-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const { privateKey } = generateKeyPairSync("ed25519");
	const routingKey = Buffer.alloc(32, 4);
	const target = { id: "operator", driver: "oci" };
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
			relationshipFactory: {
				maximumSites: 1,
				artifactKinds: ["static"],
				allowedBranches: ["*"],
				hostnameMode: "pages-style-preview",
			},
		},
		routing: { actorTarget: target.id, knownPrincipals: [], knownPhonePrincipals: [] },
		targetsById: new Map([[target.id, target]]),
	};
	const router = new ContextRouter(config, store, routingKey);
	const route = router.resolvePhone({
		providerThreadId: "thread-upgrade",
		contactAddress: "+15551230005",
		label: "Example customer",
	});
	store.createContext({
		id: route.contextId,
		targetId: route.targetId,
		driver: "oci",
		runtimeName: "runtime-upgrade",
		port: 32000,
	});
	store.bindRoute({
		source: "phone",
		providerThreadId: "thread-upgrade",
		principalHash: route.principalHash,
		projectSlug: route.projectSlug,
		targetId: route.targetId,
		contextId: route.contextId,
	});
	const identity = {
		relationshipId: "11111111-1111-4111-8111-111111111111",
		customerId: "22222222-2222-4222-8222-222222222222",
		projectId: "33333333-3333-4333-8333-333333333333",
		grantId: "44444444-4444-4444-8444-444444444444",
		userId: "55555555-5555-4555-8555-555555555555",
	};
	store.beginSiteRelationshipFactory({
		contextId: route.contextId,
		principalHash: route.principalHash,
		targetId: target.id,
		...identity,
		maximumSites: 1,
		artifactKinds: ["static"],
		allowedBranches: ["main"],
		hostnameMode: "site-root-preview",
	});
	store.activateSiteRelationshipFactory(route.contextId, identity);
	store.beginSiteDeploymentBinding({
		contextId: route.contextId,
		siteSlug: "example-business",
		displayName: "Example Business",
		siteId: "66666666-6666-4666-8666-666666666666",
		grantId: identity.grantId,
		customerId: identity.customerId,
		userId: identity.userId,
		projectId: identity.projectId,
		previewHostname: "example-business.tinyfat.dev",
		artifactKinds: ["static"],
		allowedBranches: ["main"],
		maximumSites: 1,
	});
	store.activateSiteDeploymentBinding(route.contextId, "example-business");
	const before = store.getSiteRelationshipFactory(route.contextId);
	let observed;
	const service = new HostSites({
		config,
		store,
		routingKey,
		now: () => 1_800_000_000_000,
		fetch: async (_url, init) => {
			observed = decodeCapability(new Headers(init.headers).get("authorization").replace(/^Bearer\s+/, "")).payload;
			return new Response(JSON.stringify({
				ok: true,
				created: false,
				relationship_id: observed.relationship_id,
				customer_id: observed.customer_id,
				user_id: identity.userId,
				project_id: observed.project_id,
				factory_grant_id: observed.factory_grant_id,
				principal_ref: observed.principal_ref,
				actor_ref: observed.actor_ref,
				maximum_sites: observed.maximum_sites,
				artifact_kinds: observed.artifact_kinds,
				allowed_branches: observed.allowed_branches,
				hostname_mode: observed.hostname_mode,
				preview_apex: observed.preview_apex,
			}));
		},
	});
	try {
		const upgraded = await service.ensureRelationshipFactory(target, route.contextId);
		assert.deepEqual(observed.allowed_branches, ["*"]);
		assert.equal(observed.hostname_mode, "pages-style-preview");
		assert.equal(upgraded.relationshipId, identity.relationshipId);
		assert.equal(upgraded.customerId, identity.customerId);
		assert.equal(upgraded.projectId, identity.projectId);
		assert.equal(upgraded.grantId, identity.grantId);
		assert(store.getSiteRelationshipFactory(route.contextId).generation > before.generation);
		assert.deepEqual(
			store.getSiteDeploymentBinding(route.contextId, "example-business").allowedBranches,
			["*"],
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("singular configured site grants never gain generic create authority", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-singular-site-grant-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const routingKey = Buffer.alloc(32, 6);
	const target = { id: "operator", driver: "oci" };
	const phone = "+15551230004";
	const siteDeployment = {
		grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		siteId: "11111111-1111-4111-8111-111111111111",
		siteSlug: "configured-example",
		artifactKinds: ["static"],
		allowedBranches: ["main"],
	};
	const config = {
		sites: { relationshipFactory: { maximumSites: 1, artifactKinds: ["static"], allowedBranches: ["main"], hostnameMode: "site-root-preview" } },
		routing: { actorTarget: target.id, knownPrincipals: [], knownPhonePrincipals: [{ phone, siteDeployment }] },
		targetsById: new Map([[target.id, target]]),
	};
	const router = new ContextRouter(config, store, routingKey);
	const route = router.resolvePhone({ providerThreadId: "thread", contactAddress: phone });
	store.createContext({ id: route.contextId, targetId: target.id, driver: "oci", runtimeName: "runtime", port: 32000 });
	store.bindRoute({ source: "phone", providerThreadId: "thread", principalHash: route.principalHash, projectSlug: "intake", targetId: target.id, contextId: route.contextId });
	let calls = 0;
	const service = new HostSites({ config, store, routingKey, fetch: async () => { calls++; throw new Error("unexpected"); } });
	try {
		assert.equal(await service.ensureRelationshipFactory(target, route.contextId), null);
		assert.equal(calls, 0);
		assert.equal(store.getSiteRelationshipFactory(route.contextId), null);
		assert.equal(siteDeploymentBinding(config, store, target, route.contextId, routingKey, "configured-example").siteSlug, "configured-example");
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed relationship provisioning retries the same durable identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-relationship-retry-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const { privateKey } = generateKeyPairSync("ed25519");
	const routingKey = Buffer.alloc(32, 7);
	const target = { id: "operator", driver: "oci" };
	const config = {
		sites: {
			publishUrl: "https://publish.example.com",
			previewApex: "tinyfat.dev",
			previewNamespace: "preview",
			productionNamespace: "production",
			capabilityPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			capabilityKeyId: "hostd-example-1",
			capabilityIssuer: "troublemaker-hostd",
			capabilityAudience: "tinyfat-sites-publish",
			capabilityTtlSeconds: 60,
			relationshipFactory: { maximumSites: 1, artifactKinds: ["static"], allowedBranches: ["main"], hostnameMode: "site-root-preview" },
		},
		routing: { actorTarget: target.id, knownPrincipals: [], knownPhonePrincipals: [] },
		targetsById: new Map([[target.id, target]]),
	};
	const router = new ContextRouter(config, store, routingKey);
	const route = router.resolvePhone({ providerThreadId: "thread", contactAddress: "+15551230003" });
	store.createContext({ id: route.contextId, targetId: target.id, driver: "oci", runtimeName: "runtime", port: 32000 });
	store.bindRoute({ source: "phone", providerThreadId: "thread", principalHash: route.principalHash, projectSlug: "intake", targetId: target.id, contextId: route.contextId });
	const failed = new HostSites({ config, store, routingKey, fetch: async () => new Response(JSON.stringify({ error: "temporary" }), { status: 503 }) });
	try {
		await assert.rejects(failed.ensureRelationshipFactory(target, route.contextId));
		const before = store.getSiteRelationshipFactory(route.contextId);
		assert.equal(before.status, "failed");
		const recovered = new HostSites({
			config,
			store,
			routingKey,
			fetch: async (_url, init) => {
				const payload = decodeCapability(new Headers(init.headers).get("authorization").replace(/^Bearer\s+/, "")).payload;
				return new Response(JSON.stringify({
					ok: true,
					created: false,
					relationship_id: payload.relationship_id,
					customer_id: payload.customer_id,
					user_id: "77777777-7777-4777-8777-777777777777",
					project_id: payload.project_id,
					factory_grant_id: payload.factory_grant_id,
					principal_ref: payload.principal_ref,
					actor_ref: payload.actor_ref,
					maximum_sites: payload.maximum_sites,
					artifact_kinds: payload.artifact_kinds,
					allowed_branches: payload.allowed_branches,
					hostname_mode: payload.hostname_mode,
					preview_apex: payload.preview_apex,
				}));
			},
		});
		await recovered.ensureRelationshipFactory(target, route.contextId);
		const after = store.getSiteRelationshipFactory(route.contextId);
		assert.equal(after.status, "active");
		assert.equal(after.relationshipId, before.relationshipId);
		assert.equal(after.customerId, before.customerId);
		assert.equal(after.projectId, before.projectId);
		assert.equal(after.grantId, before.grantId);
		assert(after.generation > before.generation);
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
			async create(selectedTarget, selectedContext, body) {
				calls.push({ operation: "create", selectedTarget, selectedContext, body });
				return { ok: true, created: true };
			},
			async deploy(selectedTarget, selectedContext, body) {
				calls.push({ operation: "deploy", selectedTarget, selectedContext, body });
				return { ok: true, environment: "preview" };
			},
		},
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const post = (token, selectedContext = contextId, action = "deploy") => fetch(`${base}/v1/sites/${action}`, {
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
		assert.equal(calls[0].operation, "deploy");
		assert.equal(calls[0].selectedContext, contextId);
		assert.equal(calls[0].selectedTarget, target);

		const created = await post(siteToken, contextId, "create");
		assert.equal(created.status, 200);
		assert.equal(calls.length, 2);
		assert.equal(calls[1].operation, "create");
		assert.equal(calls[1].selectedContext, contextId);
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
