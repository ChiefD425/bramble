// Verified snapshot recovery for an entries blob that won't decrypt.
//
// Issue #27: a vault whose slots and entries ended up sealed under different keys DECODES fine —
// it fails later, on the outer AEAD — and both the master password and the recovery code hit that
// same wall, because they wrap the same key. The blob writer snapshots the previous bytes before
// truncating, so the copy from before the bad write is usually still good.
//
// Pure and adapter-shaped so it can be tested directly: every unlock path (password, recovery
// code, security key, biometric) reaches it through loadEntries.

import type { CryptoAdapter } from "../adapters/crypto";
import type { StorageAdapter } from "../adapters/storage";
import { bytesToBase64 } from "../util/bytes";
import { decodeVaultBlob, type VaultBlob } from "../vault-format";
import { withVaultWriteLock } from "./write-lock";

export interface RecoverEntriesDeps {
	crypto: Pick<CryptoAdapter, "decryptWithVek">;
	storage: Pick<StorageAdapter, "readVaultBlob" | "restoreVaultFromBackup"> &
		Partial<Pick<StorageAdapter, "readVaultBackup">>;
	/** Reported when a snapshot is actually used, so the swap is never silent. */
	onRestored?: () => void;
}

const outer = (crypto: RecoverEntriesDeps["crypto"], blob: VaultBlob) =>
	crypto.decryptWithVek(bytesToBase64(blob.entriesIv), bytesToBase64(blob.entriesCiphertext));

/** The payload of a stored copy that opens under the key held, or null. */
async function openStored(
	crypto: RecoverEntriesDeps["crypto"],
	read: () => Promise<Uint8Array | null>,
): Promise<string | null> {
	try {
		const bytes = await read();
		if (!bytes) return null;
		const blob = decodeVaultBlob(bytes);
		// An empty copy proves nothing and would silently blank the vault.
		if (blob.entriesCiphertext.length === 0) return null;
		return await outer(crypto, blob);
	} catch {
		return null; // unreadable, undecodable, or equally unopenable
	}
}

/**
 * Decrypt the outer entries payload, falling back to the recovery snapshot when the live blob
 * won't open under the key already held.
 *
 * The snapshot must PROVE itself first: restoring is destructive (it overwrites the live file,
 * which is the user's only other copy), so a snapshot that is equally unopenable, unreadable, or
 * absent leaves everything untouched and the original error is rethrown unchanged.
 */
export async function decryptEntriesOrRecover(
	{ crypto, storage, onRestored }: RecoverEntriesDeps,
	blob: VaultBlob,
): Promise<string> {
	try {
		return await outer(crypto, blob);
	} catch (err) {
		const { readVaultBackup } = storage;
		if (!readVaultBackup) throw err; // no snapshot store on this platform
		// Under the vault write lock, and from a fresh read: a save that replaced the live file
		// since the caller read it is kept, and none can land before the restore.
		return withVaultWriteLock(async () => {
			const live = await openStored(crypto, () => storage.readVaultBlob());
			if (live !== null) return live;
			const recovered = await openStored(crypto, () => readVaultBackup());
			if (recovered === null) throw err;
			onRestored?.();
			await storage.restoreVaultFromBackup();
			return recovered;
		});
	}
}
