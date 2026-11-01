import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConsoleError, ConsoleService, chatImageType } from "../src/console/service.ts";
import { FilesystemWorkspaceStore } from "../src/storage/node/filesystem-workspace.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("detects chat image types from bytes only", () => {
	assert.equal(chatImageType(PNG), "image/png");
	assert.equal(chatImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	assert.equal(chatImageType(Buffer.from("GIF89a")), "image/gif");
	assert.equal(chatImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
	assert.equal(chatImageType(Buffer.from("<svg onload=alert(1)>")), null);
});

test("reads workspace images as data URLs and refuses everything else", () => {
	const root = mkdtempSync(join(tmpdir(), "chat-image-"));
	mkdirSync(join(root, "websitepaint/site"), { recursive: true });
	writeFileSync(join(root, "websitepaint/site/after.png"), PNG);
	writeFileSync(join(root, "fake.png"), "<svg/>");
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
	assert.equal(status("missing.png"), 404);
	assert.equal(status("websitepaint"), 404);
	assert.equal(status(""), 400);
	assert.throws(() => service.readImage("../outside.png"));
});
