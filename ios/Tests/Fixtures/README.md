# Loopback mobile fixture

This fixture exists only for deterministic Simulator acceptance. It binds to `127.0.0.1`, uses fake agent data, exposes the same sanitized conversation shape as Troublemaker, and makes no outbound requests.

```bash
node ios/Tests/Fixtures/mobile-fixture-server.mjs
```

Launch the phone app with:

```text
COMPUTER_MOBILE_FIXTURE_BASE_URL=http://127.0.0.1:38919
COMPUTER_MOBILE_FIXTURE_NAME=Fixture Agent
COMPUTER_MOBILE_FIXTURE_ROUTE_ID=current
COMPUTER_MOBILE_FIXTURE_AGENT_ID=agent-fixture
```

No fixture token or transcription key is needed. Typed prompts receive a deterministic sanitized assistant completion. The fixture persists stable delivery-ID receipts, rejects duplicate execution, projects the same ID on the durable user turn, and emits an immediate live cursor plus recurring cursor heartbeats so reconnect/restart acceptance exercises the production contract. Fixture completions are marked ineligible for speech so visual acceptance remains quiet and provider-free.
