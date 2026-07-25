import assert from "node:assert/strict";
import { describePreviewPortPolicy, isReservedPreviewPort, validatePreviewPort } from "../src/preview/ports.ts";

assert.equal(validatePreviewPort("4321"), 4321);
assert.equal(validatePreviewPort(5173), 5173);
assert.equal(validatePreviewPort("3000"), null);
assert.equal(validatePreviewPort("3002"), null);
assert.equal(validatePreviewPort("6080"), null);
assert.equal(validatePreviewPort("8765"), null);
assert.equal(validatePreviewPort("9222"), null);
assert.equal(validatePreviewPort("5900"), null);
assert.equal(validatePreviewPort("5999"), null);
assert.equal(validatePreviewPort("6000"), 6000);
assert.equal(validatePreviewPort("1023"), null);
assert.equal(validatePreviewPort("65536"), null);
assert.equal(validatePreviewPort("not-a-port"), null);
assert.equal(isReservedPreviewPort(5901), true);
assert.equal(isReservedPreviewPort(4321), false);
assert.match(describePreviewPortPolicy(), /5900-5999/);

console.log("preview-ports ok");
