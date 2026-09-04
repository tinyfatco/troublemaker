import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	OWNER_PUSH_VERSION,
	ownerPushAPNSPayload,
	ownerPushRegistrationKey,
	ownerPushRouteFingerprint,
	parseOwnerPushEnvelope,
	parseOwnerPushRegistration,
	type OwnerPushAcknowledgment,
	type OwnerPushAuthoritativeEventKind,
	type OwnerPushDeviceRegistration,
	type OwnerPushEnvelope,
	type OwnerPushReadState,
	type OwnerPushTransportRequest,
	type OwnerPushTransportResult,
} from "../../console/owner-push.js";

interface StoredRegistration extends OwnerPushDeviceRegistration {
	key: string;
	created_at: string;
	updated_at: string;
}

interface StoredNotificationDelivery {
	registration_key: string;
	state: "pending" | "accepted" | "rejected";
	attempts: number;
	updated_at: string;
}

interface StoredNotification {
	envelope: OwnerPushEnvelope;
	route_fingerprint: string;
	authoritative_event_kind?: OwnerPushAuthoritativeEventKind;
	state: OwnerPushReadState;
	created_at: string;
	read_at?: string;
	opened_at?: string;
	deliveries: StoredNotificationDelivery[];
}

interface OwnerPushStoreDocument {
	version: typeof OWNER_PUSH_VERSION;
	registrations: StoredRegistration[];
	notifications: StoredNotification[];
}

export interface OwnerPushStoreOptions {
	now?: () => Date;
	maximumRegistrations?: number;
	maximumNotifications?: number;
}

export interface OwnerPushRegistrationResult {
	disposition: "accepted" | "duplicate" | "updated";
	installation_id: string;
}

export interface OwnerPushAdmissionResult {
	disposition: "accepted" | "duplicate" | "conflict";
}

export interface OwnerPushDispatchPlan {
	registrationKey: string;
	request: OwnerPushTransportRequest;
}

export interface OwnerPushAcknowledgmentResult {
	notification_id: string;
	state: OwnerPushReadState;
	changed: boolean;
}

export interface OwnerPushStoreSnapshot {
	version: typeof OWNER_PUSH_VERSION;
	registrations: Array<{
		key: string;
		installation_id: string;
		binding_id: string;
		route_agent_id: string;
		subject_agent_id: string;
		environment: string;
		supported_contexts: string[];
		created_at: string;
		updated_at: string;
	}>;
	notifications: Array<{
		notification_id: string;
		route_fingerprint: string;
		authoritative_event_kind?: OwnerPushAuthoritativeEventKind;
		state: OwnerPushReadState;
		created_at: string;
		read_at?: string;
		opened_at?: string;
		deliveries: StoredNotificationDelivery[];
	}>;
}

export class OwnerPushStore {
	private document: OwnerPushStoreDocument = {
		version: OWNER_PUSH_VERSION,
		registrations: [],
		notifications: [],
	};
	private readonly now: () => Date;
	private readonly maximumRegistrations: number;
	private readonly maximumNotifications: number;

	constructor(private readonly path: string, options: OwnerPushStoreOptions = {}) {
		if (!path.startsWith("/")) throw new Error("Owner push store path must be absolute");
		this.now = options.now ?? (() => new Date());
		this.maximumRegistrations = boundedMaximum(options.maximumRegistrations, 512);
		this.maximumNotifications = boundedMaximum(options.maximumNotifications, 4096);
		this.load();
	}

	register(value: unknown): OwnerPushRegistrationResult {
		const registration = parseOwnerPushRegistration(value);
		if (!registration) throw new OwnerPushStoreError(400, "invalid_owner_push_registration");
		const key = ownerPushRegistrationKey(registration);
		const existing = this.document.registrations.find((candidate) => candidate.key === key);
		const now = this.now().toISOString();
		if (existing) {
			const duplicate = registrationsEqual(existing, registration);
			Object.assign(existing, registration, { updated_at: now });
			this.persist();
			return {
				disposition: duplicate ? "duplicate" : "updated",
				installation_id: registration.installation_id,
			};
		}
		this.document.registrations.push({
			...registration,
			key,
			created_at: now,
			updated_at: now,
		});
		this.trim();
		this.persist();
		return { disposition: "accepted", installation_id: registration.installation_id };
	}

	revoke(routeAgentId: string, subjectAgentId: string, installationId: string): number {
		const before = this.document.registrations.length;
		this.document.registrations = this.document.registrations.filter((registration) => !(
			registration.route_agent_id === routeAgentId
			&& registration.subject_agent_id === subjectAgentId
			&& registration.installation_id === installationId
		));
		const removed = before - this.document.registrations.length;
		if (removed > 0) this.persist();
		return removed;
	}

	hasAuthorizedRelationship(
		routeAgentId: string,
		subjectAgentId: string,
		bindingId: string,
		contextKind: string,
	): boolean {
		return this.document.registrations.some((registration) =>
			registration.route_agent_id === routeAgentId
			&& registration.subject_agent_id === subjectAgentId
			&& registration.binding_id === bindingId
			&& registration.supported_contexts.includes(contextKind as never));
	}

	admitNotification(
		value: unknown,
		authoritativeEventKind?: OwnerPushAuthoritativeEventKind,
	): OwnerPushAdmissionResult {
		const envelope = parseOwnerPushEnvelope(value);
		if (!envelope) throw new OwnerPushStoreError(400, "invalid_owner_push_envelope");
		const fingerprint = ownerPushRouteFingerprint(envelope);
		const existing = this.document.notifications.find(
			(candidate) => candidate.envelope.notification_id === envelope.notification_id,
		);
		if (existing) {
			const exact = existing.route_fingerprint === fingerprint
				&& existing.authoritative_event_kind === authoritativeEventKind;
			return { disposition: exact ? "duplicate" : "conflict" };
		}
		const now = this.now().toISOString();
		this.document.notifications.push({
			envelope,
			route_fingerprint: fingerprint,
			...(authoritativeEventKind ? { authoritative_event_kind: authoritativeEventKind } : {}),
			state: "unread",
			created_at: now,
			deliveries: [],
		});
		this.trim();
		this.persist();
		return { disposition: "accepted" };
	}

	planDispatches(notificationId: string): OwnerPushDispatchPlan[] {
		const notification = this.notification(notificationId);
		const payload = ownerPushAPNSPayload(notification.envelope);
		const now = this.now().toISOString();
		const plans: OwnerPushDispatchPlan[] = [];
		for (const registration of this.document.registrations) {
			if (registration.binding_id !== notification.envelope.binding_id
				|| registration.route_agent_id !== notification.envelope.route_agent_id
				|| registration.subject_agent_id !== notification.envelope.subject_agent_id
				|| !registration.supported_contexts.includes(notification.envelope.context.kind)) continue;
			let delivery = notification.deliveries.find(
				(candidate) => candidate.registration_key === registration.key,
			);
			if (delivery?.state === "accepted" || delivery?.state === "rejected") continue;
			if (!delivery) {
				delivery = {
					registration_key: registration.key,
					state: "pending",
					attempts: 0,
					updated_at: now,
				};
				notification.deliveries.push(delivery);
			}
			delivery.attempts += 1;
			delivery.updated_at = now;
			plans.push({
				registrationKey: registration.key,
				request: {
					deviceToken: registration.device_token,
					environment: registration.environment,
					collapseId: notification.envelope.notification_id,
					payload,
				},
			});
		}
		if (plans.length > 0) this.persist();
		return plans;
	}

	completeDispatch(
		notificationId: string,
		registrationKey: string,
		result: OwnerPushTransportResult,
	): void {
		const notification = this.notification(notificationId);
		const delivery = notification.deliveries.find(
			(candidate) => candidate.registration_key === registrationKey,
		);
		if (!delivery) throw new OwnerPushStoreError(404, "owner_push_dispatch_not_found");
		delivery.updated_at = this.now().toISOString();
		if (result.accepted) delivery.state = "accepted";
		else if (result.permanentTokenFailure) {
			delivery.state = "rejected";
			this.document.registrations = this.document.registrations.filter(
				(registration) => registration.key !== registrationKey,
			);
		} else {
			delivery.state = "pending";
		}
		this.persist();
	}

	acknowledge(
		acknowledgment: OwnerPushAcknowledgment,
		routeAgentId: string,
		subjectAgentId: string,
	): OwnerPushAcknowledgmentResult {
		const notification = this.notification(acknowledgment.notification_id);
		if (notification.envelope.route_agent_id !== routeAgentId
			|| notification.envelope.subject_agent_id !== subjectAgentId
			|| notification.envelope.binding_id !== acknowledgment.binding_id) {
			throw new OwnerPushStoreError(404, "owner_push_notification_not_found");
		}
		const registration = this.document.registrations.find((candidate) =>
			candidate.installation_id === acknowledgment.installation_id
			&& candidate.binding_id === acknowledgment.binding_id
			&& candidate.route_agent_id === routeAgentId
			&& candidate.subject_agent_id === subjectAgentId);
		const delivery = registration
			? notification.deliveries.find((candidate) => candidate.registration_key === registration.key)
			: undefined;
		if (!registration || !delivery || delivery.state === "rejected") {
			throw new OwnerPushStoreError(403, "owner_push_acknowledgment_unauthorized");
		}
		const now = this.now().toISOString();
		let changed = false;
		if (delivery.state === "pending") {
			// An exact receiving installation is stronger custody evidence than an
			// ambiguous APNs response. Do not resend it after this acknowledgment.
			delivery.state = "accepted";
			delivery.updated_at = now;
			changed = true;
		}
		if (acknowledgment.state === "opened" && notification.state !== "opened") {
			if (!notification.read_at) notification.read_at = now;
			notification.state = "opened";
			notification.opened_at = now;
			changed = true;
		} else if (acknowledgment.state === "read" && notification.state === "unread") {
			notification.state = "read";
			notification.read_at = now;
			changed = true;
		}
		if (changed) this.persist();
		return {
			notification_id: acknowledgment.notification_id,
			state: notification.state,
			changed,
		};
	}

	snapshot(): OwnerPushStoreSnapshot {
		return {
			version: OWNER_PUSH_VERSION,
			registrations: this.document.registrations.map((registration) => ({
				key: registration.key,
				installation_id: registration.installation_id,
				binding_id: registration.binding_id,
				route_agent_id: registration.route_agent_id,
				subject_agent_id: registration.subject_agent_id,
				environment: registration.environment,
				supported_contexts: [...registration.supported_contexts],
				created_at: registration.created_at,
				updated_at: registration.updated_at,
			})),
			notifications: this.document.notifications.map((notification) => ({
				notification_id: notification.envelope.notification_id,
				route_fingerprint: notification.route_fingerprint,
				...(notification.authoritative_event_kind
					? { authoritative_event_kind: notification.authoritative_event_kind }
					: {}),
				state: notification.state,
				created_at: notification.created_at,
				...(notification.read_at ? { read_at: notification.read_at } : {}),
				...(notification.opened_at ? { opened_at: notification.opened_at } : {}),
				deliveries: notification.deliveries.map((delivery) => ({ ...delivery })),
			})),
		};
	}

	private notification(notificationId: string): StoredNotification {
		const notification = this.document.notifications.find(
			(candidate) => candidate.envelope.notification_id === notificationId,
		);
		if (!notification) throw new OwnerPushStoreError(404, "owner_push_notification_not_found");
		return notification;
	}

	private trim(): void {
		if (this.document.registrations.length > this.maximumRegistrations) {
			this.document.registrations.sort((left, right) =>
				left.updated_at.localeCompare(right.updated_at) || left.key.localeCompare(right.key));
			this.document.registrations = this.document.registrations.slice(-this.maximumRegistrations);
		}
		if (this.document.notifications.length > this.maximumNotifications) {
			this.document.notifications.sort((left, right) =>
				left.created_at.localeCompare(right.created_at)
				|| left.envelope.notification_id.localeCompare(right.envelope.notification_id));
			this.document.notifications = this.document.notifications.slice(-this.maximumNotifications);
		}
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		const stat = lstatSync(this.path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Owner push store must be a regular file");
		if ((stat.mode & 0o077) !== 0) throw new Error("Owner push store must not be accessible by group or others");
		let parsed: unknown;
		try { parsed = JSON.parse(readFileSync(this.path, "utf8")); }
		catch { throw new Error("Owner push store is unreadable"); }
		if (!isStoreDocument(parsed)) throw new Error("Owner push store is unreadable");
		this.document = parsed;
		this.trim();
	}

	private persist(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.tmp-${process.pid}`;
		writeFileSync(temporary, `${JSON.stringify(this.document, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.path);
		chmodSync(this.path, 0o600);
	}
}

export class OwnerPushStoreError extends Error {
	constructor(readonly status: number, readonly code: string) { super(code); }
}

function registrationsEqual(
	left: OwnerPushDeviceRegistration,
	right: OwnerPushDeviceRegistration,
): boolean {
	return left.version === right.version
		&& left.installation_id === right.installation_id
		&& left.binding_id === right.binding_id
		&& left.route_agent_id === right.route_agent_id
		&& left.subject_agent_id === right.subject_agent_id
		&& left.device_token === right.device_token
		&& left.environment === right.environment
		&& [...left.supported_contexts].sort().join(",") === [...right.supported_contexts].sort().join(",");
}

function boundedMaximum(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
		throw new Error("Owner push store maximum is invalid");
	}
	return value;
}

function isStoreDocument(value: unknown): value is OwnerPushStoreDocument {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as OwnerPushStoreDocument;
	if (candidate.version !== OWNER_PUSH_VERSION
		|| !Array.isArray(candidate.registrations)
		|| !Array.isArray(candidate.notifications)) return false;
	const registrationKeys = new Set<string>();
	for (const registration of candidate.registrations) {
		const parsed = parseOwnerPushRegistration({
			version: registration.version,
			installation_id: registration.installation_id,
			binding_id: registration.binding_id,
			route_agent_id: registration.route_agent_id,
			subject_agent_id: registration.subject_agent_id,
			device_token: registration.device_token,
			environment: registration.environment,
			supported_contexts: registration.supported_contexts,
		});
		if (!parsed
			|| registration.key !== ownerPushRegistrationKey(parsed)
			|| registrationKeys.has(registration.key)
			|| !isDate(registration.created_at)
			|| !isDate(registration.updated_at)) return false;
		registrationKeys.add(registration.key);
	}
	const notificationIds = new Set<string>();
	for (const notification of candidate.notifications) {
		const envelope = parseOwnerPushEnvelope(notification.envelope);
		if (!envelope
			|| notification.route_fingerprint !== ownerPushRouteFingerprint(envelope)
			|| (notification.authoritative_event_kind !== undefined
				&& notification.authoritative_event_kind !== "completion"
				&& notification.authoritative_event_kind !== "action")
			|| notificationIds.has(envelope.notification_id)
			|| !["unread", "read", "opened"].includes(notification.state)
			|| !isDate(notification.created_at)
			|| (notification.read_at !== undefined && !isDate(notification.read_at))
			|| (notification.opened_at !== undefined && !isDate(notification.opened_at))
			|| !Array.isArray(notification.deliveries)) return false;
		if (notification.state === "unread" && (notification.read_at || notification.opened_at)) return false;
		if (notification.state === "read" && (!notification.read_at || notification.opened_at)) return false;
		if (notification.state === "opened" && (!notification.read_at || !notification.opened_at)) return false;
		const deliveryKeys = new Set<string>();
		for (const delivery of notification.deliveries) {
			if (!/^[a-f0-9]{64}$/.test(delivery.registration_key)
				|| deliveryKeys.has(delivery.registration_key)
				|| !["pending", "accepted", "rejected"].includes(delivery.state)
				|| !Number.isSafeInteger(delivery.attempts)
				|| delivery.attempts < 1
				|| !isDate(delivery.updated_at)) return false;
			deliveryKeys.add(delivery.registration_key);
		}
		notificationIds.add(envelope.notification_id);
	}
	return true;
}

function isDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}
