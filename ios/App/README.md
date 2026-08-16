# iPhone app

The iPhone app opens to the authorized-agent chooser, remembers the exact selected resident, and then presents only that resident's sanitized durable/live conversation. Capabilities and the optional Deepgram key stay in Keychain with this-device-only accessibility; WatchConnectivity receives only `WatchConversationSnapshot` values and exact-agent commands.

Push-to-talk uses the accepted Yappatron mobile audio contract: 16 kHz mono linear PCM, Deepgram `nova-3`, interim results, punctuation, smart formatting, endpointing, and explicit finalization on release. A provider failure is visible state and is never submitted as human text. Assistant speech is serialized and claimed by authoritative completion ID so reconnect or durable replay cannot speak one completion twice.

The Xcode project owns the source membership. `OAuthClient.swift` is retained as historical source but is deliberately not compiled: current authorization is an exact resident capability, not the previous fleet OAuth/file-browser prototype.
