import AppKit
import SwiftUI

@MainActor
final class AssistantPanelController {
	private weak var model: AppModel?
	private var floatingPanel: NSPanel?
	private var overlayPanel: NSPanel?

	func attach(model: AppModel) {
		guard self.model !== model else { return }
		self.model = model
	}

	func showFloatingPanel() {
		guard let model else { return }
		if let floatingPanel {
			floatingPanel.orderFrontRegardless()
			return
		}

		let panel = NSPanel(
			contentRect: NSRect(x: 0, y: 0, width: 380, height: 136),
			styleMask: [.titled, .utilityWindow, .fullSizeContentView],
			backing: .buffered,
			defer: false
		)
		panel.title = "Troublemaker"
		panel.isFloatingPanel = true
		panel.level = .floating
		panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
		panel.isReleasedWhenClosed = false
		panel.titleVisibility = .hidden
		panel.titlebarAppearsTransparent = true
		panel.contentView = NSHostingView(rootView: FloatingChatView().environmentObject(model))
		position(panel: panel, size: panel.frame.size, verticalOffset: 76)
		NSApp.activate(ignoringOtherApps: true)
		panel.makeKeyAndOrderFront(nil)
		floatingPanel = panel
	}

	func showOverlayPanel() {
		guard let model else { return }
		if let overlayPanel {
			overlayPanel.orderFrontRegardless()
			return
		}

		let panel = NSPanel(
			contentRect: NSRect(x: 0, y: 0, width: 560, height: 96),
			styleMask: [.borderless, .nonactivatingPanel],
			backing: .buffered,
			defer: false
		)
		panel.isFloatingPanel = true
		panel.level = .statusBar
		panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
		panel.backgroundColor = .clear
		panel.isOpaque = false
		panel.hasShadow = false
		panel.ignoresMouseEvents = true
		panel.isReleasedWhenClosed = false
		panel.contentView = NSHostingView(rootView: LiquidGlassOverlayView().environmentObject(model))
		positionOverlay(panel)
		panel.orderFrontRegardless()
		overlayPanel = panel
	}

	func hideAllPanels() {
		floatingPanel?.orderOut(nil)
		overlayPanel?.orderOut(nil)
	}

	private func position(panel: NSPanel, size: NSSize, verticalOffset: CGFloat) {
		let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
		let origin = NSPoint(
			x: screenFrame.maxX - size.width - 24,
			y: screenFrame.minY + verticalOffset
		)
		panel.setFrame(NSRect(origin: origin, size: size), display: true)
	}

	private func positionOverlay(_ panel: NSPanel) {
		let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
		let size = panel.frame.size
		let origin = NSPoint(
			x: screenFrame.midX - size.width / 2,
			y: screenFrame.maxY - size.height - 22
		)
		panel.setFrame(NSRect(origin: origin, size: size), display: true)
	}
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
	private let panels = AssistantPanelController()
	private weak var model: AppModel?

	func applicationDidFinishLaunching(_ notification: Notification) {
		NSApp.setActivationPolicy(.regular)
		NSApp.activate(ignoringOtherApps: true)
	}

	func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
		model?.stopBackend()
		return .terminateNow
	}

	func application(_ application: NSApplication, open urls: [URL]) {
		for url in urls {
			model?.handleOAuthCallback(url)
		}
	}

	func attach(model: AppModel) {
		self.model = model
		panels.attach(model: model)
	}

	func showFloatingChat() {
		model?.appendLog("Opening floating chat panel.")
		panels.showFloatingPanel()
	}

	func showOverlay() {
		model?.appendLog("Opening overlay panel.")
		panels.showOverlayPanel()
	}

	func hideAssistantPanels() {
		panels.hideAllPanels()
	}
}
