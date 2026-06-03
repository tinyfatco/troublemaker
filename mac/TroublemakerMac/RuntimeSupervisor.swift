import Foundation

struct BackendSnapshot: Equatable {
	enum State: String {
		case stopped
		case starting
		case ready
		case busy
		case crashed
		case external
	}

	var state: State = .stopped
	var message: String = "Stopped"
	var port: Int = 3002
	var lastHealthCheck: Date?
	var activeRunDescription: String?
}

final class RuntimeSupervisor {
	let projectRoot: URL
	let profile: TenantRuntimeProfile
	let port: Int
	var onLog: ((String) -> Void)?
	var onExit: ((Int32) -> Void)?

	private var process: Process?
	private var outputPipe: Pipe?
	private var logHandle: FileHandle?

	init(projectRoot: URL, profile: TenantRuntimeProfile = .current()) {
		self.projectRoot = projectRoot
		self.profile = profile
		self.port = profile.port
	}

	var isProcessRunning: Bool {
		process?.isRunning == true
	}

	func start(build: Bool = false, environmentOverrides: [String: String] = [:]) throws {
		if process?.isRunning == true {
			onLog?("Backend already running from this app.")
			return
		}

		let script = projectRoot.appendingPathComponent("scripts/run-local-mac.sh")
		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/bin/bash")
		process.arguments = [script.path] + (build ? [] : ["--no-build"])
		process.currentDirectoryURL = projectRoot
		var env = LauncherEnvironment.merged(projectRoot: projectRoot)
		for (key, value) in profile.environment {
			env[key] = value
		}
		for (key, value) in environmentOverrides {
			env[key] = value
		}
		process.environment = env

		let pipe = Pipe()
		process.standardOutput = pipe
		process.standardError = pipe

		let log = openAppLog()
		log.writeLine("\n[\(ISO8601DateFormatter().string(from: Date()))] Starting \(profile.bindingSummary) on 127.0.0.1:\(port)")
		outputPipe = pipe
		logHandle = log

		pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
			let data = handle.availableData
			guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
			self?.logHandle?.write(data)
			for line in text.split(whereSeparator: \.isNewline) {
				self?.onLog?(String(line))
			}
		}

		process.terminationHandler = { [weak self] terminated in
			pipe.fileHandleForReading.readabilityHandler = nil
			self?.onLog?("Backend exited with status \(terminated.terminationStatus).")
			self?.onExit?(terminated.terminationStatus)
		}

		try process.run()
		self.process = process
		onLog?("Started backend process \(process.processIdentifier).")
	}

	func stop() {
		guard let process else {
			onLog?("No app-owned backend process to stop.")
			return
		}
		process.terminate()
		self.process = nil
		outputPipe?.fileHandleForReading.readabilityHandler = nil
		outputPipe = nil
		onLog?("Stopped app-owned backend process.")
	}

	func reclaimListeningProcessIfOwned() -> Bool {
		let pids = listeningPIDs()
		guard !pids.isEmpty else { return false }
		var reclaimed = false
		for pid in pids {
			let command = processCommand(pid: pid)
			guard isOwnedRuntimeCommand(command) else {
				onLog?("Port \(port) is held by non-owned process \(pid): \(command)")
				continue
			}
			onLog?("Stopping stale app-owned backend \(pid) on port \(port).")
			_ = run("/bin/kill", ["-TERM", pid])
			reclaimed = true
		}
		return reclaimed
	}

	func restart(build: Bool = false, environmentOverrides: [String: String] = [:]) throws {
		stop()
		try start(build: build, environmentOverrides: environmentOverrides)
	}

	private func openAppLog() -> FileHandle {
		let url = BundlePaths.logURL(named: "troublemaker-app.log")
		FileManager.default.createFile(atPath: url.path, contents: nil)
		let handle = try? FileHandle(forWritingTo: url)
		handle?.seekToEndOfFile()
		return handle ?? FileHandle.standardError
	}

	private func listeningPIDs() -> [String] {
		let output = run("/usr/sbin/lsof", ["-nP", "-tiTCP:\(port)", "-sTCP:LISTEN"])
		return output
			.split(whereSeparator: \.isNewline)
			.map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
			.filter { !$0.isEmpty }
	}

	private func processCommand(pid: String) -> String {
		run("/bin/ps", ["-p", pid, "-o", "command="])
			.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	private func isOwnedRuntimeCommand(_ command: String) -> Bool {
		guard command.contains(projectRoot.path),
			  command.contains("dist/main.js"),
			  command.contains("--port=\(port)") || command.contains("--port \(port)") else {
			return false
		}
		return command.contains("/Library/Application Support/Troublemaker/Agents/")
	}

	private func run(_ executable: String, _ arguments: [String]) -> String {
		let process = Process()
		process.executableURL = URL(fileURLWithPath: executable)
		process.arguments = arguments
		let pipe = Pipe()
		process.standardOutput = pipe
		process.standardError = Pipe()
		do {
			try process.run()
			process.waitUntilExit()
			let data = pipe.fileHandleForReading.readDataToEndOfFile()
			return String(data: data, encoding: .utf8) ?? ""
		} catch {
			return ""
		}
	}
}
