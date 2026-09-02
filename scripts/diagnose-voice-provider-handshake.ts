#!/usr/bin/env npx tsx

import { createDeepgramVoiceTranscriptionProvider, type VoiceProviderHandshakeDiagnostic } from "../src/host/node/deepgram-voice-session.js";
import type { VoiceTranscriptionSession } from "../src/console/voice-session-runtime.js";

const sourceIdentity = safeArgument(process.argv[2]);
const runtimeIdentity = safeArgument(process.argv[3]);
const provider = createDeepgramVoiceTranscriptionProvider(process.env, {
	sourceIdentity,
	runtimeIdentity,
	requestID: () => "request-owner-authorized-probe",
});

if (!provider) {
	console.log(JSON.stringify({ outcome: "unavailable", response_category: "credential_source_unavailable", source_identity: sourceIdentity, runtime_identity: runtimeIdentity }));
	process.exitCode = 2;
} else {
	let activeSession: VoiceTranscriptionSession | undefined;
	const diagnostic = await new Promise<VoiceProviderHandshakeDiagnostic>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Provider handshake diagnostic timed out")), 20_000);
		const observed = createDeepgramVoiceTranscriptionProvider(process.env, {
			sourceIdentity,
			runtimeIdentity,
			requestID: () => "request-owner-authorized-probe",
			onHandshakeDiagnostic(value) {
				clearTimeout(timeout);
				activeSession?.cancel();
				resolve(value);
			},
		});
		if (!observed) {
			clearTimeout(timeout);
			reject(new Error("Provider credential source became unavailable"));
			return;
		}
		activeSession = observed.open(
			{
				session_id: "session-owner-authorized-probe",
				capture_id: "capture-owner-authorized-probe",
				delivery_id: "delivery-owner-authorized-probe",
				subject_agent_id: "agent-owner-authorized-probe",
			},
			{ speechStarted() {}, partial() {}, endOfUtterance() {}, final() {}, error() {} },
		);
	});
	console.log(JSON.stringify(diagnostic));
}

function safeArgument(value: string | undefined): string {
	const text = value?.trim() || "unknown";
	return /^[A-Za-z0-9_.:-]{1,128}$/.test(text) ? text : "unknown";
}
