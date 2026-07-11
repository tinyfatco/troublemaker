import assert from "node:assert/strict";
import { matchesBearerToken } from "../src/adapters/email-webhook.js";

assert.equal(matchesBearerToken("Bearer relay-secret", "relay-secret"), true);
assert.equal(matchesBearerToken("bearer relay-secret", "relay-secret"), true);
assert.equal(matchesBearerToken("Bearer wrong", "relay-secret"), false);
assert.equal(matchesBearerToken(undefined, "relay-secret"), false);

console.log("email webhook auth ok");
