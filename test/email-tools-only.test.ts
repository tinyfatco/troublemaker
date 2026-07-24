import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EmailWebhookAdapter } from "../src/adapters/email-webhook.js";

const workingDir = mkdtempSync(join(tmpdir(), "troublemaker-email-tools-only-"));
try {
	const adapter = new EmailWebhookAdapter({
		workingDir,
		toolsToken: "fake-tools-token",
		sendUrl: "http://127.0.0.1:9/v1/outbound/gmail",
		hostContextId: "front-desk:fake:website",
		toolsOnly: true,
	});
	await assert.rejects(
		() => adapter.postMessage("email-person@example.com", "This must remain unsent"),
		/Generic email delivery is disabled\. Use gmail_draft, then gmail_send\./,
	);
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("email tools-only boundary: ok");
