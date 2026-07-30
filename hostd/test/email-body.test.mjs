import assert from "node:assert/strict";
import test from "node:test";
import { plainTextEmailHtml } from "../src/email-body.mjs";

test("creates minimal email HTML without carrying plain-text hard wraps into prose", () => {
	const html = plainTextEmailHtml([
		"Hi there,",
		"",
		"Confirmed — your message came through",
		"successfully, and we will follow up soon.",
		"",
		"Best,",
		"Operator",
	].join("\r\n"));

	assert.equal(
		html,
		"<!doctype html><html><body style=\"margin:0;padding:0\">"
			+ "<p style=\"margin:0 0 1em 0\">Hi there,</p>"
			+ "<p style=\"margin:0 0 1em 0\">Confirmed — your message came through successfully, and we will follow up soon.</p>"
			+ "<p style=\"margin:0 0 1em 0\">Best,<br>Operator</p>"
			+ "</body></html>",
	);
	assert.ok(!html.includes("max-width"));
	assert.ok(!html.includes("font-family"));
});

test("escapes authored content and retains list line breaks", () => {
	const html = plainTextEmailHtml("Details:\n- one < two\n- Tom & Sue");
	assert.ok(html.includes("Details:<br>- one &lt; two<br>- Tom &amp; Sue"));

	const list = plainTextEmailHtml("- first\n- second");
	assert.ok(list.includes("- first<br>- second"));
});
