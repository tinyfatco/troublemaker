import Foundation
import XCTest
@testable import TroublemakerMobileCore

final class AgentBindingTests: XCTestCase {
    func testExactBindingBuildsOnlyItsOwnAgentRoute() throws {
        let binding = try AgentBinding(
            id: "binding-one",
            displayName: "Example Agent",
            baseURL: XCTUnwrap(URL(string: "https://agent.example.com/base")),
            routeAgentID: "current",
            subjectAgentID: "agent-example"
        )
        let url = try binding.consoleURL("events", query: [
            URLQueryItem(name: "surface", value: "conversation"),
        ])
        XCTAssertEqual(url.path, "/base/api/v2/agents/current/events")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "conversation")
        XCTAssertNoThrow(try binding.verify(.init(
            agentId: "agent-example",
            agentName: "Example Agent",
            workspaceReady: true
        )))
        XCTAssertThrowsError(try binding.verify(.init(
            agentId: "different-agent",
            agentName: "Different Agent",
            workspaceReady: true
        )))
    }

    func testRemoteHTTPAndTraversalAreRejected() throws {
        XCTAssertThrowsError(try AgentBinding(
            displayName: "Example Agent",
            baseURL: XCTUnwrap(URL(string: "http://agent.example.com")),
            routeAgentID: "current",
            subjectAgentID: "agent-example"
        ))
        let local = try AgentBinding(
            displayName: "Local Agent",
            baseURL: XCTUnwrap(URL(string: "http://127.0.0.1:3002")),
            routeAgentID: "current",
            subjectAgentID: "agent-example"
        )
        XCTAssertThrowsError(try local.consoleURL("../files"))
    }

    func testEnrollmentValidationNamesEveryMissingOrInvalidField() throws {
        let missing = AgentEnrollmentValidation(
            displayName: "  ",
            endpoint: "https://",
            routeAgentID: " ",
            capability: "\n"
        )
        XCTAssertFalse(missing.isValid)
        XCTAssertEqual(missing.firstInvalidField, .displayName)
        XCTAssertEqual(missing.error(for: .displayName), "Enter a display name.")
        XCTAssertEqual(missing.error(for: .endpoint), "Enter a complete private HTTPS endpoint.")
        XCTAssertEqual(missing.error(for: .routeAgentID), "Enter the exact route agent ID.")
        XCTAssertEqual(missing.error(for: .capability), "Paste the existing agent capability.")

        let invalidRoute = AgentEnrollmentValidation(
            displayName: "Example Agent",
            endpoint: "https://agent.example.com",
            routeAgentID: "not a route",
            capability: "fixture-capability"
        )
        XCTAssertEqual(
            invalidRoute.error(for: .routeAgentID),
            "Use only letters, numbers, -, _, ., or : in the route agent ID."
        )
    }

    func testEnrollmentValidationNormalizesACompleteExactBinding() throws {
        let validation = AgentEnrollmentValidation(
            displayName: "  Example Agent  ",
            endpoint: "  https://agent.example.com/private  ",
            routeAgentID: "  agent-example  ",
            capability: "  fixture-capability  "
        )
        XCTAssertTrue(validation.isValid)
        XCTAssertNil(validation.firstInvalidField)
        XCTAssertEqual(validation.displayName, "Example Agent")
        XCTAssertEqual(validation.baseURL?.absoluteString, "https://agent.example.com/private")
        XCTAssertEqual(validation.routeAgentID, "agent-example")
        XCTAssertEqual(validation.capability, "fixture-capability")

        let credentialURL = AgentEnrollmentValidation(
            displayName: "Example Agent",
            endpoint: "https://user:secret@agent.example.com",
            routeAgentID: "agent-example",
            capability: "fixture-capability"
        )
        XCTAssertEqual(credentialURL.error(for: .endpoint), "Enter a complete private HTTPS endpoint.")
    }

    func testVerificationFailureTextIsExactAndNeverEchoesProviderBodies() {
        XCTAssertEqual(
            AgentVerificationFailureText.httpStatus(401),
            "Agent verification failed (HTTP 401): the capability was rejected."
        )
        XCTAssertEqual(
            AgentVerificationFailureText.httpStatus(403),
            "Agent verification failed (HTTP 403): the capability cannot access that agent."
        )
        XCTAssertEqual(
            AgentVerificationFailureText.httpStatus(404),
            "Agent verification failed (HTTP 404): the endpoint or route agent ID was not found."
        )
        XCTAssertEqual(AgentVerificationFailureText.httpStatus(500), "Agent verification failed (HTTP 500).")
    }

    func testCapabilityFieldUsesExistingTokenSemanticsAndKeepsNativePaste() throws {
        let iosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: iosRoot.appendingPathComponent("App/Screens/LoginView.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(source.contains("SecureField(\"Agent capability\""))
        XCTAssertTrue(source.contains(".textContentType(.oneTimeCode)"))
        XCTAssertTrue(source.contains(".privacySensitive()"))
        XCTAssertFalse(source.contains(".textContentType(.password)"))
        XCTAssertFalse(source.contains(".textContentType(.newPassword)"))
        XCTAssertTrue(source.contains(".disabled(viewModel.isEnrolling)"))
        XCTAssertFalse(source.contains(".disabled(!canSubmit)"))
    }
}

final class ConversationContractTests: XCTestCase {
    func testSingleLineJSONSSEPayloadDoesNotWaitForBlankDelimiter() {
        var parser = SSELineParser()
        XCTAssertEqual(parser.consume("id: 41"), [])
        XCTAssertEqual(
            parser.consume("data: {\"kind\":\"message\"}"),
            [.init(data: "{\"kind\":\"message\"}", id: "41")]
        )
        XCTAssertEqual(parser.consume(": heartbeat"), [])
        XCTAssertEqual(parser.consume(""), [])

        XCTAssertEqual(parser.consume("data: first"), [])
        XCTAssertEqual(parser.consume("data: second"), [])
        XCTAssertEqual(parser.consume(""), [.init(data: "first\nsecond", id: nil)])
    }

    func testFixtureLiveFrameDecodesAndApplies() throws {
        let raw = #"{"sequence":1,"stream_id":"fixture-stream","id":"fixture-event-1","timestamp":"2026-08-16T03:06:06.971Z","kind":"message","message":{"id":"fixture-user-1","timestamp":"2026-08-16T03:06:06.971Z","role":"user","text":"Live relay","channel":"ios","user_name":"you","is_error":false,"speech_eligible":false}}"#
        let event = try JSONDecoder.troublemakerMobile().decode(
            ConversationLiveEvent.self,
            from: XCTUnwrap(raw.data(using: .utf8))
        )
        var reducer = ConversationReducer(bindingID: "binding-one")
        XCTAssertEqual(reducer.apply(event, for: "binding-one"), [])
        XCTAssertEqual(reducer.messages.map(\.text), ["Live relay"])
    }

    func testImmediateReadyCursorDecodesWithoutInventingConversationContent() throws {
        let raw = #"{"sequence":0,"stream_id":"fixture-stream","id":"fixture-ready","timestamp":"2026-08-16T03:06:06.971Z","kind":"cursor"}"#
        let event = try JSONDecoder.troublemakerMobile().decode(
            ConversationLiveEvent.self,
            from: XCTUnwrap(raw.data(using: .utf8))
        )
        var reducer = ConversationReducer(bindingID: "binding-one")
        XCTAssertEqual(reducer.apply(event, for: "binding-one"), [])
        XCTAssertEqual(reducer.streamID, "fixture-stream")
        XCTAssertTrue(reducer.messages.isEmpty)
    }

    func testConversationDecoderPreservesFullExactTextAndIgnoresUnknownPayloads() throws {
        let longText = String(repeating: "Full text with **Markdown** and code. ", count: 30)
        let data = try JSONSerialization.data(withJSONObject: [
            "id": "assistant-one",
            "timestamp": "2026-01-01T00:00:00Z",
            "role": "assistant",
            "text": longText,
            "completion_id": "completion-one",
            "is_error": false,
            "speech_eligible": true,
            "thinking": "PRIVATE_THINKING",
            "tool_arguments": ["command": "PRIVATE_ARGUMENT"],
        ])
        let message = try JSONDecoder.troublemakerMobile().decode(ConversationMessage.self, from: data)
        XCTAssertEqual(message.text, longText)
        XCTAssertEqual(message.completionId, "completion-one")
        XCTAssertTrue(message.speechEligible)
    }

    func testOrderedLiveAndDurableProjectionProducesOneMessageAndOneSpeech() {
        var reducer = ConversationReducer(bindingID: "binding-one")
        XCTAssertEqual(reducer.apply(event(sequence: 1, kind: .state, runID: "run-one"), for: "binding-one"), [])
        XCTAssertEqual(reducer.activeRunCount, 1)

        let assistant = event(
            sequence: 2,
            kind: .assistant,
            runID: "run-one",
            text: "Exact completion",
            isFinal: true,
            speechEligible: true
        )
        XCTAssertEqual(reducer.apply(assistant, for: "binding-one"), [])
        XCTAssertEqual(reducer.messages.map(\.text), ["Exact completion"])

        let durable = ConversationMessage(
            id: "durable-one",
            timestamp: "2026-01-01T00:00:03Z",
            role: .assistant,
            text: "Exact completion",
            completionId: "durable-one",
            speechEligible: true
        )
        XCTAssertEqual(
            reducer.apply(event(sequence: 3, kind: .message, message: durable), for: "binding-one"),
            []
        )
        XCTAssertEqual(reducer.messages.count, 1)
        XCTAssertEqual(reducer.messages.first?.id, "durable-one")
        XCTAssertEqual(reducer.messages.first?.completionId, "run-one")

        let completion = event(sequence: 4, kind: .completion, runID: "run-one", completionID: "run-one")
        XCTAssertEqual(
            reducer.apply(completion, for: "binding-one"),
            [.speak(.init(completionID: "run-one", text: "Exact completion"))]
        )
        XCTAssertEqual(reducer.activeRunCount, 0)
        XCTAssertEqual(reducer.apply(completion, for: "binding-one"), [])

        let reconnectSnapshot = event(
            sequence: 1,
            streamID: "stream-two",
            kind: .assistant,
            runID: "run-one",
            text: "Exact completion",
            isFinal: true,
            speechEligible: true
        )
        XCTAssertEqual(reducer.apply(reconnectSnapshot, for: "binding-one"), [.refreshBacklog])
        let reconnectCompletion = event(
            sequence: 2,
            streamID: "stream-two",
            kind: .completion,
            runID: "run-one",
            completionID: "run-one"
        )
        XCTAssertEqual(reducer.apply(reconnectCompletion, for: "binding-one"), [])
    }

    func testErrorsNeverBecomeSpeechAndOtherAgentEventsAreIgnored() {
        var reducer = ConversationReducer(bindingID: "binding-one")
        let assistantError = event(
            sequence: 1,
            kind: .assistant,
            runID: "run-error",
            text: "Proxy returned HTTP 500: exact body",
            isFinal: true,
            isError: true,
            speechEligible: false
        )
        XCTAssertEqual(reducer.apply(assistantError, for: "binding-two"), [])
        XCTAssertTrue(reducer.messages.isEmpty)
        XCTAssertEqual(reducer.apply(assistantError, for: "binding-one"), [])
        XCTAssertEqual(
            reducer.apply(event(sequence: 2, kind: .completion, runID: "run-error"), for: "binding-one"),
            []
        )
        XCTAssertEqual(reducer.messages.first?.text, "Proxy returned HTTP 500: exact body")
        XCTAssertEqual(reducer.messages.first?.speechEligible, false)
    }

    func testLegacyIncrementalTextDeltasAppendWithoutAbridging() {
        var reducer = ConversationReducer(bindingID: "binding-one")
        let first = ConversationLiveEvent(
            sequence: 1,
            streamId: "stream-one",
            id: "event-1",
            timestamp: "2026-01-01T00:00:01Z",
            kind: .assistant,
            runId: "run-one",
            delta: "The complete ",
            replace: false,
            isFinal: false,
            isError: false,
            speechEligible: true
        )
        let second = ConversationLiveEvent(
            sequence: 2,
            streamId: "stream-one",
            id: "event-2",
            timestamp: "2026-01-01T00:00:02Z",
            kind: .assistant,
            runId: "run-one",
            delta: "message remains intact.",
            replace: false,
            isFinal: false,
            isError: false,
            speechEligible: true
        )
        XCTAssertEqual(reducer.apply(first, for: "binding-one"), [])
        XCTAssertEqual(reducer.apply(second, for: "binding-one"), [])
        XCTAssertEqual(reducer.messages.first?.text, "The complete message remains intact.")
    }

    func testDurableUserReconciliationUsesOnlyExactDeliveryIdentity() {
        var reducer = ConversationReducer(bindingID: "binding-one")
        reducer.appendOptimisticUser(text: "same body", deliveryID: "delivery-one")
        reducer.appendOptimisticUser(text: "same body", deliveryID: "delivery-two")

        let durable = ConversationMessage(
            id: "durable-two",
            timestamp: "2026-01-01T00:00:03Z",
            role: .user,
            text: "same body",
            userName: "you",
            deliveryId: "delivery-two"
        )
        XCTAssertEqual(
            reducer.apply(event(sequence: 1, kind: .message, message: durable), for: "binding-one"),
            []
        )
        XCTAssertTrue(reducer.messages.contains { $0.id == "pending:delivery-one" })
        XCTAssertFalse(reducer.messages.contains { $0.id == "pending:delivery-two" })
        XCTAssertTrue(reducer.messages.contains { $0.id == "durable-two" })
    }

    func testBacklogRestartPreservesUnmatchedPendingAndReconcilesExactID() {
        var reducer = ConversationReducer(bindingID: "binding-one")
        reducer.appendOptimisticUser(
            text: "persisted text",
            deliveryID: "delivery-persisted",
            timestamp: "2026-01-01T00:00:01Z"
        )
        reducer.appendOptimisticUser(
            text: "persisted text",
            deliveryID: "delivery-other",
            timestamp: "2026-01-01T00:00:02Z"
        )
        reducer.loadBacklog(.init(
            messages: [.init(
                id: "durable-persisted",
                timestamp: "2026-01-01T00:00:03Z",
                role: .user,
                text: "persisted text",
                deliveryId: "delivery-persisted"
            )],
            total: 1,
            offset: 0
        ), for: "binding-one")

        XCTAssertFalse(reducer.messages.contains { $0.id == "pending:delivery-persisted" })
        XCTAssertTrue(reducer.messages.contains { $0.id == "pending:delivery-other" })
        XCTAssertTrue(reducer.messages.contains { $0.id == "durable-persisted" })
    }

    private func event(
        sequence: Int,
        streamID: String = "stream-one",
        kind: ConversationLiveKind,
        runID: String? = nil,
        completionID: String? = nil,
        message: ConversationMessage? = nil,
        text: String? = nil,
        isFinal: Bool? = nil,
        isError: Bool? = nil,
        speechEligible: Bool? = nil
    ) -> ConversationLiveEvent {
        ConversationLiveEvent(
            sequence: sequence,
            streamId: streamID,
            id: "event-\(streamID)-\(sequence)",
            timestamp: String(format: "2026-01-01T00:00:%02dZ", sequence),
            kind: kind,
            message: message,
            runId: runID,
            completionId: completionID,
            text: text,
            isFinal: isFinal,
            isError: isError,
            speechEligible: speechEligible
        )
    }
}

final class DeliveryAndRelayTests: XCTestCase {
    func testUnknownDeliveryNeverAutoResends() {
        var attempt = DeliveryAttempt(id: "delivery-one", bindingID: "binding-one", exactText: "Exact prompt")
        attempt.beginRequest()
        attempt.failTransport()
        XCTAssertEqual(attempt.state, .unknown)
        XCTAssertFalse(attempt.mayAutomaticallyResend)

        var preflight = DeliveryAttempt(id: "delivery-two", bindingID: "binding-one", exactText: "Exact prompt")
        preflight.failTransport()
        XCTAssertEqual(preflight.state, .failedBeforeSend)
        XCTAssertFalse(preflight.mayAutomaticallyResend)
    }

    func testAcceptedAndCompletedReceiptsSurviveResponseStreamLoss() {
        var accepted = DeliveryAttempt(
            id: "delivery-accepted",
            bindingID: "binding-one",
            exactText: "Exact prompt",
            createdAt: "2026-01-01T00:00:00Z"
        )
        accepted.beginRequest()
        accepted.reconcile(.init(deliveryId: accepted.id, state: .accepted))
        accepted.failTransport()
        XCTAssertEqual(accepted.state, .accepted)
        XCTAssertFalse(accepted.mayAutomaticallyResend)

        accepted.reconcile(.init(deliveryId: accepted.id, state: .completed))
        accepted.failTransport()
        XCTAssertEqual(accepted.state, .completed)
        XCTAssertFalse(accepted.mayAutomaticallyResend)
    }

    func testPendingLedgerRoundTripReconcilesRestartByStableIDOnly() throws {
        var first = DeliveryAttempt(
            id: "delivery-first",
            bindingID: "binding-one",
            exactText: "same body",
            createdAt: "2026-01-01T00:00:00Z"
        )
        first.beginRequest()
        first.failTransport()
        var second = DeliveryAttempt(
            id: "delivery-second",
            bindingID: "binding-one",
            exactText: "same body",
            createdAt: "2026-01-01T00:00:01Z"
        )
        second.beginRequest()
        second.failTransport()

        let persisted = PendingDeliveryLedger(attempts: [first, second])
        var restored = try JSONDecoder().decode(
            PendingDeliveryLedger.self,
            from: JSONEncoder().encode(persisted)
        )
        restored.reconcile([.init(deliveryId: "delivery-second", state: .completed)])

        XCTAssertEqual(restored.attempts.first { $0.id == "delivery-first" }?.state, .unknown)
        XCTAssertEqual(restored.attempts.first { $0.id == "delivery-second" }?.state, .completed)
        XCTAssertTrue(restored.attempts.allSatisfy { !$0.mayAutomaticallyResend })
    }

    func testWatchCommandsAreExactAgentBoundAndDeduplicated() {
        var ledger = WatchCommandLedger()
        let command = WatchCommand(id: "command-one", bindingID: "binding-one", kind: .prompt, text: "Hello")
        XCTAssertFalse(ledger.claim(command, selectedBindingID: "binding-two"))
        XCTAssertTrue(ledger.claim(command, selectedBindingID: "binding-one"))
        XCTAssertFalse(ledger.claim(command, selectedBindingID: "binding-one"))
        XCTAssertFalse(WatchCommand(bindingID: "binding-one", kind: .prompt, text: "  ").isAuthorized(for: "binding-one"))
    }

    func testWatchSnapshotIsBoundedAndContainsOnlyConversationProjection() throws {
        let messages = (0..<24).map { index in
            ConversationMessage(
                id: "message-\(index)",
                timestamp: String(format: "2026-01-01T00:00:%02dZ", index),
                role: index.isMultiple(of: 2) ? .user : .assistant,
                text: "Exact message \(index)",
                speechEligible: false
            )
        }
        let snapshot = WatchConversationSnapshot(
            bindingID: "binding-one",
            agentName: "Example Agent",
            state: .thinking,
            statusText: "Thinking…",
            messages: messages
        )
        XCTAssertEqual(snapshot.messages.count, 20)
        XCTAssertEqual(snapshot.messages.first?.id, "message-4")
        let encoded = String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)
        XCTAssertFalse(encoded.localizedCaseInsensitiveContains("token"))
        XCTAssertFalse(encoded.localizedCaseInsensitiveContains("credential"))
        XCTAssertFalse(encoded.localizedCaseInsensitiveContains("tool"))
        XCTAssertFalse(encoded.localizedCaseInsensitiveContains("thinking_payload"))
    }

    func testSpeechIdentityLedgerClaimsCompletionOnce() async {
        let ledger = SpeechIdentityLedger()
        let first = await ledger.claim("completion-one")
        let duplicate = await ledger.claim("completion-one")
        let second = await ledger.claim("completion-two")
        XCTAssertTrue(first)
        XCTAssertFalse(duplicate)
        XCTAssertTrue(second)
    }
}

final class PresenceAndTranscriptionContractTests: XCTestCase {
    func testPresenceUsesAuthoritativeInputs() {
        XCTAssertEqual(PresenceInputs().state, .idle)
        XCTAssertEqual(PresenceInputs(activeRunCount: 1).state, .thinking)
        XCTAssertEqual(PresenceInputs(activeRunCount: 1, isSpeaking: true).state, .speaking)
        XCTAssertEqual(PresenceInputs(isListening: true, isSpeaking: true).state, .listening)
        XCTAssertEqual(PresenceInputs(errorMessage: "Network unavailable").state, .error)
    }

    func testDeepgramContractMatchesAcceptedYappatronMobileOptions() throws {
        let components = try XCTUnwrap(URLComponents(url: DeepgramMobileContract.streamingURL(), resolvingAgainstBaseURL: false))
        let options = Dictionary(uniqueKeysWithValues: try XCTUnwrap(components.queryItems).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(components.scheme, "wss")
        XCTAssertEqual(options, [
            "model": "nova-3",
            "punctuate": "true",
            "smart_format": "true",
            "interim_results": "true",
            "diarize": "true",
            "encoding": "linear16",
            "sample_rate": "16000",
            "channels": "1",
            "endpointing": "650",
            "utterance_end_ms": "1000",
        ])
        XCTAssertEqual(DeepgramCommitPolicy.pushToTalk.silenceDebounceMs, 900)
        XCTAssertEqual(DeepgramCommitPolicy.pushToTalk.speechFinalGraceMs, 450)
        XCTAssertEqual(DeepgramCommitPolicy.pushToTalk.utteranceEndGraceMs, 0)
        XCTAssertEqual(DeepgramMobileContract.linear16Sample(from: -2), .min)
        XCTAssertEqual(DeepgramMobileContract.linear16Sample(from: -1), .min)
        XCTAssertEqual(DeepgramMobileContract.linear16Sample(from: 0), 0)
        XCTAssertEqual(DeepgramMobileContract.linear16Sample(from: 1), .max)
        XCTAssertEqual(DeepgramMobileContract.linear16Sample(from: 2), .max)
    }
}
