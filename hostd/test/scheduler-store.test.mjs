import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostStore } from "../src/store.mjs";

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-scheduler-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const contexts = ["operator:one:intake", "operator:two:intake"];
	for (const [index, id] of contexts.entries()) {
		store.createContext({
			id,
			targetId: "operator",
			driver: "oci",
			runtimeName: `runtime-${index}`,
			port: 32000 + index,
		});
	}
	return {
		store,
		contexts,
		close() {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function enqueue(store, id, contextId, sequence) {
	return store.upsertEvent({
		id,
		source: "gmail",
		providerMessageId: `message-${sequence}`,
		providerThreadId: `thread-${sequence}`,
		principalHash: `principal-${sequence}`,
		targetId: "operator",
		contextId,
		payload: { sequence },
	});
}

test("leases distinct contexts concurrently while serializing each context", () => {
	const subject = fixture();
	try {
		enqueue(subject.store, "event-one", subject.contexts[0], 1);
		enqueue(subject.store, "event-two", subject.contexts[0], 2);
		enqueue(subject.store, "event-three", subject.contexts[1], 3);

		const first = subject.store.claimNextEvent();
		assert.equal(first.id, "event-one");
		const second = subject.store.claimNextEvent();
		assert.equal(second.id, "event-three", "the second event in a busy context remains serialized");
		assert.equal(subject.store.claimNextEvent(), null);

		subject.store.acceptEvent(first.id, first.leaseToken);
		subject.store.heartbeatEvent(first.id, first.leaseToken);
		subject.store.completeEvent(first.id, first.leaseToken);
		assert.equal(subject.store.claimNextEvent().id, "event-two");
	} finally {
		subject.close();
	}
});

test("completion receipts are fenced by their lease token", () => {
	const subject = fixture();
	try {
		enqueue(subject.store, "event-fenced", subject.contexts[0], 1);
		const event = subject.store.claimNextEvent();
		subject.store.completeEvent(event.id, "wrong-token");
		assert.equal(subject.store.getEvent(event.id).status, "leased");
		subject.store.completeEvent(event.id, event.leaseToken);
		assert.equal(subject.store.getEvent(event.id).status, "completed");
	} finally {
		subject.close();
	}
});

test("journals one durable control notification with each Gmail event", () => {
	const subject = fixture();
	try {
		const input = {
			id: "event-notified",
			source: "gmail",
			providerMessageId: "message-notified",
			providerThreadId: "thread-notified",
			principalHash: "principal-notified",
			targetId: "operator",
			contextId: subject.contexts[0],
			payload: {
				sender: "person@example.com",
				metadata: { subject: "A scoped request" },
				route: { projectSlug: "intake" },
			},
		};
		subject.store.upsertEventWithControlNotification(input);
		subject.store.upsertEventWithControlNotification({ ...input, id: "duplicate-event-id" });

		const notification = subject.store.claimControlNotification();
		assert.equal(notification.id, "gmail:message-notified");
		assert.equal(notification.contextId, subject.contexts[0]);
		assert.equal(notification.attempts, 1);
		assert.equal(subject.store.claimControlNotification(), null, "the provider message is idempotent");

		subject.store.completeControlNotification(notification.id, "pppppppppppppppppppppppppp");
		assert.equal(subject.store.getControlNotification(notification.id).status, "completed");
		assert.equal(subject.store.status().completedControlNotifications, 1);
		assert.equal(subject.store.status().pendingControlNotifications, 0);
	} finally {
		subject.close();
	}
});
