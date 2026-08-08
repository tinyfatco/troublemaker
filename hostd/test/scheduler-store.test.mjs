import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventScheduler } from "../src/scheduler.mjs";
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

async function waitFor(predicate, message) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
	}
	assert.fail(message);
}

test("leases distinct contexts concurrently and appends ordered steers to a running context", () => {
	const subject = fixture();
	try {
		enqueue(subject.store, "event-one", subject.contexts[0], 1);
		enqueue(subject.store, "event-two", subject.contexts[0], 2);
		enqueue(subject.store, "event-three", subject.contexts[1], 3);
		enqueue(subject.store, "event-four", subject.contexts[0], 4);

		const first = subject.store.claimNextEvent({ maximumActiveContexts: 2 });
		assert.equal(first.id, "event-one");
		assert.equal(first.deliveryMode, "turn");
		const second = subject.store.claimNextEvent({ maximumActiveContexts: 2 });
		assert.equal(second.id, "event-three", "a leased delivery blocks only its own context");
		assert.equal(subject.store.claimNextEvent({ maximumActiveContexts: 2 }), null);

		subject.store.acceptEvent(first.id, first.leaseToken);
		subject.store.heartbeatEvent(first.id, first.leaseToken);
		const firstSteer = subject.store.claimNextEvent({ maximumActiveContexts: 2 });
		assert.equal(firstSteer.id, "event-two");
		assert.equal(firstSteer.deliveryMode, "steer");
		assert.equal(
			subject.store.claimNextEvent({ maximumActiveContexts: 2 }),
			null,
			"only one same-context delivery may be in transport at a time",
		);

		subject.store.acceptEvent(firstSteer.id, firstSteer.leaseToken);
		subject.store.heartbeatEvent(firstSteer.id, firstSteer.leaseToken);
		const secondSteer = subject.store.claimNextEvent({ maximumActiveContexts: 2 });
		assert.equal(secondSteer.id, "event-four");
		assert.equal(secondSteer.deliveryMode, "steer");
		assert.equal(subject.store.countActiveContexts(), 2);
		assert.equal(subject.store.countActiveEvents(), 4);
		assert.deepEqual(
			{
				activeContexts: subject.store.status(3).activeContexts,
				activeEvents: subject.store.status(3).activeEvents,
				availableSlots: subject.store.status(3).availableSlots,
			},
			{ activeContexts: 2, activeEvents: 4, availableSlots: 1 },
			"capacity reporting counts resident contexts, not batched event receipts",
		);
	} finally {
		subject.close();
	}
});

test("running-context steers do not consume another context slot", () => {
	const subject = fixture();
	try {
		enqueue(subject.store, "event-one", subject.contexts[0], 1);
		enqueue(subject.store, "event-two", subject.contexts[0], 2);
		enqueue(subject.store, "event-three", subject.contexts[1], 3);

		const first = subject.store.claimNextEvent({ maximumActiveContexts: 1 });
		subject.store.acceptEvent(first.id, first.leaseToken);
		subject.store.heartbeatEvent(first.id, first.leaseToken);

		const steer = subject.store.claimNextEvent({ maximumActiveContexts: 1 });
		assert.equal(steer.id, "event-two");
		assert.equal(steer.deliveryMode, "steer");
		assert.equal(
			subject.store.claimNextEvent({ maximumActiveContexts: 1 }),
			null,
			"a new context remains capped while the active context accepts batched steering",
		);
	} finally {
		subject.close();
	}
});

test("a running receipt opens the same-context Pi steering lane", async () => {
	const subject = fixture();
	try {
		enqueue(subject.store, "event-one", subject.contexts[0], 1);
		enqueue(subject.store, "event-two", subject.contexts[0], 2);
		const delivered = [];
		const scheduler = new EventScheduler({
			config: {
				scheduler: {
					maxConcurrent: 1,
					leaseSeconds: 60,
					turnLeaseSeconds: 900,
					maximumAttempts: 5,
				},
			},
			store: subject.store,
			runtime: {
				reconcile: async () => {},
				reapIdle: async () => {},
				acceptEvent: async (event) => {
					delivered.push(event);
				},
			},
		});

		await scheduler.start();
		await waitFor(
			() => subject.store.getEvent("event-one")?.status === "accepted",
			"first event was not accepted",
		);
		assert.equal(delivered.length, 1);
		assert.equal(subject.store.getEvent("event-two").status, "queued");

		const first = subject.store.getEvent("event-one");
		scheduler.receipt(first.id, first.leaseToken, "running");
		await waitFor(() => delivered.length === 2, "same-context steer was not delivered");
		assert.equal(delivered[1].id, "event-two");
		assert.equal(delivered[1].deliveryMode, "steer");
		await waitFor(
			() => subject.store.getEvent("event-two")?.status === "accepted",
			"steering event was not accepted",
		);
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

test("expired post-running leases become uncertain instead of replaying side effects", () => {
	const subject = fixture();
	try {
		enqueue(subject.store, "event-recoverable", subject.contexts[0], 1);
		let event = subject.store.claimNextEvent();
		subject.store.acceptEvent(event.id, event.leaseToken);
		subject.store.database.prepare(`
			UPDATE events SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
		`).run(event.id);
		assert.deepEqual(subject.store.recoverExpiredEvents(5), {
			recovered: 1,
			uncertain: 0,
			exhausted: 0,
		});
		assert.equal(subject.store.getEvent(event.id).status, "queued");

		event = subject.store.claimNextEvent();
		subject.store.acceptEvent(event.id, event.leaseToken);
		subject.store.heartbeatEvent(event.id, event.leaseToken);
		subject.store.database.prepare(`
			UPDATE events SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
		`).run(event.id);
		assert.deepEqual(subject.store.recoverExpiredEvents(5), {
			recovered: 0,
			uncertain: 1,
			exhausted: 0,
		});
		assert.equal(subject.store.getEvent(event.id).status, "uncertain");
		assert.equal(subject.store.claimNextEvent(), null, "uncertain work is never replayed automatically");
		assert.equal(subject.store.status().uncertainEvents, 1);
	} finally {
		subject.close();
	}
});

test("exhausted pre-running events become terminal without losing failure evidence", () => {
	const subject = fixture();
	try {
		enqueue(subject.store, "event-exhausted-queued", subject.contexts[0], 1);
		subject.store.database.prepare(`
			UPDATE events SET attempts = 5, last_error = 'preserved cold-start failure'
			WHERE id = 'event-exhausted-queued'
		`).run();

		enqueue(subject.store, "event-exhausted-accepted", subject.contexts[1], 2);
		const accepted = subject.store.claimNextEvent({ maximumAttempts: 5 });
		assert.equal(accepted.id, "event-exhausted-accepted");
		subject.store.acceptEvent(accepted.id, accepted.leaseToken);
		subject.store.database.prepare(`
			UPDATE events SET attempts = 5, lease_expires_at = '2000-01-01T00:00:00.000Z'
			WHERE id = ?
		`).run(accepted.id);

		assert.equal(subject.store.status().queuedEvents, 1);
		assert.deepEqual(subject.store.recoverExpiredEvents(5), {
			recovered: 0,
			uncertain: 0,
			exhausted: 2,
		});
		assert.deepEqual(subject.store.recoverExpiredEvents(5), {
			recovered: 0,
			uncertain: 0,
			exhausted: 0,
		}, "terminal classification is idempotent");

		const queued = subject.store.getEvent("event-exhausted-queued");
		assert.equal(queued.status, "dead");
		assert.equal(queued.attempts, 5);
		assert.equal(queued.lastError, "preserved cold-start failure");
		const expired = subject.store.getEvent("event-exhausted-accepted");
		assert.equal(expired.status, "dead");
		assert.equal(expired.attempts, 5);
		assert.equal(expired.startedAt, null);
		assert.equal(expired.lastError, "delivery lease expired before running after maximum attempts");
		assert.equal(subject.store.claimNextEvent({ maximumAttempts: 5 }), null);
		assert.equal(subject.store.status().queuedEvents, 0);
		assert.equal(subject.store.status().deadEvents, 2);
	} finally {
		subject.close();
	}
});

test("scheduler startup applies its configured attempt limit before pumping", async () => {
	const subject = fixture();
	try {
		enqueue(subject.store, "event-configured-exhaustion", subject.contexts[0], 1);
		subject.store.database.prepare(`
			UPDATE events SET attempts = 1 WHERE id = 'event-configured-exhaustion'
		`).run();
		let delivered = 0;
		const scheduler = new EventScheduler({
			config: {
				scheduler: {
					maxConcurrent: 1,
					leaseSeconds: 60,
					turnLeaseSeconds: 900,
					maximumAttempts: 1,
				},
			},
			store: subject.store,
			runtime: {
				reconcile: async () => {},
				reapIdle: async () => {},
				acceptEvent: async () => { delivered += 1; },
			},
		});

		await scheduler.start();
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		assert.equal(subject.store.getEvent("event-configured-exhaustion").status, "dead");
		assert.equal(subject.store.status().queuedEvents, 0);
		assert.equal(delivered, 0, "exhausted work is terminal before the scheduler pump");
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
