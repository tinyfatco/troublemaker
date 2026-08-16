# Computer mobile

Computer's first native mobile slice pairs an iPhone conversation client with a watchOS companion. The phone binds to one explicitly authorized Troublemaker resident, stores its capability in Keychain, and renders only the server's sanitized conversation projection. The watch receives that same bounded projection through the paired phone; it never receives the resident capability or a transcription-provider key.

The UI deliberately excludes raw thinking, tool arguments or results, terminal access, generic MCP, file browsing, fleet inboxes, and cross-agent discovery. Delivery identity, reconnect cursors, stop/steering behavior, and one-completion/one-speech behavior remain part of the shared contract rather than being inferred by the views.

## Layout

- `MobileCore/` — platform-neutral exact-agent, conversation, delivery, speech identity, presence, Watch relay, and Deepgram contracts with Swift tests.
- `App/` — iOS 17+ SwiftUI app, Keychain enrollment, sanitized SSE client, typed input, push-to-talk, serialized speech, and phone-side Watch relay.
- `WatchApp/` — watchOS 10+ compact conversation, state orb, dictation, stop, and credential-free WatchConnectivity client.
- `Tests/Fixtures/` — loopback-only deterministic fixture used for simulator acceptance.
- `TroublemakerIOS.xcodeproj` — `TroublemakerIOS` phone target (product name `Computer`) plus embedded `ComputerWatch` companion target.

## Verification

```bash
swift test --package-path ios/MobileCore

xcodebuild -project ios/TroublemakerIOS.xcodeproj \
  -target TroublemakerIOS -configuration Debug -sdk iphonesimulator \
  CODE_SIGNING_ALLOWED=NO build

xcodebuild -project ios/TroublemakerIOS.xcodeproj \
  -target ComputerWatch -configuration Debug -sdk watchsimulator \
  CODE_SIGNING_ALLOWED=NO build
```

The full paired scheme requires installed matching iOS and watchOS Simulator runtimes. Simulator acceptance uses the fixture environment documented in `Tests/Fixtures/README.md`; it never calls a live resident, Deepgram, or a speech provider.

## Enrollment and signing

Production resident endpoints must use HTTPS. Loopback HTTP is accepted only for on-device development fixtures. A development team can be selected locally in Xcode for private device installation; no team identifier or provisioning profile is committed.

The enrollment form validates every required field inline and keeps Add
actionable until verification begins, so a missing value is identified instead
of represented by an unexplained disabled button. Agent capability and optional
Deepgram inputs are obscured existing-token fields with native paste support;
they never request password generation. Verification shows progress and only
projects stable, non-secret failure text.
