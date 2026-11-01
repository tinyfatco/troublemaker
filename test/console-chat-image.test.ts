import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConsoleError, ConsoleService, chatImageDimensions, chatImageType } from "../src/console/service.ts";
import { FilesystemWorkspaceStore } from "../src/storage/node/filesystem-workspace.ts";

const PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
	0, 0, 0, 2, 0, 0, 0, 3,
]);

test("detects chat image types and bounded dimensions from bytes only", () => {
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 3, 0, 2, 1, 1, 0x11, 0]);
	const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 3, 0]);
	const webp = Buffer.alloc(30);
	webp.write("RIFF", 0, "ascii");
	webp.write("WEBP", 8, "ascii");
	webp.write("VP8X", 12, "ascii");
	webp[24] = 1;
	webp[27] = 2;
	for (const [bytes, type, dimensions] of [
		[PNG, "image/png", { width: 2, height: 3 }],
		[jpeg, "image/jpeg", { width: 2, height: 3 }],
		[gif, "image/gif", { width: 2, height: 3 }],
		[webp, "image/webp", { width: 2, height: 3 }],
	] as const) {
		assert.equal(chatImageType(bytes), type);
		assert.deepEqual(chatImageDimensions(bytes, type), dimensions);
	}
	assert.equal(chatImageType(Buffer.from("GIF8xx")), null);
	assert.equal(chatImageType(Buffer.from("<svg onload=alert(1)>")), null);
});

test("reads workspace images as data URLs and refuses everything else", () => {
	const root = mkdtempSync(join(tmpdir(), "chat-image-"));
	mkdirSync(join(root, "websitepaint/site"), { recursive: true });
	writeFileSync(join(root, "websitepaint/site/after.png"), PNG);
	writeFileSync(join(root, "fake.png"), "<svg/>");
	const oversizedDimensions = Buffer.from(PNG);
	oversizedDimensions.writeUInt32BE(10000, 16);
	writeFileSync(join(root, "oversized.png"), oversizedDimensions);
	writeFileSync(join(root, "truncated.png"), PNG.subarray(0, 8));
	const service = new ConsoleService(new FilesystemWorkspaceStore(root), {});
	assert.deepEqual(service.readImage("websitepaint/site/after.png"), {
		image: `data:image/png;base64,${PNG.toString("base64")}`,
		type: "image/png",
		bytes: PNG.length,
	});
	const status = (path: string) => {
		try {
			service.readImage(path);
			return 200;
		} catch (error) {
			return error instanceof ConsoleError ? error.status : 500;
		}
	};
	assert.equal(status("fake.png"), 415);
	assert.equal(status("truncated.png"), 415);
	assert.equal(status("oversized.png"), 413);
	assert.equal(status("missing.png"), 404);
	assert.equal(status("websitepaint"), 404);
	assert.equal(status(""), 400);
	assert.throws(() => service.readImage("../outside.png"));

	const changingFile = new ConsoleService({
		stat: () => ({ type: "file", size: 1, modified: new Date(0).toISOString() }),
		readBytes: () => Buffer.alloc(5 * 1024 * 1024 + 1),
	} as never, {});
	assert.throws(
		() => changingFile.readImage("changed.png"),
		(error) => error instanceof ConsoleError && error.status === 413,
		"the byte cap is rechecked after reading a changing file",
	);
});
