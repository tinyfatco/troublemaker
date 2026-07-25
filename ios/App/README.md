# TroublemakerIOS — App target

This directory contains the source files for the iOS App target. The `.xcodeproj` is **not** checked in yet because it benefits from being generated cleanly the first time inside Xcode.

## First-time setup (one-time, ~5 min)

1. `open -a Xcode` (Xcode 26.4.1+ is installed).
2. File → New → Project → iOS → App.
3. Configure:
   - Product Name: `TroublemakerIOS`
   - Team: (your Apple ID)
   - Organization Identifier: `com.tinyfatco`
   - Bundle Identifier (auto): `com.tinyfatco.troublemaker.ios`
   - Interface: SwiftUI
   - Language: Swift
4. Save the project at `troublemaker/ios/TroublemakerIOS/` so `TroublemakerIOSApp.swift` lands beside the existing `Info.plist`.
5. Delete the auto-generated `ContentView.swift` and `TroublemakerIOSApp.swift` Xcode created — keep the one already in this directory.
6. Add the SwiftPM packages as local package dependencies:
   - File → Add Package Dependencies → Add Local → select `troublemaker/ios/` (the package root).
   - Add `TroublemakerCore` and `TroublemakerUI` products to the App target.
7. In Signing & Capabilities, set your development team.
8. In Info, confirm the `tfat` URL scheme entry survived (from the Info.plist already in this directory).
9. Run on a simulator or device.

## Why no .xcodeproj checked in yet

Xcode rewrites pbxproj on every build setting tweak. Until the team grows, hand-merging that file is more trouble than re-running the wizard once. When the project stabilises we'll either commit the pbxproj or add `xcodegen` with a `project.yml`.

## Future: xcodegen

Drop a `project.yml` here:

```yaml
name: TroublemakerIOS
options:
  bundleIdPrefix: com.tinyfatco.troublemaker
targets:
  TroublemakerIOS:
    type: application
    platform: iOS
    deploymentTarget: "17.0"
    sources: [.]
    dependencies:
      - package: troublemaker-ios
        product: TroublemakerCore
      - package: troublemaker-ios
        product: TroublemakerUI
packages:
  troublemaker-ios:
    path: ..
```

Then `brew install xcodegen && xcodegen` rebuilds the `.xcodeproj`.
