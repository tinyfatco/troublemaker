# troublemaker-ios

iOS app for [Troublemaker](https://github.com/tinyfatco/troublemaker). Talks to the same `/api/v2/agents/*` surface as the web UI at `tinyfat.com/app`.

## Layout

- `Sources/TroublemakerCore/` — UI-free Swift library: OAuth, REST, SSE.
- `Sources/TroublemakerUI/` — SwiftUI views built on `TroublemakerCore`.
- `Tests/TroublemakerCoreTests/` — XCTest suites for the core library.
- `TroublemakerIOS/` — Xcode App target (added in step 6).

## Target

iOS 17+. OAuth 2.1 + PKCE against `https://crawdad.tinyfat.com`. URL scheme `tfat://oauth-callback`.

## Build

```bash
swift build           # builds the libraries headlessly (Mac, no Xcode UI)
swift test            # runs CoreTests
```

The App target lives in `TroublemakerIOS.xcodeproj` and links the two SwiftPM libraries.
