import assert from "node:assert/strict";
import {
	currentUserVisibleDeliveryFailure,
	recordUserVisibleDeliveryFailure,
	recordUserVisibleDeliverySuccess,
	resetUserVisibleDeliveryState,
	shouldSurfaceUserVisibleDeliveryFailure,
} from "../src/tools/user-visible-delivery-state.js";

resetUserVisibleDeliveryState();
assert.equal(currentUserVisibleDeliveryFailure(), undefined);
assert.equal(shouldSurfaceUserVisibleDeliveryFailure(true, true), false);

recordUserVisibleDeliveryFailure("zulip:7:topic:Customer%20question", new Error("scoped delivery denied"));
assert.deepEqual(currentUserVisibleDeliveryFailure(), {
	target: "zulip:7:topic:Customer%20question",
	error: "scoped delivery denied",
});
assert.equal(shouldSurfaceUserVisibleDeliveryFailure(false, true), false, "ambient turns may still yield after a failed attempted delivery");
assert.equal(shouldSurfaceUserVisibleDeliveryFailure(true, false), false, "a direct turn that remains active may recover normally");
assert.equal(shouldSurfaceUserVisibleDeliveryFailure(true, true), true, "a directly addressed turn cannot silently yield with unresolved delivery failure");

recordUserVisibleDeliverySuccess("zulip:7:topic:Customer%20question");
assert.equal(currentUserVisibleDeliveryFailure(), undefined, "a confirmed retry to the same target clears the failure");

recordUserVisibleDeliveryFailure("phone-example", "provider status unknown");
recordUserVisibleDeliverySuccess("zulip:7:topic:Customer%20question");
assert.equal(currentUserVisibleDeliveryFailure()?.target, "phone-example", "success on another target does not hide an unresolved delivery failure");

resetUserVisibleDeliveryState();
assert.equal(currentUserVisibleDeliveryFailure(), undefined, "run reset clears stale delivery state");

console.log("user-visible delivery failure state passed");
