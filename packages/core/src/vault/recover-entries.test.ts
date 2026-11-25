import { describe, expect, it, vi } from "vitest";
import { emptyEntriesPayload } from "../sync/entries-payload";
import { testVaultBlob } from "../test/vault-fixtures";
import { bytesToBase64 } from "../util/bytes";
import { encodeVaultBlob } from "../vault-format";
import { decryptEntriesOrRecover } from "./recover-entries";
import { withVaultWriteLock } from "./write-lock";

// Issue #27 recovery. Restoring is destructive — it overwrites the live file, the user's only
// other copy — so the snapshot has to prove it opens under the key we already hold. "Restore
// whatever .bak is there" would turn a recoverable vault into a lost one.

const LIVE = new Uint8Array([1, 1, 1, 1]);
const SNAPSHOT = new Uint8Array([2, 2, 2, 2]);
const PAYLOAD = JSON.stringify(emptyEntriesPayload());

/** `opens` is the set of ciphertexts the loaded key can decrypt; anything else throws like the
 * Rust core does, so live and snapshot can disagree — which is the whole point. */
function deps(opts: {
	opens: Uint8Array[];
	backup?: Uint8Array | null;
	hasBackupApi?: boolean;
	/** What the live file holds now, if a write replaced it after the caller's read. */
	live?: Uint8Array;
	beforeBackup?: () => Promise<void>;
}) {
	const crypto = {
		decryptWithVek: vi.fn(async (_iv: string, ct: string) => {
			if (!opts.opens.some((c) => bytesToBase64(c) === ct)) {
				throw new Error("aes decrypt: aead::Error");
			}
			return PAYLOAD;
		}),
	};
	const backup = () =>
		opts.backup === undefined ? encodeVaultBlob(testVaultBlob(SNAPSHOT)) : opts.backup;
	let live = encodeVaultBlob(testVaultBlob(opts.live ?? LIVE));
	const storage = {
		readVaultBlob: vi.fn(async () => live),
		restoreVaultFromBackup: vi.fn(async () => {
			const bytes = backup();
			if (bytes) live = bytes;
			return bytes !== null;
		}),
		...(opts.hasBackupApi === false
			? {}
			: {
					readVaultBackup: vi.fn(async () => {
						await opts.beforeBackup?.();
						return backup();
					}),
				}),
	};
	const onRestored = vi.fn();
	const setLive = (ct: Uint8Array) => {
		live = encodeVaultBlob(testVaultBlob(ct));
	};
	return { crypto, storage, onRestored, live: () => live, setLive };
}

describe("decryptEntriesOrRecover", () => {
	it("returns the live payload without touching the snapshot when it decrypts", async () => {
		const d = deps({ opens: [LIVE] });

		await expect(decryptEntriesOrRecover(d, testVaultBlob(LIVE))).resolves.toBe(PAYLOAD);

		expect(d.storage.readVaultBackup).not.toHaveBeenCalled();
		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("restores the snapshot once it verifies under the loaded key", async () => {
		const d = deps({ opens: [SNAPSHOT] });

		await expect(decryptEntriesOrRecover(d, testVaultBlob(LIVE))).resolves.toBe(PAYLOAD);

		expect(d.storage.restoreVaultFromBackup).toHaveBeenCalledTimes(1);
		expect(d.onRestored).toHaveBeenCalledTimes(1); // never a silent swap
	});

	it("verifies BEFORE restoring, so a bad snapshot can't clobber the live file", async () => {
		const d = deps({ opens: [SNAPSHOT] });
		const order: string[] = [];
		d.crypto.decryptWithVek.mockImplementation(async (_iv: string, ct: string) => {
			order.push("decrypt");
			if (ct !== bytesToBase64(SNAPSHOT)) throw new Error("aes decrypt: aead::Error");
			return PAYLOAD;
		});
		d.storage.restoreVaultFromBackup.mockImplementation(async () => {
			order.push("restore");
			return true;
		});

		await decryptEntriesOrRecover(d, testVaultBlob(LIVE));

		// The caller's copy, the live file read again under the lock, then the snapshot.
		expect(order).toEqual(["decrypt", "decrypt", "decrypt", "restore"]);
	});

	it("rethrows the original error when the snapshot is equally unopenable", async () => {
		const d = deps({ opens: [] });

		await expect(decryptEntriesOrRecover(d, testVaultBlob(LIVE))).rejects.toThrow(/aead::Error/);

		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("rethrows when there is no snapshot at all", async () => {
		const d = deps({ opens: [], backup: null });

		await expect(decryptEntriesOrRecover(d, testVaultBlob(LIVE))).rejects.toThrow(/aead::Error/);

		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("rethrows when the snapshot bytes don't even decode", async () => {
		const d = deps({ opens: [], backup: new Uint8Array([0, 1, 2]) });

		await expect(decryptEntriesOrRecover(d, testVaultBlob(LIVE))).rejects.toThrow(/aead::Error/);

		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("refuses an empty snapshot rather than silently blanking the vault", async () => {
		// An empty entries blob "opens" trivially; restoring it would present a vault with
		// nothing in it as a successful recovery.
		const d = deps({ opens: [], backup: encodeVaultBlob(testVaultBlob(new Uint8Array(0))) });

		await expect(decryptEntriesOrRecover(d, testVaultBlob(LIVE))).rejects.toThrow(/aead::Error/);

		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("self-disables where the platform has no snapshot store", async () => {
		const d = deps({ opens: [], hasBackupApi: false });

		await expect(decryptEntriesOrRecover(d, testVaultBlob(LIVE))).rejects.toThrow(/aead::Error/);

		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("keeps a save that replaced the live file after the caller read it", async () => {
		const SAVED = new Uint8Array([3, 3, 3, 3]);
		const d = deps({ opens: [SAVED, SNAPSHOT], live: SAVED });

		await expect(decryptEntriesOrRecover(d, testVaultBlob(LIVE))).resolves.toBe(PAYLOAD);

		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("restores under the vault write lock, so a save can't land before the restore", async () => {
		const SAVED = new Uint8Array([3, 3, 3, 3]);
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let arrive = () => {};
		const reached = new Promise<void>((resolve) => {
			arrive = resolve;
		});
		const d = deps({
			opens: [SAVED, SNAPSHOT],
			beforeBackup: async () => {
				arrive();
				await released;
			},
		});

		const recovering = decryptEntriesOrRecover(d, testVaultBlob(LIVE));
		await reached;
		const saving = withVaultWriteLock(async () => d.setLive(SAVED));
		await new Promise((resolve) => setTimeout(resolve, 10));
		release();
		await Promise.all([recovering, saving]);

		expect(d.live()).toEqual(encodeVaultBlob(testVaultBlob(SAVED)));
	});
});
