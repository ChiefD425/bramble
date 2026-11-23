// Asking the unlocked app, over a real socket in this process: run with `pnpm test:appex`.
import Foundation

@main
struct AppSessionTests {
	static var failures = 0

	static func check(_ ok: Bool, _ what: String, line: Int = #line) {
		if !ok {
			failures += 1
			print("FAIL line \(line): \(what)")
		}
	}

	/// Serve one connection at `path`: record the request, send `reply`. Returns what was asked.
	static func serveOnce(at path: String, reply: String) -> () -> String? {
		unlink(path)
		let server = socket(AF_UNIX, SOCK_STREAM, 0)
		var addr = sockaddr_un()
		addr.sun_family = sa_family_t(AF_UNIX)
		withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: Array(path.utf8)) }
		_ = withUnsafePointer(to: &addr) {
			$0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
		}
		listen(server, 1)
		var asked: String?
		let done = DispatchSemaphore(value: 0)
		Thread {
			defer {
				close(server)
				done.signal()
			}
			let conn = accept(server, nil, nil)
			guard conn >= 0 else { return }
			defer { close(conn) }
			var header = [UInt8](repeating: 0, count: 4)
			guard read(conn, &header, 4) == 4 else { return }
			let size = Int(UInt32(header[0]) | UInt32(header[1]) << 8 | UInt32(header[2]) << 16 | UInt32(header[3]) << 24)
			var body = [UInt8](repeating: 0, count: size)
			guard read(conn, &body, size) == size else { return }
			asked = String(decoding: body, as: UTF8.self)
			let out = Array(reply.utf8)
			var length = UInt32(out.count).littleEndian
			_ = write(conn, &length, 4)
			_ = write(conn, out, out.count)
		}.start()
		return {
			done.wait()
			return asked
		}
	}

	static func main() {
		// Replies
		let secret = AppSession.decodeSecret(Data(#"{"ok":true,"username":"u","password":"p","totp":"T"}"#.utf8))
		check(secret?.username == "u" && secret?.password == "p" && secret?.totp == "T", "a secret decodes")
		check(AppSession.decodeSecret(Data(#"{"ok":false}"#.utf8)) == nil, "a refusal is no secret")
		check(
			AppSession.decodeSecret(Data(#"{"ok":false,"username":"u","password":"p"}"#.utf8)) == nil,
			"only ok:true is an answer")
		check(AppSession.decodeSecret(Data("garbage".utf8)) == nil, "garbage is no secret")
		let list = AppSession.decodeList(
			Data(
				#"{"ok":true,"vaultId":"v1","logins":[{"id":"a","name":"A","username":"u","hostnames":["github.com"],"hasPassword":true,"hasTotp":false}]}"#
					.utf8))
		check(list?.vaultId == "v1" && list?.logins.first?.hostnames == ["github.com"], "a list decodes")
		check(list?.logins.first?.subdomainMatch == nil, "no subdomain mode is the default")
		check(AppSession.decodeList(Data(#"{"ok":false}"#.utf8)) == nil, "a refusal is no list")

		// Transport. A short path: sockets cap theirs at 104 bytes.
		let path = "/tmp/bramble-appsession-\(getpid())"
		defer { unlink(path) }

		// Any signed code satisfies "always", so this proves the peer check reads the server.
		var asked = serveOnce(at: path, reply: #"{"ok":true,"username":"u","password":"p"}"#)
		let got = AppSession.ask(["op": "fetch", "vaultId": "v1", "id": "a"], at: path, requirement: "always")
		let request = asked().flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: String] }
		check(request == ["op": "fetch", "vaultId": "v1", "id": "a"], "the request arrives as sent")
		check(got.flatMap(AppSession.decodeSecret)?.password == "p", "the reply comes back")

		// This test binary is not the Bramble app: nothing is sent to it.
		asked = serveOnce(at: path, reply: #"{"ok":true,"username":"u","password":"p"}"#)
		check(AppSession.ask(["op": "list"], at: path) == nil, "an impostor gets no request and gives no answer")
		check(asked() == nil, "the impostor never heard the request")

		// No app running.
		unlink(path)
		check(AppSession.ask(["op": "list"], at: path, requirement: "always") == nil, "no socket, no answer")

		if failures > 0 {
			print("\(failures) failed")
			exit(1)
		}
		print("app session: all passed")
	}
}
