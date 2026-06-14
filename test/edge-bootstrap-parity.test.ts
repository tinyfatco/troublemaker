import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/modes/edge/index.ts", import.meta.url), "utf8");

assert.match(source, /Workspace context loaded from encrypted R2/, "edge system prompt includes loaded workspace context");
assert.match(source, /BOOTSTRAP\.md and AGENTS\.md/, "edge prompt names BOOTSTRAP and AGENTS as durable instructions");
assert.match(source, /begin a light onboarding flow/, "email/web fresh greeting can follow onboarding instructions");

console.log("edge bootstrap parity ok");
