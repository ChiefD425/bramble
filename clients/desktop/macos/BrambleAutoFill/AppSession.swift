// Fill from the unlocked desktop app, so AutoFill asks for nothing while Bramble is unlocked and
// asks again once it locks or quits (src-tauri/src/autofill_session.rs). The app keeps the key;
// this asks it for one login at a time. Anything short of a trusted answer means "unlock here".
// The other way round, an unlock here hands the key to a locked app, so it stays unlocked.

import Foundation
import Security

/// One login's secrets, from `fetch`.
struct SessionSecret: Decodable {
	let username: String
	let password: String
	let totp: String?
}

/// A login as the app lists it for the sheet: no secrets.
struct SessionLogin: Decodable {
	let id: String
	let name: String
	let username: String
	let hostnames: [String]
	let subdomainMatch: String?
	let hasPassword: Bool
	let hasTotp: Bool
}

struct SessionList: Decodable {
	let vaultId: String
	let logins: [SessionLogin]
}

enum AppSession {
	static let socketName = "fill"
	/// The desktop app, and only the app, signed by us.
	static let appRequirement =
		#"anchor apple generic and identifier "app.bramble.desktop" and certificate leaf[subject.OU] = "BHGR3PP64J""#
	static let maxReply = 1 << 20

	static func fetch(vaultId: String, id: String, in container: URL) -> SessionSecret? {
		ask(["op": "fetch", "vaultId": vaultId, "id": id], at: socketPath(container)).flatMap(decodeSecret)
	}

	/// The open vault's logins; nil when the app is locked, not running, or has another vault open.
	static func list(vaultId: String?, in container: URL) -> SessionList? {
		var request = ["op": "list"]
		if let vaultId { request["vaultId"] = vaultId }
		return ask(request, at: socketPath(container)).flatMap(decodeList)
	}

	/// Hand a key this extension just unwrapped to the app, which unlocks with it if it is locked on
	/// that vault. True when it did.
	@discardableResult
	static func unlock(vaultId: String, vek: String, at path: String, requirement: String = appRequirement) -> Bool {
		ask(["op": "unlock", "vaultId": vaultId, "vek": vek], at: path, requirement: requirement).map(ok) ?? false
	}

	static func socketPath(_ container: URL) -> String {
		container.appendingPathComponent(socketName).path
	}

	static func decodeSecret(_ data: Data) -> SessionSecret? {
		guard ok(data) else { return nil }
		return try? JSONDecoder().decode(SessionSecret.self, from: data)
	}

	static func decodeList(_ data: Data) -> SessionList? {
		guard ok(data) else { return nil }
		return try? JSONDecoder().decode(SessionList.self, from: data)
	}

	private static func ok(_ data: Data) -> Bool {
		((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["ok"] as? Bool == true
	}

	/// One request, one reply, over the app's socket: a 4-byte little-endian length, then JSON.
	static func ask(_ request: [String: String], at path: String, requirement: String = appRequirement) -> Data? {
		guard let body = try? JSONSerialization.data(withJSONObject: request) else { return nil }
		let fd = socket(AF_UNIX, SOCK_STREAM, 0)
		guard fd >= 0 else { return nil }
		defer { close(fd) }
		var timeout = timeval(tv_sec: 1, tv_usec: 0)
		setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
		setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
		var addr = sockaddr_un()
		addr.sun_family = sa_family_t(AF_UNIX)
		let bytes = Array(path.utf8)
		guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
		withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
		let connected = withUnsafePointer(to: &addr) {
			$0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
				connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
			}
		}
		guard connected == 0 else { return nil }
		guard peerSatisfies(fd, requirement) else {
			log("fill socket: the other end is not Bramble")
			return nil
		}
		var length = UInt32(body.count).littleEndian
		guard writeAll(fd, Data(bytes: &length, count: 4) + body),
			let header = readExactly(fd, 4)
		else { return nil }
		let size = Int(header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }.littleEndian)
		guard size <= maxReply else { return nil }
		return readExactly(fd, size)
	}

	/// From the audit token the kernel recorded at connect, not a pid that could be reused.
	static func peerSatisfies(_ fd: Int32, _ requirement: String) -> Bool {
		var token = audit_token_t()
		var length = socklen_t(MemoryLayout<audit_token_t>.size)
		guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) == 0 else { return false }
		let data = Data(bytes: &token, count: Int(length))
		var code: SecCode?
		var req: SecRequirement?
		let attributes = [kSecGuestAttributeAudit: data] as CFDictionary
		guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code,
			SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req
		else { return false }
		let status = SecCodeCheckValidity(code, [], req)
		if status != errSecSuccess { log("fill socket: signature check \(status)") }
		return status == errSecSuccess
	}

	private static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
		data.withUnsafeBytes { buf in
			var sent = 0
			while sent < buf.count {
				let n = write(fd, buf.baseAddress! + sent, buf.count - sent)
				if n <= 0 { return false }
				sent += n
			}
			return true
		}
	}

	private static func readExactly(_ fd: Int32, _ count: Int) -> Data? {
		var data = Data(count: count)
		let ok = data.withUnsafeMutableBytes { buf in
			var got = 0
			while got < count {
				let n = read(fd, buf.baseAddress! + got, count - got)
				if n <= 0 { return false }
				got += n
			}
			return true
		}
		return ok ? data : nil
	}

	static var log: (String) -> Void = { _ in }
}
