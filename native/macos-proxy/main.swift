import Foundation
import SystemConfiguration
import Security
import Darwin

// This user-session helper holds network authorization only while a connection
// is active. EOF on the private parent pipe also restores settings after a crash.
struct Journal: Codable {
    let original: [String: Data]
    let installed: [String: Data]
}
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1)
}
let args = CommandLine.arguments
if args.count == 4 && args[1] == "status" {
    let config = SCDynamicStoreCopyProxies(nil) as? [String: Any] ?? [:]
    let enabled = (config[kSCPropNetProxiesHTTPEnable as String] as? Int) == 1 &&
        (config[kSCPropNetProxiesHTTPSEnable as String] as? Int) == 1 &&
        (config[kSCPropNetProxiesHTTPProxy as String] as? String) == args[2] &&
        (config[kSCPropNetProxiesHTTPSProxy as String] as? String) == args[2] &&
        (config[kSCPropNetProxiesHTTPPort as String] as? Int) == Int(args[3]) &&
        (config[kSCPropNetProxiesHTTPSPort as String] as? Int) == Int(args[3])
    print(enabled ? "enabled" : "disabled"); exit(0)
}
if args.count < 3 { fail("usage: macos-proxy recover <journal> | enable <journal> <host> <port>") }
let action = args[1], journalURL = URL(fileURLWithPath: args[2])
if action != "recover" && action != "enable" { fail("invalid action") }
if action == "recover" && !FileManager.default.fileExists(atPath: journalURL.path) { exit(0) }
var authorization: AuthorizationRef?
let authResult = AuthorizationCreate(nil, nil, [], &authorization)
if authResult != errAuthorizationSuccess { fail("network authorization unavailable") }
defer { if let authorization { AuthorizationFree(authorization, []) } }
let rightsResult = "system.preferences.network".withCString { name -> OSStatus in
    var item = AuthorizationItem(name: name, valueLength: 0, value: nil, flags: 0)
    return withUnsafeMutablePointer(to: &item) { pointer in
        var rights = AuthorizationRights(count: 1, items: pointer)
        return AuthorizationCopyRights(authorization!, &rights, nil, [.interactionAllowed, .extendRights, .preAuthorize], nil)
    }
}
if rightsResult != errAuthorizationSuccess { fail("network authorization cancelled or denied") }

guard let prefs = SCPreferencesCreateWithAuthorization(nil, "kukuhou proxy" as CFString, nil, authorization) else { fail("network preferences unavailable") }
func lock() throws {
    if !SCPreferencesLock(prefs, true) { throw NSError(domain: "SystemConfiguration", code: Int(SCError())) }
    SCPreferencesSynchronize(prefs)
}
func commit() throws {
    if !SCPreferencesCommitChanges(prefs) || !SCPreferencesApplyChanges(prefs) { throw NSError(domain: "SystemConfiguration", code: Int(SCError())) }
}
func protocols() -> [String: SCNetworkProtocol] {
    var result: [String: SCNetworkProtocol] = [:]
    for service in (SCNetworkServiceCopyAll(prefs) as? [SCNetworkService] ?? []) {
        if !SCNetworkServiceGetEnabled(service) { continue }
        if let id = SCNetworkServiceGetServiceID(service), let proto = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies) {
            result[id as String] = proto
        }
    }
    return result
}
func encode(_ value: [String: Any]) throws -> Data {
    try PropertyListSerialization.data(fromPropertyList: value, format: .binary, options: 0)
}
func decode(_ data: Data) throws -> [String: Any] {
    guard let value = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any] else { throw NSError(domain: "journal", code: 1) }
    return value
}
func restore() throws {
    let journal = try JSONDecoder().decode(Journal.self, from: Data(contentsOf: journalURL))
    try lock(); defer { SCPreferencesUnlock(prefs) }
    let available = protocols()
    for (id, original) in journal.original {
        guard let proto = available[id], let installed = journal.installed[id] else { continue }
        let current = SCNetworkProtocolGetConfiguration(proto) as? [String: Any] ?? [:]
        // Respect settings changed by the user or another application.
        if NSDictionary(dictionary: current).isEqual(to: try decode(installed)) {
            if !SCNetworkProtocolSetConfiguration(proto, try decode(original) as CFDictionary) { throw NSError(domain: "restore", code: Int(SCError())) }
        }
    }
    try commit()
    try FileManager.default.removeItem(at: journalURL)
}
do {
    if action == "recover" { try restore(); exit(0) }
    guard args.count == 5, ["127.0.0.1", "::1"].contains(args[3]), let port = Int(args[4]), (1...65535).contains(port) else { fail("invalid loopback proxy") }
    // Refuse to overwrite a pending recovery record.
    if FileManager.default.fileExists(atPath: journalURL.path) { try restore() }
    try lock()
    var original: [String: Data] = [:], installed: [String: Data] = [:]
    let available = protocols()
    if available.isEmpty { SCPreferencesUnlock(prefs); fail("no enabled network services") }
    for (id, proto) in available {
        var config = SCNetworkProtocolGetConfiguration(proto) as? [String: Any] ?? [:]
        original[id] = try encode(config)
        config[kSCPropNetProxiesHTTPEnable as String] = 1
        config[kSCPropNetProxiesHTTPProxy as String] = args[3]
        config[kSCPropNetProxiesHTTPPort as String] = port
        config[kSCPropNetProxiesHTTPSEnable as String] = 1
        config[kSCPropNetProxiesHTTPSProxy as String] = args[3]
        config[kSCPropNetProxiesHTTPSPort as String] = port
        config[kSCPropNetProxiesProxyAutoConfigEnable as String] = 0
        config[kSCPropNetProxiesProxyAutoDiscoveryEnable as String] = 0
        installed[id] = try encode(config)
        if !SCNetworkProtocolSetConfiguration(proto, config as CFDictionary) { SCPreferencesUnlock(prefs); fail("proxy configuration failed") }
    }
    let journal = try JSONEncoder().encode(Journal(original: original, installed: installed))
    try journal.write(to: journalURL, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: journalURL.path)
    do { try commit() } catch { SCPreferencesUnlock(prefs); try? restore(); throw error }
    SCPreferencesUnlock(prefs)
    FileHandle.standardOutput.write(Data("READY\n".utf8))
    // Only the parent owns the write end. Normal disconnect and parent death
    // both close it; no persistent launch daemon or root executable is installed.
    _ = FileHandle.standardInput.readDataToEndOfFile()
    try restore()
} catch { fail("system proxy operation failed: \(error)") }
