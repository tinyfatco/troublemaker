import Foundation

let appName = "Troublemaker"

func appContentsURL() -> URL {
	let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
	return executable.deletingLastPathComponent().deletingLastPathComponent()
}

func readProjectRoot() throws -> String {
	let marker = appContentsURL()
		.appendingPathComponent("Resources", isDirectory: true)
		.appendingPathComponent("project-root")
	let raw = try String(contentsOf: marker, encoding: .utf8)
	return raw.trimmingCharacters(in: .whitespacesAndNewlines)
}

func logURL(named name: String) -> URL {
	let logs = FileManager.default
		.homeDirectoryForCurrentUser
		.appendingPathComponent("Library/Logs", isDirectory: true)
	try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
	return logs.appendingPathComponent(name)
}

func openLog(_ url: URL) -> FileHandle {
	FileManager.default.createFile(atPath: url.path, contents: nil)
	let handle = try? FileHandle(forWritingTo: url)
	handle?.seekToEndOfFile()
	return handle ?? FileHandle.standardError
}

func mergedEnvironment(projectRoot: String) -> [String: String] {
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
	env["TROUBLEMAKER_PROJECT_ROOT"] = projectRoot
	env["PEEKABOO_NO_REMOTE"] = env["PEEKABOO_NO_REMOTE"] ?? "1"
	env["PEEKABOO_MCP_ARGS"] = env["PEEKABOO_MCP_ARGS"] ?? "mcp --no-remote"
	return env
}

@discardableResult
func run(_ executable: String, _ arguments: [String], projectRoot: String, logName: String) -> Int32 {
	let log = openLog(logURL(named: logName))
	let timestamp = ISO8601DateFormatter().string(from: Date())
	if let data = "\n[\(timestamp)] \(appName) launching: \(executable) \(arguments.joined(separator: " "))\n".data(using: .utf8) {
		log.write(data)
	}

	let process = Process()
	process.executableURL = URL(fileURLWithPath: executable)
	process.arguments = arguments
	process.currentDirectoryURL = URL(fileURLWithPath: projectRoot, isDirectory: true)
	process.environment = mergedEnvironment(projectRoot: projectRoot)
	process.standardOutput = log
	process.standardError = log

	do {
		try process.run()
	} catch {
		if let data = "Failed to launch \(executable): \(error)\n".data(using: .utf8) {
			log.write(data)
		}
		return 127
	}

	process.waitUntilExit()
	return process.terminationStatus
}

do {
	let projectRoot = try readProjectRoot()
	let args = Array(CommandLine.arguments.dropFirst())

	if args.contains("--smoke-peekaboo") {
		let status = run(
			"/usr/bin/env",
			["node", "\(projectRoot)/scripts/smoke-peekaboo-mcp.mjs"],
			projectRoot: projectRoot,
			logName: "troublemaker-peekaboo-smoke.log",
		)
		exit(status)
	}

	var runArgs: [String] = []
	if !args.contains("--build") {
		runArgs.append("--no-build")
	}

	let status = run(
		"/bin/bash",
		["\(projectRoot)/scripts/run-local-mac.sh"] + runArgs,
		projectRoot: projectRoot,
		logName: "troublemaker-app.log",
	)
	exit(status)
} catch {
	let log = openLog(logURL(named: "troublemaker-app.log"))
	if let data = "Troublemaker launcher failed: \(error)\n".data(using: .utf8) {
		log.write(data)
	}
	exit(1)
}
