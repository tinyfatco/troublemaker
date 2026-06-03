import Foundation

enum BundlePaths {
	static let appName = "Troublemaker"

	static func projectRoot() throws -> URL {
		if let marker = Bundle.main.resourceURL?.appendingPathComponent("project-root") {
			let raw = try String(contentsOf: marker, encoding: .utf8)
				.trimmingCharacters(in: .whitespacesAndNewlines)
			if !raw.isEmpty {
				return URL(fileURLWithPath: raw, isDirectory: true)
			}
		}

		if let raw = ProcessInfo.processInfo.environment["TROUBLEMAKER_PROJECT_ROOT"], !raw.isEmpty {
			return URL(fileURLWithPath: raw, isDirectory: true)
		}

		return URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
	}

	static func logURL(named name: String) -> URL {
		let logs = FileManager.default
			.homeDirectoryForCurrentUser
			.appendingPathComponent("Library/Logs", isDirectory: true)
		try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
		return logs.appendingPathComponent(name)
	}
}

enum LauncherEnvironment {
	static func merged(projectRoot: URL) -> [String: String] {
		var env = ProcessInfo.processInfo.environment
		let existingPath = env["PATH"] ?? ""
		env["PATH"] = [
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/usr/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
			existingPath,
		].filter { !$0.isEmpty }.joined(separator: ":")
		env["TROUBLEMAKER_LAUNCHED_BY_APP"] = "1"
		env["TROUBLEMAKER_APP_BUNDLE_ID"] = "com.tinyfatco.troublemaker"
		env["TROUBLEMAKER_PROJECT_ROOT"] = projectRoot.path
		env["PEEKABOO_NO_REMOTE"] = env["PEEKABOO_NO_REMOTE"] ?? "1"
		env["PEEKABOO_MCP_ARGS"] = env["PEEKABOO_MCP_ARGS"] ?? "mcp --no-remote"
		return env
	}
}

enum SmokeCommand {
	static var shouldRun: Bool {
		CommandLine.arguments.contains("--smoke-peekaboo")
	}

	static func runAndExit() -> Never {
		do {
			let projectRoot = try BundlePaths.projectRoot()
			let status = run(
				"/usr/bin/env",
				["node", projectRoot.appendingPathComponent("scripts/smoke-peekaboo-mcp.mjs").path],
				projectRoot: projectRoot,
				logName: "troublemaker-peekaboo-smoke.log"
			)
			exit(status)
		} catch {
			let log = openLog(BundlePaths.logURL(named: "troublemaker-peekaboo-smoke.log"))
			log.writeLine("Troublemaker smoke command failed: \(error)")
			exit(1)
		}
	}

	private static func openLog(_ url: URL) -> FileHandle {
		FileManager.default.createFile(atPath: url.path, contents: nil)
		let handle = try? FileHandle(forWritingTo: url)
		handle?.seekToEndOfFile()
		return handle ?? FileHandle.standardError
	}

	private static func run(_ executable: String, _ arguments: [String], projectRoot: URL, logName: String) -> Int32 {
		let log = openLog(BundlePaths.logURL(named: logName))
		log.writeLine("\n[\(ISO8601DateFormatter().string(from: Date()))] \(BundlePaths.appName) launching: \(executable) \(arguments.joined(separator: " "))")

		let process = Process()
		process.executableURL = URL(fileURLWithPath: executable)
		process.arguments = arguments
		process.currentDirectoryURL = projectRoot
		process.environment = LauncherEnvironment.merged(projectRoot: projectRoot)
		process.standardOutput = log
		process.standardError = log

		do {
			try process.run()
		} catch {
			log.writeLine("Failed to launch \(executable): \(error)")
			return 127
		}

		process.waitUntilExit()
		return process.terminationStatus
	}
}

extension FileHandle {
	func writeLine(_ line: String) {
		if let data = "\(line)\n".data(using: .utf8) {
			write(data)
		}
	}
}
