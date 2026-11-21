// The desktop app's copies of its vaults, one per vault, and which one a request opens. Foundation
// only, so `pnpm test:appex` can check it without the extension. See docs/macos-credential-provider.md.

import Foundation

/// One vault's copy (src-tauri/src/autofill_provider.rs): logins and passkeys under the vault's
/// key, its password slot, and in the clear what the sheet needs before it unlocks.
struct VaultCopy: Decodable {
	let iv: String
	let ciphertext: String
	let vaultId: String?
	/// What the app calls the vault, so the sheet can say which one it unlocks.
	let vaultName: String?
	let slot: SlotPayload?
	let passkeyIv: String?
	let passkeyCiphertext: String?
	/// The passkeys it holds, so a sign-in naming one opens this vault. Absent on the single copy
	/// from before per-vault copies.
	let passkeyCredentialIds: [String]?
	/// Milliseconds since 1970.
	let writtenAt: Double?
}

struct SlotPayload: Decodable {
	let saltB64: String
	let slotIdB64: String
	let verifierB64: String
	let wrapIvB64: String
	let wrappedVekB64: String
	let magicVersionB64: String
}

/// Every vault's copy in the group container, or the single copy from before until there is one.
func readCopies(in group: URL) -> [VaultCopy] {
	let dir = group.appendingPathComponent("autofill")
	let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
	let copies = files.filter { $0.pathExtension == "json" }.compactMap(decode)
	if !copies.isEmpty { return copies }
	return decode(group.appendingPathComponent("autofill.json")).map { [$0] } ?? []
}

private func decode(_ url: URL) -> VaultCopy? {
	guard let data = try? Data(contentsOf: url) else { return nil }
	return try? JSONDecoder().decode(VaultCopy.self, from: data)
}

/// A store identity's record identifier is `<vaultId>:<id>`; one from before carries no vault.
func untag(_ recordIdentifier: String) -> (vaultId: String?, id: String) {
	guard let colon = recordIdentifier.firstIndex(of: ":") else { return (nil, recordIdentifier) }
	return (String(recordIdentifier[..<colon]), String(recordIdentifier[recordIdentifier.index(after: colon)...]))
}

/// The copy a request opens: the vault it names, else the vault holding a passkey it names, else
/// the copy written last. Nil when the request needs a vault that has no copy here.
func chooseCopy(_ copies: [VaultCopy], vaultId: String?, credentialIds: [String]) -> VaultCopy? {
	let last = copies.max { ($0.writtenAt ?? 0) < ($1.writtenAt ?? 0) }
	if let vaultId { return copies.first { $0.vaultId == vaultId } }
	if credentialIds.isEmpty { return last }
	let wanted = Set(credentialIds)
	if let holder = copies.first(where: { !wanted.isDisjoint(with: $0.passkeyCredentialIds ?? []) }) {
		return holder
	}
	// The single copy from before does not list its passkeys, so it may still hold the one asked for.
	return copies.contains { $0.passkeyCredentialIds == nil } ? last : nil
}

/// How the vault menu names a copy: its own name, or a stand-in when the app had none to give.
func menuLabel(_ copy: VaultCopy) -> String {
	let name = copy.vaultName?.trimmingCharacters(in: .whitespaces) ?? ""
	return name.isEmpty ? String(localized: "Unnamed vault") : name
}
