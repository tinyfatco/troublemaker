import AppKit
import AuthenticationServices
import Foundation

extension ASWebAuthenticationSession {
	@MainActor
	static func troublemakerStart(url: URL, callbackURLScheme: String) async throws -> URL {
		try await withCheckedThrowingContinuation { continuation in
			let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackURLScheme) { callback, error in
				MacAuthSessionStore.shared.current = nil
				if let error {
					continuation.resume(throwing: error)
					return
				}
				guard let callback else {
					continuation.resume(throwing: URLError(.badServerResponse))
					return
				}
				continuation.resume(returning: callback)
			}
			session.presentationContextProvider = MacAuthPresentationProvider.shared
			session.prefersEphemeralWebBrowserSession = false
			MacAuthSessionStore.shared.current = session
			session.start()
		}
	}
}

@MainActor
private final class MacAuthSessionStore {
	static let shared = MacAuthSessionStore()
	var current: ASWebAuthenticationSession?
}

private final class MacAuthPresentationProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
	static let shared = MacAuthPresentationProvider()

	func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
		NSApp.keyWindow ?? NSApp.mainWindow ?? ASPresentationAnchor()
	}
}
