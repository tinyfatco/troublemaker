import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/modes/edge/index.ts", import.meta.url), "utf8");

assert.match(source, /Current surface: Email/, "edge runtime has an email-specific prompt surface");
assert.match(source, /Reply in clear, human email prose/, "email surface asks for email prose");
assert.match(source, /Do not mention internal runtime details/, "email surface hides runtime details by default");

console.log("edge email surface ok");
