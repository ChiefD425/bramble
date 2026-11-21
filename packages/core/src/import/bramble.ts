// Opening a .bramble to import into the vault that is open. Two kinds share the extension and
// both merge: a portable export, whose payload holds entries in the clear, and a full vault
// backup (plain, or an archive with its attachments), whose entries are still sealed under the
// backup's own key. Restoring a backup as a separate vault is the Restore screen's job.
//
// Reason codes and classes, not messages: this is a .ts file, which the Lingui macro transform
// does not cover, so the Import screen supplies the copy.

import type { CryptoAdapter, EncryptedPayload } from "../adapters/crypto";
import { restoreAttachments } from "../backup/archive";
import { type PickFailure, readPickedBackup } from "../backup/restore";
import type { RandomAccessSource } from "../backup/zip";
import { readPortableVaultFile, withoutId } from "../export/portable-vault";
import type { EntryData } from "../hooks/useVault";
import { decodeEntriesPayload, type FileRecord } from "../sync/entries-payload";
import { liveFiles } from "../sync/vault-merge";
import type { BlobStore } from "../vault/blob-store";
import { type FileMeta, plaintextSize, type SealedFile } from "../vault/file-mutations";
import { verifierPrefix } from "../vault-format";
import { tallyByType } from "./shared";
import type { ImportAttachment, ImportResult, SealedSource } from "./types";

/** A picked file that isn't a .bramble this screen can open. */
export class BrambleFileError extends Error {
	constructor(readonly reason: PickFailure) {
		super(`can't open this .bramble: ${reason}`);
	}
}

/** An attachment whose bytes in the backup aren't what its name says. Stops the import whole. */
export class DamagedAttachmentError extends Error {
	constructor() {
		super("an attachment in this backup is damaged");
	}
}

export interface BrambleImportDeps {
	/** `openVaultBackup` must be bound to the vault being imported into: the backup's file keys
	 * are wrapped again under that vault's key. */
	crypto: Pick<CryptoAdapter, "openPortableVault" | "openVaultBackup">;
	/** Open an attachment's sealed name and type under that same vault's key. */
	describe(record: FileRecord): Promise<FileMeta>;
	/** The ids of the entries that vault shows. Ids belong to a vault and outlive every edit, so
	 * a backup entry whose id is here is one the vault still has, as it was or newer. */
	held: ReadonlySet<string>;
}

/** The entries in a .bramble, and a backup's attachments, or null for a wrong password. */
export async function openBrambleFile(
	deps: BrambleImportDeps,
	source: RandomAccessSource,
	password: string,
): Promise<ImportResult | null> {
	const read = await readPickedBackup(source);
	if (!read.ok) throw new BrambleFileError(read.reason);
	const file = readPortableVaultFile(read.picked.vault);
	if (!file) throw new BrambleFileError("no-password");
	if (!deps.crypto.openPortableVault) throw new Error("Opening a .bramble isn't available here.");
	const magicVersion = verifierPrefix();
	const json = await deps.crypto.openPortableVault({ file, password, magicVersion });
	if (json === null) return null;

	const { entries } = JSON.parse(json) as { entries?: unknown };
	if (!Array.isArray(entries)) throw new BrambleFileError("damaged");
	// A portable export's entries are plain; a backup's are `{ id, ciphertext, ... }` records.
	if (!entries.some((e) => typeof e === "object" && e !== null && "ciphertext" in e)) {
		const imported = entries as EntryData[];
		return { imported, byType: tallyByType(imported), skipped: 0, warnings: [] };
	}

	const payload = decodeEntriesPayload(json);
	// Local-only entries (the hidden unlock key) belong to the device that made the backup.
	const shown = payload.entries.filter((e) => !e.localOnly);
	const shownIds = new Set(shown.map((e) => e.id));
	// What a backup of this vault adds is only what it lost: an entry still here stays as it is,
	// rather than coming back beside it as an older copy.
	const missing = shown.filter((e) => !deps.held.has(e.id));
	const archived = new Map(read.picked.attachments.map((a) => [a.hash, a]));
	const records = liveFiles(payload);
	// A file comes only on an entry that comes, and only with its bytes in the file.
	const carried = records.filter(
		(r) => r.entryId !== undefined && shownIds.has(r.entryId) && archived.has(r.hash),
	);
	if (!deps.crypto.openVaultBackup) throw new Error("Opening a .bramble isn't available here.");
	const opened = await deps.crypto.openVaultBackup({
		file,
		password,
		magicVersion,
		entries: missing.map(sealedEntry),
		files: carried.map(({ wrappedFek, fekIv }) => ({ wrappedFek, fekIv })),
	});
	if (!opened) return null;

	const imported: EntryData[] = [];
	const byId = new Map<string, EntryData>();
	missing.forEach((e, i) => {
		const entry = parseEntry(opened.entries[i] ?? null);
		if (!entry) return;
		imported.push(entry);
		byId.set(e.id, entry);
	});

	const attachments: ImportAttachment[] = [];
	for (const [i, record] of carried.entries()) {
		const key = opened.files[i];
		// On an entry the vault still has, it goes onto that entry, if that entry lacks it.
		const entry =
			record.entryId === undefined
				? undefined
				: deps.held.has(record.entryId)
					? record.entryId
					: byId.get(record.entryId);
		const at = archived.get(record.hash);
		if (!key || !entry || !at) continue;
		const moved = { ...record, ...key };
		const meta = await deps.describe(moved).catch(() => null);
		if (!meta) continue;
		const sealed: SealedFile = {
			hash: moved.hash,
			size: moved.size,
			wrappedFek: moved.wrappedFek,
			fekIv: moved.fekIv,
			noncePrefix: moved.noncePrefix,
			metaBlob: moved.metaBlob,
			metaIv: moved.metaIv,
		};
		attachments.push({
			entry,
			name: meta.name,
			mime: meta.mime,
			size: plaintextSize(record.size),
			source: { kind: "sealed", sealed, archive: source, at },
		});
	}

	return {
		imported,
		byType: tallyByType(imported),
		skipped: 0,
		warnings: [],
		attachments,
		alreadyHere: shown.length - missing.length,
		leftOut: {
			items: missing.length - imported.length,
			attachments: records.length - attachments.length,
		},
	};
}

/**
 * Copy a backup's attachment into the vault's store as it is. Its bytes are checked against its
 * name on the way in; a damaged one throws, which stops the import before anything is written.
 */
export async function storeSealedAttachment(
	blobs: BlobStore,
	source: SealedSource,
): Promise<SealedFile> {
	const { rejected } = await restoreAttachments(blobs, source.archive, [source.at]);
	if (rejected > 0) throw new DamagedAttachmentError();
	return source.sealed;
}

function sealedEntry({ ciphertext, iv, wrappedDek, dekIv }: EncryptedPayload): EncryptedPayload {
	return { ciphertext, iv, wrappedDek, dekIv };
}

function parseEntry(json: string | null): EntryData | null {
	if (json === null) return null;
	try {
		const parsed: unknown = JSON.parse(json);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? withoutId(parsed as EntryData)
			: null;
	} catch {
		return null;
	}
}
