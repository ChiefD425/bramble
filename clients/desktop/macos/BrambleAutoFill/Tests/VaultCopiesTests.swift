// The sheet's choice of vault, without the sheet: run with `pnpm test:appex` in clients/desktop.
import Foundation

@main
struct VaultCopiesTests {
	static var failures = 0

	static func check(_ ok: Bool, _ what: String, line: Int = #line) {
		if !ok {
			failures += 1
			print("FAIL line \(line): \(what)")
		}
	}

	static func copy(_ id: String, written: Double, credentials: [String] = []) -> VaultCopy {
		let json = """
			{"iv":"I","ciphertext":"C","vaultId":"\(id)","vaultName":"\(id)","writtenAt":\(written),"passkeyCredentialIds":\(credentials)}
			"""
		return try! JSONDecoder().decode(VaultCopy.self, from: Data(json.utf8))
	}

	static func main() {
		// A suggestion's record identifier carries its vault before the first colon.
		check(untag("v1:e1") == ("v1", "e1"), "untag splits vault and id")
		check(untag("e1") == (nil, "e1"), "an untagged id has no vault")
		check(untag("v1:a:b") == ("v1", "a:b"), "only the first colon splits")

		let copies = [copy("v1", written: 1, credentials: ["A"]), copy("v2", written: 2)]
		check(chooseCopy(copies, vaultId: "v1", credentialIds: [])?.vaultId == "v1", "a named vault")
		check(chooseCopy(copies, vaultId: "v9", credentialIds: []) == nil, "a named vault with no copy")
		check(chooseCopy(copies, vaultId: nil, credentialIds: ["A"])?.vaultId == "v1", "the vault holding the passkey")
		check(chooseCopy(copies, vaultId: nil, credentialIds: ["Z"]) == nil, "no vault holds the passkey")
		check(chooseCopy(copies, vaultId: nil, credentialIds: [])?.vaultId == "v2", "the copy written last")

		// Every vault in the menu has a name to pick it by.
		check(menuLabel(copy("v1", written: 1)) == "v1", "a vault's own name")
		let unnamed = try! JSONDecoder().decode(VaultCopy.self, from: Data(#"{"iv":"I","ciphertext":"C","vaultId":"v4","vaultName":" "}"#.utf8))
		check(menuLabel(unnamed) == "Unnamed vault", "a vault with no name")

		// Before the first write after updating, the single copy lists no passkeys: it may hold one.
		let legacy = try! JSONDecoder().decode(VaultCopy.self, from: Data(#"{"iv":"I","ciphertext":"C"}"#.utf8))
		check(chooseCopy([legacy], vaultId: nil, credentialIds: ["A"]) != nil, "the single copy from before")

		let fm = FileManager.default
		let group = fm.temporaryDirectory.appendingPathComponent("vault-copies-\(UUID().uuidString)")
		defer { try? fm.removeItem(at: group) }
		try! fm.createDirectory(at: group, withIntermediateDirectories: true)
		try! Data(#"{"iv":"I","ciphertext":"C"}"#.utf8).write(to: group.appendingPathComponent("autofill.json"))
		check(readCopies(in: group).count == 1, "the single copy from before, until there are others")

		let dir = group.appendingPathComponent("autofill")
		try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
		for id in ["v1", "v2"] {
			try! Data(#"{"iv":"I","ciphertext":"C","vaultId":"\#(id)"}"#.utf8)
				.write(to: dir.appendingPathComponent("\(id).json"))
		}
		try! Data("not json".utf8).write(to: dir.appendingPathComponent("v3.json.tmp"))
		let read = readCopies(in: group).compactMap(\.vaultId).sorted()
		check(read == ["v1", "v2"], "one copy per vault, the old one and stray files ignored")

		if failures > 0 {
			print("\(failures) check(s) failed")
			exit(1)
		}
		print("vault copies: all checks passed")
	}
}
