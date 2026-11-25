// Entries a vault can't decrypt are set aside here instead of failing the whole vault. They stay
// sealed as they arrived, are never synced or shown, and are kept until the vault is deleted, so
// a later rescue can still reach them. See docs/sync-vault-pinning-and-quarantine.md.

import type { StorageAdapter } from "../adapters/storage";
import { entryVersionKey } from "../sync/entry-version";
import type { EncryptedEntry } from "../vault-format";
import type { EntriesBlobStore } from "./entries-blob";
import { withVaultWriteLock } from "./write-lock";

export type QuarantinedEntry = EncryptedEntry & { quarantinedAt: number };
/** A previous store this code couldn't read, kept raw rather than overwritten or blocking the open. */
export type UnreadableStore = { unreadableStore: string; quarantinedAt: number };
/** A mailbox message that failed to verify or open, or came from a revoked device, kept whole. */
export type QuarantinedMessage = {
	/** The body as it arrived, base64. */
	mailboxMessage: string;
	mailboxId: string;
	messageId: string;
	sender: string;
	reason: "malformed" | "bad_signature" | "unopenable" | "bad_plaintext" | "revoked_sender";
	quarantinedAt: number;
};
export type QuarantineRecord = QuarantinedEntry | UnreadableStore | QuarantinedMessage;
export type QuarantineStore = Required<Pick<StorageAdapter, "readQuarantine" | "writeQuarantine">>;
type QuarantineDeps = { storage: QuarantineStore; vaultId: string; now?: number };

/** Set aside entries this vault can't open, then rewrite the vault without them. */
export async function quarantineEntries(
	deps: QuarantineDeps & { store: EntriesBlobStore },
	unreadable: EncryptedEntry[],
): Promise<void> {
	// Under the vault write lock: no save or other quarantine lands between a read and its write.
	await withVaultWriteLock(async () => {
		// Store first: a failed rewrite then leaves a copy in both places, never in neither.
		await addRecords(deps, unreadable, []);
		const drop = new Set(unreadable.map(entryVersionKey));
		// Re-read so a merge that landed since the load survives the rewrite.
		const current = await deps.store.readEntriesPayload();
		await deps.store.writeEntriesBlob({
			...current,
			entries: current.entries.filter((e) => !drop.has(entryVersionKey(e))),
		});
	});
}

/** Add records without touching the vault: for things that never landed in it. */
export async function appendQuarantine(
	deps: QuarantineDeps,
	add: { entries?: EncryptedEntry[]; messages?: Omit<QuarantinedMessage, "quarantinedAt">[] },
): Promise<void> {
	await withVaultWriteLock(() => addRecords(deps, add.entries ?? [], add.messages ?? []));
}

async function addRecords(
	deps: QuarantineDeps,
	entries: EncryptedEntry[],
	messages: Omit<QuarantinedMessage, "quarantinedAt">[],
): Promise<void> {
	const now = deps.now ?? Date.now();
	const kept = parseStore(await deps.storage.readQuarantine(deps.vaultId), now);
	const known = new Set([
		...kept.filter(isEntryRecord).map(entryVersionKey),
		...kept.filter(isMessageRecord).map(messageKey),
	]);
	const fresh = (key: string) => {
		if (known.has(key)) return false;
		known.add(key);
		return true;
	};
	const added = [
		...entries.filter((e) => fresh(entryVersionKey(e))),
		...messages.filter((m) => fresh(messageKey(m))),
	].map((r) => ({ ...r, quarantinedAt: now }));
	if (added.length > 0) {
		await deps.storage.writeQuarantine(JSON.stringify([...kept, ...added]), deps.vaultId);
	}
}

const isEntryRecord = (r: unknown): r is QuarantinedEntry =>
	typeof r === "object" && r !== null && "id" in r && "hlc" in r;

const isMessageRecord = (r: unknown): r is QuarantinedMessage =>
	typeof r === "object" && r !== null && "mailboxMessage" in r;

const messageKey = (m: { mailboxId: string; messageId: string }) =>
	`message|${m.mailboxId}|${m.messageId}`;

/** The stored records, or a damaged store carried forward whole so nothing in it is lost. */
function parseStore(raw: string | null, now: number): unknown[] {
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed;
	} catch {}
	return [{ unreadableStore: raw, quarantinedAt: now }];
}
