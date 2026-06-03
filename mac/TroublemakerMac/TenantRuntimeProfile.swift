import Foundation

struct CloudAgentBinding: Codable, Equatable, Identifiable {
	let id: String
	let name: String
	let tenantID: String?
	let cloudBaseURL: String
	let selectedAt: Date

	init(agent: CloudAgent, tenantID: String? = nil, cloudBaseURL: String = "https://crawdad.tinyfat.com") {
		id = agent.id
		name = agent.name
		self.tenantID = tenantID
		self.cloudBaseURL = cloudBaseURL
		selectedAt = Date()
	}
}

struct TenantRuntimeProfile: Equatable {
	let profileName: String
	let localAgentID: String
	let agentName: String
	let cloudAgentID: String?
	let tenantID: String?
	let cloudBaseURL: String
	let port: Int
	let workspaceURL: URL

	static func current(env: [String: String] = ProcessInfo.processInfo.environment) -> TenantRuntimeProfile {
		let profileName = clean(env["TROUBLEMAKER_AGENT_PROFILE"]) ?? "local-desktop"
		let cloudAgentID = clean(env["TROUBLEMAKER_CLOUD_AGENT_ID"])
		let tenantID = clean(env["TROUBLEMAKER_TENANT_ID"])
		let localAgentID = clean(env["TROUBLEMAKER_LOCAL_AGENT_ID"])
			?? cloudAgentID
			?? profileName
		let agentName = clean(env["TROUBLEMAKER_AGENT_NAME"]) ?? "Local Desktop Agent"
		let cloudBaseURL = clean(env["TROUBLEMAKER_CLOUD_BASE_URL"]) ?? "https://crawdad.tinyfat.com"
		let port = Int(clean(env["TROUBLEMAKER_PORT"]) ?? "") ?? 3017
		let workspaceURL = workspaceOverride(env: env) ?? defaultWorkspaceURL(localAgentID: localAgentID)

		return TenantRuntimeProfile(
			profileName: profileName,
			localAgentID: localAgentID,
			agentName: agentName,
			cloudAgentID: cloudAgentID,
			tenantID: tenantID,
			cloudBaseURL: cloudBaseURL,
			port: port,
			workspaceURL: workspaceURL
		)
	}

	static func cloudBound(_ binding: CloudAgentBinding, env: [String: String] = ProcessInfo.processInfo.environment) -> TenantRuntimeProfile {
		let cloudBaseURL = clean(env["TROUBLEMAKER_CLOUD_BASE_URL"]) ?? binding.cloudBaseURL
		let port = Int(clean(env["TROUBLEMAKER_PORT"]) ?? "") ?? 3017
		return TenantRuntimeProfile(
			profileName: "cloud-agent",
			localAgentID: binding.id,
			agentName: binding.name,
			cloudAgentID: binding.id,
			tenantID: binding.tenantID,
			cloudBaseURL: cloudBaseURL,
			port: port,
			workspaceURL: workspaceOverride(env: env) ?? defaultWorkspaceURL(localAgentID: binding.id)
		)
	}

	static func signedOut(env: [String: String] = ProcessInfo.processInfo.environment) -> TenantRuntimeProfile {
		let cloudBaseURL = clean(env["TROUBLEMAKER_CLOUD_BASE_URL"]) ?? "https://crawdad.tinyfat.com"
		let port = Int(clean(env["TROUBLEMAKER_PORT"]) ?? "") ?? 3017
		return TenantRuntimeProfile(
			profileName: "signed-out",
			localAgentID: "unbound-local-desktop",
			agentName: "No Agent Selected",
			cloudAgentID: nil,
			tenantID: nil,
			cloudBaseURL: cloudBaseURL,
			port: port,
			workspaceURL: workspaceOverride(env: env) ?? defaultWorkspaceURL(localAgentID: "unbound-local-desktop")
		)
	}

	var isCloudBound: Bool {
		cloudAgentID != nil
	}

	var environment: [String: String] {
		var env: [String: String] = [
			"TROUBLEMAKER_AGENT_PROFILE": profileName,
			"TROUBLEMAKER_LOCAL_AGENT_ID": localAgentID,
			"TROUBLEMAKER_AGENT_NAME": agentName,
			"TROUBLEMAKER_CLOUD_BASE_URL": cloudBaseURL,
			"TROUBLEMAKER_PORT": String(port),
			"TROUBLEMAKER_WORKSPACE": workspaceURL.path,
			"TROUBLEMAKER_APP_OWNED_RUNTIME": "1",
			"TROUBLEMAKER_DISPLAY_MODE": "desktop",
		]
		if let cloudAgentID { env["TROUBLEMAKER_CLOUD_AGENT_ID"] = cloudAgentID }
		if let tenantID { env["TROUBLEMAKER_TENANT_ID"] = tenantID }
		return env
	}

	var bindingSummary: String {
		if let cloudAgentID, !cloudAgentID.isEmpty {
			return "\(agentName) -> \(cloudAgentID)"
		}
		return "\(agentName) -> local profile \(localAgentID)"
	}

	private static func clean(_ value: String?) -> String? {
		guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
			return nil
		}
		return trimmed
	}

	private static func workspaceOverride(env: [String: String]) -> URL? {
		guard let raw = clean(env["TROUBLEMAKER_WORKSPACE"]) else { return nil }
		return URL(fileURLWithPath: raw, isDirectory: true)
	}

	private static func defaultWorkspaceURL(localAgentID: String) -> URL {
		let safeID = localAgentID
			.replacingOccurrences(of: "/", with: "-")
			.replacingOccurrences(of: ":", with: "-")
		return FileManager.default
			.homeDirectoryForCurrentUser
			.appendingPathComponent("Library/Application Support/Troublemaker/Agents", isDirectory: true)
			.appendingPathComponent(safeID, isDirectory: true)
			.appendingPathComponent("Workspace", isDirectory: true)
	}
}
