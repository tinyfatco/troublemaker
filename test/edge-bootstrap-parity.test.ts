import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/modes/edge/index.ts", import.meta.url), "utf8");
const extensionSource = readFileSync(new URL("../src/modes/edge/troublemaker-extension.ts", import.meta.url), "utf8");

assert.match(source, /BOOTSTRAP\.md and AGENTS\.md/, "edge prompt names BOOTSTRAP and AGENTS as durable instructions");
assert.match(source, /begin a light onboarding flow/, "email/web fresh greeting can follow onboarding instructions");
assert.match(extensionSource, /buildSessionPreamble/, "edge turn builder uses Troublemaker's shared session preamble");
assert.match(extensionSource, /workspaceContext/, "edge turn builder carries loaded workspace context into the preamble");

console.log("edge bootstrap parity ok");
