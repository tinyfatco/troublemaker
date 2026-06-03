import SwiftUI

@main
struct TroublemakerMacApp: App {
	@NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
	@StateObject private var model = AppModel()

	init() {
		if SmokeCommand.shouldRun {
			SmokeCommand.runAndExit()
		}
	}

	var body: some Scene {
		WindowGroup("Troublemaker") {
			MainChatView(
				showFloatingChat: {
					appDelegate.attach(model: model)
					appDelegate.showFloatingChat()
				},
				showOverlay: {
					appDelegate.attach(model: model)
					appDelegate.showOverlay()
				},
				hidePanels: {
					appDelegate.hideAssistantPanels()
				}
			)
				.environmentObject(model)
				.onAppear {
					appDelegate.attach(model: model)
					model.start()
				}
		}
		.windowToolbarStyle(.unified)
		.commands {
			CommandMenu("Runtime") {
				Button("Restart Backend") {
					model.restartBackend()
				}
				.keyboardShortcut("r", modifiers: [.command, .shift])

				Button("Build and Restart Backend") {
					model.restartBackend(build: true)
				}

				Divider()

				Button("Stop Active Run") {
					model.stopActiveRun()
				}
				.keyboardShortcut(".", modifiers: [.command])
				.disabled(!model.isSending)

				Button("Stop Backend") {
					model.stopBackend()
				}
			}

			CommandMenu("Assistant Panels") {
				Button("Show Floating Chat") {
					appDelegate.attach(model: model)
					appDelegate.showFloatingChat()
				}
				.keyboardShortcut("j", modifiers: [.command, .shift])

				Button("Show Overlay") {
					appDelegate.attach(model: model)
					appDelegate.showOverlay()
				}
				.keyboardShortcut("o", modifiers: [.command, .shift])

				Divider()

				Button("Hide Panels") {
					appDelegate.hideAssistantPanels()
				}
				.keyboardShortcut("h", modifiers: [.command, .shift])
			}
		}
	}
}
