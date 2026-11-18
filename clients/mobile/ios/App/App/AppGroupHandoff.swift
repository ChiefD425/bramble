import Foundation

// The extension -> app handoffs (minted passkeys, fill-and-save associations, new logins): a JSON array of
// VEK-encrypted {iv, ciphertext} records per queue, in a file in the App Group container. The
// extension appends and the app drains, each under an exclusive flock on the shared container, so
// an append racing a drain is never lost. A file rather than UserDefaults: each process caches its
// defaults, so even a locked read there can be stale. Compiled into the App AND AutoFillProbe.
enum AppGroupHandoff {
	typealias Record = [String: String]

	enum Queue: String {
		case passkeys = "pending-passkeys.json"
		case associations = "pending-associations.json"
		// Logins made with "New login" in the picker. Peeked and removed one by one, never taken:
		// the picker already filled the password into a sign-up form.
		case logins = "pending-logins.json"

		// Where builds before the file queue kept it; drained once, with the file.
		var legacyKey: String? {
			switch self {
			case .passkeys: return BrambleVault.pendingPasskeysKey
			case .associations: return BrambleVault.pendingAssociationsKey
			case .logins: return nil
			}
		}
	}

	static func append(_ record: Record, to queue: Queue) {
		update(queue) { $0 + [record] }
	}

	/// Every pending record, cleared in the same locked step.
	static func take(_ queue: Queue) -> [Record] {
		var taken: [Record] = []
		update(queue) { current in
			var legacy: [Record] = []
			if let key = queue.legacyKey, let defaults = UserDefaults(suiteName: BrambleVault.appGroup) {
				legacy = (defaults.array(forKey: key) as? [Record]) ?? []
				defaults.removeObject(forKey: key)
			}
			taken = legacy + current
			return []
		}
		return taken
	}

	/// Every pending record, left in place. A plain read: writes land atomically, never half a file.
	static func peek(_ queue: Queue) -> [Record] {
		fileURL(queue).map(read) ?? []
	}

	/// Drop the records with these ivs, keeping the rest.
	static func remove(ivs: Set<String>, from queue: Queue) {
		guard !ivs.isEmpty else { return }
		update(queue) { $0.filter { !ivs.contains($0["iv"] ?? "") } }
	}

	/// Put back records the app couldn't decrypt (another vault's), ahead of any appended since.
	static func restore(_ keep: [Record], to queue: Queue) {
		guard !keep.isEmpty else { return }
		update(queue) { keep + $0 }
	}

	// Not the new logins: this runs when one vault is deleted, and a login another vault's picker
	// made is that vault's only copy of a password already in use. The deleted vault's own records
	// are sealed under a key that is gone with it.
	static func removeAll() {
		for queue in [Queue.passkeys, .associations] {
			update(queue) { _ in [] }
			if let key = queue.legacyKey { UserDefaults(suiteName: BrambleVault.appGroup)?.removeObject(forKey: key) }
		}
	}

	/// Run `body` holding the App Group lock, for other read-modify-writes of shared state.
	static func locked<T>(_ body: () -> T) -> T {
		let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: BrambleVault.appGroup)
		let fd = dir.map { open($0.appendingPathComponent("handoff.lock").path, O_CREAT | O_RDWR, 0o600) } ?? -1
		// Unlocked rather than not at all: dropping a minted passkey is worse than a rare race.
		if fd >= 0 { flock(fd, LOCK_EX) }
		defer { if fd >= 0 { close(fd) } }  // closing releases the lock
		return body()
	}

	private static func fileURL(_ queue: Queue) -> URL? {
		FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: BrambleVault.appGroup)?
			.appendingPathComponent(queue.rawValue)
	}

	private static func read(_ url: URL) -> [Record] {
		(try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [Record] } ?? []
	}

	private static func update(_ queue: Queue, _ change: ([Record]) -> [Record]) {
		guard let url = fileURL(queue) else { return }
		locked {
			let next = change(read(url))
			if next.isEmpty {
				try? FileManager.default.removeItem(at: url)
			} else if let data = try? JSONSerialization.data(withJSONObject: next) {
				try? data.write(to: url, options: .atomic)
			}
		}
	}
}
